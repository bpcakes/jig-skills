#!/usr/bin/env node

import { readBrief } from "./review-brief.mjs";

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewEvidence } from "./review-evidence.mjs";
import { normalizeExcludePaths } from "./review-exclusions.mjs";
import { gitEnvironment } from "./git-environment.mjs";
import { childEnvironment, normalizeLauncher, resolveProviderLaunch } from "./provider-launch.mjs";
import { CODEX_CLI_EFFORTS } from "./review-options.mjs";

import {
  buildReviewPrompt,
  collectReviewContext,
  resolveScope,
  runCommand,
} from "./review-context.mjs";
import {
  assertSupportedAdapterPlatform,
  assertScopeMatchesFingerprint,
  installAdapterCancellation,
  providerTimeout,
  verifyScopeFingerprint,
} from "./adapter-runtime.mjs";

const DEFAULT_TIMEOUT_MS = 28 * 60 * 1000;
const MAX_CODEX_OUTPUT_BYTES = 4 * 1024 * 1024;
const LAST_MESSAGE_FILE = "codex-last-message.txt";

function normalizeModel(value) {
  if (value == null) return null;
  const model = String(value).trim();
  if (!model) throw new Error("--model must not be blank.");
  return model;
}

function normalizeEffort(value) {
  if (value == null) return null;
  const effort = String(value).trim().toLowerCase();
  if (!CODEX_CLI_EFFORTS.has(effort)) {
    throw new Error(
      `Unsupported effort "${effort}". The Codex CLI accepts ${[...CODEX_CLI_EFFORTS].join(", ")}.`,
    );
  }
  return effort;
}

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    scope: null,
    base: null,
    includeWorkingTree: false,
    model: null,
    effort: null,
    launcher: "none",
    expectedFingerprint: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    excludePaths: [],
  };
  const supported = new Set([
    "--cwd",
    "--scope",
    "--base",
    "--include-working-tree",
    "--model",
    "--effort",
    "--launcher",
    "--task-brief",
    "--task-brief-hash",
    "--expected-fingerprint",
    "--timeout-ms",
    "--exclude-path",
  ]);
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!supported.has(argument)) throw new Error(`Unsupported argument: ${argument}`);
    if (seen.has(argument) && argument !== "--exclude-path") {
      throw new Error(`Duplicate argument: ${argument}`);
    }
    seen.add(argument);
    if (argument === "--include-working-tree") {
      options.includeWorkingTree = true;
      continue;
    }
    const value = argv[index + 1];
    if (value == null || value === "") throw new Error(`Missing value for ${argument}`);
    index += 1;
    if (argument === "--task-brief") {
      options.taskBrief = value;
    } else if (argument === "--task-brief-hash") {
      options.taskBriefHash = value;
    } else if (argument === "--exclude-path") {
      options.excludePaths.push(value);
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = Number(value);
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
        throw new Error("--timeout-ms must be a positive integer.");
      }
    } else if (argument === "--expected-fingerprint") {
      options.expectedFingerprint = value;
    } else {
      options[argument.slice(2)] = value;
    }
  }

  if (!options.scope) throw new Error("Missing required --scope.");
  if (!new Set(["working-tree", "branch"]).has(options.scope)) {
    throw new Error("--scope must be working-tree or branch.");
  }
  if (options.scope === "branch" && !options.base) {
    throw new Error("Branch scope requires --base.");
  }
  if (options.scope === "working-tree" && options.base) {
    throw new Error("Working-tree scope does not accept --base.");
  }
  if (options.includeWorkingTree && options.scope !== "branch") {
    throw new Error("--include-working-tree requires branch scope.");
  }
  if (!options.expectedFingerprint) {
    throw new Error("Missing required --expected-fingerprint.");
  }
  if (!/^[0-9a-f]{64}$/i.test(options.expectedFingerprint)) {
    throw new Error("--expected-fingerprint must be a 64-character hexadecimal SHA-256 value.");
  }
  options.expectedFingerprint = options.expectedFingerprint.toLowerCase();
  options.excludePaths = normalizeExcludePaths(options.excludePaths);
  options.model = normalizeModel(options.model);
  options.effort = normalizeEffort(options.effort);
  options.launcher = normalizeLauncher(options.launcher, "--launcher");
  return options;
}

// A read-only, ephemeral, configuration-independent Codex session. The user's
// config.toml is ignored so the reviewer does not inherit instructions, MCP
// servers, or model overrides from whichever home the launcher selected; auth
// still comes from that home. The sandbox denies writes and network access.
function buildCodexArgs(options, scope, lastMessagePath) {
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "-c",
    'approval_policy="never"',
    "-c",
    "mcp_servers={}",
    "-c",
    'web_search="disabled"',
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.memories=false",
    "--cd",
    scope.repoRoot,
    "--output-last-message",
    lastMessagePath,
  ];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(options.effort)}`);
  args.push("-");
  return args;
}

function parseCodexResult(lastMessagePath) {
  if (!existsSync(lastMessagePath)) throw new Error("Codex did not write a final message.");
  const report = readFileSync(lastMessagePath, "utf8").trim();
  if (!report) throw new Error("Codex returned no review output.");
  return report;
}

async function runCodexReview(options, dependencies = {}) {
  assertSupportedAdapterPlatform();
  if (!options.expectedFingerprint) {
    throw new Error("Codex review requires an expected scope fingerprint.");
  }
  options = {
    ...options,
    expectedFingerprint: options.expectedFingerprint.toLowerCase(),
    model: normalizeModel(options.model),
    effort: normalizeEffort(options.effort),
    launcher: normalizeLauncher(options.launcher, "--launcher"),
  };
  if (Boolean(options.taskBrief) !== Boolean(options.taskBriefHash)) throw new Error("--task-brief and --task-brief-hash must be supplied together.");
  const taskBrief = readBrief(options.taskBrief, options.taskBriefHash);
  const deadlineAt = Date.now() + options.timeoutMs;
  const signal = dependencies.signal ?? null;
  const initialFingerprint = await verifyScopeFingerprint(
    options,
    options.expectedFingerprint,
    deadlineAt,
    signal,
  );
  const scope = await resolveScope(options, { deadlineAt, signal });
  assertScopeMatchesFingerprint(scope, initialFingerprint);
  const evidence = new ReviewEvidence({ deadlineAt, signal });
  try {
    const context = await collectReviewContext(scope, { deadlineAt, signal, evidence });
    const prompt = buildReviewPrompt(scope, context, { taskBrief, tooling: "codex" }) + (dependencies.promptSuffix ?? "");
    const codexBin = dependencies.codexBin ?? process.env.JIG_CODEX_BIN ?? "codex";
    const lastMessagePath = path.join(evidence.directory, LAST_MESSAGE_FILE);
    const launch = resolveProviderLaunch({
      provider: "codex",
      launcher: options.launcher,
      executable: codexBin,
      args: buildCodexArgs(options, scope, lastMessagePath),
      inherited: process.env,
      jigBin: dependencies.jigBin ?? null,
    });
    const allocateProviderTimeout = dependencies.providerTimeout ?? providerTimeout;
    await runCommand(launch.command, launch.args, {
      cwd: scope.repoRoot,
      input: prompt,
      timeoutMs: allocateProviderTimeout(deadlineAt, options.timeoutMs),
      maxBuffer: MAX_CODEX_OUTPUT_BYTES,
      signal,
      env: gitEnvironment(childEnvironment(process.env)),
    });
    await verifyScopeFingerprint(options, initialFingerprint.fingerprint, deadlineAt, signal);
    const report = parseCodexResult(lastMessagePath);
    return dependencies.parseReport ? dependencies.parseReport(evidence.structuredReport(report, context)) : evidence.annotateReport(report, context);
  } finally {
    evidence.cleanup();
  }
}

async function main() {
  const cancellation = installAdapterCancellation();
  try {
    const report = await runCodexReview(
      parseArgs(process.argv.slice(2)),
      { signal: cancellation.signal },
    );
    process.stdout.write(`${report}\n`);
  } catch (error) {
    if (cancellation.parentSignal && !error.parentSignal) {
      error.parentSignal = cancellation.parentSignal;
    }
    throw error;
  } finally {
    cancellation.dispose();
  }
}

const isMain = process.argv[1]
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    if (error.parentSignal) {
      process.kill(process.pid, error.parentSignal);
      return;
    }
    const prefix = error.timedOut ? "codex-review timed out" : "codex-review failed";
    process.stderr.write(`${prefix}: ${error.message}\n`);
    process.exitCode = error.timedOut ? 124 : 1;
  });
}

export {
  buildCodexArgs,
  parseArgs,
  parseCodexResult,
  runCodexReview,
};
