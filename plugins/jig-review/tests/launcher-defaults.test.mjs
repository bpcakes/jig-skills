import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { supportsAutoLauncher } from "../skills/panel-review/scripts/provider-launch.mjs";
import { parseArgs, withDefaultLaunchers } from "../skills/panel-review/scripts/review-options.mjs";
import { parseArgs as loopArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";
import { createRun } from "../skills/review-fix-loop/scripts/review-fix-loop.mjs";

function fixture(t, mode = "compatible") {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jig-launcher-defaults-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "jig"), log = path.join(directory, "probes.jsonl");
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args.length !== 3 || args[1] !== 'launch' || args[2] !== '--help') process.exit(99);
const mode = ${JSON.stringify(mode)};
if (mode === 'hang') setInterval(() => {}, 1000);
else {
  console.log('Usage: jig ' + args[0] + ' launch [OPTIONS] [HOME]');
  if (mode !== 'old' && (mode !== 'claude-only' || args[0] === 'claude')) console.log('    --auto Select a home');
  if (mode === 'failed') process.exitCode = 1;
}
`, { mode: 0o755 });
  const inherited = { ...process.env, JIG_LAUNCHER_BIN: binary };
  const available = provider => supportsAutoLauncher(provider, { inherited, timeoutMs: mode === "hang" ? 100 : 1000 });
  return { directory, binary, inherited, available,
    probes: () => readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) };
}

test("default option CLI detects compatible Jig with help-only probes for both providers", t => {
  const f = fixture(t);
  const cli = fileURLToPath(new URL("../skills/panel-review/scripts/review-options.mjs", import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, [cli], { env: f.inherited, encoding: "utf8" }));
  assert.equal(result.claude.launcher, "auto");
  assert.equal(result.codex.launcher, "auto");
  assert.equal(result.codex.runtime, "cli");
  assert.deepEqual(f.probes(), [["claude", "launch", "--help"], ["codex", "launch", "--help"]]);
});

for (const mode of ["old", "failed", "hang", "missing"]) {
  test(`default launchers fall back without launching providers when Jig is ${mode}`, t => {
    const f = fixture(t, mode);
    if (mode === "missing") f.inherited.JIG_LAUNCHER_BIN = path.join(f.directory, "absent");
    const result = parseArgs([], { launcherAvailable: f.available });
    assert.equal(result.claude.launcher, "none");
    assert.equal(result.codex.launcher, "none");
    assert.equal(result.codex.runtime, "native");
  });
}

test("Jig compatibility is provider-specific", t => {
  const f = fixture(t, "claude-only");
  const result = parseArgs([], { launcherAvailable: f.available });
  assert.equal(result.claude.launcher, "auto");
  assert.equal(result.codex.runtime, "native");
  assert.equal(result.codex.launcher, "none");
});

test("explicit launchers, Claude profiles, native runtime and native-only efforts retain their meaning", () => {
  const unexpected = () => assert.fail("an explicit choice must not probe Jig");
  for (const args of [
    ["--claude-launcher", "none", "--codex-launcher", "none"],
    ["--claude-config-dir", "/selected/profile", "--codex-runtime", "native"],
    ["--claude-launcher", "home:work", "--codex-launcher", "auto"],
    ["--reviewers", "codex", "--codex-effort", "ultra"],
    ["--reviewers", "cursor"],
  ]) parseArgs(args, { launcherAvailable: unexpected });
  const automatic = parseArgs(["--codex-effort", "minimal"], { launcherAvailable: () => true });
  assert.equal(automatic.codex.runtime, "cli");
  assert.equal(automatic.codex.effort, "minimal");
  assert.throws(() => parseArgs(["--codex-effort", "minimal"], { launcherAvailable: () => false }), /Unsupported --codex-effort/);
});

test("only selected reviewers are probed", t => {
  const f = fixture(t);
  parseArgs(["--reviewers", "claude"], { launcherAvailable: f.available });
  assert.deepEqual(f.probes(), [["claude", "launch", "--help"]]);
});

test("loop resolves defaults after configured runtimes and custom adapters", () => {
  const options = loopArgs(["--reviewers", "claude,codex"]);
  const resolved = withDefaultLaunchers(options.review, options.defaultLaunchers, [], () => true);
  assert.equal(resolved.codex.runtime, "cli");
  assert.equal(resolved.codex.launcher, "auto");
  assert.equal(resolved.claude.launcher, "auto");
  const configured = withDefaultLaunchers(options.review, options.defaultLaunchers,
    [{ id: "codex", runtime: "native" }, { id: "claude", command: ["custom-review"] }],
    () => assert.fail("configured native/custom providers must not probe Jig"));
  assert.equal(configured.codex.runtime, "native");
  assert.equal(configured.codex.launcher, "none");
  assert.equal(configured.claude.launcher, "none");
  assert.equal(options.review.codex.runtime, "native", "resolution must not mutate parser inputs");
});

test("controller initialization persists detected launchers and selects bundled bridges", async t => {
  const f = fixture(t);
  const previous = process.env.JIG_LAUNCHER_BIN;
  // Relative overrides resolve in the selected checkout, like the review worker.
  process.env.JIG_LAUNCHER_BIN = "./jig";
  t.after(() => {
    if (previous === undefined) delete process.env.JIG_LAUNCHER_BIN;
    else process.env.JIG_LAUNCHER_BIN = previous;
  });
  const git = (...args) => execFileSync("git", args, { cwd: f.directory, stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "--allow-empty", "-qm", "baseline");
  const run = await createRun({ cwd: f.directory,
    options: loopArgs(["--reviewers", "claude,codex", "--commit-mode", "none"]),
    contract: { goal: "Check launcher selection", acceptanceCriteria: [{ id: "selection", description: "Select compatible Jig" }],
      nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: [],
      requiredValidation: [{ id: "node", argv: [process.execPath, "--version"] }] } });
  assert.equal(run.options.review.claude.launcher, "auto");
  assert.equal(run.options.review.codex.launcher, "auto");
  assert.equal(run.options.review.codex.runtime, "cli");
  assert.ok(run.config.reviewers.every(provider => provider.bundled && provider.command));
  const saved = JSON.parse(readFileSync(path.join(run.directory, "run.json"), "utf8"));
  assert.deepEqual(saved.options.review, run.options.review);
  assert.deepEqual(f.probes(), [["claude", "launch", "--help"], ["codex", "launch", "--help"]]);
});
