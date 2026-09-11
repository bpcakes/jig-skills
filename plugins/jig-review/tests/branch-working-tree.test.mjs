import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureFingerprint, parseArgs as parseFingerprint } from "../skills/comprehensive-review/scripts/scope-fingerprint.mjs";
import { buildReviewPrompt, collectReviewContext, resolveScope } from "../skills/comprehensive-review/scripts/review-context.mjs";
import { parseArgs as parseClaude, runClaudeReview } from "../skills/comprehensive-review/scripts/claude-review.mjs";
import { parseArgs as parseCursor, runCursorReview } from "../skills/comprehensive-review/scripts/cursor-review.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "jig-branch-working-tree-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Branch Review Test");
  git(cwd, "config", "user.email", "review@example.invalid");
  writeFileSync(path.join(cwd, "app.txt"), "BASE-CONTENT\n");
  writeFileSync(path.join(cwd, "ignored.txt"), "BASE-IGNORED\n");
  writeFileSync(path.join(cwd, ".reviewignore"), "ignored.txt\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  return { cwd, base, scope: "branch", includeWorkingTree: true };
}

function branchAndRepairs(options) {
  const { cwd } = options;
  writeFileSync(path.join(cwd, "app.txt"), "COMMITTED-DEFECT\n");
  writeFileSync(path.join(cwd, "other.txt"), "OTHER-BRANCH-DEFECT\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "branch changes");
  writeFileSync(path.join(cwd, "app.txt"), "STAGED-CORRECTION\n");
  git(cwd, "add", "app.txt");
  writeFileSync(path.join(cwd, "app.txt"), "FINAL-CORRECTION\n");
  writeFileSync(path.join(cwd, "regression.txt"), "UNTRACKED-REGRESSION-CASE\n");
}

test("combined branch scope is explicit and branch-only in every CLI", () => {
  for (const parse of [parseFingerprint, parseClaude, parseCursor]) {
    const extra = parse === parseFingerprint ? [] : ["--expected-fingerprint", "a".repeat(64)];
    const args = ["--scope", "branch", "--base", "main", ...extra];
    assert.equal(parse(args).includeWorkingTree, false);
    assert.equal(parse([...args, "--include-working-tree"]).includeWorkingTree, true);
    assert.throws(() => parse([...args, "--include-working-tree", "--include-working-tree"]), /Duplicate/);
    assert.throws(() => parse(["--scope", "working-tree", "--include-working-tree", ...extra]), /requires branch/);
  }
});

test("every pass retains untouched branch defects alongside staged, unstaged, and untracked repairs", async (t) => {
  const options = repository(t);
  branchAndRepairs(options);
  const index = readFileSync(path.join(options.cwd, ".git/index"));
  const before = await captureFingerprint(options);
  assert.deepEqual(before.workingTreePathsDifferingFromIndex, ["app.txt"]);
  assert.deepEqual(before.workingTreePathsAbsentFromIndex, ["regression.txt"]);
  assert.deepEqual(before.dirtySubmodulePaths, []);
  const scope = await resolveScope(options);
  const context = await collectReviewContext(scope);
  assert.equal(context.incomplete, false);
  for (const evidence of ["BASE-CONTENT", "COMMITTED-DEFECT", "OTHER-BRANCH-DEFECT", "STAGED-CORRECTION", "FINAL-CORRECTION", "UNTRACKED-REGRESSION-CASE"]) {
    assert.ok(context.text.includes(evidence), `missing ${evidence}`);
  }
  assert.match(buildReviewPrompt(scope, context), /final working files are the review target/i);
  assert.deepEqual(readFileSync(path.join(options.cwd, ".git/index")), index);
  assert.equal((await captureFingerprint(options)).fingerprint, before.fingerprint);

  writeFileSync(path.join(options.cwd, "app.txt"), "NEXT-ROUND-CORRECTION\n");
  const next = await captureFingerprint({ ...options, base: before.baseOid });
  assert.notEqual(next.fingerprint, before.fingerprint);
  assert.equal(next.headOid, before.headOid);
  assert.equal(next.mergeBaseOid, before.mergeBaseOid);
  const nextContext = await collectReviewContext(await resolveScope({ ...options, base: before.baseOid }));
  assert.match(nextContext.text, /OTHER-BRANCH-DEFECT/);
  assert.match(nextContext.text, /NEXT-ROUND-CORRECTION/);
});

test("combined scope sees local-only changes and cannot be confused with committed-only branch scope", async (t) => {
  const options = repository(t);
  const empty = await captureFingerprint(options);
  assert.equal(empty.hasChanges, false);
  const committedOnly = await captureFingerprint({ ...options, includeWorkingTree: false });
  assert.notEqual(empty.fingerprint, committedOnly.fingerprint);
  writeFileSync(path.join(options.cwd, "new.txt"), "local only\n");
  const localOnly = await captureFingerprint(options);
  assert.equal(localOnly.hasChanges, true);
  assert.deepEqual(localOnly.workingTreePathsDifferingFromIndex, []);
  assert.deepEqual(localOnly.workingTreePathsAbsentFromIndex, ["new.txt"]);
  assert.equal((await captureFingerprint({ ...options, includeWorkingTree: false })).hasChanges, false);
  await assert.rejects(resolveScope({ ...options, includeWorkingTree: false }), /clean checkout/);
  assert.match((await collectReviewContext(await resolveScope(options))).text, /local only/);
});

test("restoring branch content to the base still reviews the committed change and its inverse", async (t) => {
  const options = repository(t);
  writeFileSync(path.join(options.cwd, "app.txt"), "COMMITTED-DEFECT\n");
  git(options.cwd, "commit", "-qam", "branch defect");
  writeFileSync(path.join(options.cwd, "app.txt"), "BASE-CONTENT\n");
  assert.equal(git(options.cwd, "diff", options.base, "--", "app.txt"), "");
  assert.equal((await captureFingerprint(options)).hasChanges, true);
  const context = await collectReviewContext(await resolveScope(options));
  assert.match(context.text, /\+COMMITTED-DEFECT/);
  assert.match(context.text, /-COMMITTED-DEFECT/);
  assert.match(context.text, /\+BASE-CONTENT/);
});

test("combined scope trusts base exclusions and a pinned OID even when local policy and base refs move", async (t) => {
  const options = repository(t);
  git(options.cwd, "branch", "review-base", options.base);
  branchAndRepairs(options);
  writeFileSync(path.join(options.cwd, ".reviewignore"), "app.txt\nother.txt\nregression.txt\n");
  const before = await captureFingerprint({ ...options, base: "review-base" });
  assert.deepEqual(before.excludePaths, ["ignored.txt"]);
  assert.equal(before.reviewIgnoreRevision, options.base);
  writeFileSync(path.join(options.cwd, "ignored.txt"), "EXCLUDED-LOCAL-PAYLOAD\n");
  git(options.cwd, "branch", "-f", "review-base", "HEAD");
  const after = await captureFingerprint({ ...options, base: before.baseOid });
  assert.equal(after.fingerprint, before.fingerprint);
  assert.deepEqual(after.workingTreePathsDifferingFromIndex, [".reviewignore", "app.txt"]);
  assert.deepEqual(after.workingTreePathsAbsentFromIndex, ["regression.txt"]);
  const context = await collectReviewContext(await resolveScope({ ...options, base: before.baseOid }));
  for (const evidence of [
    "FINAL-CORRECTION",
    "UNTRACKED-REGRESSION-CASE",
    "OTHER-BRANCH-DEFECT",
  ]) {
    assert.ok(context.text.includes(evidence), `missing ${evidence}`);
  }
  assert.doesNotMatch(context.text, /EXCLUDED-LOCAL-PAYLOAD/);
});

test("branch plus repair context retains initialized submodule commits and local evidence", async (t) => {
  const options = repository(t);
  const source = repository(t);
  git(options.cwd, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source.cwd, "vendor");
  git(options.cwd, "commit", "-qam", "add submodule");
  options.base = git(options.cwd, "rev-parse", "HEAD");
  const vendor = path.join(options.cwd, "vendor");
  git(vendor, "config", "user.name", "Submodule Test");
  git(vendor, "config", "user.email", "submodule@example.invalid");
  writeFileSync(path.join(vendor, "app.txt"), "SUBMODULE-BRANCH-DEFECT\n");
  git(vendor, "commit", "-qam", "submodule change");
  git(options.cwd, "commit", "-qam", "update gitlink");
  writeFileSync(path.join(vendor, "app.txt"), "SUBMODULE-REPAIR\n");
  writeFileSync(path.join(vendor, "case.txt"), "SUBMODULE-UNTRACKED\n");
  const before = await captureFingerprint(options);
  assert.equal(before.complete, true);
  assert.equal(before.submoduleCount, 1);
  assert.deepEqual(before.workingTreePathsDifferingFromIndex, ["vendor/app.txt"]);
  assert.deepEqual(before.workingTreePathsAbsentFromIndex, ["vendor/case.txt"]);
  assert.deepEqual(before.dirtySubmodulePaths, ["vendor"]);
  const context = await collectReviewContext(await resolveScope(options));
  assert.equal(context.incomplete, false);
  for (const evidence of ["SUBMODULE-BRANCH-DEFECT", "SUBMODULE-REPAIR", "SUBMODULE-UNTRACKED"]) {
    assert.ok(context.text.includes(evidence), `missing ${evidence}`);
  }
  writeFileSync(path.join(vendor, "case.txt"), "SUBMODULE-CASE-CHANGED\n");
  assert.notEqual((await captureFingerprint(options)).fingerprint, before.fingerprint);
});

test("index-state reporting preserves nested submodule paths", async (t) => {
  const options = repository(t);
  const vendorSource = repository(t);
  const nestedSource = repository(t);
  git(options.cwd, "-c", "protocol.file.allow=always", "submodule", "add", "-q", vendorSource.cwd, "vendor");
  const vendor = path.join(options.cwd, "vendor");
  git(vendor, "config", "user.name", "Nested Submodule Test");
  git(vendor, "config", "user.email", "nested@example.invalid");
  git(vendor, "-c", "protocol.file.allow=always", "submodule", "add", "-q", nestedSource.cwd, "nested");
  git(vendor, "commit", "-qam", "add nested submodule");
  git(options.cwd, "commit", "-qam", "add nested submodules");
  options.base = git(options.cwd, "rev-parse", "HEAD");

  const nested = path.join(vendor, "nested");
  git(nested, "config", "user.name", "Nested Submodule Test");
  git(nested, "config", "user.email", "nested@example.invalid");
  writeFileSync(path.join(nested, "app.txt"), "NESTED-COMMITTED\n");
  git(nested, "commit", "-qam", "move nested head");
  writeFileSync(path.join(nested, "app.txt"), "NESTED-WORKING\n");
  writeFileSync(path.join(nested, "case.txt"), "NESTED-UNTRACKED\n");

  const fingerprint = await captureFingerprint(options);
  assert.equal(fingerprint.complete, true);
  assert.equal(fingerprint.submoduleCount, 2);
  assert.equal(fingerprint.pathInventoryComplete, true);
  assert.equal(fingerprint.workingTreePathsDifferingFromIndexCount, 2);
  assert.equal(fingerprint.workingTreePathsDifferingFromIndexTruncated, false);
  assert.deepEqual(fingerprint.workingTreePathsDifferingFromIndex, [
    "vendor/nested",
    "vendor/nested/app.txt",
  ]);
  assert.equal(fingerprint.workingTreePathsAbsentFromIndexCount, 1);
  assert.equal(fingerprint.workingTreePathsAbsentFromIndexTruncated, false);
  assert.deepEqual(fingerprint.workingTreePathsAbsentFromIndex, [
    "vendor/nested/case.txt",
  ]);
  assert.equal(fingerprint.dirtySubmodulePathsCount, 2);
  assert.equal(fingerprint.dirtySubmodulePathsTruncated, false);
  assert.deepEqual(fingerprint.dirtySubmodulePaths, ["vendor", "vendor/nested"]);
});

test("combined scope preserves coverage limitations", async (t) => {
  const options = repository(t);
  writeFileSync(path.join(options.cwd, "oversized.txt"), "x".repeat(65 * 1024));
  const scope = await resolveScope(options);
  const context = await collectReviewContext(scope);
  assert.equal(context.incomplete, true);
  assert.match(buildReviewPrompt(scope, context), /Do not claim complete coverage/);
  await assert.rejects(resolveScope({ ...options, base: "missing-base" }));
  await assert.rejects(captureFingerprint({ ...options, base: "missing-base" }));
});

test("both adapters transport the combined scope and reject checkout drift", async (t) => {
  for (const provider of ["claude", "cursor"]) {
    await t.test(provider, async (subtest) => {
      const options = repository(subtest);
      branchAndRepairs(options);
      const captureDir = mkdtempSync(path.join(os.tmpdir(), "jig-branch-provider-"));
      subtest.after(() => rmSync(captureDir, { recursive: true, force: true }));
      const capture = path.join(captureDir, "prompt.txt");
      const binary = path.join(captureDir, "provider.mjs");
      const promptReader = provider === "claude"
        ? 'let prompt = ""; for await (const chunk of process.stdin) prompt += chunk;'
        : 'const argv = process.argv.slice(2); const prompt = readFileSync(path.join(argv[argv.indexOf("--add-dir") + 1], "review-prompt.md"), "utf8");';
      const response = provider === "claude"
        ? 'process.stdout.write(JSON.stringify({result: "Transport complete"}));'
        : 'process.stdout.write("Transport complete");';
      const script = [
        "#!/usr/bin/env node",
        'import { readFileSync, writeFileSync } from "node:fs";',
        'import path from "node:path";',
        promptReader,
        `writeFileSync(${JSON.stringify(capture)}, prompt);`,
        response,
      ].join("\n");
      writeFileSync(binary, script, { mode: 0o700 });
      const fingerprint = await captureFingerprint(options);
      const args = ["--cwd", options.cwd, "--scope", "branch", "--base", fingerprint.baseOid,
        "--include-working-tree", "--expected-fingerprint", fingerprint.fingerprint, "--timeout-ms", "10000"];
      const parsed = (provider === "claude" ? parseClaude : parseCursor)(args);
      const run = () => provider === "claude"
        ? runClaudeReview(parsed, { claudeBin: binary })
        : runCursorReview(parsed, { cursorBin: binary });
      assert.equal(await run(), "Transport complete");
      const prompt = readFileSync(capture, "utf8");
      for (const evidence of ["COMMITTED-DEFECT", "OTHER-BRANCH-DEFECT", "STAGED-CORRECTION", "FINAL-CORRECTION", "UNTRACKED-REGRESSION-CASE"]) {
        assert.ok(prompt.includes(evidence), `missing ${evidence}`);
      }
      assert.match(prompt, /final working files are the review target/i);
      writeFileSync(binary, `${script}\nwriteFileSync(${JSON.stringify(path.join(options.cwd, "app.txt"))}, "unexpected change\\n");`);
      await assert.rejects(run(), /review scope fingerprint changed/);
    });
  }
});
