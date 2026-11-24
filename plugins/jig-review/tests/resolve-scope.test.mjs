import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs, resolveReviewScope } from "../skills/panel-review/scripts/resolve-scope.mjs";
import { captureFingerprint, parseArgs as parseFingerprintArgs } from "../skills/panel-review/scripts/scope-fingerprint.mjs";

const cli = fileURLToPath(new URL("../skills/panel-review/scripts/resolve-scope.mjs", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// A repository on a branch whose name is not a default-branch candidate.
function repository(t, { commit = true } = {}) {
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jig-resolve-scope-")));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, "init", "-q", "-b", "work");
  git(repo, "config", "user.name", "Scope Test");
  git(repo, "config", "user.email", "scope@example.invalid");
  if (commit) {
    writeFileSync(path.join(repo, "tracked.txt"), "base\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-qm", "base");
  }
  return repo;
}

function commitChange(repo, text) {
  writeFileSync(path.join(repo, "tracked.txt"), text);
  git(repo, "commit", "-qam", text.trim());
  return git(repo, "rev-parse", "HEAD");
}

test("flag conflicts are rejected from the arguments alone", () => {
  assert.throws(() => parseArgs(["--scope", "everything"]), /--scope must be auto, working-tree, or branch/);
  assert.throws(() => parseArgs(["--base", "main", "--scope", "working-tree"]), /--base selects branch scope/);
  for (const args of [["--scope", "auto", "--include-working-tree"], ["--scope", "auto", "--base", "main", "--include-working-tree"]]) {
    assert.throws(() => parseArgs(args), /cannot be combined with --scope auto; use --scope branch --include-working-tree or --base <ref> --include-working-tree/);
  }
  for (const args of [["--include-working-tree"], ["--scope", "working-tree", "--include-working-tree"]]) {
    assert.throws(() => parseArgs(args), /--include-working-tree requires branch scope/);
  }
  assert.throws(() => parseArgs(["--reviewers", "claude"]), /Unsupported argument: --reviewers/);
  assert.throws(() => parseArgs(["--scope", "branch", "--scope", "auto"]), /Duplicate argument: --scope/);
  assert.throws(() => parseArgs(["--base"]), /Missing value for --base/);
  // The next flag is not the value that was left out.
  assert.throws(() => parseArgs(["--base", "--include-working-tree"]), /Missing value for --base/);
  assert.throws(() => parseArgs(["--scope", "branch", "--cwd", "--wait"]), /Missing value for --cwd/);
  assert.deepEqual(parseArgs(["--cwd", "/repo", "--wait", "--base", "main", "--include-working-tree"]),
    { cwd: "/repo", scope: null, base: "main", includeWorkingTree: true });
});

test("no scope flags select the working tree, including before the first commit", async (t) => {
  const repo = repository(t);
  assert.deepEqual(await resolveReviewScope({ cwd: repo }), {
    repoRoot: repo, scope: "working-tree", scopeSource: "default", base: null, baseRef: null, baseSource: null,
    includeWorkingTree: false, arguments: ["--scope", "working-tree"],
  });
  const unborn = repository(t, { commit: false });
  assert.equal((await resolveReviewScope({ cwd: unborn })).scope, "working-tree");
  assert.equal((await resolveReviewScope({ cwd: unborn, scope: "auto" })).scopeSource, "auto-local-changes");
  await assert.rejects(resolveReviewScope({ cwd: unborn, scope: "branch" }), /Branch scope requires HEAD to resolve to a commit/);
});

test("a named base selects branch scope and is never replaced", async (t) => {
  const repo = repository(t);
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "branch", "main");
  git(repo, "tag", "v1");
  commitChange(repo, "changed\n");
  for (const scope of [null, "branch", "auto"]) {
    assert.deepEqual(await resolveReviewScope({ cwd: repo, scope, base: "v1" }), {
      repoRoot: repo, scope: "branch", scopeSource: "base", base, baseRef: "v1", baseSource: "option",
      includeWorkingTree: false, arguments: ["--scope", "branch", "--base", base],
    });
  }
  assert.deepEqual((await resolveReviewScope({ cwd: repo, base: "v1", includeWorkingTree: true })).arguments,
    ["--scope", "branch", "--base", base, "--include-working-tree"]);
  // main exists and would be detected, but a mistyped base must fail rather than fall back.
  await assert.rejects(resolveReviewScope({ cwd: repo, base: "mian" }), /Invalid --base "mian": it does not resolve to a commit/);
  await assert.rejects(resolveReviewScope({ cwd: repo, base: "--upload-pack=x" }), /Invalid --base/);
});

test("auto chooses the working tree only while local changes exist", async (t) => {
  const repo = repository(t);
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "branch", "main");
  commitChange(repo, "changed\n");
  const clean = await resolveReviewScope({ cwd: repo, scope: "auto" });
  assert.deepEqual([clean.scope, clean.scopeSource, clean.base, clean.baseRef], ["branch", "auto-clean-checkout", base, "refs/heads/main"]);
  writeFileSync(path.join(repo, "untracked.txt"), "new\n");
  const dirty = await resolveReviewScope({ cwd: repo, scope: "auto" });
  assert.deepEqual([dirty.scope, dirty.scopeSource, dirty.arguments], ["working-tree", "auto-local-changes", ["--scope", "working-tree"]]);
  // An explicit branch scope is not changed by local edits; the fingerprint owns the clean check.
  assert.equal((await resolveReviewScope({ cwd: repo, scope: "branch" })).scope, "branch");
});

test("auto sees local changes that Git status is configured to hide inside submodules", async (t) => {
  const repo = repository(t);
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "branch", "main");
  const inner = repository(t);
  const library = repository(t);
  const addSubmodule = (cwd, source, name) => {
    git(cwd, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, name);
    // Each repository hides the changes inside its own submodule.
    git(cwd, "config", "-f", ".gitmodules", `submodule.${name}.ignore`, "dirty");
    git(cwd, "commit", "-qam", name);
  };
  addSubmodule(library, inner, "inner");
  addSubmodule(repo, library, "lib");
  git(repo, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init", "--recursive");
  const auto = async () => {
    const resolved = await resolveReviewScope({ cwd: repo, scope: "auto" });
    return [resolved.scope, resolved.scopeSource];
  };
  const status = (...options) => git(repo, "status", "--porcelain=v1", "--untracked-files=all", ...options);

  assert.deepEqual(await auto(), ["branch", "auto-clean-checkout"]);
  for (const hidden of [path.join("lib", "local.txt"), path.join("lib", "inner", "local.txt")]) {
    writeFileSync(path.join(repo, hidden), "local\n");
    assert.equal(status(), "", `Git status hides ${hidden}`);
    assert.deepEqual(await auto(), ["working-tree", "auto-local-changes"], hidden);
    // Branch scope would have been refused: its clean check sees the same change.
    const capture = await captureFingerprint({ cwd: repo, scope: "branch", base });
    assert.equal(capture.checkoutClean, false, hidden);
    rmSync(path.join(repo, hidden));
  }
  // The nested change stays hidden even from a status told to ignore no submodule.
  writeFileSync(path.join(repo, "lib", "inner", "local.txt"), "local\n");
  assert.equal(status("--ignore-submodules=none"), "");
  assert.deepEqual(await auto(), ["working-tree", "auto-local-changes"]);
  rmSync(path.join(repo, "lib", "inner", "local.txt"));
  assert.deepEqual(await auto(), ["branch", "auto-clean-checkout"]);
  assert.equal((await captureFingerprint({ cwd: repo, scope: "branch", base })).checkoutClean, true);
});

test("the default branch is origin/HEAD, then main, master or trunk with local before origin", async (t) => {
  const repo = repository(t);
  const first = git(repo, "rev-parse", "HEAD");
  const second = commitChange(repo, "second\n");
  const third = commitChange(repo, "third\n");
  const detect = async () => {
    const { base, baseRef, baseSource } = await resolveReviewScope({ cwd: repo, scope: "branch" });
    return [baseRef, base, baseSource];
  };
  await assert.rejects(detect(), /Cannot detect the default branch \(no origin\/HEAD, main, master, or trunk\); pass --base <ref> or --scope working-tree/);

  git(repo, "update-ref", "refs/remotes/origin/trunk", first);
  assert.deepEqual(await detect(), ["refs/remotes/origin/trunk", first, "default-branch-name"]);
  git(repo, "update-ref", "refs/heads/trunk", second);
  assert.deepEqual(await detect(), ["refs/heads/trunk", second, "default-branch-name"]);
  git(repo, "update-ref", "refs/remotes/origin/master", first);
  assert.deepEqual(await detect(), ["refs/remotes/origin/master", first, "default-branch-name"]);
  git(repo, "update-ref", "refs/remotes/origin/main", second);
  assert.deepEqual(await detect(), ["refs/remotes/origin/main", second, "default-branch-name"]);
  git(repo, "update-ref", "refs/heads/main", third);
  assert.deepEqual(await detect(), ["refs/heads/main", third, "default-branch-name"]);

  git(repo, "update-ref", "refs/remotes/origin/develop", first);
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
  assert.deepEqual(await detect(), ["refs/remotes/origin/develop", first, "origin-head"]);
  // A dangling origin/HEAD names nothing, so detection continues with the branch names.
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/removed");
  assert.deepEqual(await detect(), ["refs/heads/main", third, "default-branch-name"]);
});

test("a checked-out default branch is compared with its remote, not with itself", async (t) => {
  const repo = repository(t);
  const pushed = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "main");
  git(repo, "update-ref", "refs/remotes/origin/main", pushed);
  const unpushed = commitChange(repo, "unpushed\n");
  const base = async (scope) => {
    const resolved = await resolveReviewScope({ cwd: repo, scope });
    return [resolved.scope, resolved.baseRef, resolved.base, resolved.baseSource];
  };
  // No origin/HEAD, as after `git remote add` rather than `git clone`. Local
  // main against itself would report nothing to review.
  assert.deepEqual(await base("auto"), ["branch", "refs/remotes/origin/main", pushed, "default-branch-name"]);
  // Any other checkout still prefers local main, even at the same commit.
  git(repo, "checkout", "-q", "-b", "feature");
  assert.deepEqual(await base("branch"), ["branch", "refs/heads/main", unpushed, "default-branch-name"]);
  git(repo, "checkout", "-q", "--detach", "main");
  assert.deepEqual(await base("branch"), ["branch", "refs/heads/main", unpushed, "default-branch-name"]);
  // Without origin/main the branch is its own base, which reports nothing to
  // review. The later names do not take its place: a leftover master or an
  // origin/trunk is not what main was branched from.
  git(repo, "checkout", "-q", "main");
  git(repo, "update-ref", "refs/heads/master", pushed);
  git(repo, "update-ref", "refs/remotes/origin/trunk", pushed);
  assert.deepEqual(await base("branch"), ["branch", "refs/remotes/origin/main", pushed, "default-branch-name"]);
  git(repo, "update-ref", "-d", "refs/remotes/origin/main");
  for (const scope of ["branch", "auto"]) {
    assert.deepEqual(await base(scope), ["branch", "refs/heads/main", unpushed, "default-branch-name"]);
  }
  // An earlier name still comes first, as it does for every other checkout.
  git(repo, "checkout", "-q", "master");
  assert.deepEqual(await base("branch"), ["branch", "refs/heads/main", unpushed, "default-branch-name"]);
});

test("resolved arguments are exactly what the fingerprint helper accepts", async (t) => {
  const repo = repository(t);
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "branch", "main");
  commitChange(repo, "changed\n");
  writeFileSync(path.join(repo, "untracked.txt"), "new\n");
  const resolved = await resolveReviewScope({ cwd: path.join(repo), scope: "branch", includeWorkingTree: true });
  const options = parseFingerprintArgs(["--cwd", resolved.repoRoot, ...resolved.arguments]);
  assert.deepEqual([options.scope, options.base, options.includeWorkingTree], ["branch", base, true]);
  const capture = await captureFingerprint(options);
  assert.deepEqual([capture.scope, capture.baseOid, capture.includeWorkingTree, capture.hasChanges], ["branch", base, true, true]);
});

test("the command prints the resolution as JSON and explains a rejection", (t) => {
  const repo = repository(t);
  mkdirSync(path.join(repo, "nested"));
  writeFileSync(path.join(repo, "nested", "untracked.txt"), "new\n");
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: "utf8" });
  const resolved = run("--scope", "auto", "--wait");
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.deepEqual(JSON.parse(resolved.stdout).arguments, ["--scope", "working-tree"]);
  assert.equal(JSON.parse(run("--cwd", path.join(repo, "nested")).stdout).repoRoot, repo);
  const rejected = run("--scope", "auto", "--include-working-tree");
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, "");
  assert.match(rejected.stderr, /^resolve-scope: --include-working-tree cannot be combined with --scope auto/);
  const missing = run("--base", "no-such-ref");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^resolve-scope: Invalid --base "no-such-ref"/);
});

test("a wrong --cwd is reported as the directory, not as Git being absent", async (t) => {
  const repo = repository(t);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: "utf8" });
  // Node reports a missing working directory as ENOENT on the command itself.
  const nowhere = run("--cwd", path.join(repo, "no-such-directory"));
  assert.equal(nowhere.status, 1);
  assert.equal(nowhere.stdout, "");
  assert.match(nowhere.stderr, /^resolve-scope: spawn git ENOENT: the working directory ".*no-such-directory" is not an existing directory\n$/);
  const file = run("--cwd", path.join(repo, "tracked.txt"));
  assert.equal(file.status, 1);
  assert.match(file.stderr, /^resolve-scope: spawn .*ENOTDIR: the working directory ".*tracked\.txt" is not an existing directory\n$/);
  // The code is unchanged for callers that act on it.
  await assert.rejects(resolveReviewScope({ cwd: path.join(repo, "no-such-directory") }), { code: "ENOENT" });

  // With the directory in place, the same error does mean that Git is missing.
  const empty = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jig-resolve-scope-path-")));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const absent = spawnSync(process.execPath, [cli], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: empty } });
  assert.equal(absent.status, 1);
  assert.equal(absent.stderr, "resolve-scope: spawn git ENOENT\n");
  // A caller that names no directory runs Git in its own, which exists.
  const searchPath = process.env.PATH;
  process.env.PATH = empty;
  try {
    await assert.rejects(resolveReviewScope({}), { code: "ENOENT", message: "spawn git ENOENT" });
  } finally {
    process.env.PATH = searchPath;
  }
});

test("a Git failure on a detected ref fails the resolution instead of moving on to another base", (t) => {
  const repo = repository(t);
  git(repo, "branch", "main");
  git(repo, "branch", "master");
  commitChange(repo, "changed\n");
  const bin = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jig-resolve-scope-git-")));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  // Git cannot read the commit behind these refs, as with a corrupt object:
  // that is a failed command, not a ref that names nothing.
  writeFileSync(path.join(bin, "git"), [
    "#!/bin/sh",
    'for argument in "$@"; do',
    '  case "$argument" in',
    "    'refs/heads/main^{commit}'|'unreadable^{commit}') echo 'fatal: loose object is corrupt' >&2; exit 128 ;;",
    "  esac",
    "done",
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  // master exists and would be the next candidate.
  const detected = run("--scope", "branch");
  assert.equal(detected.status, 1);
  assert.equal(detected.stdout, "");
  assert.equal(detected.stderr, "resolve-scope: git rev-parse failed: fatal: loose object is corrupt\n");
  // A base the user named fails by name whatever status Git gave.
  const named = run("--base", "unreadable");
  assert.equal(named.status, 1);
  assert.match(named.stderr, /^resolve-scope: Invalid --base "unreadable": it does not resolve to a commit\.\n$/);
  assert.deepEqual(JSON.parse(run("--base", "master").stdout).baseRef, "master");
});

test("a signal stops the Git command the resolver is waiting for", async (t) => {
  const repo = repository(t);
  const bin = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jig-resolve-scope-git-")));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const pidFile = path.join(bin, "status.pid");
  const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  // `git status` never finishes; every other command is the real Git.
  writeFileSync(path.join(bin, "git"), [
    "#!/bin/sh",
    'for argument in "$@"; do',
    `  if [ "$argument" = status ]; then echo $$ > '${pidFile}'; exec sleep 60; fi`,
    "done",
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  const child = spawn(process.execPath, [cli, "--scope", "auto"], {
    cwd: repo, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  });
  const deadlineAt = Date.now() + 10_000;
  while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim()) {
    if (Date.now() >= deadlineAt) throw new Error("the resolver did not reach git status");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const gitPid = Number(readFileSync(pidFile, "utf8"));
  t.after(() => {
    try {
      process.kill(gitPid, "SIGKILL");
    } catch {
      // Already gone, as the test expects.
    }
  });

  const exit = once(child, "exit");
  child.kill("SIGTERM");
  const unresponsive = setTimeout(() => child.kill("SIGKILL"), 5_000);
  const ended = await exit;
  clearTimeout(unresponsive);
  assert.deepEqual(ended, [null, "SIGTERM"], "the resolver ends by the signal it was sent");
  assert.equal(stdout, "");
  // Git runs in its own process group, so only the resolver can stop it.
  const goneBy = Date.now() + 2_000;
  for (;;) {
    try {
      process.kill(gitPid, 0);
    } catch (error) {
      if (error.code === "ESRCH") break;
      throw error;
    }
    if (Date.now() >= goneBy) assert.fail("git status was still running after the resolver ended");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});
