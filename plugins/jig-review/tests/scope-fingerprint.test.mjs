import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fingerprintScript = fileURLToPath(new URL(
  "../skills/comprehensive-review/scripts/scope-fingerprint.mjs",
  import.meta.url,
));

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fingerprint(cwd, scope, base = null) {
  const args = [fingerprintScript, "--cwd", cwd, "--scope", scope];
  if (base) args.push("--base", base);
  return JSON.parse(execFileSync(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  }));
}

function makeRepository() {
  const repo = mkdtempSync(path.join(os.tmpdir(), "jig-scope-fingerprint-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Fingerprint Test"]);
  git(repo, ["config", "user.email", "fingerprint@example.invalid"]);
  writeFileSync(path.join(repo, "tracked.txt"), "initial\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-qm", "initial"]);
  return repo;
}

function makeRepositoryWithSubmodule(t) {
  const repo = makeRepository();
  const source = makeRepository();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  });
  git(repo, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    "--name",
    "example-dependency",
    source,
    "vendor/example",
  ]);
  git(repo, ["commit", "-qam", "add submodule"]);
  return { repo, submodule: path.join(repo, "vendor/example") };
}

test("branch fingerprint includes mutable checkout state", (t) => {
  const repo = makeRepository();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const base = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(repo, "tracked.txt"), "committed change\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-qm", "branch change"]);

  const clean = fingerprint(repo, "branch", base);
  assert.equal(clean.checkoutClean, true);
  assert.equal(clean.complete, true);

  writeFileSync(path.join(repo, "tracked.txt"), "mutable checkout change\n");
  const dirty = fingerprint(repo, "branch", base);
  assert.equal(dirty.checkoutClean, false);
  assert.notEqual(dirty.fingerprint, clean.fingerprint);
});

test("unavailable initialized submodules are recorded instead of aborting", (t) => {
  const repo = makeRepository();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const gitlinkOid = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["update-index", "--add", "--cacheinfo", `160000,${gitlinkOid},vendor/broken`]);
  git(repo, ["commit", "-qm", "add broken submodule entry"]);
  mkdirSync(path.join(repo, "vendor", "broken"), { recursive: true });
  writeFileSync(path.join(repo, "vendor", "broken", ".git"), "gitdir: missing\n");

  const result = fingerprint(repo, "working-tree");
  assert.equal(result.hasChanges, true);
  assert.equal(result.complete, false);
  assert.deepEqual(result.issues, [
    { path: "vendor/broken", reason: "submodule-unavailable" },
  ]);
});

test("non-directory gitlink paths make fingerprint coverage incomplete", async (t) => {
  for (const kind of ["file", "symlink"]) {
    await t.test(kind, (subtest) => {
      const { repo, submodule } = makeRepositoryWithSubmodule(subtest);
      rmSync(submodule, { recursive: true, force: true });
      if (kind === "file") writeFileSync(submodule, "not a submodule\n");
      else symlinkSync(path.join(repo, "tracked.txt"), submodule);

      const result = fingerprint(repo, "working-tree");

      assert.equal(result.hasChanges, true);
      assert.equal(result.complete, false);
      assert.deepEqual(result.issues, [
        { path: "vendor/example", reason: "submodule-path-not-directory" },
      ]);
    });
  }
});

test("missing registered submodule worktrees make fingerprint coverage incomplete", (t) => {
  const { repo, submodule } = makeRepositoryWithSubmodule(t);
  rmSync(submodule, { recursive: true, force: true });

  const result = fingerprint(repo, "working-tree");

  assert.equal(result.hasChanges, true);
  assert.equal(result.complete, false);
  assert.deepEqual(result.issues, [
    { path: "vendor/example", reason: "registered-submodule-worktree-missing" },
  ]);
});

test("absent deinitialized submodule worktrees remain complete and unchanged", (t) => {
  const { repo, submodule } = makeRepositoryWithSubmodule(t);
  git(repo, ["submodule", "--quiet", "deinit", "--force", "--", "vendor/example"]);
  rmSync(submodule, { recursive: true, force: true });

  const result = fingerprint(repo, "working-tree");

  assert.equal(result.hasChanges, false);
  assert.equal(result.complete, true);
  assert.deepEqual(result.issues, []);
});

test("working-tree fingerprint supports an unborn HEAD", (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "jig-scope-unborn-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ["init", "-q"]);
  writeFileSync(path.join(repo, "first.txt"), "first revision\n");
  git(repo, ["add", "first.txt"]);

  const result = fingerprint(repo, "working-tree");

  assert.equal(result.headOid, null);
  assert.equal(result.hasChanges, true);
  assert.equal(result.complete, true);
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
});

test("untracked nested repositories make fingerprint coverage incomplete", (t) => {
  const repo = makeRepository();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const nested = path.join(repo, "nested");
  mkdirSync(nested);
  git(nested, ["init", "-q"]);
  writeFileSync(path.join(nested, "inside.txt"), "nested content\n");

  const result = fingerprint(repo, "working-tree");

  assert.equal(result.complete, false);
  assert.deepEqual(result.issues, [
    { path: "nested/", reason: "untracked-directory" },
  ]);
});

test("unreadable untracked files degrade fingerprint coverage", {
  skip: process.getuid?.() === 0,
}, (t) => {
  const repo = makeRepository();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const unreadable = path.join(repo, "unreadable.txt");
  writeFileSync(unreadable, "hidden\n");
  chmodSync(unreadable, 0o000);

  const result = fingerprint(repo, "working-tree");
  const repeated = fingerprint(repo, "working-tree");

  assert.equal(result.complete, false);
  assert.deepEqual(result.issues, [
    { path: "unreadable.txt", reason: "unreadable" },
  ]);
  assert.equal(repeated.fingerprint, result.fingerprint);
});

test("fingerprint deadline exits with timeout status", (t) => {
  const repo = makeRepository();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  assert.throws(
    () => execFileSync(process.execPath, [
      fingerprintScript,
      "--cwd",
      repo,
      "--scope",
      "working-tree",
      "--timeout-ms",
      "1",
    ], { encoding: "utf8", stdio: "pipe" }),
    (error) => error.status === 124,
  );
});
