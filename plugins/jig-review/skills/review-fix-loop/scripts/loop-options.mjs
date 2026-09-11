#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseArgs as parseReviewArgs,
  readOptionValue,
  reviewOptionTakesValue,
} from "../../comprehensive-review/scripts/review-options.mjs";

const DEFAULT_MAX_ROUNDS = 3;
const MAX_ROUNDS = 3;
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const FIX_MODES = new Set(["minimal", "comprehensive"]);

function parseArgs(argv) {
  let scope = null;
  let base = null;
  let fixMode = "minimal";
  let minSeverity = "medium";
  let maxRounds = DEFAULT_MAX_ROUNDS;
  const reviewArgv = [];
  const provided = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];

    if (flag === "--wait") continue;
    if (flag === "--include-working-tree") {
      throw new Error(
        "review-fix-loop already includes working-tree changes in branch scope; "
        + "use --base or --scope branch without --include-working-tree.",
      );
    }
    if (flag === "--base") {
      if (provided.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
      base = readOptionValue(argv, index, flag);
      if (!base.trim()) throw new Error("--base must not be blank.");
      provided.add(flag);
      index += 1;
      continue;
    }
    if (flag === "--scope") {
      if (provided.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
      scope = readOptionValue(argv, index, flag);
      if (!["working-tree", "branch", "auto"].includes(scope)) {
        throw new Error("--scope must be working-tree, branch, or auto.");
      }
      provided.add(flag);
      index += 1;
      continue;
    }
    if (flag === "--fix-mode") {
      if (provided.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
      fixMode = readOptionValue(argv, index, flag).trim().toLowerCase();
      if (!FIX_MODES.has(fixMode)) {
        throw new Error(
          `Unsupported --fix-mode value "${fixMode}". Use minimal or comprehensive.`,
        );
      }
      provided.add(flag);
      index += 1;
      continue;
    }
    if (flag === "--min-severity") {
      if (provided.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
      minSeverity = readOptionValue(argv, index, flag).trim().toLowerCase();
      if (!SEVERITIES.has(minSeverity)) {
        throw new Error(
          `Unsupported --min-severity value "${minSeverity}". Use critical, high, medium, or low.`,
        );
      }
      provided.add(flag);
      index += 1;
      continue;
    }
    if (flag === "--max-rounds") {
      if (provided.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
      maxRounds = Number(readOptionValue(argv, index, flag));
      if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS) {
        throw new Error(`--max-rounds must be an integer from 1 to ${MAX_ROUNDS}.`);
      }
      provided.add(flag);
      index += 1;
      continue;
    }

    reviewArgv.push(flag);
    if (reviewOptionTakesValue(flag)) {
      reviewArgv.push(readOptionValue(argv, index, flag));
      index += 1;
    }
  }

  if (base && scope === "working-tree") {
    throw new Error("--base cannot be combined with --scope working-tree.");
  }

  return {
    scope: base ? "branch" : scope ?? "working-tree",
    base,
    fixMode,
    minSeverity,
    maxRounds,
    review: parseReviewArgs(reviewArgv),
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
    process.stderr.write(`loop-options: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export {
  DEFAULT_MAX_ROUNDS,
  MAX_ROUNDS,
  parseArgs,
};
