import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CURSOR_MODELS,
  parseArgs,
} from "../skills/comprehensive-review/scripts/review-options.mjs";

test("default reviewers remain Claude and Codex", () => {
  assert.deepEqual(parseArgs([]), {
    reviewers: ["claude", "codex"],
    claude: { model: "opus", effort: null, fileAccess: "restricted" },
    codex: { model: null, effort: null },
    cursor: null,
  });
});

test("reviewers and namespaced model settings are normalized", () => {
  assert.deepEqual(
    parseArgs([
      "--reviewers",
      "cursor, Claude, codex",
      "--claude-model",
      "sonnet",
      "--claude-effort",
      "max",
      "--claude-file-access",
      "HOST",
      "--codex-model",
      "gpt-5.6-sol",
      "--codex-effort",
      "ultra",
      "--cursor-effort",
      "xhigh",
    ]),
    {
      reviewers: ["claude", "codex", "cursor"],
      claude: { model: "sonnet", effort: "max", fileAccess: "host" },
      codex: { model: "gpt-5.6-sol", effort: "ultra" },
      cursor: { effort: "xhigh", model: "cursor-grok-4.6-xhigh" },
    },
  );
  assert.equal(CURSOR_MODELS.high, "cursor-grok-4.6-high");
});

test("single-reviewer selection does not configure or require other CLIs", () => {
  assert.deepEqual(parseArgs(["--reviewers", "cursor", "--cursor-effort", "low"]), {
    reviewers: ["cursor"],
    claude: null,
    codex: null,
    cursor: { effort: "low", model: "cursor-grok-4.6-low" },
  });
});

test("reviewer-specific settings require selecting that reviewer", () => {
  assert.throws(
    () => parseArgs(["--reviewers", "codex", "--claude-model", "opus"]),
    /requires selecting claude/,
  );
  assert.throws(
    () => parseArgs(["--reviewers", "codex", "--claude-file-access", "host"]),
    /requires selecting claude/,
  );
  assert.throws(
    () => parseArgs(["--reviewers", "claude", "--cursor-effort", "high"]),
    /requires selecting cursor/,
  );
});

test("ambiguous legacy flags and invalid reviewer lists are rejected", () => {
  assert.throws(() => parseArgs(["--model", "opus"]), /Unsupported argument/);
  assert.throws(() => parseArgs(["--effort", "high"]), /Unsupported argument/);
  assert.throws(() => parseArgs(["--reviewers", "claude,claude"]), /Duplicate reviewer/);
  assert.throws(() => parseArgs(["--reviewers", "claude,grok"]), /Unknown reviewer/);
  assert.throws(() => parseArgs(["--reviewers", ""]), /Missing value/);
});

test("provider effort levels are validated independently", () => {
  assert.throws(
    () => parseArgs(["--claude-effort", "ultra"]),
    /Unsupported --claude-effort/,
  );
  assert.throws(
    () => parseArgs(["--reviewers", "cursor", "--cursor-effort", "max"]),
    /Unsupported --cursor-effort/,
  );
  assert.throws(
    () => parseArgs(["--claude-file-access", "workspace"]),
    /Unsupported --claude-file-access/,
  );
});

test("CLI entrypoint works when the skill directory is reached through a symlink", (t) => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "jig-review-options-link-"));
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL(
    "../skills/comprehensive-review/scripts/review-options.mjs",
    import.meta.url,
  ));
  const linkedScript = path.join(temporaryDirectory, "review-options.mjs");
  symlinkSync(source, linkedScript);

  const output = execFileSync(
    process.execPath,
    [linkedScript, "--reviewers", "cursor", "--cursor-effort", "medium"],
    { encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(output), {
    reviewers: ["cursor"],
    claude: null,
    codex: null,
    cursor: { effort: "medium", model: "cursor-grok-4.6-medium" },
  });
});
