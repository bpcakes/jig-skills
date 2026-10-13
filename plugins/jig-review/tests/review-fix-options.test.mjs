import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_ROUNDS, MAX_ROUNDS, parseArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";

test("defaults resolve auto scope, all severities, three rounds and balanced native reviews", () => {
  const o = parseArgs([]);
  assert.equal(o.scope, "auto"); assert.equal(o.minSeverity, "low"); assert.equal(o.maxRounds, 3);
  assert.equal(o.reviewPolicy, "balanced"); assert.deepEqual(o.review.reviewers, ["codex"]);
  assert.equal(o.fixMode, "balanced");
  assert.equal(o.commitMode, "per-round");
  assert.equal(DEFAULT_MAX_ROUNDS, 3); assert.equal(MAX_ROUNDS, 10);
});
test("commit mode defaults to per-round and accepts an explicit non-committing mode", () => {
  assert.equal(parseArgs(["--commit-mode", " NONE "]).commitMode, "none");
  for (const value of ["squash", "", "true"]) assert.throws(() => parseArgs(["--commit-mode", value]), /commit-mode|Missing value/);
  assert.throws(() => parseArgs(["--commit-mode"]), /Missing value/);
  assert.throws(() => parseArgs(["--commit-mode", "none", "--commit-mode", "per-round"]), /Duplicate/);
});
test("strict policy, provider settings and exclusions compose", () => {
  const o = parseArgs(["--review-policy", "strict", "--all-reviewers", "--cursor-speed", "fast", "--exclude-path", ".agents/", "--max-rounds", "2"]);
  assert.deepEqual(o.review.reviewers, ["claude", "codex", "cursor"]);
  assert.deepEqual(o.review.excludePaths, [".agents"]); assert.equal(o.maxRounds, 2);
  assert.deepEqual(parseArgs(["--review-policy", "strict"]).review.reviewers, ["claude", "codex"]);
});
test("removed options fail clearly and scope conflicts cannot be ignored", () => {
  assert.throws(() => parseArgs(["--wait"]), /was removed/);
  assert.throws(() => parseArgs(["--include-working-tree"]), /already include/);
  assert.throws(() => parseArgs(["--base", "main", "--scope", "working-tree"]), /cannot be combined/);
  assert.equal(parseArgs(["--base", "main"]).scope, "branch");
});
test("bounds and missing/duplicate options fail before execution", () => {
  for (const name of ["--max-rounds", "--max-provider-attempts"]) {
    for (const value of ["0", "11", "1.5", "bad"]) assert.throws(() => parseArgs([name, value]), /integer/);
  }
  for (const name of ["--scope", "--base", "--fix-mode", "--max-rounds", "--review-policy", "--exclude-path"]) assert.throws(() => parseArgs([name, "--unknown"]), /Missing value/);
  assert.throws(() => parseArgs(["--scope", "auto", "--scope", "branch"]), /Duplicate/);
  assert.throws(() => parseArgs(["--review-policy", "quick"]), /balanced or strict/);
  assert.throws(() => parseArgs(["--min-severity", "important"]), /severity/);
  assert.equal(parseArgs(["--min-severity", " HIGH "]).minSeverity, "high");
  assert.throws(() => parseArgs(["--reviewers", "codex", "--cursor-speed", "fast"]), /requires selecting cursor/);
  assert.throws(() => parseArgs(["--claude-model", "custom"]), /requires selecting claude/);
});
test("repair modes are validated independently of review policy, severity and budget", () => {
  for (const mode of ["minimal", "balanced", "comprehensive"]) {
    const o = parseArgs(["--fix-mode", ` ${mode.toUpperCase()} `, "--review-policy", "strict", "--min-severity", "high", "--max-rounds", "2"]);
    assert.equal(o.fixMode, mode); assert.equal(o.reviewPolicy, "strict");
    assert.equal(o.minSeverity, "high"); assert.equal(o.maxRounds, 2);
    assert.deepEqual(o.review.reviewers, ["claude", "codex"]);
  }
  for (const value of ["", "quick", "toString", "constructor"]) assert.throws(() => parseArgs(["--fix-mode", value]), /fix-mode|Missing value/);
  assert.throws(() => parseArgs(["--fix-mode"]), /Missing value/);
  assert.throws(() => parseArgs(["--fix-mode", "minimal", "--fix-mode", "comprehensive"]), /Duplicate/);
});
test("entrypoint works through a symlink", t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "loop-options-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, "loop.mjs");
  symlinkSync(fileURLToPath(new URL("../skills/review-fix-loop/scripts/loop-options.mjs", import.meta.url)), link);
  assert.equal(JSON.parse(execFileSync(process.execPath, [link], { encoding: "utf8" })).maxRounds, 3);
});

test("Codex runtime and launcher selections reach the loop's review options", () => {
  const o = parseArgs(["--reviewers", "claude,codex", "--codex-launcher", "auto", "--claude-launcher", "home:work"]);
  assert.equal(o.review.codex.runtime, "cli"); assert.equal(o.review.codex.launcher, "auto"); assert.equal(o.review.claude.launcher, "home:work");
  assert.equal(parseArgs([]).review.codex.runtime, "native");
  assert.throws(() => parseArgs(["--codex-runtime", "native", "--codex-launcher", "auto"]), /omit --codex-runtime/);
  // Loop options defer the runtime-specific effort check to init, where a configuration file may change the runtime.
  assert.equal(parseArgs(["--codex-effort", "minimal"]).review.codex.effort, "minimal");
  assert.equal(parseArgs(["--codex-runtime", "cli", "--codex-effort", "ultra"]).review.codex.effort, "ultra");
  assert.throws(() => parseArgs(["--codex-effort", "extreme"]), /Unsupported --codex-effort/);
});

test("a Claude Code host defaults to independent Claude reviews and Codex through its CLI", () => {
  const balanced = parseArgs(["--host", "claude"]);
  assert.equal(balanced.review.host, "claude"); assert.deepEqual(balanced.review.reviewers, ["claude"]); assert.equal(balanced.explicitReviewers, false);
  const strict = parseArgs(["--host", "claude", "--review-policy", "strict"]);
  assert.deepEqual(strict.review.reviewers, ["claude", "codex"]); assert.equal(strict.review.codex.runtime, "cli");
  assert.deepEqual(parseArgs(["--host", "claude", "--reviewers", "codex"]).review.codex.runtime, "cli");
  assert.throws(() => parseArgs(["--host", "claude", "--reviewers", "codex", "--codex-runtime", "native"]), /no native Codex subagent/);
  // Codex hosts keep their native default.
  assert.deepEqual(parseArgs(["--host", "codex"]).review.reviewers, ["codex"]);
  assert.throws(() => parseArgs(["--host", "gemini"]), /Unsupported --host value/);
});
