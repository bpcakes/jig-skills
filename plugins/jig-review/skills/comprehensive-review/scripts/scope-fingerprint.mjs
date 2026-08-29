#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Linux guarantees /proc/self/fd entries can be used to preserve raw path bytes
// across spawn. Other supported platforms degrade non-UTF-8 submodule coverage
// instead of relying on implementation-specific /dev/fd spawn ordering.
const FD_DIRECTORY = existsSync("/proc/self/fd") ? "/proc/self/fd" : null;
const GIT_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_FINGERPRINT_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 500;
const STDIO_DRAIN_MS = 500;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    scope: null,
    base: null,
    timeoutMs: DEFAULT_FINGERPRINT_TIMEOUT_MS,
  };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--cwd", "--scope", "--base", "--timeout-ms"].includes(argument)) {
      throw new Error(`Unsupported argument: ${argument}`);
    }
    if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    seen.add(argument);
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${argument}`);
    if (argument === "--timeout-ms") {
      options.timeoutMs = Number(value);
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
        throw new Error("--timeout-ms must be a positive integer.");
      }
    } else {
      options[argument.slice(2)] = value;
    }
    index += 1;
  }

  if (!options.scope) throw new Error("Missing required --scope.");
  if (!["working-tree", "branch"].includes(options.scope)) {
    throw new Error("--scope must be working-tree or branch.");
  }
  if (options.scope === "branch" && !options.base) {
    throw new Error("Branch scope requires --base.");
  }
  if (options.scope === "working-tree" && options.base) {
    throw new Error("Working-tree scope does not accept --base.");
  }

  return options;
}

function assertWithinDeadline(deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw Object.assign(
      new Error("fingerprint capture exceeded its deadline"),
      { timedOut: true },
    );
  }
  return remaining;
}

function signalProcessTree(child, signal) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct process when the group already disappeared.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

function runGit(cwd, args, deadlineAt, signal = null) {
  const environment = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error("fingerprint capture cancelled"), { cancelled: true }));
      return;
    }
    let directoryFd = null;
    let child;
    let settled = false;
    let terminalError = null;
    let killTimer = null;
    let hardSettleTimer = null;
    let drainTimer = null;
    let timeoutTimer = null;
    let stdoutBytes = 0;
    let stderr = Buffer.alloc(0);
    const stdout = [];
    let closedDirectoryFd = false;
    let exitCode = null;
    let exitSeen = false;
    const closeDirectoryFd = () => {
      if (directoryFd !== null && !closedDirectoryFd) {
        closeSync(directoryFd);
        closedDirectoryFd = true;
      }
    };
    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (hardSettleTimer) clearTimeout(hardSettleTimer);
      if (drainTimer) clearTimeout(drainTimer);
      signal?.removeEventListener("abort", handleAbort);
      closeDirectoryFd();
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (error) signalProcessTree(child, "SIGKILL");
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      if (exitCode !== 0) {
        const detail = stderr.toString("utf8").trim();
        reject(Object.assign(
          new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ""}`),
          { exitCode },
        ));
        return;
      }
      resolve(Buffer.concat(stdout));
    };
    const closeStdio = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const terminate = (error) => {
      if (!terminalError) terminalError = error;
      signalProcessTree(child, "SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), KILL_GRACE_MS);
      }
      if (!hardSettleTimer) {
        hardSettleTimer = setTimeout(() => {
          signalProcessTree(child, "SIGKILL");
          closeStdio();
          finish(terminalError);
        }, KILL_GRACE_MS + STDIO_DRAIN_MS);
      }
    };
    const handleAbort = () => {
      terminate(signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error("fingerprint capture cancelled"), { cancelled: true }));
    };

    try {
      const timeoutMs = Math.min(GIT_TIMEOUT_MS, assertWithinDeadline(deadlineAt));
      if (Buffer.isBuffer(cwd)) {
        if (!FD_DIRECTORY) {
          throw new Error("Raw-byte Git paths require /proc/self/fd or /dev/fd support.");
        }
        directoryFd = openSync(cwd, "r");
      }
      child = spawn("git", args, {
        cwd: directoryFd === null ? cwd : `${FD_DIRECTORY}/3`,
        env: environment,
        detached: process.platform !== "win32",
        stdio: directoryFd === null
          ? ["ignore", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe", directoryFd],
      });
      timeoutTimer = setTimeout(
        () => terminate(Object.assign(
          new Error(`git ${args[0]} timed out after ${timeoutMs} ms`),
          { timedOut: true },
        )),
        timeoutMs,
      );
    } catch (error) {
      closeDirectoryFd();
      reject(error);
      return;
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_GIT_OUTPUT_BYTES) {
        terminate(Object.assign(
          new Error(`git ${args[0]} output exceeded ${MAX_GIT_OUTPUT_BYTES} bytes`),
          { outputLimit: true },
        ));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      const combined = stderr.length ? Buffer.concat([stderr, chunk]) : Buffer.from(chunk);
      stderr = combined.length <= MAX_ERROR_BYTES
        ? combined
        : combined.subarray(combined.length - MAX_ERROR_BYTES);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      exitSeen = true;
      exitCode = code;
      if (!drainTimer) {
        drainTimer = setTimeout(() => {
          closeStdio();
          finish(terminalError);
        }, STDIO_DRAIN_MS);
      }
    });
    child.on("close", (code) => {
      if (!exitSeen) exitCode = code;
      finish(terminalError);
    });
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) handleAbort();
  });
}

async function gitText(cwd, args, deadlineAt, signal = null) {
  return (await runGit(cwd, args, deadlineAt, signal)).toString("utf8").trim();
}

async function resolveHeadOid(repoRoot, deadlineAt, signal = null) {
  try {
    return await gitText(repoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      "HEAD^{commit}",
    ], deadlineAt, signal);
  } catch (error) {
    if (error.exitCode === 1) return null;
    throw error;
  }
}

function hashField(hash, label, value) {
  hash.update(label, "utf8");
  hash.update("\0", "utf8");
  hash.update(value);
  hash.update("\0", "utf8");
}

function splitNull(buffer) {
  const values = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      if (index > start) values.push(Buffer.from(buffer.subarray(start, index)));
      start = index + 1;
    }
  }
  if (start < buffer.length) values.push(Buffer.from(buffer.subarray(start)));
  return values;
}

function absoluteBufferPath(repoRoot, relativePath) {
  return Buffer.concat([
    Buffer.from(repoRoot),
    Buffer.from(path.sep),
    relativePath,
  ]);
}

function childRepositoryPath(repoRoot, relativePath) {
  const rawPath = absoluteBufferPath(repoRoot, relativePath);
  const roundTripsUtf8 = Buffer.from(relativePath.toString("utf8"), "utf8")
    .equals(relativePath);
  return typeof repoRoot === "string" && roundTripsUtf8
    ? rawPath.toString("utf8")
    : rawPath;
}

function repositoryPathKey(filePath) {
  if (Buffer.isBuffer(filePath)) return `raw:${filePath.toString("hex")}`;
  return realpathSync(filePath, { encoding: "buffer" }).toString("hex");
}

function trimLineEnding(buffer) {
  let end = buffer.length;
  while (end > 0 && (buffer[end - 1] === 10 || buffer[end - 1] === 13)) end -= 1;
  return buffer.subarray(0, end);
}

function sameFileState(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function changedFileError() {
  return Object.assign(
    new Error("fingerprint file changed during capture"),
    { changedDuringCapture: true },
  );
}

function pathIssueReason(error) {
  if (error.changedDuringCapture || ["ENOENT", "ELOOP"].includes(error.code)) {
    return "changed-during-capture";
  }
  if (["EACCES", "EPERM"].includes(error.code)) return "unreadable";
  return "file-read-failed";
}

async function hashFile(filePath, expectedStat, deadlineAt, signal = null) {
  const remaining = assertWithinDeadline(deadlineAt);
  return await new Promise((resolve, reject) => {
    let fileDescriptor;
    try {
      fileDescriptor = openSync(
        filePath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const openedStat = fstatSync(fileDescriptor);
      if (!openedStat.isFile() || !sameFileState(expectedStat, openedStat)) {
        throw changedFileError();
      }
    } catch (error) {
      if (fileDescriptor != null) closeSync(fileDescriptor);
      reject(error);
      return;
    }
    const stream = createReadStream(filePath, { fd: fileDescriptor, autoClose: false });
    const contentHash = createHash("sha256");
    let closed = false;
    const closeFile = () => {
      if (closed) return;
      closeSync(fileDescriptor);
      closed = true;
    };
    const deadlineError = () => Object.assign(
      new Error("fingerprint file hashing exceeded its deadline"),
      { timedOut: true },
    );
    const handleAbort = () => stream.destroy(signal.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error("fingerprint capture cancelled"), { cancelled: true }));
    const timer = setTimeout(
      () => stream.destroy(deadlineError()),
      remaining,
    );
    signal?.addEventListener("abort", handleAbort, { once: true });
    stream.on("data", (chunk) => {
      if (Date.now() >= deadlineAt) {
        stream.destroy(deadlineError());
        return;
      }
      contentHash.update(chunk);
    });
    stream.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
      closeFile();
      reject(error);
    });
    stream.on("end", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
      try {
        const finalStat = fstatSync(fileDescriptor);
        if (!sameFileState(expectedStat, finalStat)) {
          throw changedFileError();
        }
        resolve(contentHash.digest());
      } catch (error) {
        reject(error);
      } finally {
        closeFile();
      }
    });
    if (signal?.aborted) handleAbort();
  });
}

async function hashPathStates(
  hash,
  repoRoot,
  label,
  relativePaths,
  deadlineAt,
  signal = null,
) {
  const issues = [];
  for (const relativePath of relativePaths) {
    assertWithinDeadline(deadlineAt);
    const filePath = absoluteBufferPath(repoRoot, relativePath);
    hashField(hash, `${label}-path`, relativePath);
    let stat;
    try {
      stat = lstatSync(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        hashField(hash, `${label}-kind`, Buffer.from("deleted"));
        if (label === "untracked") {
          issues.push({
            path: displayRawPath(relativePath),
            reason: "changed-during-capture",
          });
        }
        continue;
      }
      const reason = pathIssueReason(error);
      hashField(hash, `${label}-kind`, Buffer.from("unavailable"));
      hashField(hash, `${label}-issue`, Buffer.from(reason));
      issues.push({ path: displayRawPath(relativePath), reason });
      continue;
    }

    hashField(hash, `${label}-mode`, Buffer.from(stat.mode.toString(8)));
    if (stat.isSymbolicLink()) {
      hashField(hash, `${label}-kind`, Buffer.from("symlink"));
      try {
        hashField(hash, `${label}-target`, readlinkSync(filePath, { encoding: "buffer" }));
      } catch (error) {
        const reason = pathIssueReason(error);
        hashField(hash, `${label}-issue`, Buffer.from(reason));
        issues.push({ path: displayRawPath(relativePath), reason });
      }
    } else if (stat.isFile()) {
      hashField(hash, `${label}-kind`, Buffer.from("file"));
      try {
        const digest = await hashFile(filePath, stat, deadlineAt, signal);
        hashField(hash, `${label}-content-sha256`, digest);
      } catch (error) {
        if (error.timedOut || error.cancelled) throw error;
        const reason = pathIssueReason(error);
        hashField(hash, `${label}-issue`, Buffer.from(reason));
        issues.push({ path: displayRawPath(relativePath), reason });
      }
    } else if (stat.isDirectory()) {
      hashField(hash, `${label}-kind`, Buffer.from("directory"));
      if (label === "untracked") {
        issues.push({ path: displayRawPath(relativePath), reason: "untracked-directory" });
      }
    } else {
      hashField(hash, `${label}-kind`, Buffer.from("special"));
    }
  }
  return issues;
}

function gitlinkEntries(indexEntries) {
  const entries = new Map();
  for (const entry of splitNull(indexEntries)) {
    const separator = entry.indexOf(9);
    if (separator < 0) continue;
    const header = entry.subarray(0, separator).toString("ascii");
    if (!header.startsWith("160000 ")) continue;
    const relativePath = Buffer.from(entry.subarray(separator + 1));
    const oid = header.split(" ")[1];
    entries.set(relativePath.toString("hex"), { oid, relativePath });
  }
  return [...entries.values()].sort((left, right) => (
    Buffer.compare(left.relativePath, right.relativePath)
  ));
}

function displayRawPath(rawPath) {
  const decoded = rawPath.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(rawPath)
    ? decoded
    : `raw-path:${rawPath.toString("hex")}`;
}

function parseNullConfigEntries(output) {
  return splitNull(output).map((entry) => {
    const separator = entry.indexOf(10);
    if (separator < 0) return null;
    return {
      key: entry.subarray(0, separator).toString("utf8"),
      value: Buffer.from(entry.subarray(separator + 1)),
    };
  }).filter(Boolean);
}

async function registeredSubmodulePaths(repoRoot, deadlineAt, signal = null) {
  // `git submodule init` registers a submodule by copying its URL into the
  // superproject's local config; `deinit` removes that section again.
  let configuredUrls;
  try {
    configuredUrls = await runGit(repoRoot, [
      "config",
      "--null",
      "--local",
      "--get-regexp",
      "^submodule\\..*\\.url$",
    ], deadlineAt, signal);
  } catch (error) {
    if (error.exitCode === 1) return new Set();
    throw error;
  }

  let configuredPaths;
  try {
    configuredPaths = await runGit(repoRoot, [
      "config",
      "--null",
      "--file",
      ".gitmodules",
      "--get-regexp",
      "^submodule\\..*\\.path$",
    ], deadlineAt, signal);
  } catch (error) {
    if (error.exitCode === 1) return new Set();
    throw error;
  }

  const registeredNames = new Set(parseNullConfigEntries(configuredUrls)
    .map(({ key }) => key.match(/^submodule\.(.*)\.url$/i)?.[1])
    .filter((name) => name != null));
  return new Set(parseNullConfigEntries(configuredPaths)
    .filter(({ key }) => registeredNames.has(key.match(/^submodule\.(.*)\.path$/i)?.[1]))
    .map(({ value }) => value.toString("hex")));
}

async function hashTrackedSubmodules(
  hash,
  repoRoot,
  visitedRoots,
  indexEntries,
  deadlineAt,
  signal = null,
) {
  const entries = gitlinkEntries(indexEntries);
  const registeredPaths = entries.length > 0
    ? await registeredSubmodulePaths(repoRoot, deadlineAt, signal)
    : new Set();
  let hasChanges = false;
  let submoduleCount = 0;
  const issues = [];

  for (const { oid: expectedOid, relativePath } of entries) {
    assertWithinDeadline(deadlineAt);
    hashField(hash, "submodule-path", relativePath);
    hashField(hash, "submodule-index-oid", Buffer.from(expectedOid));
    const submodulePath = childRepositoryPath(repoRoot, relativePath);
    let stat;
    try {
      stat = lstatSync(submodulePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        const registered = registeredPaths.has(relativePath.toString("hex"));
        hashField(hash, "submodule-state", Buffer.from(
          registered ? "registered-worktree-missing" : "absent",
        ));
        if (registered) {
          issues.push({
            path: displayRawPath(relativePath),
            reason: "registered-submodule-worktree-missing",
          });
          hasChanges = true;
        }
        continue;
      }
      throw error;
    }

    if (!stat.isDirectory()) {
      hashField(hash, "submodule-state", Buffer.from("not-directory"));
      issues.push({
        path: displayRawPath(relativePath),
        reason: "submodule-path-not-directory",
      });
      hasChanges = true;
      continue;
    }

    try {
      const prefix = trimLineEnding(
        await runGit(submodulePath, ["rev-parse", "--show-prefix"], deadlineAt, signal),
      );
      if (prefix.length > 0) {
        const registered = registeredPaths.has(relativePath.toString("hex"));
        hashField(hash, "submodule-state", Buffer.from(
          registered ? "registered-worktree-missing" : "uninitialized",
        ));
        if (registered) {
          issues.push({
            path: displayRawPath(relativePath),
            reason: "registered-submodule-worktree-missing",
          });
          hasChanges = true;
        }
        continue;
      }
      const canonicalRootKey = repositoryPathKey(submodulePath);
      if (visitedRoots.has(canonicalRootKey)) {
        hashField(hash, "submodule-state", Buffer.from("cycle"));
        continue;
      }

      hashField(hash, "submodule-state", Buffer.from("initialized"));
      const submoduleHead = await gitText(submodulePath, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        "HEAD^{commit}",
      ], deadlineAt, signal);
      hashField(hash, "submodule-head", Buffer.from(submoduleHead));
      const result = await workingTreeFingerprint(
        submodulePath,
        submoduleHead,
        visitedRoots,
        deadlineAt,
        signal,
      );
      hashField(hash, "submodule-fingerprint", Buffer.from(result.fingerprint));
      hasChanges ||= submoduleHead !== expectedOid || result.hasChanges;
      submoduleCount += 1 + result.submoduleCount;
      const displayPath = displayRawPath(relativePath);
      issues.push(...result.issues.map((issue) => ({
        ...issue,
        path: issue.path ? `${displayPath}/${issue.path}` : displayPath,
      })));
    } catch (error) {
      if (error.timedOut || error.outputLimit || error.cancelled) throw error;
      hashField(hash, "submodule-state", Buffer.from("unavailable"));
      const displayPath = displayRawPath(relativePath);
      issues.push({ path: displayPath, reason: "submodule-unavailable" });
      hasChanges = true;
    }
  }

  return { hasChanges, submoduleCount, issues };
}

async function workingTreeFingerprint(
  repoRoot,
  headOid,
  visitedRoots = new Set(),
  deadlineAt = Date.now() + DEFAULT_FINGERPRINT_TIMEOUT_MS,
  signal = null,
) {
  assertWithinDeadline(deadlineAt);
  visitedRoots.add(repositoryPathKey(repoRoot));
  const hash = createHash("sha256");
  hashField(hash, "scope", Buffer.from("working-tree"));
  hashField(hash, "head", Buffer.from(headOid ?? "unborn"));

  const status = await runGit(repoRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=all",
  ], deadlineAt, signal);
  hashField(hash, "status", status);

  const indexEntries = await runGit(
    repoRoot,
    ["ls-files", "--stage", "-z"],
    deadlineAt,
    signal,
  );
  hashField(hash, "index-entries", indexEntries);

  const staged = await runGit(repoRoot, [
    "diff",
    "--cached",
    "--name-only",
    "--no-ext-diff",
    "--no-textconv",
    "-z",
  ], deadlineAt, signal);
  hashField(hash, "staged-paths", staged);

  const unstaged = splitNull(await runGit(repoRoot, [
    "diff",
    "--name-only",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=all",
    "-z",
  ], deadlineAt, signal)).sort(Buffer.compare);
  const pathIssues = await hashPathStates(
    hash,
    repoRoot,
    "unstaged",
    unstaged,
    deadlineAt,
    signal,
  );

  const untracked = splitNull(await runGit(repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ], deadlineAt, signal)).sort(Buffer.compare);

  pathIssues.push(...await hashPathStates(
    hash,
    repoRoot,
    "untracked",
    untracked,
    deadlineAt,
    signal,
  ));

  const submodules = await hashTrackedSubmodules(
    hash,
    repoRoot,
    visitedRoots,
    indexEntries,
    deadlineAt,
    signal,
  );
  const issues = [...pathIssues, ...submodules.issues];

  return {
    scope: "working-tree",
    repoRoot,
    headOid,
    baseOid: null,
    mergeBaseOid: null,
    hasChanges: status.length > 0 || staged.length > 0 || submodules.hasChanges,
    submoduleCount: submodules.submoduleCount,
    complete: issues.length === 0,
    issues,
    fingerprint: hash.digest("hex"),
  };
}

async function branchFingerprint(repoRoot, headOid, baseRef, deadlineAt, signal = null) {
  if (!headOid) {
    throw new Error("Branch scope requires HEAD to resolve to a commit; use working-tree scope for an unborn repository.");
  }
  const baseOid = await gitText(repoRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${baseRef}^{commit}`,
  ], deadlineAt, signal);
  const mergeBaseOid = await gitText(
    repoRoot,
    ["merge-base", headOid, baseOid],
    deadlineAt,
    signal,
  );
  const changedPaths = await runGit(repoRoot, [
    "diff",
    "--name-only",
    "-z",
    `${mergeBaseOid}..${headOid}`,
  ], deadlineAt, signal);
  const checkout = await workingTreeFingerprint(
    repoRoot,
    headOid,
    new Set(),
    deadlineAt,
    signal,
  );
  const hash = createHash("sha256");
  hashField(hash, "scope", Buffer.from("branch"));
  hashField(hash, "head", Buffer.from(headOid));
  hashField(hash, "base", Buffer.from(baseOid));
  hashField(hash, "merge-base", Buffer.from(mergeBaseOid));
  hashField(hash, "checkout-fingerprint", Buffer.from(checkout.fingerprint));

  return {
    scope: "branch",
    repoRoot,
    headOid,
    baseOid,
    mergeBaseOid,
    hasChanges: changedPaths.length > 0,
    checkoutClean: !checkout.hasChanges,
    submoduleCount: checkout.submoduleCount,
    complete: checkout.complete,
    issues: checkout.issues,
    fingerprint: hash.digest("hex"),
  };
}

async function captureFingerprint(options) {
  const deadlineAt = Date.now() + (options.timeoutMs ?? DEFAULT_FINGERPRINT_TIMEOUT_MS);
  const repoRoot = await gitText(
    options.cwd,
    ["rev-parse", "--show-toplevel"],
    deadlineAt,
    options.signal,
  );
  const headOid = await resolveHeadOid(repoRoot, deadlineAt, options.signal);
  return options.scope === "working-tree"
    ? await workingTreeFingerprint(repoRoot, headOid, new Set(), deadlineAt, options.signal)
    : await branchFingerprint(repoRoot, headOid, options.base, deadlineAt, options.signal);
}

async function main() {
  const controller = new AbortController();
  let parentSignal = null;
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (parentSignal) return;
      parentSignal = signal;
      controller.abort(Object.assign(
        new Error(`fingerprint capture received ${signal}`),
        { cancelled: true, parentSignal: signal },
      ));
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  try {
    const result = await captureFingerprint({
      ...parseArgs(process.argv.slice(2)),
      signal: controller.signal,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    if (parentSignal && !error.parentSignal) error.parentSignal = parentSignal;
    throw error;
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
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
    process.stderr.write(`scope-fingerprint: ${error.message}\n`);
    process.exitCode = error.timedOut ? 124 : 1;
  });
}

export {
  captureFingerprint,
  parseArgs,
};
