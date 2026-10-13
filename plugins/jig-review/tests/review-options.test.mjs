import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CURSOR_MODELS,
  parseArgs as parseReviewArgs,
} from "../skills/comprehensive-review/scripts/review-options.mjs";

// These baseline cases exercise hosts without Jig; launcher-defaults covers
// capability detection using isolated executables, independent of the test host.
const parseArgs = (argv, options = {}) => parseReviewArgs(argv, { launcherAvailable: () => false, ...options });

test("default reviewers remain Claude and Codex", () => {
  assert.deepEqual(parseArgs([]), {
    host: "codex",
    reviewers: ["claude", "codex"],
    claude: {
      model: "opus",
      effort: null,
      fileAccess: "restricted",
      configDir: null,
      launcher: "none",
    },
    codex: { model: null, effort: null, runtime: "native", launcher: "none" },
    cursor: null,
    excludePaths: [],
  });
});

test("all-reviewers selects every provider in canonical order", () => {
  assert.deepEqual(
    parseArgs([
      "--all-reviewers",
      "--cursor-effort",
      "xhigh",
      "--cursor-speed",
      "fast",
    ]),
    {
      host: "codex",
      reviewers: ["claude", "codex", "cursor"],
      claude: {
        model: "opus",
        effort: null,
        fileAccess: "restricted",
        configDir: null,
        launcher: "none",
      },
      codex: { model: null, effort: null, runtime: "native", launcher: "none" },
      cursor: {
        effort: "xhigh",
        speed: "fast",
        model: "cursor-grok-4.6-xhigh-fast",
      },
      excludePaths: [],
    },
  );
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
      "--cursor-speed",
      "fast",
    ]),
    {
      host: "codex",
      reviewers: ["claude", "codex", "cursor"],
      claude: {
        model: "sonnet",
        effort: "max",
        fileAccess: "host",
        configDir: null,
        launcher: "none",
      },
      codex: { model: "gpt-5.6-sol", effort: "ultra", runtime: "native", launcher: "none" },
      cursor: {
        effort: "xhigh",
        speed: "fast",
        model: "cursor-grok-4.6-xhigh-fast",
      },
      excludePaths: [],
    },
  );
  assert.equal(CURSOR_MODELS.high, "cursor-grok-4.6-high");
});

test("single-reviewer selection does not configure or require other CLIs", () => {
  assert.deepEqual(parseArgs(["--reviewers", "cursor", "--cursor-effort", "low"]), {
    host: "codex",
    reviewers: ["cursor"],
    claude: null,
    codex: null,
    cursor: {
      effort: "low",
      speed: "standard",
      model: "cursor-grok-4.6-low",
    },
    excludePaths: [],
  });
});

test("review exclusions are repeatable, normalized, and deduplicated", () => {
  assert.deepEqual(parseArgs([
    "--exclude-path",
    "/.agent/",
    "--exclude-path",
    "build/output",
    "--exclude-path",
    ".agent",
  ]).excludePaths, [".agent", "build/output"]);
  assert.throws(
    () => parseArgs(["--exclude-path", "../outside"]),
    /normalized repository-relative path/,
  );
  assert.throws(
    () => parseArgs(["--exclude-path", "*.jsonl"]),
    /glob patterns/,
  );
  assert.throws(
    () => parseArgs(["--exclude-path", ".reviewignore"]),
    /cannot exclude itself/,
  );
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
    () => parseArgs(["--reviewers", "codex", "--claude-config-dir", "~/.claude-work"]),
    /requires selecting claude/,
  );
  assert.throws(
    () => parseArgs(["--reviewers", "claude", "--cursor-effort", "high"]),
    /requires selecting cursor/,
  );
  assert.throws(
    () => parseArgs(["--reviewers", "claude", "--cursor-speed", "fast"]),
    /requires selecting cursor/,
  );
});

test("review options reject flags as values while accepting explicit literal exclusion paths", () => {
  for (const flag of ["--exclude-path", "--claude-model", "--claude-config-dir", "--reviewers"]) {
    assert.throws(
      () => parseArgs([flag, "--all-reviewers"]),
      { message: `Missing value for ${flag}` },
    );
  }
  assert.deepEqual(parseArgs(["--exclude-path", "/--all-reviewers"]).excludePaths, ["--all-reviewers"]);
});

test("Claude config directory is explicit and home-relative paths are expanded", () => {
  const result = parseArgs(["--claude-config-dir", "~/.claude-appleid"]);
  assert.equal(result.claude.configDir, path.join(os.homedir(), ".claude-appleid"));
  assert.throws(
    () => parseArgs(["--claude-config-dir", ".claude-relative"]),
    /absolute path or start with ~\//,
  );
  assert.throws(
    () => parseArgs(["--claude-config-dir", "~another-user/.claude"]),
    /supports only ~ or ~\//,
  );
});

test("ambiguous legacy flags and invalid reviewer lists are rejected", () => {
  assert.throws(() => parseArgs(["--model", "opus"]), /Unsupported argument/);
  assert.throws(() => parseArgs(["--effort", "high"]), /Unsupported argument/);
  assert.throws(() => parseArgs(["--reviewers", "claude,claude"]), /Duplicate reviewer/);
  assert.throws(() => parseArgs(["--reviewers", "claude,grok"]), /Unknown reviewer/);
  assert.throws(() => parseArgs(["--reviewers", ""]), /Missing value/);
  assert.throws(
    () => parseArgs(["--all-reviewers", "--reviewers", "codex"]),
    /cannot be combined/,
  );
  assert.throws(
    () => parseArgs(["--all-reviewers", "--all-reviewers"]),
    /Duplicate argument/,
  );
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
    () => parseArgs(["--reviewers", "cursor", "--cursor-speed", "turbo"]),
    /Unsupported --cursor-speed/,
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
    [
      linkedScript,
      "--reviewers",
      "cursor",
      "--cursor-effort",
      "medium",
      "--cursor-speed",
      "fast",
    ],
    { encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(output), {
    host: "codex",
    reviewers: ["cursor"],
    claude: null,
    codex: null,
    cursor: {
      effort: "medium",
      speed: "fast",
      model: "cursor-grok-4.6-medium-fast",
    },
    excludePaths: [],
  });
});

test("Jig launchers select provider homes and imply the Codex CLI runtime", () => {
  const launched = parseArgs(["--claude-launcher", "auto", "--codex-launcher", "home:work"]);
  assert.equal(launched.claude.launcher, "auto");
  assert.deepEqual(launched.codex, { model: null, effort: null, runtime: "cli", launcher: "home:work" });
  assert.deepEqual(parseArgs(["--codex-runtime", "cli"]).codex, { model: null, effort: null, runtime: "cli", launcher: "none" });
  assert.equal(parseArgs(["--codex-effort", "ultra"]).codex.effort, "ultra", "native Codex keeps the host effort range");
  assert.equal(parseArgs(["--codex-runtime", "cli", "--codex-effort", "minimal"]).codex.effort, "minimal");
  assert.throws(() => parseArgs(["--codex-runtime", "cli", "--codex-effort", "ultra"]), /Unsupported --codex-effort value "ultra"\. Use minimal, low, medium, high, xhigh/);
  assert.throws(() => parseArgs(["--codex-effort", "minimal"]), /Unsupported --codex-effort value "minimal"\. Use low, medium, high, xhigh, max, ultra/);
  assert.equal(parseArgs(["--codex-effort", "minimal"], { deferCodexEffort: true }).codex.effort, "minimal");
  assert.throws(() => parseArgs(["--codex-runtime", "native", "--codex-launcher", "auto"]), /use --codex-runtime cli or omit --codex-runtime/);
  assert.throws(() => parseArgs(["--codex-runtime", "subagent"]), /Unsupported --codex-runtime value/);
  assert.throws(() => parseArgs(["--claude-launcher", "picker"]), /Unsupported --claude-launcher value "picker"/);
  assert.throws(() => parseArgs(["--claude-launcher", "home:work", "--claude-config-dir", "~/.claude-work"]), /cannot be combined with --claude-launcher/);
  assert.throws(() => parseArgs(["--reviewers", "claude", "--codex-launcher", "auto"]), /--codex-launcher requires selecting codex/);
  assert.throws(() => parseArgs(["--reviewers", "codex", "--claude-launcher", "auto"]), /--claude-launcher requires selecting claude/);
  assert.throws(() => parseArgs(["--reviewers", "cursor", "--codex-runtime", "cli"]), /--codex-runtime requires selecting codex/);
});

test("a Claude Code host reviews with Codex only through its CLI adapter", () => {
  const claudeHost = parseArgs(["--host", "claude"]);
  assert.equal(claudeHost.host, "claude");
  assert.deepEqual(claudeHost.reviewers, ["claude", "codex"]);
  assert.deepEqual(claudeHost.codex, { model: null, effort: null, runtime: "cli", launcher: "none" });
  assert.equal(parseArgs(["--host", "Claude", "--codex-effort", "minimal"]).codex.effort, "minimal", "the CLI effort range applies");
  assert.throws(() => parseArgs(["--host", "claude", "--codex-effort", "ultra"]), /Use minimal, low, medium, high, xhigh/);
  // An explicit native runtime would make a Claude subagent report as Codex.
  assert.throws(() => parseArgs(["--host", "claude", "--codex-runtime", "native"]), /Claude Code has no native Codex subagent/);
  assert.equal(parseArgs(["--host", "claude", "--codex-launcher", "auto"]).codex.runtime, "cli");
  assert.equal(parseArgs(["--host", "claude", "--reviewers", "claude"]).codex, null);
  assert.equal(parseArgs(["--host", "codex"]).codex.runtime, "native");
  assert.throws(() => parseArgs(["--host", "cursor"]), /Unsupported --host value "cursor"\. Use codex, claude/);
  assert.throws(() => parseArgs(["--host", "claude", "--host", "codex"]), /Duplicate argument: --host/);
  assert.throws(() => parseArgs(["--host"]), /Missing value for --host/);
});
