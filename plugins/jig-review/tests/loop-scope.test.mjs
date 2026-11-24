import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git, resolveScope } from "../skills/review-fix-loop/scripts/repository.mjs";
import { parseArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "jig-loop-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "feature");
  git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(path.join(root, "value"), "base\n");
  git(root, "add", "."); git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD").toString().trim();
  writeFileSync(path.join(root, "value"), "feature\n");
  git(root, "commit", "-qam", "feature");
  const head = git(root, "rev-parse", "HEAD").toString().trim();
  return { root, base, head };
}

for (const name of ["main", "master", "trunk"]) for (const prefix of ["refs/heads", "refs/remotes/origin"]) {
  test(`automatic loop scope resolves ${prefix}/${name} without origin/HEAD`, async t => {
    const { root, base } = fixture(t);
    git(root, "update-ref", `${prefix}/${name}`, base);
    const result = await resolveScope(root, parseArgs([]));
    assert.equal(result.args.scope, "branch"); assert.equal(result.args.base, base);
    assert.equal(result.fingerprint.hasChanges, true);
    assert.equal(result.fingerprint.includeWorkingTree, true);
  });
}

test("loop base detection honors origin/HEAD, then branch name order and local preference", async t => {
  const { root, base, head } = fixture(t);
  git(root, "update-ref", "refs/remotes/origin/trunk", base);
  git(root, "update-ref", "refs/heads/main", head);
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  assert.equal((await resolveScope(root, parseArgs([]))).args.base, base);
  git(root, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  assert.equal((await resolveScope(root, parseArgs([]))).args.base, head);
  git(root, "update-ref", "-d", "refs/heads/main");
  git(root, "update-ref", "refs/heads/master", head);
  assert.equal((await resolveScope(root, parseArgs([]))).args.base, base);
});

test("loop base detection ignores same-named tags and preserves explicit or dirty scopes", async t => {
  const { root, base, head } = fixture(t);
  git(root, "tag", "main", head);
  await assert.rejects(resolveScope(root, parseArgs([])), /Cannot detect the default branch .*pass --base <ref> or --scope working-tree/);
  git(root, "update-ref", "refs/remotes/origin/trunk", base);
  assert.equal((await resolveScope(root, parseArgs([]))).args.base, base);
  assert.equal((await resolveScope(root, parseArgs(["--base", head]))).args.base, head);
  await assert.rejects(resolveScope(root, parseArgs(["--base", "missing"])), /Invalid --base "missing": it does not resolve to a commit/);
  writeFileSync(path.join(root, "value"), "local\n");
  assert.equal((await resolveScope(root, parseArgs([]))).args.scope, "working-tree");
  assert.equal((await resolveScope(root, parseArgs(["--scope", "branch"]))).args.base, base);
});

test("the loop compares a checked-out default branch with its remote, as panel-review does", async t => {
  const { root, base, head } = fixture(t);
  git(root, "checkout", "-q", "-b", "main");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  const result = await resolveScope(root, parseArgs([]));
  assert.equal(result.args.scope, "branch"); assert.equal(result.args.base, base);
  assert.equal(result.fingerprint.hasChanges, true, "the unpushed commit is reviewed");
  // A dangling origin/HEAD names nothing, so detection continues with the branch names.
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/removed");
  assert.equal((await resolveScope(root, parseArgs([]))).args.base, base);
  // Without its remote the branch is its own base and there is nothing to review.
  git(root, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  git(root, "update-ref", "-d", "refs/remotes/origin/main");
  const alone = await resolveScope(root, parseArgs([]));
  assert.equal(alone.args.base, head); assert.equal(alone.fingerprint.hasChanges, false);
});

test("automatic loop scope sees changes that Git status is configured to hide inside a submodule", async t => {
  const { root, base } = fixture(t), library = fixture(t);
  git(root, "update-ref", "refs/heads/main", base);
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", library.root, "lib"], { cwd: root, stdio: "ignore" });
  git(root, "config", "-f", ".gitmodules", "submodule.lib.ignore", "dirty");
  git(root, "commit", "-qam", "library");
  assert.equal((await resolveScope(root, parseArgs([]))).args.scope, "branch");
  writeFileSync(path.join(root, "lib", "local.txt"), "local\n");
  assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all").toString(), "", "Git status hides the change");
  const result = await resolveScope(root, parseArgs([]));
  assert.equal(result.args.scope, "working-tree"); assert.equal(result.fingerprint.hasChanges, true);
  // A loop that excludes the submodule has nothing to review there, so the
  // branch's commit is reviewed instead of an empty working tree.
  const excluded = await resolveScope(root, parseArgs(["--exclude-path", "lib"]));
  assert.equal(excluded.args.scope, "branch"); assert.equal(excluded.fingerprint.hasChanges, true);
  // A change Git status lists still selects the working tree when the loop
  // excludes it, as it always has.
  writeFileSync(path.join(root, "notes.txt"), "local\n");
  assert.equal((await resolveScope(root, parseArgs(["--exclude-path", "lib", "--exclude-path", "notes.txt"]))).args.scope, "working-tree");
});
