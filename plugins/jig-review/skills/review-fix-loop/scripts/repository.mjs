import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { contentHash, copyBlob, hash, json, readBlob, readJSON, storeBlob, storeFile } from "./run-store.mjs";
import { sameFile, streamFile, withRegularFile } from "./file-content.mjs";
import { captureFingerprint } from "../../comprehensive-review/scripts/scope-fingerprint.mjs";
import { isExcludedPath } from "../../comprehensive-review/scripts/review-exclusions.mjs";
import { gitEnvironment } from "../../comprehensive-review/scripts/git-environment.mjs";
import { assertCompleteFingerprint } from "../../comprehensive-review/scripts/adapter-runtime.mjs";
import { assertStorage, DEFAULT_STORAGE, storageLimit } from "./storage-budget.mjs";

export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: gitEnvironment(), maxBuffer: 64 * 1024 * 1024, timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
}
const textGit = (cwd, ...args) => git(cwd, ...args).toString("utf8").trim();
const maybeGit = (cwd, ...args) => { try { return textGit(cwd, ...args); } catch { return null; } };
export const repositoryRoot = cwd => realpathSync(textGit(cwd, "rev-parse", "--show-toplevel"));
export function unsupported(message) {
  return Object.assign(new Error(`${message} Workflow stopped; no fallback is permitted.`), { code: "UNSUPPORTED_REPOSITORY" });
}
function assertSupportedHistory(directory) {
  // Object alternates do not carry shallow boundaries. Ask Git so linked
  // worktrees and submodule gitfiles resolve their actual repository metadata.
  if (textGit(directory, "rev-parse", "--is-shallow-repository") === "true") throw unsupported(`Unsupported shallow repository in ${directory}; private copies cannot preserve shallow history.`);
  // Object alternates do not carry replacement mappings. Inspect Git's ref
  // database (including packed/shared refs), not just the loose-ref directory.
  const replacement = textGit(directory, "for-each-ref", "--count=1", "--format=%(refname)", "refs/replace/");
  if (replacement) throw unsupported(`Unsupported Git replacement ref ${replacement} in ${directory}; private copies cannot preserve replacement history.`);
  // Legacy grafts also rewrite ancestry without changing the stored objects.
  const grafts = textGit(directory, "rev-parse", "--path-format=absolute", "--git-path", "info/grafts");
  if (existsSync(grafts) && readRegularFile(path.dirname(grafts), path.basename(grafts)).bytes.toString("utf8")
    .split("\n").some(line => line.trim() && !line.trimStart().startsWith("#"))) {
    throw unsupported(`Unsupported Git graft file ${grafts} in ${directory}; private copies cannot preserve grafted history.`);
  }
}
export function safePath(value) {
  if (typeof value !== "string" || !value || /[\\\0\r\n]/.test(value) || path.isAbsolute(value)
      || value.split("/").some(part => !part || [".", ".."].includes(part) || part.toLowerCase() === ".git") || /^[A-Za-z]:/.test(value)) throw new Error(`Unsafe repository path: ${JSON.stringify(value)}`);
  return value;
}
// Admission and every application batch use the same filesystem prerequisite.
// Check all destinations before publishing even the first addition in a batch.
export function assertBackupFilesystem(root, paths, backupDirectory) {
  const device = (location, follow = false) => {
    while (!existsSync(location)) location = path.dirname(location);
    return lstatSync(follow ? realpathSync(location) : location).dev;
  };
  const backupDevice = device(backupDirectory, true);
  for (const name of ["", ...paths]) {
    if (name) { safePath(name); noSymlinkParents(root, name); }
    if (device(path.join(root, name)) !== backupDevice) throw unsupported(`Source path ${name || root} and journal backups at ${backupDirectory} must share a filesystem; cross-filesystem patch application is unsupported.`);
  }
}
function noSymlinkParents(root, name) {
  let current = root;
  for (const part of name.split("/").slice(0, -1)) {
    current = path.join(current, part);
    if (existsSync(current) && !lstatSync(current).isDirectory()) throw new Error(`Non-directory path ancestor: ${name}`);
  }
}
export function readRegularFile(root, name, maximum = 32 * 1024 * 1024) {
  safePath(name); noSymlinkParents(root, name);
  const fd = openSync(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maximum) throw unsupported(`Unsupported or oversized file: ${name} (only regular files up to ${maximum} bytes are supported).`);
    const chunks = []; let length = 0;
    while (length <= maximum) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maximum + 1 - length));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      chunks.push(chunk.subarray(0, count)); length += count;
    }
    const after = fstatSync(fd);
    if (length > maximum || ["dev", "ino", "mode", "size", "mtimeMs", "ctimeMs"].some(key => before[key] !== after[key])) throw new Error(`File changed during bounded read: ${name}`);
    return { bytes: Buffer.concat(chunks, length), mode: before.mode & 0o777 };
  } finally { closeSync(fd); }
}
export function entry(root, name, store, { expectedStat, maxBytes } = {}) {
  safePath(name); noSymlinkParents(root, name);
  const file = path.join(root, name);
  let stat;
  try { stat = lstatSync(file); } catch (error) { if (error.code === "ENOENT" && !expectedStat) return null; throw error; }
  if (expectedStat === null || (expectedStat && !sameFile(expectedStat, stat))) throw new Error(`File changed before capture: ${name}`);
  if (stat.isSymbolicLink()) {
    const bytes = readlinkSync(file, { encoding: "buffer" });
    return { type: "symlink", blob: store ? storeBlob(store, bytes) : hash(bytes), mode: 0o777 };
  }
  if (!stat.isFile()) throw unsupported(`Unsupported non-regular file: ${name}.`);
  const options = { expectedStat: stat, maxBytes };
  return { type: "file", ...(store ? storeFile(store, file, options) : streamFile(file, options)) };
}
export function put(root, name, value, store) {
  safePath(name); noSymlinkParents(root, name);
  const file = path.join(root, name);
  if (value === null) { if (entry(root, name) !== null) rmSync(file); return; }
  mkdirSync(path.dirname(file), { recursive: true });
  if (entry(root, name)?.type === "symlink" || value.type === "symlink") {
    if (entry(root, name) !== null) rmSync(file);
    if (value.type === "symlink") { symlinkSync(readBlob(store, value.blob), file); return; }
  }
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, value.mode);
  try { copyBlob(store, value.blob, fd); } finally { closeSync(fd); }
  chmodSync(file, value.mode);
}
function syncDirectory(directory) {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function backupEntry(edit) { return entry(path.dirname(edit.backup), path.basename(edit.backup)); }
export function applyTemporary(root, edit, source = {}) {
  safePath(edit.path); safePath(edit.temporary);
  if (Object.hasOwn(source, edit.temporary) || path.posix.dirname(edit.temporary) !== path.posix.dirname(edit.path)
      || !/^\.jig-apply-[a-f0-9-]+$/.test(path.posix.basename(edit.temporary))) throw new Error("Temporary ownership is not established");
  const current = entry(root, edit.temporary);
  if (current && (!edit.after || hash(current) !== hash(edit.after))) throw new Error("Temporary contents differ from the journal; concurrent work retained");
  return current;
}
// One reconciliation boundary for terminal cleanup, resume, and new-run admission.
// Never restore over a user deletion: an absent displaced replacement requires
// explicit recovery, since another editor may have removed a published file.
export function reconcileApplication(root, journal, { cleanup = false } = {}) {
  const retainedTemporaries = [], unresolvedPaths = [];
  for (const edit of journal.changes) {
    try {
      const current = applyTemporary(root, edit, journal.source.files);
      if (current && cleanup) {
        unlinkSync(path.join(root, edit.temporary));
        syncDirectory(path.dirname(path.join(root, edit.temporary)));
      }
    } catch (error) { retainedTemporaries.push({ path: edit.temporary, reason: error.message }); }
    try {
      const actual = entry(root, edit.path), backup = backupEntry(edit);
      if (backup && hash(backup) !== hash(edit.before)) throw new Error(`Displaced file changed; recover it from ${edit.backup}`);
      if (backup && edit.after && actual === null) throw new Error(`Displaced destination is absent; recover it from ${edit.backup}`);
    } catch (error) { unresolvedPaths.push({ path: edit.path, reason: error.message }); }
  }
  return { retainedTemporaries, unresolvedPaths, resolved: !retainedTemporaries.length && !unresolvedPaths.length };
}
// Completed publications no longer constrain destination contents: a later
// repair may legitimately replace/delete them. Their displaced inodes remain
// live recovery obligations until explicit pruning, however.
export function reconcileBackups(directory, records) {
  const unresolvedPaths = [], known = new Set(), backupRoot = path.join(directory, "backups");
  for (const edit of records) {
    known.add(edit.backup);
    try {
      if (path.dirname(edit.backup) !== backupRoot) throw new Error("Invalid backup ownership");
      const actual = backupEntry(edit);
      if (!actual) throw new Error(`Retained backup is missing; restore ${edit.backup}`);
      if (hash(actual) !== hash(edit.before)) throw new Error(`Displaced file changed; recover it from ${edit.backup}`);
    } catch (error) { unresolvedPaths.push({ path: edit.path, reason: error.message }); }
  }
  if (existsSync(backupRoot)) for (const name of readdirSync(backupRoot)) {
    const backup = path.join(backupRoot, name);
    if (!known.has(backup)) unresolvedPaths.push({ path: backup, reason: "Retained backup has no recovery journal; restore its corresponding metadata before release or pruning." });
  }
  return { retainedTemporaries: [], unresolvedPaths, resolved: !unresolvedPaths.length };
}
export function applyFile(root, edit, store) {
  noSymlinkParents(root, edit.path);
  const destination = path.join(root, edit.path), temporary = path.join(root, edit.temporary);
  const actual = entry(root, edit.path), backup = backupEntry(edit);
  const candidate = applyTemporary(root, edit);
  if (backup && hash(backup) !== hash(edit.before)) throw new Error(`Concurrent edit preserved at ${edit.backup}`);
  if (hash(actual) === hash(edit.after) && (backup || edit.before === null)) {
    if (candidate) unlinkSync(temporary);
    return;
  }
  if (backup ? actual !== null : hash(actual) !== hash(edit.before)) throw new Error(`Concurrent mutation before replacement: ${edit.path}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  if (edit.after && !candidate) {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, edit.after.mode);
    try { copyBlob(store, edit.after.blob, fd); fchmodSync(fd, edit.after.mode); fsyncSync(fd); } finally { closeSync(fd); }
  }
  // Move the displaced inode into the durable journal, then publish with
  // exclusive creation. Never rename a candidate over a live destination.
  // Open writers retain that inode in backups, including after publication.
  if (edit.before && !backup) {
    mkdirSync(path.dirname(edit.backup), { recursive: true, mode: 0o700 });
    renameSync(destination, edit.backup);
    syncDirectory(path.dirname(destination)); syncDirectory(path.dirname(edit.backup));
    if (hash(backupEntry(edit)) !== hash(edit.before)) {
      try { linkSync(edit.backup, destination); } catch (error) { if (error.code !== "EEXIST") throw error; }
      throw new Error(`Concurrent edit preserved at ${edit.backup}`);
    }
  }
  if (edit.after) { applyTemporary(root, edit); linkSync(temporary, destination); applyTemporary(root, edit); unlinkSync(temporary); }
  syncDirectory(path.dirname(destination));
}
function names(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\0").filter(Boolean);
}
export function pathsDifferFromIndex(root, paths, repositories) {
  const prefixes = Object.keys(repositories).sort((a, b) => b.length - a.length);
  return paths.some(name => {
    safePath(name);
    const prefix = prefixes.find(prefix => name.startsWith(prefix));
    if (prefix === undefined) throw new Error(`No repository owns repaired path: ${name}`);
    const directory = path.join(root, prefix), relative = name.slice(prefix.length);
    const staged = names(git(directory, "--literal-pathspecs", "ls-files", "--stage", "-z", "--", relative));
    const current = entry(directory, relative);
    if (!staged.length) return current !== null;
    if (!current || staged.length !== 1) return true;
    const match = /^(\d+) ([a-f0-9]+) 0\t/.exec(staged[0]);
    if (!match) return true;
    const [, mode, oid] = match;
    if (current.type === "symlink") return mode !== "120000" || current.blob !== hash(git(directory, "cat-file", "blob", oid));
    if (mode === "120000" && maybeGit(directory, "config", "--bool", "core.symlinks") === "false") {
      return current.blob !== hash(git(directory, "cat-file", "blob", oid));
    }
    if (!["100644", "100755"].includes(mode)) return true;
    if (maybeGit(directory, "config", "--bool", "core.filemode") !== "false"
        && Boolean(current.mode & 0o100) !== (mode === "100755")) return true;
    // Read and hash the contents directly: status/diff trust assume-unchanged
    // and skip-worktree flags. Honor Git's text conversion without writing or
    // refreshing the index, and keep executable filters unsupported.
    assertSupportedAttributes(directory, [relative], {});
    const actual = withRegularFile(path.join(directory, relative), fd => execFileSync("git", ["hash-object", `--path=${relative}`, "--stdin"], {
      cwd: directory, env: gitEnvironment(), timeout: 30000, stdio: [fd, "pipe", "pipe"],
    }).toString("utf8").trim());
    return actual !== oid;
  });
}
function semanticIndex(directory) {
  const raw = git(directory, "ls-files", "--stage", "--debug", "-z").toString("utf8");
  const entries = []; let offset = 0;
  while (offset < raw.length) {
    const nul = raw.indexOf("\0", offset);
    if (nul < 0) throw new Error("Incomplete index entry.");
    const header = raw.slice(offset, nul);
    const match = /^  ctime:[\s\S]*?\tflags: ([a-f0-9]+)\n/.exec(raw.slice(nul + 1));
    if (!match) throw new Error("Incomplete index flags.");
    // Intent-to-add, skip-worktree, assume-unchanged. Exclude stat caches and
    // ephemeral refresh flags while preserving staged OIDs, modes and stages.
    entries.push([header, parseInt(match[1], 16) & 0x60008000]);
    offset = nul + 1 + match[0].length;
  }
  return hash(entries);
}
function comparisonContext(directory, store, configuration) {
  const config = Object.create(null);
  const pattern = /^(core\.(autocrlf|eol|safecrlf|filemode|symlinks|ignorecase|precomposeunicode|checkroundtripencoding)|diff\.(algorithm|indentheuristic|renames|renamelimit|.+\.(binary|wordregex|xfuncname|funcname)))$/;
  for (const [key, value] of Object.entries(configuration)) if (pattern.test(key)) config[key] = value;
  const read = file => {
    const bytes = file && existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
    return store ? storeBlob(store, bytes) : hash(bytes);
  };
  const [infoAttributes, infoExclude] = textGit(directory, "rev-parse", "--path-format=absolute", "--git-path", "info/attributes", "--git-path", "info/exclude").split("\n");
  const configuredPath = key => {
    const value = maybeGit(directory, "config", "--path", key);
    return value ? path.resolve(directory, value) : null;
  };
  const globalConfig = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || directory, ".config");
  const variables = Object.fromEntries(textGit(directory, "var", "-l").split("\n").map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
  const globalAttributes = configuredPath("core.attributesFile") ?? variables.GIT_ATTR_GLOBAL ?? path.join(globalConfig, "git", "attributes");
  // Git itself resolves boolean environment flags (including "0"/"false").
  // The shell-path variable arrived with the attribute-path API in Git 2.42;
  // unlike GIT_ATTR_SYSTEM, it is present even when system attributes are off.
  if (!variables.GIT_SHELL_PATH) throw new Error("Git 2.42+ is required to pin comparison attribute paths.");
  const systemAttributes = variables.GIT_ATTR_SYSTEM ?? null;
  return { config, infoAttributes: read(infoAttributes), systemAttributes: read(systemAttributes), globalAttributes: read(globalAttributes),
    infoExclude: read(infoExclude), globalExclude: read(configuredPath("core.excludesFile") ?? path.join(globalConfig, "git", "ignore")) };
}
function assertSupportedAttributes(directory, paths, configuration) {
  if (!paths.length) return;
  const values = names(execFileSync("git", ["check-attr", "-z", "--stdin", "filter", "diff"], {
    cwd: directory, env: gitEnvironment(), input: `${paths.join("\0")}\0`, maxBuffer: 64 * 1024 * 1024, timeout: 30000,
  }));
  for (let i = 0; i < values.length; i += 3) {
    const [name, attribute, value] = values.slice(i, i + 3);
    if (["unspecified", "unset", "set"].includes(value)) continue;
    if (attribute === "filter" || configuration[`diff.${value}.textconv`] || configuration[`diff.${value}.command`]) {
      throw unsupported(`Unsupported executable Git ${attribute} attribute on ${name}; external conversion drivers are not supported.`);
    }
  }
}
function diffIdentity(directory) {
  const args = ["--raw", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", "-z"];
  return hash([git(directory, "diff", ...args).toString("base64"), git(directory, "diff", "--cached", ...args).toString("base64")]);
}
export function snapshot(root, store, { maxBytes = DEFAULT_STORAGE.maxSourceBytes } = {}) {
  const files = Object.create(null), repositories = Object.create(null), diffs = Object.create(null);
  let sourceBytes = 0;
  function visit(directory, prefix = "") {
    assertSupportedHistory(directory);
    const configuration = Object.create(null);
    for (const item of names(git(directory, "config", "-z", "--list"))) {
      const at = item.indexOf("\n");
      configuration[at < 0 ? item : item.slice(0, at)] = at < 0 ? "true" : item.slice(at + 1);
    }
    const index = textGit(directory, "rev-parse", "--path-format=absolute", "--git-path", "index");
    repositories[prefix] = { head: maybeGit(directory, "rev-parse", "--verify", "HEAD"),
      objectFormat: textGit(directory, "rev-parse", "--show-object-format=storage"),
      index: semanticIndex(directory),
      indexPath: index, branch: maybeGit(directory, "symbolic-ref", "-q", "HEAD"), comparison: comparisonContext(directory, store, configuration) };
    const links = new Set(), tracked = new Set();
    for (const item of names(git(directory, "ls-files", "--stage", "-z"))) {
      const meta = item.slice(0, item.indexOf("\t")), name = item.slice(item.indexOf("\t") + 1);
      if (!meta.endsWith(" 0")) throw new Error("Resolve the existing unmerged index before starting a repair run.");
      tracked.add(name);
      if (meta.startsWith("160000 ")) links.add(name);
    }
    const paths = [...new Set(names(git(directory, "ls-files", "-z", "--cached", "--others", "--exclude-standard")))].sort();
    const checkedDirectories = new Set();
    const checkDirectory = name => {
      if (name === "." || checkedDirectories.has(name)) return;
      if (existsSync(path.join(directory, name, ".git"))) throw unsupported(`Unsupported nested repository: ${path.join(directory, name)}`);
      checkedDirectories.add(name);
    };
    assertSupportedAttributes(directory, paths, configuration);
    for (const name of paths) {
      if (name.endsWith("/")) throw unsupported(`Unsupported nested repository or directory: ${name}`);
      safePath(name);
      noSymlinkParents(directory, name);
      // Tracked descendants hide Git's slash-suffixed untracked-repository
      // marker. Inspect each ancestor once, within this repository boundary.
      for (let parent = path.dirname(name); parent !== "."; parent = path.dirname(parent)) checkDirectory(parent);
      if (links.has(name)) {
        if (existsSync(path.join(directory, name, ".git"))) visit(path.join(directory, name), `${prefix}${name}/`);
        continue;
      }
      let stat;
      try { stat = lstatSync(path.join(directory, name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      // Git lists both the deleted tracked file and the replacement tree's
      // files. Only the snapshot represents that file as absent: entry() must
      // still reject directories at mutation destinations to preserve them.
      if (tracked.has(name) && stat?.isDirectory()) { checkDirectory(name); files[`${prefix}${name}`] = null; continue; }
      // New source snapshots cannot represent special permission bits. Keep
      // this admission rule separate from entry(), which also verifies legacy
      // backup journals using their original ordinary-permission semantics.
      if (stat?.isFile() && (stat.mode & 0o7000)) throw unsupported(`Unsupported source permissions: ${prefix}${name}; setuid, setgid, and sticky bits cannot be captured.`);
      sourceBytes += stat?.size ?? 0;
      if (sourceBytes > maxBytes) throw storageLimit(`included source exceeds maxSourceBytes=${maxBytes} at ${prefix}${name}`);
      files[`${prefix}${name}`] = entry(directory, name, store, { expectedStat: stat ?? null });
    }
    diffs[prefix] = diffIdentity(directory);
  }
  visit(root);
  return { files, repositories, diffs, sourceBytes, contentHash: contentHash(files), guard: hash({ files, repositories }) };
}
export async function resolveScope(cwd, options) {
  const root = repositoryRoot(cwd);
  let scope = options.scope, base = options.base;
  if (scope === "auto") scope = !maybeGit(root, "rev-parse", "--verify", "HEAD") || git(root, "status", "--porcelain=v1", "--untracked-files=all").length ? "working-tree" : "branch";
  if (scope === "branch" && !base) {
    base = maybeGit(root, "symbolic-ref", "refs/remotes/origin/HEAD");
    if (!base) base = ["main", "master", "trunk"].flatMap(name => [`refs/heads/${name}`, `refs/remotes/origin/${name}`])
      .find(ref => maybeGit(root, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`));
    if (!base) throw new Error("Cannot infer branch base; supply --base or --scope working-tree.");
  }
  const args = { cwd: root, scope, base, includeWorkingTree: scope === "branch", excludePaths: options.review.excludePaths, timeoutMs: 300000 };
  const fingerprint = await captureFingerprint(args);
  assertCompleteFingerprint(fingerprint);
  args.base = fingerprint.baseOid;
  return { root, args, fingerprint };
}
export function overlayPath(run, label) {
  if (path.basename(label) !== label || label === "." || label === "..") throw new Error("Invalid overlay label.");
  return path.join(run.workspaceRoot ?? path.join(run.directory, "overlays"), label);
}
export function allocateWorkspace(run, label) {
  const overlay = overlayPath(run, label);
  if (existsSync(overlay)) throw new Error(`Overlay already exists: ${overlay}`);
  // Used for copies and validation scratch alike. Ownership precedes allocation.
  json(path.join(run.directory, "resources", `${label}.json`), { kind: "overlay", path: overlay });
  mkdirSync(overlay, { recursive: true, mode: 0o700 });
  return overlay;
}
export function makeOverlay(run, snapshotValue, label, { verify = true } = {}) {
  const overlay = overlayPath(run, label);
  if (existsSync(overlay)) throw new Error(`Overlay already exists: ${overlay}`);
  // A saved snapshot does not authorize newly introduced history overrides.
  // Check every source repository before allocating even the root copy.
  for (const prefix of Object.keys(snapshotValue.repositories)) assertSupportedHistory(path.join(run.root, prefix));
  // Include Git administration, metadata, and bounded command output headroom.
  const bytes = Object.values(snapshotValue.files).reduce((sum, value) => sum + (value ? lstatSync(path.join(run.directory, "blobs", value.blob)).size : 0), 0);
  const limit = run.config?.storage?.maxSourceBytes ?? DEFAULT_STORAGE.maxSourceBytes;
  if (bytes > limit) throw storageLimit(`candidate needs ${bytes} source bytes; maxSourceBytes=${limit}`);
  assertStorage(run, bytes + 32 * 1024 * 1024 + Object.values(snapshotValue.repositories).reduce((sum, repo) => sum + (existsSync(repo.indexPath) ? lstatSync(repo.indexPath).size : 0), 0));
  allocateWorkspace(run, label);
  for (const [prefix, repo] of Object.entries(snapshotValue.repositories)) {
    const target = path.join(overlay, prefix);
    mkdirSync(target, { recursive: true });
    // Empty templates alone do not override global core.hooksPath. Disable
    // hooks for preparation and retain that policy for later copy operations.
    const copyGit = (...args) => git(target, "-c", "core.hooksPath=/dev/null", ...args);
    const format = repo.objectFormat ?? textGit(path.join(run.root, prefix), "rev-parse", "--show-object-format=storage");
    copyGit("init", "-q", "--template=", `--object-format=${format}`);
    copyGit("config", "--local", "core.hooksPath", "/dev/null");
    mkdirSync(path.join(target, ".git", "info"), { recursive: true });
    const sourceObjects = textGit(path.join(run.root, prefix), "rev-parse", "--path-format=absolute", "--git-path", "objects");
    mkdirSync(path.join(target, ".git", "objects", "info"), { recursive: true });
    writeFileSync(path.join(target, ".git", "objects", "info", "alternates"), `${sourceObjects}\n`);
    if (repo.head) copyGit("update-ref", "--no-deref", "HEAD", repo.head);
    if (existsSync(repo.indexPath)) copyFileSync(repo.indexPath, path.join(target, ".git", "index"));
    const context = repo.comparison;
    for (const [key, value] of Object.entries(context.config)) copyGit("config", key, value);
    for (const [name, digest] of [["attributes", context.infoAttributes], ["exclude", context.infoExclude], ["jig-ignore", context.globalExclude]]) {
      writeFileSync(path.join(target, ".git", "info", name), readBlob(run.directory, digest));
    }
    writeFileSync(path.join(target, ".git", "info", "jig-attributes"), Buffer.concat([
      readBlob(run.directory, context.systemAttributes), Buffer.from("\n"), readBlob(run.directory, context.globalAttributes), Buffer.from("\n"),
    ]));
    copyGit("config", "core.attributesFile", path.join(target, ".git", "info", "jig-attributes"));
    copyGit("config", "core.excludesFile", path.join(target, ".git", "info", "jig-ignore"));
    for (const name of readdirSync(path.dirname(repo.indexPath)).filter(name => name.startsWith("sharedindex."))) copyFileSync(path.join(path.dirname(repo.indexPath), name), path.join(target, ".git", name));
  }
  for (const [name, value] of Object.entries(snapshotValue.files)) if (value) put(overlay, name, value, run.directory);
  if (verify && Object.entries(snapshotValue.diffs).some(([prefix, digest]) => diffIdentity(path.join(overlay, prefix)) !== digest)) {
    throw new Error("Repository copy does not preserve the source Git diff.");
  }
  json(path.join(run.directory, "snapshots", `${label}.json`), snapshotValue);
  return overlay;
}
export function alternateObjectDirectories(overlay, repositories) {
  const directories = new Set();
  for (const prefix of Object.keys(repositories)) {
    // Git resolves recursive alternates, including linked/shared repositories.
    for (const line of textGit(path.join(overlay, prefix), "-c", "core.quotePath=false", "count-objects", "-v").split("\n")) {
      if (!line.startsWith("alternate: ")) continue;
      const encoded = line.slice("alternate: ".length);
      const directory = encoded.startsWith('"') ? JSON.parse(encoded) : encoded;
      directories.add(realpathSync(directory));
    }
  }
  return [...directories].sort();
}
export function discardOverlay(run, overlay) {
  const legacyScratch = overlay && path.dirname(overlay) === path.join(run.directory, "temporary") && /^[a-f0-9-]{36}$/.test(path.basename(overlay));
  if (overlay && (path.dirname(overlay) === path.dirname(overlayPath(run, "owned")) || legacyScratch)) {
    rmSync(overlay, { recursive: true, force: true });
    rmSync(path.join(run.directory, "resources", `${path.basename(overlay)}.json`), { force: true });
  }
}
export function reservedOverlays(run) {
  const directory = path.join(run.directory, "resources");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith(".json")).map(name => readJSON(path.join(directory, name)))
    .filter(record => record.kind === "overlay" && path.dirname(record.path) === path.dirname(overlayPath(run, "owned"))).map(record => record.path);
}
export function overlayFiles(overlay) {
  const files = Object.create(null);
  function walk(directory, prefix = "") {
    for (const name of readdirSync(directory).sort()) {
      if (name === ".git") continue;
      const relative = `${prefix}${name}`;
      if (lstatSync(path.join(directory, name)).isDirectory()) walk(path.join(directory, name), `${relative}/`);
      else files[relative] = entry(overlay, relative);
    }
  }
  walk(overlay);
  return files;
}
export function changes(before, after, excluded = []) {
  const result = [];
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = Object.hasOwn(before, name) ? before[name] : null, b = Object.hasOwn(after, name) ? after[name] : null;
    if (hash(a) === hash(b)) continue;
    if (isExcludedPath(name, excluded)) throw new Error(`Mutation of excluded path: ${name}`);
    result.push({ path: name, before: a, after: b });
  }
  return result;
}
export const sameContent = (a, b) => changes(a, b).length === 0;
