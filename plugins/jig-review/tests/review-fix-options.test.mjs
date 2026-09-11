import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MAX_ROUNDS,
  MAX_ROUNDS,
  parseArgs,
} from "../skills/review-fix-loop/scripts/loop-options.mjs";

test("loop defaults to minimal fixes, medium severity, and three working-tree repair rounds", () => {
  const options = parseArgs([]);
  assert.equal(options.scope, "working-tree");
  assert.equal(options.fixMode, "minimal");
  assert.equal(options.minSeverity, "medium");
  assert.equal(options.maxRounds, 3);
  assert.deepEqual(options.review.reviewers, ["claude", "codex"]);
  assert.equal(DEFAULT_MAX_ROUNDS, 3);
  assert.equal(MAX_ROUNDS, 3);
});

test("loop controls compose with normalized comprehensive-review controls", () => {
  const options = parseArgs([
    "--all-reviewers",
    "--fix-mode",
    " COMPREHENSIVE ",
    "--min-severity",
    "HIGH",
    "--max-rounds",
    "2",
    "--cursor-effort",
    "xhigh",
    "--cursor-speed",
    "fast",
    "--exclude-path",
    ".agents/",
  ]);

  assert.equal(options.scope, "working-tree");
  assert.equal(options.fixMode, "comprehensive");
  assert.equal(options.minSeverity, "high");
  assert.equal(options.maxRounds, 2);
  assert.deepEqual(options.review.reviewers, ["claude", "codex", "cursor"]);
  assert.deepEqual(options.review.cursor, {
    effort: "xhigh",
    speed: "fast",
    model: "cursor-grok-4.6-xhigh-fast",
  });
  assert.deepEqual(options.review.excludePaths, [".agents"]);
});

test("fix mode is independent of severity and reviewer configuration", () => {
  for (const fixMode of ["minimal", "comprehensive"]) {
    for (const minSeverity of ["critical", "high", "medium", "low"]) {
      const options = parseArgs([
        "--reviewers", "codex",
        "--min-severity", minSeverity,
        "--fix-mode", fixMode,
        "--max-rounds", "1",
      ]);
      assert.equal(options.fixMode, fixMode);
      assert.equal(options.minSeverity, minSeverity);
      assert.deepEqual(options.review, parseArgs(["--reviewers", "codex"]).review);
    }
  }
});

test("loop rejects invalid, missing, and duplicate fix modes", () => {
  for (const value of ["structural", "auto", " "]) {
    assert.throws(
      () => parseArgs(["--fix-mode", value]),
      /Unsupported --fix-mode/,
    );
  }
  for (const args of [["--fix-mode"], ["--fix-mode", ""], ["--fix-mode", "--all-reviewers"]]) {
    assert.throws(() => parseArgs(args), /Missing value for --fix-mode/);
  }
  assert.throws(
    () => parseArgs(["--fix-mode", "minimal", "--fix-mode", "comprehensive"]),
    /Duplicate argument: --fix-mode/,
  );
});

test("loop accepts branch and auto scope and a base implies branch", () => {
  assert.equal(parseArgs(["--scope", "branch"]).scope, "branch");
  assert.equal(parseArgs(["--scope", "auto"]).scope, "auto");
  for (const args of [["--base", "main"], ["--scope", "auto", "--base", "main"], ["--base", "main", "--scope", "branch"]]) {
    const options = parseArgs(args);
    assert.equal(options.scope, "branch");
    assert.equal(options.base, "main");
  }
  assert.equal(parseArgs([]).base, null);
  for (const args of [["--base", "main", "--scope", "working-tree"], ["--scope", "working-tree", "--base", "main"]]) {
    assert.throws(() => parseArgs(args), /cannot be combined/);
  }
  assert.throws(() => parseArgs(["--base", "main", "--base", "other"]), /Duplicate argument/);
  assert.throws(() => parseArgs(["--scope", "branch", "--scope", "auto"]), /Duplicate argument/);
  assert.throws(() => parseArgs(["--scope", "unknown"]), /--scope must be/);
  assert.throws(() => parseArgs(["--base", " "]), /must not be blank/);
});

test("loop explains that branch scope already includes working-tree changes", () => {
  const message = "review-fix-loop already includes working-tree changes in branch scope; "
    + "use --base or --scope branch without --include-working-tree.";
  for (const args of [
    ["--include-working-tree"],
    ["--base", "main", "--include-working-tree"],
    ["--include-working-tree", "--scope", "branch"],
  ]) {
    assert.throws(() => parseArgs(args), { message });
  }
});

test("loop rejects invalid bounds and duplicate controls", () => {
  assert.throws(
    () => parseArgs(["--max-rounds", "0"]),
    /integer from 1 to 3/,
  );
  assert.throws(
    () => parseArgs(["--max-rounds", "4"]),
    /integer from 1 to 3/,
  );
  assert.throws(
    () => parseArgs(["--min-severity", "important"]),
    /Unsupported --min-severity/,
  );
  assert.throws(
    () => parseArgs(["--max-rounds", "2", "--max-rounds", "3"]),
    /Duplicate argument/,
  );
});

test("loop delegates reviewer validation and treats wait as a no-op", () => {
  assert.deepEqual(
    parseArgs(["--wait", "--reviewers", "codex"]).review.reviewers,
    ["codex"],
  );
  assert.throws(
    () => parseArgs(["--reviewers", "codex", "--cursor-speed", "fast"]),
    /requires selecting cursor/,
  );
  assert.throws(
    () => parseArgs(["--all-reviewers", "--reviewers", "codex"]),
    /cannot be combined/,
  );
});

test("a following control cannot be consumed as a loop or reviewer value", () => {
  for (const flag of ["--exclude-path", "--claude-model", "--fix-mode", "--min-severity", "--max-rounds", "--scope", "--base"]) {
    for (const next of ["--fix-mode", "--base", "--max-rounds", "--all-reviewers", "--wait", "--unknown"]) {
      assert.throws(
        () => parseArgs([flag, next]),
        { message: `Missing value for ${flag}` },
      );
    }
  }
  assert.throws(
    () => parseArgs(["--exclude-path", "--max-rounds", "1"]),
    { message: "Missing value for --exclude-path" },
  );
  assert.deepEqual(
    parseArgs(["--exclude-path", "/--fix-mode", "--max-rounds", "1"]).review.excludePaths,
    ["--fix-mode"],
  );
});

test("malformed forwarded controls fail the CLI without emitting configuration", () => {
  const script = fileURLToPath(new URL(
    "../skills/review-fix-loop/scripts/loop-options.mjs",
    import.meta.url,
  ));
  for (const args of [["--exclude-path", "--fix-mode"], ["--exclude-path", "--base"], ["--exclude-path", "--max-rounds", "1"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "loop-options: Missing value for --exclude-path\n");
  }
});

test("loop options entrypoint works through a symlink", (t) => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "jig-review-fix-link-"));
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL(
    "../skills/review-fix-loop/scripts/loop-options.mjs",
    import.meta.url,
  ));
  const linkedScript = path.join(temporaryDirectory, "loop-options.mjs");
  symlinkSync(source, linkedScript);

  const output = execFileSync(
    process.execPath,
    [linkedScript, "--reviewers", "codex", "--fix-mode", "comprehensive", "--max-rounds", "1"],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(output);
  assert.equal(parsed.fixMode, "comprehensive");
  assert.equal(parsed.maxRounds, 1);
  assert.deepEqual(parsed.review.reviewers, ["codex"]);
});
