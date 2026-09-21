#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs as reviewArgs, readOptionValue, reviewOptionTakesValue } from "../../comprehensive-review/scripts/review-options.mjs";
import { DEFAULT_FIX_MODE, repairPolicy } from "./repair-policy.mjs";

export const DEFAULT_MAX_ROUNDS = 3;
export const MAX_ROUNDS = 10;

export function parseArgs(argv) {
  const options = { scope: "auto", base: null, fixMode: DEFAULT_FIX_MODE, commitMode: "per-round", minSeverity: "low", maxRounds: DEFAULT_MAX_ROUNDS,
    reviewPolicy: "balanced", maxProviderAttempts: 3, infrastructureRetries: 1 };
  const names = { "--scope": "scope", "--base": "base", "--fix-mode": "fixMode", "--commit-mode": "commitMode", "--min-severity": "minSeverity",
    "--max-rounds": "maxRounds", "--review-policy": "reviewPolicy", "--max-provider-attempts": "maxProviderAttempts" };
  const seen = new Set();
  const forwarded = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--log-to-beads") throw new Error("--log-to-beads belongs to the comprehensive-review parent; log final residual findings after the controller terminates.");
    if (flag === "--wait") throw new Error("--wait was removed; use the controller's run command to wait for a boundary.");
    if (flag === "--include-working-tree") throw new Error("Branch loops already include working-tree changes; use --base or --scope branch.");
    if (names[flag]) {
      if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
      seen.add(flag);
      options[names[flag]] = readOptionValue(argv, i++, flag).trim();
    } else {
      forwarded.push(flag);
      if (reviewOptionTakesValue(flag)) forwarded.push(readOptionValue(argv, i++, flag));
    }
  }
  if (!["auto", "branch", "working-tree"].includes(options.scope)) throw new Error("--scope must be auto, branch, or working-tree.");
  if (!["balanced", "strict"].includes(options.reviewPolicy)) throw new Error("--review-policy must be balanced or strict.");
  options.fixMode = options.fixMode.toLowerCase();
  repairPolicy(options.fixMode);
  options.commitMode = options.commitMode.toLowerCase();
  if (!["per-round", "none"].includes(options.commitMode)) throw new Error("--commit-mode must be per-round or none.");
  options.minSeverity = options.minSeverity.toLowerCase();
  if (!["low", "medium", "high", "critical"].includes(options.minSeverity)) throw new Error("Unsupported --min-severity.");
  for (const key of ["maxRounds", "maxProviderAttempts"]) {
    options[key] = Number(options[key]);
    if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > MAX_ROUNDS) throw new Error(`${key} must be an integer from 1 to ${MAX_ROUNDS}.`);
  }
  if (seen.has("--base") && !options.base) throw new Error("--base must not be blank.");
  if (options.base && options.scope === "working-tree") throw new Error("--base cannot be combined with --scope working-tree.");
  if (options.base) options.scope = "branch";
  if (!forwarded.includes("--reviewers") && !forwarded.includes("--all-reviewers")) {
    forwarded.unshift("--reviewers", options.reviewPolicy === "strict" ? "claude,codex" : "codex");
  }
  options.review = reviewArgs(forwarded);
  return options;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(parseArgs(process.argv.slice(2)), null, 2)}\n`); }
  catch (error) { process.stderr.write(`loop-options: ${error.message}\n`); process.exitCode = 1; }
}
