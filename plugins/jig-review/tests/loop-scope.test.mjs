import assert from "node:assert/strict";
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
  await assert.rejects(resolveScope(root, parseArgs([])), /Cannot infer branch base/);
  git(root, "update-ref", "refs/remotes/origin/trunk", base);
  assert.equal((await resolveScope(root, parseArgs([]))).args.base, base);
  assert.equal((await resolveScope(root, parseArgs(["--base", head]))).args.base, head);
  await assert.rejects(resolveScope(root, parseArgs(["--base", "missing"])), /git rev-parse failed/);
  writeFileSync(path.join(root, "value"), "local\n");
  assert.equal((await resolveScope(root, parseArgs([]))).args.scope, "working-tree");
  assert.equal((await resolveScope(root, parseArgs(["--scope", "branch"]))).args.base, base);
});
