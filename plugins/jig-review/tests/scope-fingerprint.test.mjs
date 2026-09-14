import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runGit as runFingerprintGit } from "../skills/comprehensive-review/scripts/scope-fingerprint.mjs";

const fingerprintScript = fileURLToPath(new URL(
  "../skills/comprehensive-review/scripts/scope-fingerprint.mjs",
  import.meta.url,
));

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fingerprint(cwd, scope, base = null, excludePaths = []) {
  const args = [fingerprintScript, "--cwd", cwd, "--scope", scope];
  if (base) args.push("--base", base);
  for (const excludedPath of excludePaths) args.push("--exclude-path", excludedPath);
  return JSON.parse(execFileSync(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  }));
}

test("working-tree fingerprint honors committed .reviewignore and explicit exclusions", (t) => {
  const repo = makeRepository();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(path.join(repo, ".agent"));
  writeFileSync(path.join(repo, ".agent", "state.jsonl"), "baseline\n");
  writeFileSync(path.join(repo, ".reviewignore"), "# generated review state\n/.agent/\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "add review policy"]);

  writeFileSync(path.join(repo, ".agent", "state.jsonl"), "large ignored state\n");
  const policyResult = fingerprint(repo, "working-tree");
  assert.equal(policyResult.hasChanges, false);
  assert.equal(policyResult.complete, true);
  assert.deepEqual(policyResult.excludePaths, [".agent"]);
  assert.deepEqual(policyResult.reviewIgnorePaths, [".agent"]);
  assert.equal(policyResult.reviewIgnoreRevision, policyResult.headOid);

  writeFileSync(path.join(repo, "generated.log"), "ignored explicitly\n");
  const explicitResult = fingerprint(repo, "working-tree", null, ["generated.log", ".agent/"]);
  assert.equal(explicitResult.hasChanges, false);
  assert.deepEqual(explicitResult.excludePaths, [".agent", "generated.log"]);
  assert.deepEqual(explicitResult.explicitExcludePaths, [".agent", "generated.log"]);
  assert.notEqual(explicitResult.fingerprint, policyResult.fingerprint);
});

test("path inventories distinguish reserved UTF-8 names from raw-byte names", {
  skip: process.platform === "win32",
}, (t) => {
  const repo = makeRepository();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const reservedName = "raw-path:ff";
  const rawName = Buffer.from([0xff]);
  writeFileSync(path.join(repo, reservedName), "valid UTF-8 name\n");
  try {
    writeFileSync(
      Buffer.concat([Buffer.from(`${repo}${path.sep}`), rawName]),
      "non-UTF-8 name\n",
    );
  } catch (error) {
    if (["EILSEQ", "EINVAL", "ENOTSUP"].includes(error?.code)) {
      t.skip(`filesystem does not support raw-byte filenames: ${error.code}`);
      return;
    }
    throw error;
  }
  if (!readdirSync(repo, { encoding: "buffer" }).some((entry) => entry.equals(rawName))) {
    t.skip("filesystem did not preserve the raw-byte filename");
    return;
  }

  const result = fingerprint(repo, "working-tree");

  assert.equal(result.complete, true);
  assert.equal(result.pathInventoryComplete, true);
  assert.equal(result.workingTreePathsAbsentFromIndexCount, 2);
  assert.equal(result.workingTreePathsAbsentFromIndexTruncated, false);
  assert.deepEqual(result.workingTreePathsAbsentFromIndex, [
    "raw-path:ff",
    `utf8-path:${Buffer.from(reservedName).toString("hex")}`,
  ]);
});

test("path inventories cap serialized output and retain exact counts", (t) => {
  const repo = makeRepository();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  for (let index = 0; index < 300; index += 1) {
    const suffix = `${String(index).padStart(3, "0")}-${"x".repeat(200)}.txt`;
    writeFileSync(path.join(repo, `inventory-${suffix}`), "bounded\n");
  }

  const result = fingerprint(repo, "working-tree");
  const serialized = JSON.stringify(result, null, 2);

  assert.equal(result.complete, true);
  assert.equal(result.pathInventoryComplete, false);
  assert.deepEqual(result.pathInventoryLimits, {
    maxEntriesPerList: 256,
    maxJsonBytesPerList: 32 * 1024,
  });
  assert.equal(result.workingTreePathsAbsentFromIndexCount, 300);
  assert.equal(result.workingTreePathsAbsentFromIndexTruncated, true);
  assert.ok(result.workingTreePathsAbsentFromIndex.length < 300);
  assert.ok(Buffer.byteLength(serialized) < 40 * 1024, serialized.length);
  assert.ok(serialized.indexOf('"fingerprint"') < serialized.indexOf('"workingTreePathsAbsentFromIndex"'));
});

test("branch fingerprint uses base .reviewignore but still requires a fully clean checkout", (t) => {
  const repo = makeRepository();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(path.join(repo, ".agent"));
  writeFileSync(path.join(repo, ".agent", "state.jsonl"), "baseline\n");
  writeFileSync(path.join(repo, ".reviewignore"), ".agent/\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "add review policy"]);
  const base = git(repo, ["rev-parse", "HEAD"]);

  writeFileSync(path.join(repo, ".agent", "state.jsonl"), "branch-only ignored change\n");
  git(repo, ["add", ".agent/state.jsonl"]);
  git(repo, ["commit", "-qm", "update generated state"]);
  const ignoredOnly = fingerprint(repo, "branch", base);
  assert.equal(ignoredOnly.hasChanges, false);
  assert.equal(ignoredOnly.checkoutClean, true);
  assert.equal(ignoredOnly.reviewIgnoreRevision, base);

  writeFileSync(path.join(repo, ".agent", "state.jsonl"), "dirty checkout\n");
  const dirty = fingerprint(repo, "branch", base);
  assert.equal(dirty.hasChanges, false);
  assert.equal(dirty.checkoutClean, false);
});

test("a branch cannot activate a new .reviewignore rule from its own diff", (t) => {
  const repo = makeRepository();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const base = git(repo, ["rev-parse", "HEAD"]);
  mkdirSync(path.join(repo, "generated"));
  writeFileSync(path.join(repo, "generated", "result.txt"), "must remain visible\n");
  writeFileSync(path.join(repo, ".reviewignore"), "generated/\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "try to hide branch files"]);

  const result = fingerprint(repo, "branch", base);
  assert.equal(result.hasChanges, true);
  assert.deepEqual(result.excludePaths, []);
  assert.equal(result.reviewIgnoreRevision, null);
});

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
  assert.equal(result.pathInventoryComplete, false);
  assert.equal(result.dirtySubmodulePathsCount, 0);
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
      assert.equal(result.pathInventoryComplete, false);
      assert.equal(result.dirtySubmodulePathsCount, 0);
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
  assert.equal(result.pathInventoryComplete, false);
  assert.equal(result.dirtySubmodulePathsCount, 0);
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

test("fingerprint Git capture rejects stdout that never reaches end", async (t) => {
  const repo = makeRepository();
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "jig-fingerprint-stdio-"));
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });
  const helperPath = path.join(temporaryDirectory, "hold-stdout.mjs");
  const pidPath = path.join(temporaryDirectory, "pid.txt");
  writeFileSync(helperPath, [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {",
    "  detached: true,",
    "  stdio: ['ignore', 1, 2],",
    "});",
    "writeFileSync(process.argv[2], String(child.pid));",
    "child.unref();",
    "",
  ].join("\n"));
  const alias = `alias.hold=!${JSON.stringify(process.execPath)} ${JSON.stringify(helperPath)} ${JSON.stringify(pidPath)}`;

  await assert.rejects(
    runFingerprintGit(repo, ["-c", alias, "hold"], Date.now() + 5_000),
    (error) => error.outputIncomplete === true && error.outputLimit == null,
  );

  assert.equal(existsSync(pidPath), true);
  const escapedPid = Number(readFileSync(pidPath, "utf8"));
  t.after(() => {
    try {
      process.kill(escapedPid, "SIGKILL");
    } catch {
      // The process may already have exited.
    }
  });
});
