#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
    codexModel: null,
    codexEffort: null,
    cursorEffort: "high",
  };
  const flags = new Map([
    ["--reviewers", "reviewers"],
    ["--claude-model", "claudeModel"],
    ["--claude-effort", "claudeEffort"],
    ["--claude-file-access", "claudeFileAccess"],
    ["--codex-model", "codexModel"],
    ["--codex-effort", "codexEffort"],
    ["--cursor-effort", "cursorEffort"],
  ]);
  const provided = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const property = flags.get(flag);
    if (!property) throw new Error(`Unsupported argument: ${flag}`);
    if (provided.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    const value = argv[index + 1];
    if (value == null || value === "") throw new Error(`Missing value for ${flag}`);
    raw[property] = value;
    provided.add(flag);
    index += 1;
  }

  const reviewers = parseReviewers(raw.reviewers);
  const selected = new Set(reviewers);
  const reviewerFlags = {
    claude: ["--claude-model", "--claude-effort", "--claude-file-access"],
    codex: ["--codex-model", "--codex-effort"],
    cursor: ["--cursor-effort"],
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
  const cursorEffort = selected.has("cursor")
    ? effort("--cursor-effort", raw.cursorEffort, new Set(Object.keys(CURSOR_MODELS)))
    : null;
  const cursor = cursorEffort == null
    ? null
    : { effort: cursorEffort, model: CURSOR_MODELS[cursorEffort] };

  return { reviewers, claude, codex, cursor };
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
  parseArgs,
};
