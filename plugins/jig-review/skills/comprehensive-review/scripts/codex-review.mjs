#!/usr/bin/env node

import { readBrief } from "./review-brief.mjs";

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
  remainingAdapterTime,
  verifyScopeFingerprint,
} from "./adapter-runtime.mjs";

const DEFAULT_TIMEOUT_MS = 28 * 60 * 1000;
const MAX_CODEX_OUTPUT_BYTES = 4 * 1024 * 1024;
const LAST_MESSAGE_FILE = "codex-last-message.txt";
const PRIVATE_HOME_DIR = "codex-home";
const SHIM_FILE = "codex-shim.sh";
const MAX_TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

// Only Codex's own error channel decides failures; the shim's startup message
// below is recognized by the bridge as a permanent configuration failure.
const MISSING_CREDENTIALS = "the Codex CLI reviewer requires file-based credentials in the selected home";

const RENDER_TIMEOUT_MS = 60 * 1000;
const MAX_RENDER_BYTES = 64 * 1024 * 1024;
const PROJECT_DOC_OVERRIDES = Object.freeze(["-c", "project_doc_max_bytes=0"]);

function renderedText(value, parts = []) {
  if (typeof value === "string") parts.push(value);
  else if (Array.isArray(value)) for (const item of value) renderedText(item, parts);
  else if (value && typeof value === "object") for (const item of Object.values(value)) renderedText(item, parts);
  return parts.join("\n");
}

// Codex's own renderer is the authority on what it would load for this working
// directory, home, and configuration. Rendering needs no credentials or network.
async function renderPrompt(codexBin, { cwd, privateHome, overrides, deadlineAt, signal, environment }) {
  const result = await runCommand(codexBin, ["debug", "prompt-input", ...overrides, "isolation check"], {
    cwd,
    timeoutMs: Math.min(RENDER_TIMEOUT_MS, remainingAdapterTime(deadlineAt)),
    maxBuffer: MAX_RENDER_BYTES,
    signal,
    env: { ...environment, CODEX_HOME: privateHome },
  });
  try {
    return renderedText(JSON.parse(result.stdout.toString("utf8")));
  } catch {
    throw isolationError("codex debug prompt-input did not return a JSON prompt rendering.");
  }
}

// Skills are listed as "(file: rN/relative/SKILL.md)" under a roots table of
// "- `rN` = `absolute root`" lines.
function listedSkills(text) {
  const roots = new Map();
  for (const match of text.matchAll(/^- `(r\d+)` = `(.+)`$/gm)) roots.set(match[1], match[2]);
  const files = [];
  for (const match of text.matchAll(/\(file: (r\d+)\/([^)]+)\)/g)) {
    const root = roots.get(match[1]);
    files.push(root ? path.join(root, match[2]) : `${match[1]}/${match[2]}`);
  }
  return files;
}

function within(file, directory) {
  const relative = path.relative(directory, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Everything Codex lists outside the private home is ambient: repository,
// user, or system skills. Codex's embedded skills live inside the private home.
function ambientSkills(text, privateHome) {
  let home = path.resolve(privateHome);
  try {
    home = realpathSync(privateHome);
  } catch {
    // The directory is created before rendering; fall back to the given path.
  }
  return [...new Set(listedSkills(text).filter((file) => {
    let real = file;
    try {
      real = realpathSync(file);
    } catch {
      // A listed but unreadable path is still ambient.
    }
    return !within(file, home) && !within(real, home);
  }))].sort();
}

function instructionsLoaded(text) {
  return /^# AGENTS\.md instructions for /m.test(text);
}

// Configuration overrides that keep ambient instructions out of the reviewer:
// no project AGENTS.md files, and every listed ambient skill disabled by its
// SKILL.md path, which is how skills.config identifies a skill.
function isolationOverrides(skillFiles = []) {
  const overrides = [...PROJECT_DOC_OVERRIDES];
  const files = [...new Set(skillFiles)].sort();
  if (files.length) {
    overrides.push("-c", `skills.config=[${files.map((file) => `{path=${JSON.stringify(file)},enabled=false}`).join(",")}]`);
  }
  return overrides;
}

function isolationError(message) {
  return Object.assign(new Error(`Codex isolation incomplete: ${message}`), { providerError: `Codex isolation incomplete: ${message}` });
}

// Ask Codex what it would load, disable all of it, then prove that only its own
// embedded skills and no AGENTS.md instructions remain. Fails closed.
async function isolate(codexBin, context) {
  let baseline;
  try {
    baseline = await renderPrompt(codexBin, { ...context, overrides: PROJECT_DOC_OVERRIDES });
  } catch (error) {
    throw classifyFailure(error, Buffer.alloc(0));
  }
  const overrides = isolationOverrides(ambientSkills(baseline, context.privateHome));
  let verification;
  try {
    verification = await renderPrompt(codexBin, { ...context, overrides });
  } catch (error) {
    throw classifyFailure(error, Buffer.alloc(0));
  }
  const leftover = ambientSkills(verification, context.privateHome);
  if (leftover.length) throw isolationError(`Codex still lists skills outside the private home: ${leftover.join(", ")}`);
  if (instructionsLoaded(verification)) throw isolationError("AGENTS.md instructions still load.");
  return overrides;
}

// Jig and the adapter both start Codex through this shim. For `exec` it swaps in
// a private CODEX_HOME holding only a symlink to the selected home's auth.json,
// so credentials (including refreshed tokens, which Codex writes in place) stay
// with the real home while its instructions, skills, and configuration do not
// reach the reviewer. Jig's usage inspection and any other invocation pass
// through unchanged.
const SHIM_PROBE = "--jig-review-probe";
const SHIM = `#!/bin/sh
# Generated by codex-review.mjs for one review; removed with its evidence directory.
set -u
if [ "\${1:-}" = "${SHIM_PROBE}" ]; then
  exit 0
fi
real="$JIG_REVIEW_CODEX_BIN"
if [ "\${1:-}" != "exec" ]; then
  exec "$real" "$@"
fi
source_home="\${CODEX_HOME:-$HOME/.codex}"
private="$JIG_REVIEW_PRIVATE_HOME"
if [ ! -f "$source_home/auth.json" ]; then
  printf 'codex-review: the selected Codex home has no auth.json; ${MISSING_CREDENTIALS} (not logged in, or keyring storage)\n' >&2
  exit 1
fi
ln -sfn "$source_home/auth.json" "$private/auth.json" || exit 1
CODEX_HOME="$private" exec "$real" "$@"
`;

// Jig can only start an executable, so under a launcher the shim must run from
// the evidence directory. A noexec temporary filesystem makes that fail with
// EACCES on every attempt; detect it once and fail as a configuration error.
const SHIM_NOT_EXECUTABLE = "the evidence directory does not permit executing the launcher shim (noexec temporary filesystem?); set TMPDIR to an executable location or use --launcher none";
async function probeShim(shim, { deadlineAt, signal }) {
  try {
    await runCommand(shim, [SHIM_PROBE], { timeoutMs: Math.min(RENDER_TIMEOUT_MS, remainingAdapterTime(deadlineAt)), signal, env: gitEnvironment(childEnvironment(process.env)) });
  } catch (error) {
    if (error.timedOut || error.cancelled) throw error;
    throw Object.assign(new Error(`${SHIM_NOT_EXECUTABLE}: ${error.message}`), { providerError: SHIM_NOT_EXECUTABLE });
  }
}

function writeShim(directory) {
  const shim = path.join(directory, SHIM_FILE);
  writeFileSync(shim, SHIM, { mode: 0o700 });
  chmodSync(shim, 0o700);
  const privateHome = path.join(directory, PRIVATE_HOME_DIR);
  mkdirSync(privateHome, { mode: 0o700 });
  return { shim, privateHome };
}

function tailBuffer(previous, chunk, limit) {
  const combined = previous.length ? Buffer.concat([previous, chunk]) : Buffer.from(chunk);
  return combined.length <= limit ? combined : combined.subarray(combined.length - limit);
}

// With --json, stdout carries Codex's JSONL event stream. A partial first line
// after tail truncation is skipped like any other non-JSON line.
function parseEvents(buffer) {
  const events = [];
  for (const line of buffer.toString("utf8").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      const event = JSON.parse(text);
      if (event && typeof event === "object") events.push(event);
    } catch {
      // Not a complete event line.
    }
  }
  return events;
}

function structuredErrors(events) {
  return events
    .filter((event) => event.type === "error" || event.type === "turn.failed")
    .map((event) => event.message ?? event.error?.message ?? event.error)
    .filter((message) => typeof message === "string" && message.trim());
}

// Only Codex's own error events classify a failure. Once a thread has started,
// stderr and the rest of the event stream are transcript, including command
// output quoted from the repository, so a mentioned "quota exceeded" or ENOENT
// there must not disable the provider. Before any event exists, stderr is the
// launcher's or CLI's startup diagnostic and remains the failure message.
function classifyFailure(error, transcript) {
  const events = parseEvents(transcript);
  if (!events.length) {
    error.providerError = error.stderr || error.message;
    return error;
  }
  const structured = structuredErrors(events);
  error.transcript = error.stderr ?? "";
  error.providerError = structured.join("\n");
  const status = /exited with (signal \S+|\S+?)(?::|$)/.exec(error.message)?.[1];
  if (status && !error.timedOut && !error.cancelled) {
    error.message = `codex exited with ${status}${structured.length
      ? `: ${structured.join("; ")}`
      : "; no structured provider error was reported (see transcript)"}`;
  }
  return error;
}

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

// A read-only, ephemeral, configuration-independent Codex session. The private
// home carries only credentials, user configuration and execpolicy rules are
// ignored, and the isolation overrides disable project instructions and every
// ambient skill, so neither the selected home nor the reviewed repository can
// add instructions or widen command approval past the read-only sandbox, which
// denies writes and network access. --json keeps the event stream on stdout for
// failure classification.
function buildCodexArgs(options, scope, lastMessagePath, overrides = isolationOverrides()) {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    ...overrides,
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
    const { shim, privateHome } = writeShim(evidence.directory);
    const overrides = await isolate(codexBin, {
      cwd: scope.repoRoot, privateHome, deadlineAt, signal, environment: gitEnvironment(childEnvironment(process.env)),
    });
    // Without a launcher the shim is read by /bin/sh, so the evidence directory
    // need not be executable; Jig has to exec it, so that path is probed first.
    const launched = options.launcher !== "none";
    if (launched) await probeShim(shim, { deadlineAt, signal });
    const codexArgs = buildCodexArgs(options, scope, lastMessagePath, overrides);
    const launch = resolveProviderLaunch({
      provider: "codex",
      launcher: options.launcher,
      executable: launched ? shim : "/bin/sh",
      args: launched ? codexArgs : [shim, ...codexArgs],
      inherited: process.env,
      jigBin: dependencies.jigBin ?? null,
    });
    // JIG_CODEX_BIN makes Jig start the shim; the shim finds the real executable
    // and the private home through the JIG_REVIEW_* variables.
    const environment = childEnvironment(process.env, {
      JIG_CODEX_BIN: shim,
      JIG_REVIEW_CODEX_BIN: codexBin,
      JIG_REVIEW_PRIVATE_HOME: privateHome,
    });
    const allocateProviderTimeout = dependencies.providerTimeout ?? providerTimeout;
    let transcript = Buffer.alloc(0);
    try {
      await runCommand(launch.command, launch.args, {
        cwd: scope.repoRoot,
        input: prompt,
        timeoutMs: allocateProviderTimeout(deadlineAt, options.timeoutMs),
        maxBuffer: MAX_CODEX_OUTPUT_BYTES,
        overflow: "truncate",
        onStdout: (chunk) => { transcript = tailBuffer(transcript, chunk, MAX_TRANSCRIPT_TAIL_BYTES); },
        signal,
        env: gitEnvironment(environment),
      });
    } catch (error) {
      throw classifyFailure(error, transcript);
    }
    await verifyScopeFingerprint(options, initialFingerprint.fingerprint, deadlineAt, signal);
    let report;
    try {
      report = parseCodexResult(lastMessagePath);
    } catch (error) {
      throw classifyFailure(error, transcript);
    }
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
  MISSING_CREDENTIALS,
  SHIM_NOT_EXECUTABLE,
  ambientSkills,
  buildCodexArgs,
  classifyFailure,
  instructionsLoaded,
  isolate,
  isolationOverrides,
  listedSkills,
  parseArgs,
  parseCodexResult,
  probeShim,
  renderPrompt,
  runCodexReview,
  writeShim,
};
