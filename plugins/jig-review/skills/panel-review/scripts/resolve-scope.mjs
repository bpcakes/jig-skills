#!/usr/bin/env node

// Turns the user's scope flags into the concrete arguments that the fingerprint
// helper and every adapter accept. The rules in references/scope.md are applied
// here once, rather than re-derived from prose on every run.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runGit } from "./scope-fingerprint.mjs";
import { installSignalCancellation } from "./signal-cancellation.mjs";

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const SCOPES = new Set(["auto", "working-tree", "branch"]);
const FLAGS = new Set(["--cwd", "--scope", "--base", "--include-working-tree", "--wait"]);
const DEFAULT_BRANCH_NAMES = Object.freeze(["main", "master", "trunk"]);

function parseArgs(argv) {
  const options = { cwd: process.cwd(), scope: null, base: null, includeWorkingTree: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!FLAGS.has(argument)) throw new Error(`Unsupported argument: ${argument}`);
    if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    seen.add(argument);
    if (argument === "--include-working-tree") {
      options.includeWorkingTree = true;
      continue;
    }
    // Accepted for compatibility; it selects nothing.
    if (argument === "--wait") continue;
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${argument}`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  return validate(options);
}

// Everything here is decided from the arguments alone, before Git is inspected,
// so the same command cannot become valid or invalid as the checkout changes.
function validate(options) {
  if (options.scope != null && !SCOPES.has(options.scope)) {
    throw new Error("--scope must be auto, working-tree, or branch.");
  }
  if (options.base != null && options.scope === "working-tree") {
    throw new Error("--base selects branch scope and cannot be combined with --scope working-tree.");
  }
  if (options.includeWorkingTree && options.scope === "auto") {
    throw new Error("--include-working-tree cannot be combined with --scope auto; use --scope branch --include-working-tree or --base <ref> --include-working-tree.");
  }
  if (options.includeWorkingTree && options.scope !== "branch" && options.base == null) {
    throw new Error("--include-working-tree requires branch scope; add --scope branch or --base <ref>.");
  }
  return options;
}

async function resolveReviewScope(options) {
  options = validate({ scope: null, base: null, includeWorkingTree: false, ...options });
  const deadlineAt = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const git = (cwd, args) => runGit(cwd, args, deadlineAt, options.signal ?? null);
  const repoRoot = (await git(options.cwd, ["rev-parse", "--show-toplevel"])).toString("utf8").trim();

  // The commit a ref names, or null when Git found none, which `rev-parse
  // --verify --quiet` reports as status 1. For a ref this helper chose, any
  // other status is a Git failure, such as an unreadable object, and fails the
  // resolution rather than passing for an absent ref: detection would go on to
  // another base. A base the user named may be an expression Git rejects with
  // another status; it names no commit either way. Deadlines and cancellation
  // carry no exit status and always fail the resolution.
  const commit = async (ref, { named = false } = {}) => {
    try {
      return (await git(repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]))
        .toString("utf8").trim() || null;
    } catch (error) {
      if (error.exitCode === 1 || (named && error.exitCode != null)) return null;
      throw error;
    }
  };
  const hasLocalChanges = async () => {
    try {
      return (await git(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length > 0;
    } catch (error) {
      // Status too large to hold is itself evidence of local changes.
      if (error.outputLimit) return true;
      throw error;
    }
  };
  // The checked-out branch as a full ref, or null on a detached HEAD.
  const currentBranch = async () => {
    try {
      return (await git(repoRoot, ["symbolic-ref", "--quiet", "HEAD"])).toString("utf8").trim() || null;
    } catch (error) {
      if (error.exitCode == null) throw error;
      return null;
    }
  };
  const defaultBranch = async () => {
    const candidates = [];
    try {
      const target = (await git(repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).toString("utf8").trim();
      if (target) candidates.push({ baseRef: target, baseSource: "origin-head" });
    } catch (error) {
      if (error.exitCode == null) throw error;
    }
    // A local branch is preferred over its origin/<name> counterpart, except
    // for the checked-out branch: compared with itself it has no diff, so with
    // unpushed commits its base is origin/<name>. Only that pair changes order.
    // Without origin/<name> the branch is still its own base, ahead of the
    // later names: a leftover `master` is not what `main` was branched from.
    const current = await currentBranch();
    for (const name of DEFAULT_BRANCH_NAMES) {
      const local = `refs/heads/${name}`;
      const remote = `refs/remotes/origin/${name}`;
      for (const baseRef of local === current ? [remote, local] : [local, remote]) {
        candidates.push({ baseRef, baseSource: "default-branch-name" });
      }
    }
    for (const candidate of candidates) {
      const base = await commit(candidate.baseRef);
      if (base) return { ...candidate, base };
    }
    throw new Error("Cannot detect the default branch (no origin/HEAD, main, master, or trunk); pass --base <ref> or --scope working-tree.");
  };

  const headOid = await commit("HEAD");
  let scope = options.scope ?? "working-tree";
  let scopeSource = options.scope == null ? "default" : "option";
  if (options.base != null) {
    scope = "branch";
    scopeSource = "base";
  } else if (scope === "auto") {
    const dirty = !headOid || await hasLocalChanges();
    scope = dirty ? "working-tree" : "branch";
    scopeSource = dirty ? "auto-local-changes" : "auto-clean-checkout";
  }

  if (scope === "working-tree") {
    return {
      repoRoot, scope, scopeSource, base: null, baseRef: null, baseSource: null,
      includeWorkingTree: false, arguments: ["--scope", "working-tree"],
    };
  }
  if (!headOid) {
    throw new Error("Branch scope requires HEAD to resolve to a commit; use --scope working-tree for an unborn repository.");
  }
  let selected;
  if (options.base != null) {
    const base = await commit(options.base, { named: true });
    // A named base is the user's choice; never fall back to a detected one.
    if (!base) throw new Error(`Invalid --base ${JSON.stringify(options.base)}: it does not resolve to a commit.`);
    selected = { base, baseRef: options.base, baseSource: "option" };
  } else {
    selected = await defaultBranch();
  }
  return {
    repoRoot, scope, scopeSource, ...selected, includeWorkingTree: options.includeWorkingTree,
    arguments: ["--scope", "branch", "--base", selected.base, ...(options.includeWorkingTree ? ["--include-working-tree"] : [])],
  };
}

const isMain = process.argv[1]
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  // Git runs in its own process group; a signal stops it before ending this one.
  const cancellation = installSignalCancellation({ subject: "scope resolution" });
  try {
    const result = await resolveReviewScope({ ...parseArgs(process.argv.slice(2)), signal: cancellation.signal });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    if (!cancellation.parentSignal) {
      process.stderr.write(`resolve-scope: ${error.message}\n`);
      process.exitCode = error.timedOut ? 124 : 1;
    }
  } finally {
    cancellation.dispose();
  }
  if (cancellation.parentSignal) process.kill(process.pid, cancellation.parentSignal);
}

export { parseArgs, resolveReviewScope };
