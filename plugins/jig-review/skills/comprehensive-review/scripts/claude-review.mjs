#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildReviewPrompt,
  collectReviewContext,
  resolveScope,
  runCommand,
} from "./review-context.mjs";
import {
  assertSupportedAdapterPlatform,
  installAdapterCancellation,
  providerTimeout,
  verifyScopeFingerprint,
} from "./adapter-runtime.mjs";

const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const VALID_FILE_ACCESS = new Set(["restricted", "host"]);
const DEFAULT_TIMEOUT_MS = 28 * 60 * 1000;
const MAX_CLAUDE_OUTPUT_BYTES = 4 * 1024 * 1024;

function normalizeFileAccess(value = "restricted") {
  const normalized = String(value).trim().toLowerCase();
  if (!VALID_FILE_ACCESS.has(normalized)) {
    throw new Error(`Unsupported file access "${normalized}". Use restricted or host.`);
  }
  return normalized;
}

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    scope: null,
    base: null,
    model: "opus",
    effort: null,
    fileAccess: "restricted",
    expectedFingerprint: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const supported = new Set([
    "--cwd",
    "--scope",
    "--base",
    "--model",
    "--effort",
    "--file-access",
    "--expected-fingerprint",
    "--timeout-ms",
  ]);
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!supported.has(argument)) throw new Error(`Unsupported argument: ${argument}`);
    if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    seen.add(argument);
    const value = argv[index + 1];
    if (value == null || value === "") throw new Error(`Missing value for ${argument}`);
    index += 1;
    if (argument === "--timeout-ms") {
      options.timeoutMs = Number(value);
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
        throw new Error("--timeout-ms must be a positive integer.");
      }
    } else if (argument === "--expected-fingerprint") {
      options.expectedFingerprint = value;
    } else if (argument === "--file-access") {
      options.fileAccess = value;
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
  if (!options.expectedFingerprint) {
    throw new Error("Missing required --expected-fingerprint.");
  }
  if (!/^[0-9a-f]{64}$/i.test(options.expectedFingerprint)) {
    throw new Error("--expected-fingerprint must be a 64-character hexadecimal SHA-256 value.");
  }
  options.expectedFingerprint = options.expectedFingerprint.toLowerCase();
  options.fileAccess = normalizeFileAccess(options.fileAccess);
  options.model = String(options.model).trim();
  if (!options.model) throw new Error("--model must not be blank.");
  if (options.effort) {
    options.effort = String(options.effort).trim().toLowerCase();
    if (!VALID_EFFORTS.has(options.effort)) {
      throw new Error(
        `Unsupported effort "${options.effort}". Use low, medium, high, xhigh, or max.`,
      );
    }
  }
  return options;
}

function buildClaudeArgs(options) {
  const fileAccess = normalizeFileAccess(options.fileAccess);
  const args = [
    "-p",
    "--safe-mode",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--no-chrome",
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "Read,Glob,Grep",
    "--allowedTools",
    "Read",
    "--allowedTools",
    "Glob",
    "--allowedTools",
    "Grep",
  ];
  if (fileAccess === "restricted") args.push("--restricted");
  args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  return args;
}

function parseClaudeResult(stdout) {
  const text = stdout.toString("utf8").trim();
  if (!text) throw new Error("Claude returned no output.");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    for (const line of text.split(/\r?\n/).reverse()) {
      try {
        const candidate = JSON.parse(line);
        if (candidate && typeof candidate === "object"
          && (candidate.is_error === true
            || (typeof candidate.result === "string" && candidate.result.trim()))) {
          payload = candidate;
          break;
        }
      } catch {
        // Continue looking for terminal JSON.
      }
    }
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Claude returned malformed JSON output.");
  }
  if (payload.is_error === true) {
    throw new Error(typeof payload.result === "string" ? payload.result : "Claude reported an error.");
  }
  if (typeof payload.result !== "string" || !payload.result.trim()) {
    throw new Error("Claude output did not contain a final review result.");
  }
  return payload.result.trim();
}

async function runClaudeReview(options, dependencies = {}) {
  assertSupportedAdapterPlatform();
  if (!options.expectedFingerprint) {
    throw new Error("Claude review requires an expected scope fingerprint.");
  }
  options = {
    ...options,
    expectedFingerprint: options.expectedFingerprint.toLowerCase(),
    fileAccess: normalizeFileAccess(options.fileAccess),
  };
  const deadlineAt = Date.now() + options.timeoutMs;
  const signal = dependencies.signal ?? null;
  const initialFingerprint = await verifyScopeFingerprint(
    options,
    options.expectedFingerprint,
    deadlineAt,
    signal,
  );
  const scope = await resolveScope(options, { deadlineAt, signal });
  const prompt = buildReviewPrompt(
    scope,
    await collectReviewContext(scope, { deadlineAt, signal }),
  );
  const claudeBin = dependencies.claudeBin ?? process.env.JIG_CLAUDE_BIN ?? "claude";
  const allocateProviderTimeout = dependencies.providerTimeout ?? providerTimeout;
  const result = await runCommand(claudeBin, buildClaudeArgs(options), {
    cwd: scope.repoRoot,
    input: prompt,
    timeoutMs: allocateProviderTimeout(deadlineAt, options.timeoutMs),
    maxBuffer: MAX_CLAUDE_OUTPUT_BYTES,
    signal,
  });
  await verifyScopeFingerprint(
    options,
    initialFingerprint.fingerprint,
    deadlineAt,
    signal,
  );
  return parseClaudeResult(result.stdout);
}

async function main() {
  const cancellation = installAdapterCancellation();
  try {
    const report = await runClaudeReview(
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
    const prefix = error.timedOut ? "claude-review timed out" : "claude-review failed";
    process.stderr.write(`${prefix}: ${error.message}\n`);
    process.exitCode = error.timedOut ? 124 : 1;
  });
}

export {
  buildClaudeArgs,
  buildReviewPrompt,
  collectReviewContext,
  parseArgs,
  parseClaudeResult,
  resolveScope,
  runClaudeReview,
};
