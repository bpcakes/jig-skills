#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeClaudeConfigDir } from "./claude-config.mjs";
import { normalizeExcludePaths } from "./review-exclusions.mjs";

const REVIEWER_ORDER = ["claude", "codex", "cursor"];
const REVIEWERS = new Set(REVIEWER_ORDER);
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CLAUDE_FILE_ACCESS = new Set(["restricted", "host"]);
const CODEX_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const CURSOR_MODELS = Object.freeze({
  low: "cursor-grok-4.6-low",
  medium: "cursor-grok-4.6-medium",
  high: "cursor-grok-4.6-high",
  xhigh: "cursor-grok-4.6-xhigh",
});
const CURSOR_SPEEDS = new Set(["standard", "fast"]);

function cursorModel(effortLevel, speed = "standard") {
  const model = CURSOR_MODELS[effortLevel];
  return speed === "fast" ? `${model}-fast` : model;
}

function nonblank(flag, value) {
  const normalized = String(value).trim();
  if (!normalized) throw new Error(`${flag} must not be blank.`);
  return normalized;
}

function effort(flag, value, supported) {
  const normalized = nonblank(flag, value).toLowerCase();
  if (!supported.has(normalized)) {
    throw new Error(`Unsupported ${flag} value "${normalized}". Use ${[...supported].join(", ")}.`);
  }
  return normalized;
}

function parseReviewers(value) {
  const values = String(value).split(",").map((item) => item.trim().toLowerCase());
  if (!values.length || values.some((item) => !item)) {
    throw new Error("--reviewers requires a comma-separated list.");
  }
  const selected = new Set();
  for (const reviewer of values) {
    if (!REVIEWERS.has(reviewer)) {
      throw new Error(`Unknown reviewer "${reviewer}". Use claude, codex, or cursor.`);
    }
    if (selected.has(reviewer)) throw new Error(`Duplicate reviewer "${reviewer}".`);
    selected.add(reviewer);
  }
  return REVIEWER_ORDER.filter((reviewer) => selected.has(reviewer));
}

function parseArgs(argv) {
  const raw = {
    reviewers: "claude,codex",
    claudeModel: "opus",
    claudeEffort: null,
    claudeFileAccess: "restricted",
    claudeConfigDir: null,
    codexModel: null,
    codexEffort: null,
    cursorEffort: "high",
    cursorSpeed: "standard",
    excludePaths: [],
  };
  const flags = new Map([
    ["--reviewers", "reviewers"],
    ["--claude-model", "claudeModel"],
    ["--claude-effort", "claudeEffort"],
    ["--claude-file-access", "claudeFileAccess"],
    ["--claude-config-dir", "claudeConfigDir"],
    ["--codex-model", "codexModel"],
    ["--codex-effort", "codexEffort"],
    ["--cursor-effort", "cursorEffort"],
    ["--cursor-speed", "cursorSpeed"],
    ["--exclude-path", "excludePaths"],
  ]);
  const provided = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const property = flags.get(flag);
    if (!property) throw new Error(`Unsupported argument: ${flag}`);
    if (provided.has(flag) && flag !== "--exclude-path") {
      throw new Error(`Duplicate argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value == null || value === "") throw new Error(`Missing value for ${flag}`);
    if (flag === "--exclude-path") raw.excludePaths.push(value);
    else raw[property] = value;
    provided.add(flag);
    index += 1;
  }

  const reviewers = parseReviewers(raw.reviewers);
  const selected = new Set(reviewers);
  const reviewerFlags = {
    claude: [
      "--claude-model",
      "--claude-effort",
      "--claude-file-access",
      "--claude-config-dir",
    ],
    codex: ["--codex-model", "--codex-effort"],
    cursor: ["--cursor-effort", "--cursor-speed"],
  };
  for (const [reviewer, configurationFlags] of Object.entries(reviewerFlags)) {
    if (selected.has(reviewer)) continue;
    const invalid = configurationFlags.find((flag) => provided.has(flag));
    if (invalid) throw new Error(`${invalid} requires selecting ${reviewer} in --reviewers.`);
  }

  const claude = selected.has("claude")
    ? {
        model: nonblank("--claude-model", raw.claudeModel),
        effort: raw.claudeEffort == null
          ? null
          : effort("--claude-effort", raw.claudeEffort, CLAUDE_EFFORTS),
        fileAccess: effort(
          "--claude-file-access",
          raw.claudeFileAccess,
          CLAUDE_FILE_ACCESS,
        ),
        configDir: normalizeClaudeConfigDir(raw.claudeConfigDir),
      }
    : null;
  const codex = selected.has("codex")
    ? {
        model: raw.codexModel == null ? null : nonblank("--codex-model", raw.codexModel),
        effort: raw.codexEffort == null
          ? null
          : effort("--codex-effort", raw.codexEffort, CODEX_EFFORTS),
      }
    : null;
  let cursor = null;
  if (selected.has("cursor")) {
    const cursorEffort = effort(
      "--cursor-effort",
      raw.cursorEffort,
      new Set(Object.keys(CURSOR_MODELS)),
    );
    const speed = effort("--cursor-speed", raw.cursorSpeed, CURSOR_SPEEDS);
    cursor = {
      effort: cursorEffort,
      speed,
      model: cursorModel(cursorEffort, speed),
    };
  }

  return {
    reviewers,
    claude,
    codex,
    cursor,
    excludePaths: normalizeExcludePaths(raw.excludePaths),
  };
}

function main() {
  process.stdout.write(`${JSON.stringify(parseArgs(process.argv.slice(2)), null, 2)}\n`);
}

const isMain = process.argv[1]
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`review-options: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export {
  CURSOR_MODELS,
  CURSOR_SPEEDS,
  cursorModel,
  parseArgs,
};
