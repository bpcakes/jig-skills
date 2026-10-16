import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkingTreeRun as createRun } from "./fixtures/working-tree-loop.mjs";
import { advance, runUntilBoundary, status, submit, TERMINAL } from "../skills/review-fix-loop/scripts/review-fix-loop.mjs";
import { commandEnvironment } from "../skills/review-fix-loop/scripts/job-runtime.mjs";
import { parseArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";
import { loadRun, resultFile } from "../skills/review-fix-loop/scripts/run-store.mjs";
import { resultSchema } from "../skills/review-fix-loop/scripts/assignment-schema.mjs";
import { failureResult, parseReport, reviewAssignment } from "../skills/review-fix-loop/scripts/provider-bridge.mjs";
import { validateContract } from "../skills/review-fix-loop/scripts/task-contract.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "jig-workflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(path.join(root, "value.txt"), "base\n");
  mkdirSync(path.join(root, ".agent")); writeFileSync(path.join(root, ".agent/receipts.jsonl"), '{"before":true}\n');
  git("add", "."); git("commit", "-qm", "base"); writeFileSync(path.join(root, "value.txt"), "updated\n");
  const contract = { goal: "Preserve updated value", nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: [],
    acceptanceCriteria: [{ id: "value", description: "Value is updated" }],
    requiredValidation: [{ id: "unit", argv: [process.execPath, "-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'updated\\n')"] }] };
  const start = async (config = {}, args = [], overrides = {}) => {
    const run = await createRun({ cwd: root, config, options: parseArgs(args), contract: { ...contract, ...overrides } });
    t.after(() => rmSync(path.dirname(run.workspaceRoot), { recursive: true, force: true }));
    return run;
  };
  return { root, start, contract };
}
const vote = a => ({ assignmentId: a.id, fingerprint: a.fingerprint, complete: true, findings: [],
  acceptance: [{ criterionId: "value", status: "satisfied", evidence: "Inspected source and pinned assertion", validationIds: ["unit"] }] });
async function finish(run) {
  for (let n = 0; n < 200; n++) {
    run = await runUntilBoundary(run.directory);
    if (TERMINAL.has(run.phase)) return run;
    for (const item of status(run).assignments.filter(p => p.native && !p.resultReceived)) {
      const a = JSON.parse(readFileSync(item.request)).assignment;
      await submit(run.directory, a.id, a.role === "review" ? vote(a) : { assignmentId: a.id, fingerprint: a.fingerprint,
        decisions: a.findings.map(f => ({ id: f.id, status: "fixed", evidence: "Verified required checks and source" })) });
    }
  }
  assert.fail("Did not finish");
}

test("native discovery issues both independent assignments and accepts reversed submissions after reload", async t => {
  const f = fixture(t); let run = await runUntilBoundary((await f.start()).directory);
  const items = status(run).assignments;
  assert.equal(items.length, 2); assert.equal(run.reports.length, 0);
  for (const item of items.reverse()) {
    run = loadRun(run.directory);
    const a = JSON.parse(readFileSync(item.request)).assignment;
    assert.equal(a.reports, undefined); assert.equal(a.findings, undefined);
    await submit(run.directory, item.id, vote(a));
  }
  run = await finish(run);
  assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome));
  assert.equal(run.reports.length, 2); assert.equal(run.attempts.length, 2);
});

test("malformed native submissions remain correctable without consuming a provider attempt", async t => {
  const f = fixture(t), run = await runUntilBoundary((await f.start()).directory);
  const a = run.pending.assignment;
  await assert.rejects(submit(run.directory, a.id, { ...vote(a), findings: "invalid" }), /Malformed review/);
  assert.equal(existsSync(resultFile(run, a.id)), false);
  await submit(run.directory, a.id, vote(a));
  const done = await finish(run);
  assert.equal(done.phase, "CONVERGED"); assert.equal(done.attempts.length, 2);
});

test("source drift stops a concurrent wave without accepting sibling results or starting repairs", async t => {
  const f = fixture(t), run = await runUntilBoundary((await f.start()).directory);
  await submit(run.directory, run.pending.id, vote(run.pending.assignment));
  writeFileSync(path.join(f.root, "value.txt"), "concurrent writer\n");
  const stopped = await advance(run.directory);
  assert.equal(stopped.phase, "SCOPE_CHANGED"); assert.equal(stopped.reports.length, 0);
  assert.equal(stopped.pending, null); assert.deepEqual(stopped.reviewQueue, {});
  assert.equal(readFileSync(path.join(f.root, "value.txt"), "utf8"), "concurrent writer\n");
});

test("prerequisites and required checks use the same explicitly inherited worker environment", async t => {
  const f = fixture(t), name = "JIG_TEST_VALIDATION_ENV";
  const previous = process.env[name]; process.env[name] = "synthetic";
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  const argv = [process.execPath, "-e", `require('node:assert/strict').equal(process.env.${name},'synthetic')`];
  const contract = { prerequisites: [{ id: "preflight", argv, requiredEnvironment: [name] }], requiredValidation: [{ id: "unit", argv, requiredEnvironment: [name] }] };
  await assert.rejects(f.start({}, [], contract), /Required validation environment missing in the worker/);
  const run = await runUntilBoundary((await f.start({ environmentFrom: { validate: [name] } }, [], contract)).directory);
  assert.equal(run.phase, "REVIEW"); assert.equal(run.validation.length, 1);
  assert.equal(run.validation[0].purpose, "prerequisite"); assert.equal(run.validation[0].outcome, "succeeded");
  const done = await finish(run);
  assert.equal(done.phase, "CONVERGED"); assert.equal(done.validation.length, 2);
});

test("failed prerequisites stop before any provider executes", async t => {
  const f = fixture(t), run = await runUntilBoundary((await f.start({}, [], {
    prerequisites: [{ id: "service", argv: [process.execPath, "-e", "process.exit(9)"] }],
  })).directory);
  assert.equal(run.phase, "VALIDATION_FAILED"); assert.equal(run.outcome.code, "PREREQUISITE_FAILED");
  assert.equal(run.attempts.length, 0); assert.equal(run.validation[0].exitCode, 9);
});

for (const provider of ["claude", "cursor"]) test(`${provider} bridge preserves scope/options and parses the published wire contract`, async () => {
  const a = { id: "001-review", role: "review", provider, repository: "/repo", fingerprint: "pinned", providerOptions: { model: "test", effort: "high", speed: "fast", fileAccess: "restricted" },
    scope: { scope: "branch", baseOid: "base", includeWorkingTree: true, explicitExcludePaths: ["private"] },
    contract: { acceptanceCriteria: [{ id: "value" }], requiredValidation: [{ id: "unit" }] } };
  a.resultSchema = resultSchema(a);
  const result = await reviewAssignment(a, { runner: async (options, dependencies) => {
    assert.equal(options.cwd, a.repository); assert.equal(options.expectedFingerprint, a.fingerprint);
    assert.equal(options.effort, "high"); assert.equal(options.fileAccess, "restricted"); assert.equal(options.includeWorkingTree, true);
    assert.deepEqual(options.excludePaths, ["private"]); assert.ok(dependencies.promptSuffix.includes('"resultSchema"'));
    // Without a recorded receipt, reviewers must still name the checks for every criterion.
    assert.match(dependencies.promptSuffix, /acceptance entry for each criterion \("value"\)[^\n]*naming the required checks \("unit"\)[^\n]*even when no receipt has been recorded yet\. Example entry: \{"criterionId":"value","status":"uncertain","evidence":"\.\.\.","validationIds":\["unit"\]\}\n$/);
    return dependencies.parseReport(JSON.stringify(vote(a)));
  } });
  assert.deepEqual(result, vote(a));
  assert.throws(() => parseReport(a, JSON.stringify({ ...vote(a), fingerprint: "wrong" })), /Malformed/);
  // Report formatting failures stay retryable even when the report text quotes a permanent-failure phrase.
  for (const report of ["ENOENT: no such file quota exceeded", "unexpected status 401 Unauthorized: Incorrect API key provided: [redacted]", JSON.stringify({ ...vote(a), fingerprint: "wrong authentication failed" })]) {
    let failure;
    assert.throws(() => parseReport(a, report), (error) => { failure = error; return true; });
    assert.equal(failure.providerError, "");
    assert.equal(failureResult(failure).retryable, undefined, report);
  }
});

test("bridge marks only recognized permanent errors non-retryable", () => {
  for (const error of ["authentication failed", "quota exceeded", "usage limit reached",
    "jig exited with 1: No eligible Claude home with fresh subscription headroom; inspect `jig claude homes --usage` or pass HOME explicitly",
    "jig exited with 2: error: unexpected argument '--auto' found"]) assert.equal(failureResult(new Error(error)).retryable, false);
  for (const provider of ["Claude", "Codex"]) {
    for (const diagnostic of [`No ${provider} homes found under the configured search roots`,
      `${provider} home 'missing' was not found at /tmp/missing`]) {
      assert.equal(failureResult(new Error(`jig exited with 1: ${diagnostic}`)).retryable, false, diagnostic);
      assert.equal(failureResult(Object.assign(new Error(diagnostic), { providerError: "", transcript: diagnostic })).retryable, undefined,
        "quoted missing-home errors must not disable a provider that has already started");
    }
  }
  // An adapter that separates the provider's error channel from transcript text decides through providerError.
  assert.equal(failureResult(Object.assign(new Error("codex exited with 1; no structured provider error was reported"), { providerError: "", transcript: "ENOENT quota exceeded" })).retryable, undefined);
  assert.equal(failureResult(Object.assign(new Error("codex exited with 1: usage limit reached"), { providerError: "usage limit reached" })).retryable, false);
  for (const providerError of ["unexpected status 401 Unauthorized", "Incorrect API key provided: [redacted]"]) {
    assert.equal(failureResult(Object.assign(new Error("codex exited with 1"), { providerError })).retryable, false);
  }
  for (const providerError of ["unexpected status 429 Too Many Requests", "unexpected status 503 Service Unavailable"]) {
    assert.equal(failureResult(Object.assign(new Error("codex exited with 1"), { providerError })).retryable, undefined);
  }
  assert.equal(failureResult(new Error("temporary capacity exceeded")).retryable, undefined);
  assert.equal(failureResult(Object.assign(new Error("timed out"), { timedOut: true })).execution, "uncertain");
});

test("codex bridge forwards launcher and model controls but not the controller's runtime decision", async () => {
  const a = { id: "001-review", role: "review", provider: "codex", repository: "/repo", fingerprint: "pinned",
    providerOptions: { model: "gpt-5-codex", effort: "high", runtime: "cli", launcher: "auto" },
    scope: { scope: "working-tree", includeWorkingTree: false },
    contract: { acceptanceCriteria: [{ id: "value" }], requiredValidation: [{ id: "unit" }] } };
  a.resultSchema = resultSchema(a);
  const result = await reviewAssignment(a, { runner: async (options, dependencies) => {
    assert.equal(options.model, "gpt-5-codex"); assert.equal(options.effort, "high"); assert.equal(options.launcher, "auto");
    assert.equal(Object.hasOwn(options, "runtime"), false); assert.ok(dependencies.promptSuffix.includes('"resultSchema"'));
    return dependencies.parseReport(JSON.stringify(vote(a)));
  } });
  assert.deepEqual(result, vote(a));
  await assert.rejects(reviewAssignment({ ...a, provider: "gemini" }), /Claude, Codex, or Cursor/);
});

test("launcher-selected bundled bridges preflight the Jig executable instead of the provider CLI", async t => {
  const f = fixture(t);
  const previous = process.env.JIG_LAUNCHER_BIN;
  t.after(() => { if (previous == null) delete process.env.JIG_LAUNCHER_BIN; else process.env.JIG_LAUNCHER_BIN = previous; });
  const args = ["--reviewers", "claude,codex", "--claude-launcher", "auto", "--codex-launcher", "auto"];
  process.env.JIG_LAUNCHER_BIN = "/missing/jig-launcher";
  let run = await f.start({}, args);
  run = await advance(run.directory); run = await advance(run.directory);
  assert.equal(run.phase, "REVIEW_INCOMPLETE", JSON.stringify(run.outcome));
  assert.match(JSON.stringify(run.outcome), /claude, codex/);
  assert.ok(run.capabilities.every(p => p.bundled && p.available === false));
  // With a launcher present, Codex still needs its own executable because the adapter renders with it directly.
  const previousPath = process.env.PATH;
  t.after(() => { process.env.PATH = previousPath; });
  const bin = path.join(f.root, ".git", "bin"); mkdirSync(bin, { recursive: true });
  process.env.JIG_LAUNCHER_BIN = process.execPath;
  // Keep git and node reachable; drop only directories that provide a codex executable.
  process.env.PATH = [bin, ...(previousPath ?? "").split(path.delimiter).filter(dir => dir && !existsSync(path.join(dir, "codex")))].join(path.delimiter);
  run = await f.start({}, args);
  run = await advance(run.directory); run = await advance(run.directory);
  assert.equal(run.phase, "REVIEW_INCOMPLETE", JSON.stringify(run.outcome));
  assert.deepEqual(run.capabilities.map(p => [p.id, p.available]), [["claude", true], ["codex", false]]);
  writeFileSync(path.join(bin, "codex"), "#!/bin/sh\nexit 0\n"); chmodSync(path.join(bin, "codex"), 0o755);
  run = await f.start({}, args);
  run = await advance(run.directory); run = await advance(run.directory);
  assert.equal(run.phase, "REVIEW", JSON.stringify(run.outcome));
  assert.deepEqual(run.capabilities.map(p => [p.id, p.bundled, p.available]), [["claude", true, true], ["codex", true, true]]);
  await assert.rejects(f.start({ reviewers: [{ id: "claude", runtime: "cli" }] }, ["--reviewers", "claude"]), /runtime applies only to the codex reviewer/);
  await assert.rejects(f.start({ reviewers: [{ id: "codex", runtime: "subagent" }] }, ["--reviewers", "codex"]), /must be native or cli/);
  // The configured entry and the loop options resolve to one effective runtime before dispatch.
  await assert.rejects(f.start({ reviewers: [{ id: "codex", runtime: "native" }] }, ["--reviewers", "codex", "--codex-launcher", "auto"]), /requires the cli runtime, but the codex reviewer entry selects runtime native/);
  await assert.rejects(f.start({ reviewers: [{ id: "codex", runtime: "cli" }] }, ["--reviewers", "codex", "--codex-effort", "ultra"]), /not valid for the cli Codex runtime/);
  // A native entry overriding --codex-runtime cli must not admit a CLI-only effort.
  await assert.rejects(f.start({ reviewers: [{ id: "codex", runtime: "native" }] }, ["--reviewers", "codex", "--codex-runtime", "cli", "--codex-effort", "minimal"]), /not valid for the native Codex runtime/);
});

test("review workers inherit every credential their provider CLI honors and nothing else", () => {
  const inherited = { PATH: "/usr/bin", HOME: "/home/u", SECRET_TOKEN: "no", CODEX_API_KEY: "ck", CODEX_ACCESS_TOKEN: "ct", OPENAI_API_KEY: "ok", CODEX_HOME: "/home/u/.codex-work",
    ANTHROPIC_API_KEY: "ak", ANTHROPIC_AUTH_TOKEN: "at", CLAUDE_CODE_OAUTH_TOKEN: "ot", CLAUDE_CONFIG_DIR: "/home/u/.claude-work", CURSOR_API_KEY: "cu", JIG_LAUNCHER_BIN: "/opt/jig" };
  const codex = commandEnvironment({ role: "review", assignment: { provider: "codex" } }, inherited);
  for (const name of ["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY", "CODEX_HOME", "JIG_LAUNCHER_BIN", "PATH", "HOME"]) assert.equal(codex[name], inherited[name], name);
  for (const name of ["SECRET_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CURSOR_API_KEY"]) assert.equal(codex[name], undefined, name);
  const claude = commandEnvironment({ role: "review", assignment: { provider: "claude" } }, inherited);
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "JIG_LAUNCHER_BIN"]) assert.equal(claude[name], inherited[name], name);
  assert.equal(claude.CODEX_API_KEY, undefined);
  assert.equal(commandEnvironment({ role: "validate", assignment: {} }, inherited).CODEX_API_KEY, undefined, "validation never receives provider credentials");
});

test("the CLI Codex runtime without a launcher preflights only the codex executable", async t => {
  const f = fixture(t);
  const previousPath = process.env.PATH;
  t.after(() => { process.env.PATH = previousPath; });
  const bin = path.join(f.root, ".git", "bin"); mkdirSync(bin, { recursive: true });
  process.env.PATH = [bin, ...(previousPath ?? "").split(path.delimiter).filter(dir => dir && !existsSync(path.join(dir, "codex")))].join(path.delimiter);
  const cli = ["--reviewers", "codex", "--codex-runtime", "cli"];
  let run = await f.start({}, cli);
  run = await advance(run.directory); run = await advance(run.directory);
  assert.equal(run.phase, "REVIEW_INCOMPLETE", JSON.stringify(run.outcome));
  assert.deepEqual(run.capabilities.map(p => [p.id, p.bundled, p.available]), [["codex", true, false]]);
  writeFileSync(path.join(bin, "codex"), "#!/bin/sh\nexit 0\n"); chmodSync(path.join(bin, "codex"), 0o755);
  run = await f.start({}, cli);
  run = await advance(run.directory); run = await advance(run.directory);
  assert.equal(run.phase, "REVIEW", JSON.stringify(run.outcome));
  assert.deepEqual(run.capabilities.map(p => [p.id, p.bundled, p.available]), [["codex", true, true]]);
});

for (const [provider, executable, launcher] of [
  ["codex", "codex", false], ["codex", "codex", true],
  ["claude", "claude", false], ["cursor", "cursor-agent", false],
]) test(`${provider}${launcher ? " with Jig" : ""} preflight honors only forwarded executable overrides`, async t => {
  const f = fixture(t), variable = `JIG_${provider.toUpperCase()}_BIN`;
  const previous = { PATH: process.env.PATH, [variable]: process.env[variable], JIG_LAUNCHER_BIN: process.env.JIG_LAUNCHER_BIN };
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const bin = path.join(f.root, ".git", "bin"); mkdirSync(bin, { recursive: true });
  process.env.PATH = [bin, ...(previous.PATH ?? "").split(path.delimiter).filter(dir => dir && !existsSync(path.join(dir, executable)))].join(path.delimiter);
  process.env[variable] = process.execPath;
  if (launcher) process.env.JIG_LAUNCHER_BIN = process.execPath;
  const args = ["--reviewers", provider, ...(provider === "codex" ? ["--codex-runtime", "cli"] : []),
    ...(launcher ? ["--codex-launcher", "auto"] : [])];
  const config = { environmentFrom: { review: [variable] } };
  const preflight = async (fixture, config) => {
    let run = await fixture.start(config, args);
    run = await advance(run.directory); run = await advance(run.directory);
    assert.equal(run.attempts.length, 0, "capability checks must not invoke a provider");
    return run;
  };

  // An absolute override is sufficient even when the default executable is absent.
  let run = await preflight(f, config);
  assert.equal(run.phase, "REVIEW", JSON.stringify(run.outcome));
  assert.deepEqual(run.capabilities.map(p => [p.id, p.available]), [[provider, true]]);

  // A default on PATH must not hide a broken override that the adapter will use.
  writeFileSync(path.join(bin, executable), "#!/bin/sh\nexit 0\n"); chmodSync(path.join(bin, executable), 0o755);
  process.env[variable] = path.join(bin, "missing-provider");
  run = await preflight(fixture(t), config);
  assert.equal(run.phase, "REVIEW_INCOMPLETE", JSON.stringify(run.outcome));
  assert.deepEqual(run.capabilities.map(p => [p.id, p.available]), [[provider, false]]);

  // Ambient overrides omitted from the worker allowlist must not affect preflight.
  run = await preflight(fixture(t), {});
  assert.equal(run.phase, "REVIEW", JSON.stringify(run.outcome));
  assert.deepEqual(run.capabilities.map(p => [p.id, p.available]), [[provider, true]]);
});

test("the configured codex runtime is resolved once and travels with the capability", async t => {
  const configured = await fixture(t).start({ reviewers: [{ id: "codex", runtime: "cli" }] }, ["--reviewers", "codex"]);
  assert.deepEqual(configured.config.reviewers.map(p => [p.id, p.runtime, p.bundled]), [["codex", "cli", true]]);
  const native = await fixture(t).start({ reviewers: [{ id: "codex" }] }, ["--reviewers", "codex", "--codex-effort", "ultra"]);
  assert.deepEqual(native.config.reviewers.map(p => [p.id, p.runtime, p.bundled]), [["codex", "native", undefined]]);
  // A configured CLI entry accepts a CLI-only effort even without --codex-runtime on the command line.
  const minimal = await fixture(t).start({ reviewers: [{ id: "codex", runtime: "cli" }] }, ["--reviewers", "codex", "--codex-effort", "minimal"]);
  assert.deepEqual(minimal.config.reviewers.map(p => [p.id, p.runtime]), [["codex", "cli"]]);
  assert.equal(minimal.options.review.codex.effort, "minimal");
});

test("a Claude Code host dispatches every reviewer through a bundled bridge", async t => {
  const balanced = await fixture(t).start({}, ["--host", "claude"]);
  assert.deepEqual(balanced.config.reviewers.map(p => [p.id, p.runtime, p.bundled]), [["claude", undefined, true]]);
  const strict = await fixture(t).start({}, ["--host", "claude", "--review-policy", "strict"]);
  assert.deepEqual(strict.config.reviewers.map(p => [p.id, p.runtime, p.bundled]), [["claude", undefined, true], ["codex", "cli", true]]);
  const configured = await fixture(t).start({ reviewers: [{ id: "codex" }] }, ["--host", "claude", "--reviewers", "codex"]);
  assert.deepEqual(configured.config.reviewers.map(p => [p.id, p.runtime, p.bundled]), [["codex", "cli", true]]);
  // A native entry would hand the review to a Claude subagent labeled as Codex.
  await assert.rejects(fixture(t).start({ reviewers: [{ id: "codex", runtime: "native" }] }, ["--host", "claude", "--reviewers", "codex"]), /Claude Code has no native Codex subagent/);
  // A custom command does not make a native runtime valid on this host.
  await assert.rejects(fixture(t).start({ reviewers: [{ id: "codex", runtime: "native", command: [process.execPath, "provider.mjs"] }] }, ["--host", "claude", "--reviewers", "codex"]), /Claude Code has no native Codex subagent/);
  const custom = await fixture(t).start({ reviewers: [{ id: "codex", runtime: "cli", command: [process.execPath, "provider.mjs"] }] }, ["--host", "claude", "--reviewers", "codex"]);
  assert.deepEqual(custom.config.reviewers.map(p => [p.id, p.runtime, p.bundled]), [["codex", "cli", undefined]]);
});

test("evidence declarations reject broad paths and policy files", () => {
  const base = { goal: "test", nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: [], acceptanceCriteria: [{ id: "v", description: "v" }], requiredValidation: [{ id: "v", argv: ["true"] }] };
  for (const file of [".agent/*", ".agent/jig-contract.json", ".agent/jig-contract.jsonl", "../receipts.jsonl", "AGENTS.jsonl"]) {
    assert.throws(() => validateContract({ ...base, evidenceOutputs: [{ path: file, format: "jsonl" }] }));
  }
});

function externalReviewer(f, { overlap = false, permanentFailure = false } = {}) {
  const file = path.join(f.root, ".git", "provider.mjs");
  writeFileSync(file, `import fs from 'node:fs';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const a=JSON.parse(input); const dir=${JSON.stringify(path.join(f.root, ".git"))};
fs.writeFileSync(dir+'/'+a.id+'.started',a.provider);
${overlap ? `let both=false; for(let n=0;n<500;n++){if(fs.readdirSync(dir).filter(p=>p.endsWith('.started')).length>=2){both=true;break;}await new Promise(r=>setTimeout(r,10));}if(!both)throw new Error('Sibling did not start');` : ""}
process.stdout.write(JSON.stringify(${permanentFailure ? "{error:'authentication failed',retryable:false}" : "{assignmentId:a.id,fingerprint:a.fingerprint,complete:true,findings:[],acceptance:[{criterionId:'value',status:'satisfied',evidence:'Inspected',validationIds:['unit']}]}"}));`);
  return [process.execPath, file];
}

test("external discovery jobs overlap and explicit three-provider coverage is required", async t => {
  const f = fixture(t), command = externalReviewer(f, { overlap: true });
  const run = await finish(await f.start({ reviewers: ["claude", "codex", "cursor"].map(id => ({ id, command })) }, ["--all-reviewers"]));
  assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome));
  assert.deepEqual(status(run).providerCoverage.completed.sort(), ["claude", "codex", "cursor"]);
  assert.equal(run.attempts.length, 3); assert.equal(run.reports.length, 3);
});

test("a known permanent provider failure is retained and never repeatedly dispatched", async t => {
  const f = fixture(t), command = externalReviewer(f, { permanentFailure: true });
  const run = await runUntilBoundary((await f.start({ reviewers: [{ id: "claude", command }], reviewConcurrency: 1 }, ["--reviewers", "claude"])).directory);
  assert.equal(run.phase, "REVIEW_INCOMPLETE", JSON.stringify(run.outcome));
  assert.equal(run.attempts.length, 1); assert.ok(run.providerFailures.claude);
  assert.deepEqual(status(run).providerCoverage.completed, []);
});

test("Codex incorrect API key errors stop controller retries after one attempt", async t => {
  const f = fixture(t), file = path.join(f.root, ".git", "invalid-key-provider.mjs");
  writeFileSync(file, `import { classifyFailure } from ${JSON.stringify(import.meta.resolve("../skills/panel-review/scripts/codex-review.mjs"))};
import { failureResult } from ${JSON.stringify(import.meta.resolve("../skills/review-fix-loop/scripts/provider-bridge.mjs"))};
for await (const chunk of process.stdin) {}
const event = { type: "turn.failed", error: { message: "unexpected status 401 Unauthorized: Incorrect API key provided: [redacted]" } };
const error = classifyFailure(new Error("codex exited with 1"), Buffer.from(JSON.stringify(event) + "\\n"));
process.stdout.write(JSON.stringify(failureResult(error)) + "\\n");`);
  const run = await runUntilBoundary((await f.start({
    reviewers: [{ id: "codex", command: [process.execPath, file] }], reviewConcurrency: 1,
  }, ["--reviewers", "codex"])).directory);
  assert.equal(run.phase, "REVIEW_INCOMPLETE", JSON.stringify(run.outcome));
  assert.equal(run.attempts.length, 1);
  assert.match(run.providerFailures.codex.error, /401 Unauthorized: Incorrect API key provided/);
  assert.deepEqual(status(run).providerCoverage.completed, []);
});

for (const mutation of ["append", "overwrite", "delete", "chmod", "undeclared", "policy"]) test(`repair evidence output ${mutation} preserves the declared boundary`, async t => {
  const f = fixture(t);
  const run = await f.start({ reviewConcurrency: 1 }, ["--exclude-path", ".agent"],
    { evidenceOutputs: [{ path: ".agent/receipts.jsonl", format: "jsonl" }] });
  let current = run;
  for (;;) {
    current = await runUntilBoundary(current.directory);
    assert.ok(!TERMINAL.has(current.phase), JSON.stringify(current.outcome));
    const a = current.pending.assignment;
    if (a.role === "review") await submit(current.directory, a.id, { ...vote(a), findings: [{ key: "value", path: "value.txt", title: "Regression", severity: "medium", evidence: "Need a source repair" }] });
    else if (a.role === "triage") await submit(current.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint,
      decisions: a.findings.map(f => ({ id: f.id, status: "actionable", evidence: "Source repair required" })) });
    else {
      writeFileSync(path.join(f.root, "value.txt"), "fixed\n");
      if (mutation === "append") appendFileSync(path.join(f.root, ".agent/receipts.jsonl"), '{"check":"synthetic"}\n');
      if (mutation === "overwrite") writeFileSync(path.join(f.root, ".agent/receipts.jsonl"), '{"replacement":true}\n');
      if (mutation === "delete") rmSync(path.join(f.root, ".agent/receipts.jsonl"));
      if (mutation === "chmod") chmodSync(path.join(f.root, ".agent/receipts.jsonl"), 0o755);
      if (mutation === "undeclared") writeFileSync(path.join(f.root, ".agent/other.jsonl"), '{"check":true}\n');
      if (mutation === "policy") writeFileSync(path.join(f.root, ".agent/jig-contract.json"), '{"changed":true}\n');
      await submit(current.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint,
        workspaceEdits: [{ path: "value.txt", reason: "Causal repair", findingIds: a.findings.map(f => f.id) }] });
      current = await advance(current.directory);
      if (mutation === "append") {
        assert.equal(current.phase, "VALIDATE", JSON.stringify(current.outcome));
        assert.ok(current.sourceReconciliations[0].paths.includes(".agent/receipts.jsonl"));
        assert.equal(current.validation.length, 0, "a claimed receipt is not a controller result");
      } else {
        assert.equal(current.phase, "BLOCKED", JSON.stringify(current.outcome));
        assert.match(current.outcome.reason, /Evidence output|excluded path/);
      }
      assert.equal(readFileSync(path.join(f.root, "value.txt"), "utf8"), "fixed\n");
      break;
    }
  }
});

for (const provider of ["claude", "cursor"]) test(`${provider} bundled bridge executes a local CLI with the pinned fingerprint and structured result`, async t => {
  const f = fixture(t), run = await runUntilBoundary((await f.start()).directory);
  const a = { ...run.pending.assignment, provider, providerOptions: provider === "claude"
    ? { model: "opus", effort: "high", fileAccess: "restricted", configDir: null }
    : { effort: "high", speed: "standard" } };
  a.resultSchema = resultSchema(a);
  const executable = path.join(f.root, ".git", "fake-cli.mjs");
  writeFileSync(executable, `#!${process.execPath}
import fs from 'node:fs';
let prompt='';
if(${JSON.stringify(provider)}==='claude'){ for await(const chunk of process.stdin) prompt+=chunk; }
else {const arg=process.argv.at(-1);const file=arg.match(/from (.+)\\. Follow/)[1];prompt=fs.readFileSync(file,'utf8');}
const assignment=JSON.parse(prompt.split('\\n').findLast(line=>line.startsWith('{')));
if(!assignment.instructions.includes('read-only')) throw new Error('Role omitted');
const report=JSON.stringify({assignmentId:assignment.id,fingerprint:assignment.fingerprint,complete:true,findings:[],acceptance:[{criterionId:'value',status:'satisfied',evidence:'Checked source',validationIds:['unit']}]});
process.stdout.write(${JSON.stringify(provider)}==='claude'?JSON.stringify({type:'result',result:report,is_error:false}):report);
`);
  chmodSync(executable, 0o755);
  const result = await reviewAssignment(a, provider === "claude" ? { claudeBin: executable } : { cursorBin: executable });
  assert.equal(result.assignmentId, a.id); assert.equal(result.fingerprint, a.fingerprint); assert.equal(result.complete, true);
  // Settle the controller's actual assignments independently of the bridge probe.
  assert.equal((await finish(run)).phase, "CONVERGED");
});

test("interruption preparing the second review preserves both durable assignments without duplicate attempts", async t => {
  const f = fixture(t); let run = await f.start();
  run = await advance(run.directory); run = await advance(run.directory); assert.equal(run.phase, "REVIEW");
  const hook = path.join(f.root, ".git", "interrupt.mjs");
  writeFileSync(hook, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const rename=fs.renameSync;fs.renameSync=function(from,to){const result=rename.call(this,from,to);if(String(to).endsWith('/00002-review/request.json'))process.kill(process.pid,'SIGKILL');return result;};syncBuiltinESMExports();`);
  const cli = new URL("../skills/review-fix-loop/scripts/review-fix-loop.mjs", import.meta.url);
  assert.throws(() => execFileSync(process.execPath, ["--import", hook, cli.pathname, "advance", "--run", run.directory], { stdio: "pipe", timeout: 20000 }), error => error.signal === "SIGKILL");
  run = await runUntilBoundary(run.directory);
  assert.equal(status(run).assignments.length, 2); assert.equal(run.attempts.length, 2);
  assert.equal(run.pending.preparing, undefined);
  const done = await finish(run);
  assert.equal(done.phase, "CONVERGED"); assert.equal(done.attempts.length, 2);
});

test("source drift cancels every external sibling and preserves results before releasing the mutation barrier", async t => {
  const f = fixture(t), provider = path.join(f.root, ".git", "waiting-provider.mjs");
  writeFileSync(provider, `import fs from 'node:fs';let input='';for await(const chunk of process.stdin)input+=chunk;const a=JSON.parse(input);const prefix=${JSON.stringify(path.join(f.root, ".git"))}+'/'+a.id;fs.writeFileSync(prefix+'.started','yes');while(!fs.existsSync(prefix+'.finish'))await new Promise(r=>setTimeout(r,20));process.stdout.write(JSON.stringify({assignmentId:a.id,fingerprint:a.fingerprint,complete:true,findings:[],acceptance:[{criterionId:'value',status:'satisfied',evidence:'Checked',validationIds:['unit']}]}));`);
  let run = await f.start({ reviewers: [{ id: "codex", command: [process.execPath, provider] }] });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    run = await advance(run.directory);
    if (run.attempts.length === 2 && run.attempts.every(a => existsSync(path.join(f.root, ".git", a.id + ".started")))) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(run.attempts.length, 2); assert.ok(run.attempts.every(a => existsSync(path.join(f.root, ".git", a.id + ".started"))));
  writeFileSync(path.join(f.root, "value.txt"), "concurrent\n");
  writeFileSync(path.join(f.root, ".git", run.pending.id + ".finish"), "finish");
  run = await runUntilBoundary(run.directory);
  assert.equal(run.phase, "SCOPE_CHANGED", JSON.stringify(run.outcome));
  assert.equal(status(run).waiting, false); assert.equal(run.cleanup.length, 0); assert.equal(run.reports.length, 0);
  assert.ok(run.attempts.every(a => existsSync(resultFile(run, a.id))));
  assert.equal(readFileSync(path.join(f.root, "value.txt"), "utf8"), "concurrent\n");
});


test("an explicitly selected unavailable provider fails before any review invocation", async t => {
  const f = fixture(t);
  const run = await runUntilBoundary((await f.start({ reviewers: [{ id: "codex" }, { id: "claude", command: ["/missing/jig-test-provider"] }] }, ["--reviewers", "claude,codex"])).directory);
  assert.equal(run.phase, "REVIEW_INCOMPLETE"); assert.equal(run.attempts.length, 0);
  assert.deepEqual(run.outcome.unavailable, ["claude"]);
  assert.deepEqual(status(run).providerCoverage.completed, []);
});

test("a completed sibling frees a concurrency slot before the first reviewer finishes", async t => {
  const f = fixture(t), provider = path.join(f.root, ".git", "ordered-provider.mjs");
  writeFileSync(provider, `import fs from 'node:fs';let input='';for await(const chunk of process.stdin)input+=chunk;const a=JSON.parse(input);const dir=${JSON.stringify(path.join(f.root, ".git"))};fs.writeFileSync(dir+'/'+a.provider+'.started','yes');if(a.provider==='claude'){for(let n=0;!fs.existsSync(dir+'/cursor.started');n++){if(n>1000)throw new Error('Third reviewer waited for the first');await new Promise(r=>setTimeout(r,10));}}process.stdout.write(JSON.stringify({assignmentId:a.id,fingerprint:a.fingerprint,complete:true,findings:[],acceptance:[{criterionId:'value',status:'satisfied',evidence:'Checked',validationIds:['unit']}]}));`);
  const run = await finish(await f.start({ reviewers: ["claude", "codex", "cursor"].map(id => ({ id, command: [process.execPath, provider] })) }, ["--all-reviewers"]));
  assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome));
  assert.equal(run.reports[0].provider, "codex");
  assert.equal(run.attempts.length, 3);
});

test("missing environment for an optional check records failure without blocking required acceptance", async t => {
  const f = fixture(t);
  const run = await finish(await f.start({}, [], { requiredValidation: [...f.contract.requiredValidation,
    { id: "optional", optional: true, argv: [process.execPath, "-e", "throw new Error('must not execute')"], requiredEnvironment: ["JIG_TEST_ABSENT_ENV"] }] }));
  assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome));
  const optional = run.validation.filter(v => v.checkId === "optional");
  assert.ok(optional.length); assert.ok(optional.every(v => v.execution === "not_started" && v.error.includes("JIG_TEST_ABSENT_ENV")));
});

test("a repair with an unknown finding is rejected before freezing and can be corrected in place", async t => {
  const f = fixture(t); let run = await f.start({ reviewConcurrency: 1 });
  for (;;) {
    run = await runUntilBoundary(run.directory);
    const a = run.pending.assignment;
    if (a.role === "review") await submit(run.directory, a.id, { ...vote(a), findings: [{ key: "v", path: "value.txt", severity: "medium", title: "Repair", evidence: "Source correction needed" }] });
    else if (a.role === "triage") await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint,
      decisions: a.findings.map(f => ({ id: f.id, status: "actionable", evidence: "Verified the source" })) });
    else {
      writeFileSync(path.join(f.root, "value.txt"), "corrected\n");
      const result = { assignmentId: a.id, fingerprint: a.fingerprint,
        workspaceEdits: [{ path: "value.txt", reason: "Repair the original defect", findingIds: ["invented"] }] };
      await assert.rejects(submit(run.directory, a.id, result), /Malformed repair/);
      assert.equal(existsSync(resultFile(run, a.id)), false);
      assert.equal(loadRun(run.directory).pending.id, a.id);
      assert.equal(readFileSync(path.join(f.root, "value.txt"), "utf8"), "corrected\n");
      result.workspaceEdits[0].findingIds = a.findings.map(f => f.id);
      await submit(run.directory, a.id, result);
      const next = await advance(run.directory);
      assert.equal(next.phase, "VALIDATE", JSON.stringify(next.outcome));
      assert.equal(next.assignmentAttempts.filter(a => a.role === "repair").length, 1);
      break;
    }
  }
});

test("a permanent triage failure also stops without repeating the assignment", async t => {
  const f = fixture(t); let run = await runUntilBoundary((await f.start()).directory);
  for (const item of status(run).assignments) {
    const a = JSON.parse(readFileSync(item.request)).assignment;
    await submit(run.directory, item.id, vote(a));
  }
  run = await runUntilBoundary(run.directory); assert.equal(run.pending.role, "triage");
  await submit(run.directory, run.pending.id, { error: "authentication failed", retryable: false });
  run = await runUntilBoundary(run.directory);
  assert.equal(run.phase, "BLOCKED"); assert.equal(run.assignmentAttempts.length, 1);
});
