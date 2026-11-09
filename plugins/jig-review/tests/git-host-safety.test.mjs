import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git as repositoryGit } from "../skills/review-fix-loop/scripts/repository.mjs";
import { captureFingerprint } from "../skills/panel-review/scripts/scope-fingerprint.mjs";
import { collectReviewContext, resolveScope } from "../skills/panel-review/scripts/review-context.mjs";
import { localGitEnvironment } from "../skills/panel-review/scripts/git-environment.mjs";
import { withEnforcedGit } from "../skills/panel-review/scripts/git-lease.mjs";

function fixture(t, { localRemote = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "jig-promisor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"); mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(path.join(repo, "value"), "original\n"); git("add", "."); git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "base");
  const oid = git("rev-parse", "HEAD:value");
  const remote = path.join(root, "origin.git");
  if (localRemote) git("clone", "-q", "--bare", "--no-hardlinks", repo, remote);
  writeFileSync(path.join(repo, "value"), "changed\n");
  rmSync(path.join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
  const marker = path.join(root, "host-command-ran"), helper = path.join(root, "ssh.cjs");
  writeFileSync(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called'); process.exit(1);\n`);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  git("config", "remote.origin.url", "ssh://unused.invalid/example");
  git("config", "remote.origin.promisor", "true"); git("config", "extensions.partialClone", "origin");
  git("config", "core.sshCommand", `${quote(process.execPath)} ${quote(helper)}`);
  return { repo, marker, oid, remote };
}

test("trusted local Git environment overrides inherited transport permission", () => {
  withEnforcedGit(() => assert.equal(localGitEnvironment({ GIT_ALLOW_PROTOCOL: "ssh:file" }).GIT_ALLOW_PROTOCOL, ""));
  assert.equal(localGitEnvironment({ GIT_ALLOW_PROTOCOL: "ssh:file" }).GIT_ALLOW_PROTOCOL, "ssh:file");
});

test("standalone inspection preserves a configured clean filter", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jig-clean-filter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("config", "filter.fixture.clean", "sed s/payload/pointer/g");
  writeFileSync(path.join(root, ".gitattributes"), "data.txt filter=fixture\n");
  writeFileSync(path.join(root, "data.txt"), "payload\n");
  git("add", "."); git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "base");
  assert.equal(git("status", "--porcelain"), "");
  const context = await collectReviewContext(await resolveScope({ cwd: root, scope: "working-tree" }));
  assert.equal(context.incomplete, false); assert.equal(context.truncated, false);
  assert.doesNotMatch(context.text, /M data.txt|diff --git/);
});

test("standalone Git can retrieve a missing blob from its configured local promisor", t => {
  const f = fixture(t, { localRemote: true });
  execFileSync("git", ["config", "remote.origin.url", `file://${f.remote}`], { cwd: f.repo });
  assert.equal(repositoryGit(f.repo, "cat-file", "blob", f.oid).toString("utf8").trim(), "original");
  assert.equal(existsSync(f.marker), false);
});

for (const wrapper of ["repository", "fingerprint", "review-context"]) test(`${wrapper} cannot run a promisor transport helper`, async t => {
  const f = fixture(t);
  await withEnforcedGit(async () => {
    if (wrapper === "repository") assert.throws(() => repositoryGit(f.repo, "cat-file", "blob", f.oid));
    else if (wrapper === "fingerprint") await assert.rejects(captureFingerprint({ cwd: f.repo, scope: "working-tree" }));
    else {
      const scope = await resolveScope({ cwd: f.repo, scope: "working-tree" });
      await assert.rejects(collectReviewContext(scope));
    }
  });
  assert.equal(existsSync(f.marker), false, "repository command executed on the trusted host");
});
