import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectReviewContext, resolveScope } from "../skills/comprehensive-review/scripts/review-context.mjs";
import { captureFingerprint } from "../skills/comprehensive-review/scripts/scope-fingerprint.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
}

function repository(t) {
  const repo = mkdtempSync(path.join(os.tmpdir(), "jig-large-index-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Review Test"]);
  git(repo, ["config", "user.email", "review@example.invalid"]);
  writeFileSync(path.join(repo, "tracked.txt"), "initial\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "initial"]);
  return repo;
}

function enlargeIndex(repo) {
  const directory = path.join(repo, "a-index");
  mkdirSync(directory);
  for (let i = 0; i < 4000; i += 1) {
    writeFileSync(path.join(directory, `${String(i).padStart(5, "0")}-${"x".repeat(40)}.txt`), "");
  }
  git(repo, ["add", "a-index"]);
  git(repo, ["commit", "-qm", "large index"]);
  assert.ok(git(repo, ["ls-files", "--stage", "-z"]).length > 256 * 1024);
}

function addGitlinks(repo, count = 5_000) {
  const oid = git(repo, ["rev-parse", "HEAD"]).toString("utf8").trim();
  const records = Buffer.from(Array.from(
    { length: count },
    (_, index) => `160000 ${oid}\tvendor/${String(index).padStart(5, "0")}\0`,
  ).join(""));
  execFileSync("git", ["update-index", "-z", "--index-info"], {
    cwd: repo,
    input: records,
  });
  git(repo, ["commit", "-qm", "many gitlinks"]);
}

test("a large index without submodules retains complete review coverage", async (t) => {
  const repo = repository(t);
  enlargeIndex(repo);
  writeFileSync(path.join(repo, "tracked.txt"), "visible root change\n");
  const fingerprint = await captureFingerprint({ cwd: repo, scope: "working-tree" });
  const scope = await resolveScope({ cwd: repo, scope: "working-tree" });
  const context = await collectReviewContext(scope);
  assert.equal(fingerprint.complete, true, fingerprint.issues.join("; "));
  assert.equal(fingerprint.hasChanges, true);
  assert.equal(context.incomplete, false, context.limitations.join("; "));
  assert.match(context.text, /\+visible root change/);
});

test("excessive gitlinks degrade submodule enumeration without aborting", async (t) => {
  const repo = repository(t);
  addGitlinks(repo);
  writeFileSync(path.join(repo, "tracked.txt"), "visible root change\n");

  const scope = await resolveScope({ cwd: repo, scope: "working-tree" });
  const context = await collectReviewContext(scope);

  assert.equal(context.incomplete, true);
  assert.match(context.text, /submodule enumeration exceeded the adapter limit/);
  assert.ok(context.limitations.includes("submodule enumeration exceeded the adapter limit"));
});

test("excessive nested gitlinks identify the affected submodule", async (t) => {
  const repo = repository(t);
  const source = repository(t);
  git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "dependency"]);
  git(repo, ["commit", "-qam", "add submodule"]);
  const submodule = path.join(repo, "dependency");
  git(submodule, ["config", "user.name", "Review Test"]);
  git(submodule, ["config", "user.email", "review@example.invalid"]);
  addGitlinks(submodule);
  git(repo, ["add", "dependency"]);

  const scope = await resolveScope({ cwd: repo, scope: "working-tree" });
  const context = await collectReviewContext(scope);

  assert.equal(context.incomplete, true);
  assert.match(
    context.text,
    /## Submodule dependency children\n\[submodule enumeration exceeded the adapter limit\]/,
  );
  assert.ok(context.limitations.includes("submodule enumeration exceeded the adapter limit"));
});

test("a gitlink beyond the former index cutoff remains reviewed and respects exclusions", async (t) => {
  const repo = repository(t);
  const source = repository(t);
  enlargeIndex(repo);
  git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "vendor/example"]);
  git(repo, ["commit", "-qam", "add submodule"]);
  assert.ok(git(repo, ["ls-files", "--stage", "-z"]).indexOf(Buffer.from("160000 ")) > 256 * 1024);
  writeFileSync(path.join(repo, "vendor/example/tracked.txt"), "visible late submodule change\n");

  const scope = await resolveScope({ cwd: repo, scope: "working-tree" });
  const context = await collectReviewContext(scope);
  assert.equal(context.incomplete, false, context.limitations.join("; "));
  assert.match(context.text, /\+visible late submodule change/);

  const excluded = await resolveScope({ cwd: repo, scope: "working-tree", excludePaths: ["vendor/example"] });
  const excludedContext = await collectReviewContext(excluded);
  assert.equal(excludedContext.incomplete, false, excludedContext.limitations.join("; "));
  assert.doesNotMatch(excludedContext.text, /visible late submodule change/);
});
