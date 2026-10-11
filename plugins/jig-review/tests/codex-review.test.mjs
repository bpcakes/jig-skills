import { readBrief, reviewGuidance } from "../skills/comprehensive-review/scripts/review-brief.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCodexArgs,
  classifyFailure,
  parseArgs,
  parseCodexResult,
  runCodexReview,
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

// A stand-in for codex (or for jig forwarding to codex): records argv, prompt, and
// environment, then writes the report to the --output-last-message path.
function fakeProvider(directory, name, { exitCode = 0, stderr = "", stdout = "", report = "No actionable findings from Codex." } = {}) {
  const file = path.join(directory, name);
  writeFileSync(file, [
    "#!/usr/bin/env node",
    'import { writeFileSync } from "node:fs";',
    "let prompt = '';",
    "for await (const chunk of process.stdin) prompt += chunk;",
    "const argv = process.argv.slice(2);",
    "writeFileSync(process.env.FAKE_CODEX_CAPTURE, JSON.stringify({ argv, prompt, env: process.env }));",
    `if (${JSON.stringify(stdout)}) process.stdout.write(${JSON.stringify(stdout)});`,
    `if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});`,
    `if (${exitCode} !== 0) process.exit(${exitCode});`,
    "const output = argv[argv.indexOf('--output-last-message') + 1];",
    `writeFileSync(output, ${JSON.stringify(report)});`,
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

async function adapterFixture(t) {
  const repo = makeRepository();
  const scratch = mkdtempSync(path.join(os.tmpdir(), "jig-codex-capture-"));
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });
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
  return { repo, scratch, capturePath, pinnedBrief, parse, captured: () => JSON.parse(readFileSync(capturePath, "utf8")) };
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
  const args = buildCodexArgs({ model: "gpt-5-codex", effort: "high" }, { repoRoot: "/repo" }, "/tmp/last.txt");
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
  const defaults = buildCodexArgs({ model: null, effort: null }, { repoRoot: "/repo" }, "/tmp/last.txt");
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
  withEnvironment(t, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "parent", CODEX_SANDBOX_NETWORK_DISABLED: "1", CODEX_HOME: "/home/user/.codex-work" });
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
  assert.equal(captured.env.CODEX_HOME, "/home/user/.codex-work", "the provider home configuration is retained");
  assert.equal(captured.env.GIT_OPTIONAL_LOCKS, "0");
});

test("a Jig launcher wraps the Codex command and forwards the adapter arguments exactly", async (t) => {
  const f = await adapterFixture(t);
  const fakeJig = fakeProvider(f.scratch, "fake-jig.mjs");
  const report = await runCodexReview(f.parse(["--launcher", "auto"]), { codexBin: "codex-must-not-run", jigBin: fakeJig });
  assert.equal(report, "No actionable findings from Codex.");
  const captured = f.captured();
  assert.deepEqual(captured.argv.slice(0, 5), ["codex", "launch", "--auto", "--", "exec"]);
  assert.equal(captured.argv.at(-1), "-");

  withEnvironment(t, { JIG_LAUNCHER_BIN: fakeJig });
  await runCodexReview(f.parse(["--launcher", "home:work"]), { codexBin: "codex-must-not-run" });
  assert.deepEqual(f.captured().argv.slice(0, 5), ["codex", "launch", "work", "--", "exec"]);
});

test("a launcher without an eligible home is a permanent provider failure", async (t) => {
  const f = await adapterFixture(t);
  const message = "No eligible Codex home with fresh subscription headroom; inspect `jig codex homes --usage` or pass HOME explicitly";
  const fakeJig = fakeProvider(f.scratch, "exhausted-jig.mjs", { exitCode: 1, stderr: `${message}\n` });
  let failure;
  await assert.rejects(runCodexReview(f.parse(["--launcher", "auto"]), { jigBin: fakeJig }), (error) => { failure = error; return /No eligible Codex home/.test(error.message); });
  assert.equal(failureResult(failure).retryable, false);
  const stale = fakeProvider(f.scratch, "stale-jig.mjs", { exitCode: 2, stderr: "error: unexpected argument '--auto' found\n" });
  await assert.rejects(runCodexReview(f.parse(["--launcher", "auto"]), { jigBin: stale }), (error) => { failure = error; return /unexpected argument/.test(error.message); });
  assert.equal(failureResult(failure).retryable, false);
});

test("a missing final message fails the review instead of returning an empty report", async (t) => {
  const f = await adapterFixture(t);
  const silent = path.join(f.scratch, "silent-codex.mjs");
  writeFileSync(silent, "#!/usr/bin/env node\nfor await (const chunk of process.stdin) {}\nprocess.stdout.write('progress only');\n");
  chmodSync(silent, 0o755);
  await assert.rejects(runCodexReview(f.parse(), { codexBin: silent }), /did not write a final message/);
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
