import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gitEnvironment } from "../../comprehensive-review/scripts/git-environment.mjs";
import { isExcludedPath } from "../../comprehensive-review/scripts/review-exclusions.mjs";
import { git, snapshot, sameContent, unsupported } from "./repository.mjs";
import { hash, readBlob, save, storeBlob } from "./run-store.mjs";

const textGit = (root, ...args) => git(root, ...args).toString().trim();
const names = bytes => bytes.toString().split("\0").filter(Boolean);
const fileHash = file => existsSync(file) ? hash(readFileSync(file)) : null;
// The reviewed snapshot includes executable bits even when the user's normal
// Git commands ignore them. Publication must detect and record that same tree.
export const checkoutDirty = root => git(root, "-c", "core.filemode=true", "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none").length > 0;

export function assertNoGitOperation(root) {
  const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"];
  const paths = textGit(root, "rev-parse", "--path-format=absolute", ...markers.flatMap(marker => ["--git-path", marker])).split("\n");
  for (let i = 0; i < markers.length; i++) if (existsSync(paths[i])) {
    throw unsupported(`Unfinished Git operation (${markers[i]}); finish or abort it before per-round commits.`);
  }
}

export function assertCommitScope(root, current, exclusions) {
  assertNoGitOperation(root);
  if (!current.repositories[""].head) throw unsupported("Per-round commits require an existing HEAD; use --commit-mode none for an unborn repository.");
  const dirty = new Set([...names(git(root, "-c", "core.filemode=true", "diff", "HEAD", "--ignore-submodules=none", "--name-only", "--no-renames", "-z")),
    ...names(git(root, "-c", "core.filemode=true", "diff", "--cached", "HEAD", "--ignore-submodules=none", "--name-only", "--no-renames", "-z")),
    ...names(git(root, "ls-files", "--others", "--exclude-standard", "-z"))]);
  // The commit must describe all included checkout inputs. Never sweep an
  // excluded edit or nested working tree into a parent repository's commit.
  for (const name of dirty) if (isExcludedPath(name, exclusions)) throw unsupported(`Dirty excluded path ${name}; preserve it with --commit-mode none or separate it before starting a commit run.`);
  for (const prefix of Object.keys(current.repositories).filter(Boolean)) {
    if (checkoutDirty(path.join(root, prefix))) throw unsupported(`Dirty submodule ${prefix}; use --commit-mode none or settle its work before a commit run.`);
  }
  for (const item of names(git(root, "ls-files", "--stage", "-z"))) {
    if (item.startsWith("160000 ") && dirty.has(item.slice(item.indexOf("\t") + 1))) throw unsupported("Changed submodule gitlinks require --commit-mode none.");
  }
  if (names(git(root, "ls-files", "-v", "-z")).some(item => item[0] === "S" || /[a-z]/.test(item[0]))) {
    throw unsupported("Per-round commits cannot publish skip-worktree or assume-unchanged entries; use --commit-mode none.");
  }
  // Fail before changing HEAD/index when Git cannot create a local commit.
  textGit(root, "var", "GIT_AUTHOR_IDENT");
  textGit(root, "var", "GIT_COMMITTER_IDENT");
}

function privateGit(run, index, args, input) {
  return execFileSync("git", args, { cwd: run.root, env: { ...gitEnvironment(), GIT_INDEX_FILE: index },
    input, maxBuffer: 64 * 1024 * 1024, timeout: 30000, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
}

export function prepareRoundCommit(run, message) {
  if (run.commitJournal || !checkoutDirty(run.root)) return;
  if (run.commits.some(commit => commit.round === run.round)) {
    throw new Error("This round already has a commit; later source changes remain uncommitted. Another counted repair round is required; no extra commit or history rewrite was performed.");
  }
  const current = snapshot(run.root, undefined, { maxBytes: run.config.storage.maxSourceBytes });
  if (current.guard !== run.expected.guard) throw new Error("Checkout changed before commit preparation.");
  assertCommitScope(run.root, current, run.fingerprint.excludePaths);
  const index = path.join(run.directory, `commit-index-${run.sequence}-${run.round}`);
  const parent = current.repositories[""].head;
  try {
    rmSync(index, { force: true });
    // Preserve membership (including staged ignored additions), but discard
    // stat caches: copying an index with a newer mtime can conceal racy-clean
    // same-size edits. A zero-stat index forces add to read the actual files.
    privateGit(run, index, ["read-tree", "--empty"]);
    privateGit(run, index, ["update-index", "-z", "--index-info"], git(run.root, "ls-files", "--stage", "-z"));
    privateGit(run, index, ["-c", "core.filemode=true", "add", "-A", "--", "."]);
    for (const name of names(privateGit(run, index, ["diff", "--cached", "HEAD", "--name-only", "--no-renames", "-z"]))) {
      if (isExcludedPath(name, run.fingerprint.excludePaths)) throw new Error(`Commit would include excluded path ${name}; HEAD and source index were not changed.`);
    }
    const tree = privateGit(run, index, ["write-tree"]).toString().trim();
    const oldTree = textGit(run.root, "rev-parse", `${parent}^{tree}`);
    // A staged-only change with working files restored to HEAD still needs an
    // index publication, but must not manufacture an empty commit.
    let oid = parent;
    if (tree !== oldTree) {
      let signing = false;
      try { signing = textGit(run.root, "config", "--bool", "commit.gpgsign") === "true"; } catch {}
      oid = privateGit(run, index, ["commit-tree", tree, "-p", parent, ...(signing ? ["-S"] : [])], `${message}\n`).toString().trim();
    }
    const after = snapshot(run.root, undefined, { maxBytes: run.config.storage.maxSourceBytes });
    if (after.guard !== current.guard) throw new Error("Checkout changed while preparing a round commit; HEAD and index were not published.");
    const indexPath = current.repositories[""].indexPath;
    run.commitJournal = { parent, oid, tree, message, round: run.round, branch: current.repositories[""].branch,
      indexPath, oldIndex: existsSync(indexPath) ? storeBlob(run.directory, readFileSync(indexPath)) : null,
      newIndex: storeBlob(run.directory, readFileSync(index)), lockIdentity: null };
    save(run, "round-commit-prepared", { parent, oid, round: run.round });
  } finally { rmSync(index, { force: true }); }
}

function sameIdentity(file, identity) {
  if (!identity || !existsSync(file)) return false;
  const stat = lstatSync(file);
  return stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino;
}

// HEAD and index cannot be changed in one Git transaction. Journal both and
// accept only the exact old/new states on resume. Never reset source files or
// overwrite an intervening index, branch change, or commit.
export function publishRoundCommit(run) {
  const j = run.commitJournal;
  if (!j) return;
  assertNoGitOperation(run.root);
  const current = snapshot(run.root, undefined, { maxBytes: run.config.storage.maxSourceBytes });
  const repository = current.repositories[""];
  const normalized = structuredClone(current.repositories);
  normalized[""].head = run.expected.repositories[""].head;
  normalized[""].index = run.expected.repositories[""].index;
  if (!sameContent(current.files, run.expected.files) || hash(normalized) !== hash(run.expected.repositories)
      || ![j.parent, j.oid].includes(repository.head) || repository.branch !== j.branch) throw new Error("Checkout or branch changed during round commit publication; journal retained.");
  const actualIndex = fileHash(j.indexPath), lock = `${j.indexPath}.lock`;
  if (![j.oldIndex, j.newIndex].includes(actualIndex)) throw new Error("Git index changed during round commit publication; journal retained.");
  if (existsSync(lock) && (!sameIdentity(lock, j.lockIdentity) || fileHash(lock) !== j.newIndex)) throw new Error("Unowned or changed Git index lock; preserve it and reconcile the commit journal.");
  if (repository.head === j.oid && actualIndex === j.newIndex && !existsSync(lock)) return;
  if (!existsSync(lock)) {
    const fd = openSync(lock, "wx", 0o600);
    try { writeFileSync(fd, readBlob(run.directory, j.newIndex)); fsyncSync(fd); }
    finally { closeSync(fd); }
    const stat = lstatSync(lock);
    j.lockIdentity = { dev: stat.dev, ino: stat.ino };
    save(run, "round-commit-index-locked");
  }
  // Recheck after acquiring the index lock, before updating the branch ref.
  if (fileHash(j.indexPath) !== actualIndex) throw new Error("Git index changed while locking round publication; journal retained.");
  assertNoGitOperation(run.root);
  const head = textGit(run.root, "rev-parse", "HEAD");
  if (head === j.parent && j.parent !== j.oid) git(run.root, "update-ref", "-m", j.message.split("\n")[0], j.branch ?? "HEAD", j.oid, j.parent);
  else if (head !== j.oid) throw new Error("HEAD changed during round commit publication; journal retained.");
  if (!sameIdentity(lock, j.lockIdentity) || fileHash(lock) !== j.newIndex) throw new Error("Round commit index lock changed; journal retained.");
  renameSync(lock, j.indexPath);
  const directory = openSync(path.dirname(j.indexPath), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
