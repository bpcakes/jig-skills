import { readBrief, reviewGuidance } from "../skills/comprehensive-review/scripts/review-brief.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MISSING_CREDENTIALS,
  SHIM_NOT_EXECUTABLE,
  ambientSkills,
  buildCodexArgs,
  classifyFailure,
  instructionsLoaded,
  isolate,
  isolationOverrides,
  listedSkills,
  parseArgs,
  parseCodexResult,
  probeShim,
  renderPrompt,
  runCodexReview,
  writeShim,
} from "../skills/comprehensive-review/scripts/codex-review.mjs";
import { failureResult } from "../skills/review-fix-loop/scripts/provider-bridge.mjs";
import { captureFingerprint } from "../skills/comprehensive-review/scripts/scope-fingerprint.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepository() {
  const repo = mkdtempSync(path.join(os.tmpdir(), "jig-codex-review-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Adapter Test"]);
  git(repo, ["config", "user.email", "adapter@example.invalid"]);
  writeFileSync(path.join(repo, "example.js"), "export function value() {\n  return 1;\n}\n");
  git(repo, ["add", "example.js"]);
  git(repo, ["commit", "-qm", "initial"]);
  writeFileSync(path.join(repo, "example.js"), "export function value() {\n  return 3;\n}\n");
  return repo;
}

async function workingTreeFingerprint(repo) {
  return (await captureFingerprint({ cwd: repo, scope: "working-tree", base: null, timeoutMs: 5_000 })).fingerprint;
}

// A stand-in for codex (or for jig forwarding to codex). `debug prompt-input`
// renders Codex's roots table and skill entries from the same locations Codex
// scans (CODEX_HOME/skills, cwd .agents/skills and .codex/skills, ~/.agents/skills)
// honoring skills.config and project_doc_max_bytes unless told to ignore them.
// Other invocations record argv, prompt, and environment, then write the report
// to the --output-last-message path.
function fakeProvider(directory, name, { exitCode = 0, stderr = "", stdout = "", report = "No actionable findings from Codex.", writeReport = true, ignoreSkillsConfig = false, keepDocs = false } = {}) {
  const file = path.join(directory, name);
  writeFileSync(file, [
    "#!/usr/bin/env node",
    'import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    "const argv = process.argv.slice(2);",
    "function skillFiles(root, out = []) { let entries = []; try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }",
    "  for (const entry of entries) { const full = path.join(root, entry.name); if (entry.name === 'SKILL.md') out.push(full); else if (entry.isDirectory()) skillFiles(full, out); } return out; }",
    "if (argv[0] === 'debug') {",
    "  const overrides = argv.filter((a, i) => argv[i - 1] === '-c');",
    `  const disabled = ${ignoreSkillsConfig} ? new Set() : new Set(overrides.filter(o => o.startsWith('skills.config=')).flatMap(o => [...o.matchAll(/path="((?:[^"\\\\]|\\\\.)*)"/g)].map(m => JSON.parse('"' + m[1] + '"'))));`,
    `  const docs = ${keepDocs} || !overrides.includes('project_doc_max_bytes=0');`,
    "  const system = path.join(process.env.CODEX_HOME, 'skills', '.system', 'fake-system-skill'); mkdirSync(system, { recursive: true });",
    "  writeFileSync(path.join(system, 'SKILL.md'), '---\\nname: fake-system-skill\\ndescription: FAKE_SYSTEM_SKILL\\n---\\n');",
    "  const roots = [path.join(process.env.HOME, '.agents', 'skills'), path.join(process.env.CODEX_HOME, 'skills', '.system'), path.join(process.env.CODEX_HOME, 'skills'), path.join(process.cwd(), '.agents', 'skills'), path.join(process.cwd(), '.codex', 'skills')];",
    "  const lines = ['<skills_instructions>', '### Skill roots'];",
    "  roots.forEach((root, index) => lines.push('- `r' + index + '` = `' + root + '`'));",
    "  lines.push('### Available skills');",
    "  roots.forEach((root, index) => { for (const skill of skillFiles(root)) { if (index === 2 && skill.includes('/.system/')) continue; if (disabled.has(skill)) continue; const description = (readFileSync(skill, 'utf8').match(/^description: (.*)$/m) ?? [, 'none'])[1]; lines.push('- ' + path.basename(path.dirname(skill)) + ': ' + description + ' (file: r' + index + '/' + path.relative(root, skill) + ')'); } });",
    "  lines.push('</skills_instructions>');",
    "  const messages = [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: lines.join('\\n') }] }];",
    "  const agents = path.join(process.cwd(), 'AGENTS.md');",
    "  if (docs && existsSync(agents)) messages.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for ' + process.cwd() + '\\n\\n<INSTRUCTIONS>\\n' + readFileSync(agents, 'utf8') + '</INSTRUCTIONS>' }] });",
    "  process.stdout.write(JSON.stringify(messages));",
    "  process.exit(0);",
    "}",
    "let prompt = '';",
    "for await (const chunk of process.stdin) prompt += chunk;",
    "let home = null;",
    "try { home = { path: process.env.CODEX_HOME, entries: readdirSync(process.env.CODEX_HOME).sort(), authLink: readlinkSync(process.env.CODEX_HOME + '/auth.json') }; } catch (error) { home = { path: process.env.CODEX_HOME, error: error.code }; }",
    "writeFileSync(process.env.FAKE_CODEX_CAPTURE, JSON.stringify({ argv, prompt, env: process.env, home }));",
    `if (${JSON.stringify(stdout)}) process.stdout.write(${JSON.stringify(stdout)});`,
    `if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});`,
    `if (${exitCode} !== 0) process.exit(${exitCode});`,
    "const outputIndex = argv.indexOf('--output-last-message');",
    `if (${writeReport} && outputIndex >= 0) writeFileSync(argv[outputIndex + 1], ${JSON.stringify(report)});`,
    "",
  ].join("\n"));
  chmodSync(file, 0o755);
  return file;
}

function withEnvironment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function writeSkill(root, name, marker) {
  mkdirSync(path.join(root, name), { recursive: true });
  writeFileSync(path.join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${marker}\n---\nbody\n`);
  return path.join(root, name, "SKILL.md");
}

async function adapterFixture(t) {
  const repo = makeRepository();
  const scratch = mkdtempSync(path.join(os.tmpdir(), "jig-codex-capture-"));
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });
  // Ambient inputs a real reviewer must not see: repository and user skills,
  // repository instructions, and a selected home with instructions and skills.
  writeFileSync(path.join(repo, "AGENTS.md"), "PROBE_REPO_AGENTS: always say apple.\n");
  const repoSkill = writeSkill(path.join(repo, ".agents", "skills"), "repo-probe-skill", "PROBE_REPO_SKILL");
  const deepSkill = writeSkill(path.join(repo, ".agents", "skills", "a", "b", "c", "d", "e", "f"), "deep-probe-skill", "PROBE_DEEP_SKILL");
  const codexSkill = writeSkill(path.join(repo, ".codex", "skills"), "codex-probe-skill", "PROBE_CODEX_SKILL");
  const userHome = path.join(scratch, "user-home");
  const userSkill = writeSkill(path.join(userHome, ".agents", "skills"), "user-probe-skill", "PROBE_USER_SKILL");
  const sourceHome = path.join(scratch, "source-codex-home");
  mkdirSync(sourceHome, { recursive: true });
  writeFileSync(path.join(sourceHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "test-key" }));
  writeFileSync(path.join(sourceHome, "AGENTS.md"), "PROBE_HOME_AGENTS: always say banana.\n");
  writeFileSync(path.join(sourceHome, "config.toml"), 'model = "probe-model"\n');
  writeSkill(path.join(sourceHome, "skills"), "home-probe-skill", "PROBE_HOME_SKILL");
  withEnvironment(t, { HOME: userHome, CODEX_HOME: sourceHome });
  const capturePath = path.join(scratch, "capture.json");
  const taskBrief = path.join(scratch, "brief.json");
  writeFileSync(taskBrief, JSON.stringify({ goal: "Preserve public values", requirements: [{ id: "R1", text: "Return the requested value", source: "User request" }], constraints: [], nonGoals: [], unknowns: [] }));
  const pinnedBrief = readBrief(taskBrief);
  withEnvironment(t, { FAKE_CODEX_CAPTURE: capturePath });
  const expectedFingerprint = await workingTreeFingerprint(repo);
  const parse = (extra = []) => parseArgs([
    "--cwd", repo, "--scope", "working-tree", "--expected-fingerprint", expectedFingerprint,
    "--task-brief", taskBrief, "--task-brief-hash", pinnedBrief.hash, "--timeout-ms", "5000", ...extra,
  ]);
  return { repo, scratch, capturePath, pinnedBrief, parse, repoSkill, deepSkill, codexSkill, userSkill, userHome, sourceHome, captured: () => JSON.parse(readFileSync(capturePath, "utf8")) };
}

test("argument parsing validates Codex CLI efforts and launcher selection", () => {
  assert.deepEqual(
    parseArgs(["--cwd", "/tmp/repo", "--scope", "branch", "--base", "abc123", "--model", "gpt-5-codex", "--effort", "XHigh",
      "--launcher", "home:work", "--expected-fingerprint", "A".repeat(64), "--timeout-ms", "5000"]),
    { cwd: "/tmp/repo", scope: "branch", base: "abc123", includeWorkingTree: false, model: "gpt-5-codex", effort: "xhigh",
      launcher: "home:work", expectedFingerprint: "a".repeat(64), timeoutMs: 5000, excludePaths: [] },
  );
  const base = ["--scope", "working-tree", "--expected-fingerprint", "a".repeat(64)];
  assert.equal(parseArgs(base).launcher, "none");
  assert.equal(parseArgs(base).model, null);
  assert.throws(() => parseArgs([...base, "--effort", "max"]), /The Codex CLI accepts minimal, low, medium, high, xhigh/);
  assert.throws(() => parseArgs([...base, "--launcher", "picker"]), /Unsupported --launcher value/);
  assert.throws(() => parseArgs([...base, "--model", " "]), /--model must not be blank/);
  assert.throws(() => parseArgs([...base, "--config-dir", "/x"]), /Unsupported argument: --config-dir/);
  assert.throws(() => parseArgs([...base, "--scope", "branch"]), /Duplicate argument/);
  assert.throws(() => parseArgs(["--scope", "working-tree"]), /expected-fingerprint/);
});

test("Codex arguments select an ephemeral read-only session without user configuration", () => {
  const args = buildCodexArgs({ model: "gpt-5-codex", effort: "high" }, { repoRoot: "/repo" }, "/tmp/last.txt", ["-c", "project_doc_max_bytes=0"]);
  assert.equal(args[0], "exec");
  assert.equal(args.at(-1), "-", "the prompt arrives over stdin");
  for (const flag of ["--json", "--ephemeral", "--ignore-user-config", "--ignore-rules"]) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
  assert.deepEqual(args.slice(args.indexOf("--cd"), args.indexOf("--cd") + 2), ["--cd", "/repo"]);
  assert.deepEqual(args.slice(args.indexOf("--output-last-message"), args.indexOf("--output-last-message") + 2), ["--output-last-message", "/tmp/last.txt"]);
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "gpt-5-codex"]);
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(!args.includes("--add-dir"), "a read-only sandbox needs no writable directories");
  assert.ok(args.includes("project_doc_max_bytes=0"));
  const defaults = buildCodexArgs({ model: null, effort: null }, { repoRoot: "/repo" }, "/tmp/last.txt", []);
  assert.ok(!defaults.includes("--model"));
  assert.ok(!defaults.some((arg) => arg.startsWith("model_reasoning_effort")));
});

test("the final message file is the report", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jig-codex-last-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "last.txt");
  assert.throws(() => parseCodexResult(file), /did not write a final message/);
  writeFileSync(file, "  \n");
  assert.throws(() => parseCodexResult(file), /no review output/);
  writeFileSync(file, "\nFindings\n");
  assert.equal(parseCodexResult(file), "Findings");
});

test("the adapter runs Codex directly with a scrubbed environment and shell-oriented instructions", async (t) => {
  const f = await adapterFixture(t);
  withEnvironment(t, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "parent", CODEX_SANDBOX_NETWORK_DISABLED: "1" });
  const fakeCodex = fakeProvider(f.scratch, "fake-codex.mjs");
  const report = await runCodexReview(f.parse(["--model", "gpt-5-codex", "--effort", "medium"]), { codexBin: fakeCodex });
  assert.equal(report, "No actionable findings from Codex.");
  const captured = f.captured();
  assert.equal(captured.argv[0], "exec");
  assert.deepEqual(captured.argv.slice(captured.argv.indexOf("--model"), captured.argv.indexOf("--model") + 2), ["--model", "gpt-5-codex"]);
  assert.ok(captured.argv.includes('model_reasoning_effort="medium"'));
  assert.equal(captured.argv.at(-1), "-");
  assert.ok(captured.prompt.includes(reviewGuidance(f.pinnedBrief)));
  assert.match(captured.prompt, /Target: working tree at [0-9a-f]{40}/);
  assert.match(captured.prompt, /\+  return 3;/);
  assert.match(captured.prompt, /read-only shell commands such as cat, sed, or rg/);
  assert.ok(!captured.prompt.includes("or shell commands."), "Codex must be allowed read-only shell inspection");
  assert.equal(captured.env.CLAUDECODE, undefined);
  assert.equal(captured.env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(captured.env.CODEX_SANDBOX_NETWORK_DISABLED, undefined);
  assert.equal(captured.env.GIT_OPTIONAL_LOCKS, "0");
  // The reviewer runs in a private home that holds the selected credentials and
  // only what Codex itself writes there; the selected home's instructions,
  // skills, and configuration are absent.
  assert.notEqual(captured.home.path, f.sourceHome);
  assert.ok(captured.home.entries.includes("auth.json"), JSON.stringify(captured.home.entries));
  for (const name of ["AGENTS.md", "config.toml"]) assert.ok(!captured.home.entries.includes(name), name);
  assert.equal(captured.home.authLink, path.join(f.sourceHome, "auth.json"));
  assert.ok(captured.argv.includes("project_doc_max_bytes=0"));
  const skills = captured.argv.find((arg) => arg.startsWith("skills.config="));
  for (const file of [f.repoSkill, f.deepSkill, f.codexSkill, f.userSkill]) assert.ok(skills.includes(`{path=${JSON.stringify(file)},enabled=false}`), file);
  assert.ok(!skills.includes("fake-system-skill"), "Codex's own skills inside the private home stay enabled");
  assert.equal(captured.env.JIG_CODEX_BIN?.endsWith("codex-shim.sh"), true);
  assert.equal(captured.env.JIG_REVIEW_CODEX_BIN, fakeCodex);
});

test("without a launcher the shim runs through sh, and an unexecutable shim is a permanent failure under a launcher", async (t) => {
  const f = await adapterFixture(t);
  // Direct launches never execute a file from the evidence directory.
  const fakeCodex = fakeProvider(f.scratch, "sh-codex.mjs");
  const directory = path.join(f.scratch, "noexec"); mkdirSync(directory, { mode: 0o700 });
  const { shim } = writeShim(directory);
  chmodSync(shim, 0o600);
  const viaSh = spawnSync("/bin/sh", [shim, "--jig-review-probe"], { encoding: "utf8" });
  assert.equal(viaSh.status, 0, "sh can read a non-executable shim");
  let failure;
  await assert.rejects(probeShim(shim, { deadlineAt: Date.now() + 5000, signal: null }), (error) => { failure = error; return true; });
  assert.ok(failure.message.startsWith(SHIM_NOT_EXECUTABLE), failure.message);
  assert.equal(failure.providerError, SHIM_NOT_EXECUTABLE);
  assert.equal(failureResult(failure).retryable, false);
  await runCodexReview(f.parse(), { codexBin: fakeCodex });
  assert.equal(f.captured().argv[0], "exec", "the direct review still reaches the provider through the shim");
});

test("a Jig launcher wraps the Codex command and forwards the adapter arguments exactly", async (t) => {
  const f = await adapterFixture(t);
  const fakeJig = fakeProvider(f.scratch, "fake-jig.mjs");
  // The pre-launch isolation renders use the Codex executable directly; the review itself must go through Jig.
  const renderOnly = fakeProvider(f.scratch, "render-only-codex.mjs", { report: "launcher was bypassed" });
  const report = await runCodexReview(f.parse(["--launcher", "auto"]), { codexBin: renderOnly, jigBin: fakeJig });
  assert.equal(report, "No actionable findings from Codex.");
  const captured = f.captured();
  assert.deepEqual(captured.argv.slice(0, 5), ["codex", "launch", "--auto", "--", "exec"]);
  assert.equal(captured.argv.at(-1), "-");

  withEnvironment(t, { JIG_LAUNCHER_BIN: fakeJig });
  await runCodexReview(f.parse(["--launcher", "home:work"]), { codexBin: renderOnly });
  assert.deepEqual(f.captured().argv.slice(0, 5), ["codex", "launch", "work", "--", "exec"]);
});

test("a launcher without an eligible home is a permanent provider failure", async (t) => {
  const f = await adapterFixture(t);
  const message = "No eligible Codex home with fresh subscription headroom; inspect `jig codex homes --usage` or pass HOME explicitly";
  const fakeJig = fakeProvider(f.scratch, "exhausted-jig.mjs", { exitCode: 1, stderr: `${message}\n` });
  const codex = fakeProvider(f.scratch, "render-codex.mjs");
  let failure;
  await assert.rejects(runCodexReview(f.parse(["--launcher", "auto"]), { codexBin: codex, jigBin: fakeJig }), (error) => { failure = error; return /No eligible Codex home/.test(error.message); });
  assert.equal(failureResult(failure).retryable, false);
  const stale = fakeProvider(f.scratch, "stale-jig.mjs", { exitCode: 2, stderr: "error: unexpected argument '--auto' found\n" });
  await assert.rejects(runCodexReview(f.parse(["--launcher", "auto"]), { codexBin: codex, jigBin: stale }), (error) => { failure = error; return /unexpected argument/.test(error.message); });
  assert.equal(failureResult(failure).retryable, false);
});

test("a missing final message fails the review instead of returning an empty report", async (t) => {
  const f = await adapterFixture(t);
  const silent = fakeProvider(f.scratch, "silent-codex.mjs", { writeReport: false, stdout: "progress only" });
  await assert.rejects(runCodexReview(f.parse(), { codexBin: silent }), /did not write a final message/);
  const broken = path.join(f.scratch, "broken-render-codex.mjs");
  writeFileSync(broken, "#!/usr/bin/env node\nprocess.stdout.write('not json');\n");
  chmodSync(broken, 0o755);
  let failure;
  await assert.rejects(runCodexReview(f.parse(), { codexBin: broken }), (error) => { failure = error; return /did not return a JSON prompt rendering/.test(error.message); });
  assert.equal(failureResult(failure).retryable, false);
});

test("transcript text never classifies a failure; only Codex's structured error events do", async (t) => {
  const f = await adapterFixture(t);
  const transcript = [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "cat README.md", aggregated_output: "ENOENT: quota exceeded, usage limit reached, authentication failed" } }),
  ].join("\n") + "\n";
  const noisy = fakeProvider(f.scratch, "noisy-codex.mjs", { exitCode: 1, stdout: transcript, stderr: "cat README.md\nENOENT: quota exceeded\n" });
  let failure;
  await assert.rejects(runCodexReview(f.parse(), { codexBin: noisy }), (error) => { failure = error; return true; });
  assert.match(failure.message, /codex exited with 1; no structured provider error was reported/);
  assert.equal(failure.providerError, "");
  assert.match(failure.transcript, /quota exceeded/);
  assert.equal(failureResult(failure).retryable, undefined, "a transient failure with quoted repository text stays retryable");

  const structured = fakeProvider(f.scratch, "unauthenticated-codex.mjs", { exitCode: 1,
    stdout: transcript + JSON.stringify({ type: "error", message: "authentication failed: not logged in" }) + "\n" });
  await assert.rejects(runCodexReview(f.parse(), { codexBin: structured }), (error) => { failure = error; return true; });
  assert.equal(failure.message, "codex exited with 1: authentication failed: not logged in");
  assert.equal(failure.providerError, "authentication failed: not logged in");
  assert.equal(failureResult(failure).retryable, false);

  const silent = fakeProvider(f.scratch, "silent-success-codex.mjs", { stdout: transcript, report: "" });
  await assert.rejects(runCodexReview(f.parse(), { codexBin: silent }), (error) => { failure = error; return true; });
  assert.match(failure.message, /no review output/);
  assert.equal(failure.providerError, "");

  const timeout = classifyFailure(Object.assign(new Error("codex timed out after 5 ms"), { timedOut: true, stderr: "ENOENT" }), Buffer.from(transcript));
  assert.equal(timeout.message, "codex timed out after 5 ms", "timeouts keep their message");
  assert.equal(timeout.providerError, "");
  const failedTurn = classifyFailure(new Error("codex exited with 1: noise"), Buffer.from(JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } }) + "\n"));
  assert.equal(failedTurn.providerError, "usage limit reached");
  assert.equal(failureResult(failedTurn).retryable, false);
});

test("rendered prompts are parsed into absolute skill paths, ambient skills, and instruction presence", () => {
  const text = [
    "### Skill roots", "- `r0` = `/home/u/.agents/skills`", "- `r1` = `/tmp/private/skills/.system`", "- `r2` = `/srv/repo/.codex/skills`",
    "### Available skills", "- user: U (file: r0/user/SKILL.md)", "- sys: S (file: r1/sys/SKILL.md)", "- deep: D (file: r2/a/b/c/deep/SKILL.md)", "- orphan: O (file: r9/orphan/SKILL.md)",
  ].join("\n");
  assert.deepEqual(listedSkills(text), ["/home/u/.agents/skills/user/SKILL.md", "/tmp/private/skills/.system/sys/SKILL.md", "/srv/repo/.codex/skills/a/b/c/deep/SKILL.md", "r9/orphan/SKILL.md"]);
  assert.deepEqual(ambientSkills(text, "/tmp/private"), ["/home/u/.agents/skills/user/SKILL.md", "/srv/repo/.codex/skills/a/b/c/deep/SKILL.md", "r9/orphan/SKILL.md"]);
  assert.equal(instructionsLoaded("# AGENTS.md instructions for /srv/repo\n<INSTRUCTIONS>x</INSTRUCTIONS>"), true);
  assert.equal(instructionsLoaded("no instructions here"), false);
  assert.deepEqual(isolationOverrides([]), ["-c", "project_doc_max_bytes=0"]);
  assert.deepEqual(isolationOverrides(["/b/SKILL.md", "/a/SKILL.md", "/a/SKILL.md"]), ["-c", "project_doc_max_bytes=0", "-c", 'skills.config=[{path="/a/SKILL.md",enabled=false},{path="/b/SKILL.md",enabled=false}]']);
});

test("isolation fails closed when Codex still lists ambient skills or instructions", async (t) => {
  const f = await adapterFixture(t);
  const stubborn = fakeProvider(f.scratch, "stubborn-codex.mjs", { ignoreSkillsConfig: true });
  let failure;
  await assert.rejects(runCodexReview(f.parse(), { codexBin: stubborn }), (error) => { failure = error; return true; });
  assert.match(failure.message, /Codex isolation incomplete: Codex still lists skills outside the private home/);
  assert.ok(failure.message.includes(f.codexSkill) && failure.message.includes(f.deepSkill), failure.message);
  assert.equal(failureResult(failure).retryable, false);
  const documented = fakeProvider(f.scratch, "documented-codex.mjs", { keepDocs: true });
  await assert.rejects(runCodexReview(f.parse(), { codexBin: documented }), /AGENTS\.md instructions still load/);
  assert.ok(!existsSync(f.capturePath), "the provider never started");
});

test("a selected home without file-based credentials is a permanent failure", async (t) => {
  const f = await adapterFixture(t);
  rmSync(path.join(f.sourceHome, "auth.json"));
  const fakeCodex = fakeProvider(f.scratch, "unreached-codex.mjs");
  let failure;
  await assert.rejects(runCodexReview(f.parse(), { codexBin: fakeCodex }), (error) => { failure = error; return true; });
  assert.match(failure.message, /the selected Codex home has no auth\.json/);
  assert.ok(!failure.message.includes(f.sourceHome), "the diagnostic names no home path");
  assert.ok(failure.providerError.includes(MISSING_CREDENTIALS));
  assert.equal(failureResult(failure).retryable, false);
});

test("under a launcher the shim passes inspection through and isolates only exec", async (t) => {
  const f = await adapterFixture(t);
  const fakeCodex = fakeProvider(f.scratch, "launched-codex.mjs");
  const inspection = path.join(f.scratch, "inspection.json");
  const fakeJig = path.join(f.scratch, "fake-jig.mjs");
  // Like Jig: inspect usage with the configured executable, then launch it with
  // CODEX_HOME set to the selected home and the forwarded arguments.
  writeFileSync(fakeJig, [
    "#!/usr/bin/env node",
    'import { spawnSync } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    "const argv = process.argv.slice(2);",
    "const forwarded = argv.slice(argv.indexOf('--') + 1);",
    `const env = { ...process.env, CODEX_HOME: ${JSON.stringify(f.sourceHome)}, FAKE_CODEX_CAPTURE: ${JSON.stringify(inspection)} };`,
    "spawnSync(process.env.JIG_CODEX_BIN, ['app-server'], { env, stdio: ['ignore', 'ignore', 'inherit'], input: undefined });",
    "const result = spawnSync(process.env.JIG_CODEX_BIN, forwarded, { env: { ...env, FAKE_CODEX_CAPTURE: process.env.FAKE_CODEX_CAPTURE }, stdio: 'inherit' });",
    "process.exit(result.status ?? 1);",
    "",
  ].join("\n"));
  chmodSync(fakeJig, 0o755);
  const report = await runCodexReview(f.parse(["--launcher", "auto"]), { codexBin: fakeCodex, jigBin: fakeJig });
  assert.equal(report, "No actionable findings from Codex.");
  const inspected = JSON.parse(readFileSync(inspection, "utf8"));
  assert.deepEqual(inspected.argv, ["app-server"]);
  assert.equal(inspected.home.path, f.sourceHome, "inspection keeps the selected home");
  const launched = f.captured();
  assert.deepEqual(launched.argv.slice(0, 2), ["exec", "--json"]);
  assert.notEqual(launched.home.path, f.sourceHome);
  assert.ok(launched.home.entries.includes("auth.json"));
  assert.ok(!launched.home.entries.includes("AGENTS.md"));
  assert.equal(launched.home.authLink, path.join(f.sourceHome, "auth.json"));
});

const codexCli = spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;
test("the installed Codex CLI renders no ambient instructions or skills after the adapter's isolation", { skip: codexCli ? false : "codex CLI not installed" }, async (t) => {
  const f = await adapterFixture(t);
  const privateHome = path.join(f.scratch, "private-home"); mkdirSync(privateHome, { mode: 0o700 });
  const context = { cwd: f.repo, privateHome, deadlineAt: Date.now() + 120_000, signal: null, environment: { ...process.env, HOME: f.userHome } };
  const markers = ["PROBE_REPO_AGENTS", "PROBE_REPO_SKILL", "PROBE_DEEP_SKILL", "PROBE_CODEX_SKILL", "PROBE_USER_SKILL"];
  const ambient = await renderPrompt("codex", { ...context, overrides: [] });
  const leaked = markers.filter((marker) => ambient.includes(marker));
  assert.ok(leaked.includes("PROBE_REPO_AGENTS") && leaked.includes("PROBE_REPO_SKILL") && leaked.includes("PROBE_USER_SKILL"), `baseline leaks: ${leaked.join(", ")}`);
  const overrides = await isolate("codex", context);
  const isolated = await renderPrompt("codex", { ...context, overrides });
  for (const marker of markers) assert.ok(!isolated.includes(marker), `${marker} leaked`);
  assert.deepEqual(ambientSkills(isolated, privateHome), []);
  assert.equal(instructionsLoaded(isolated), false);
  assert.ok(!ambient.includes("PROBE_HOME_AGENTS") && !ambient.includes("PROBE_HOME_SKILL"), "the private home never exposes the selected home's instructions or skills");
});
