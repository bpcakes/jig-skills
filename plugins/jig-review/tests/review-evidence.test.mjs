import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ReviewEvidence } from "../skills/comprehensive-review/scripts/review-evidence.mjs";
import { buildReviewPrompt, collectReviewContext, resolveScope } from "../skills/comprehensive-review/scripts/review-context.mjs";
import { captureFingerprint } from "../skills/comprehensive-review/scripts/scope-fingerprint.mjs";
import { runClaudeReview } from "../skills/comprehensive-review/scripts/claude-review.mjs";
import { runCursorReview } from "../skills/comprehensive-review/scripts/cursor-review.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

function repository(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jig-evidence-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, "init", "-q");
  git(directory, "config", "user.name", "Test");
  git(directory, "config", "user.email", "test@example.invalid");
  return directory;
}

function store(t, options = {}) {
  const evidence = new ReviewEvidence(options);
  t.after(evidence.cleanup);
  return evidence;
}

function pages(evidence) {
  return readdirSync(evidence.directory).filter((name) => /^page-\d+\.json$/.test(name))
    .sort().map((name) => JSON.parse(readFileSync(path.join(evidence.directory, name))));
}

function sectionText(evidence, section) {
  return pages(evidence).filter((page) => page.section === section)
    .map((page) => page.textFragments.join("")).join("");
}

function aggregateFixture(t) {
  const repo = repository(t);
  writeFileSync(path.join(repo, "versions.txt"), `${"B".repeat(180_000)}\n`);
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  writeFileSync(path.join(repo, "versions.txt"), `${"S".repeat(180_000)}\n`);
  git(repo, "add", ".");
  writeFileSync(path.join(repo, "versions.txt"), `${"C".repeat(180_000)}\n`);
  for (const name of ["one.txt", "two.txt"]) writeFileSync(path.join(repo, name), "u".repeat(60_000));
  return repo;
}

test("a patch beyond 384 KiB retains deleted and prior code byte-for-byte", async (t) => {
  const repo = repository(t);
  const before = Array.from({ length: 2500 }, (_, i) => `old-${i}-${"b".repeat(100)}\n`).join("");
  writeFileSync(path.join(repo, "deleted.txt"), "DELETED_ONLY_EVIDENCE\n");
  writeFileSync(path.join(repo, "changed.txt"), before);
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  rmSync(path.join(repo, "deleted.txt"));
  writeFileSync(path.join(repo, "changed.txt"), before.replaceAll("old-", "new-"));
  const scope = await resolveScope({ cwd: repo, scope: "working-tree" });
  const legacy = await collectReviewContext(scope);
  assert.equal(legacy.incomplete, true);
  assert.match(legacy.text, /full diff omitted/);
  const evidence = store(t);
  const context = await collectReviewContext(scope, { evidence });
  const expected = git(repo, "diff", "--ignore-submodules=all", "--no-ext-diff", "--no-textconv", "--find-renames");
  assert.ok(Buffer.byteLength(expected) > 384 * 1024);
  assert.equal(sectionText(evidence, "Working tree unstaged diff"), expected);
  assert.match(expected, /-DELETED_ONLY_EVIDENCE/);
  assert.equal(context.incomplete, false);
  assert.ok(context.evidence.pageCount > 1);
});

test("aggregate overflow preserves distinct base/index/current versions and untracked files", async (t) => {
  const repo = aggregateFixture(t);
  const scope = await resolveScope({ cwd: repo, scope: "working-tree" });
  const staged = git(repo, "diff", "--cached", "--submodule=diff", "--no-ext-diff", "--no-textconv", "--find-renames");
  const unstaged = git(repo, "diff", "--ignore-submodules=all", "--no-ext-diff", "--no-textconv", "--find-renames");
  assert.ok(Buffer.byteLength(staged) < 384 * 1024);
  assert.ok(Buffer.byteLength(unstaged) < 384 * 1024);
  const legacy = await collectReviewContext(scope);
  assert.deepEqual(legacy.limitations, ["overall review-context byte limit reached"]);
  const evidence = store(t);
  const context = await collectReviewContext(scope, { evidence });
  assert.equal(context.incomplete, false);
  assert.ok(Buffer.byteLength(buildReviewPrompt(scope, context)) < 8192,
    "paged review must not also inline the oversized preview");
  assert.equal(sectionText(evidence, "Working tree staged diff"), staged);
  assert.equal(sectionText(evidence, "Working tree unstaged diff"), unstaged);
  const untracked = sectionText(evidence, "Working tree untracked files");
  assert.match(untracked, /one.txt/);
  assert.match(untracked, /two.txt/);
  assert.equal((untracked.match(/u{60000}/g) ?? []).length, 2);
  for (const name of readdirSync(evidence.directory)) {
    const text = readFileSync(path.join(evidence.directory, name), "utf8");
    assert.ok(text.split("\n").length < 2000);
    assert.ok(text.split("\n").every((line) => line.length < 2000));
  }
});

test("branch evidence uses the pinned merge-base and preserves deleted content", async (t) => {
  const repo = repository(t);
  writeFileSync(path.join(repo, "gone.txt"), "removed\n".repeat(60_000));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD").trim();
  rmSync(path.join(repo, "gone.txt"));
  git(repo, "commit", "-qam", "delete");
  const scope = await resolveScope({ cwd: repo, scope: "branch", base });
  const evidence = store(t);
  const context = await collectReviewContext(scope, { evidence });
  const range = `${scope.mergeBaseOid}..${scope.headOid}`;
  assert.equal(sectionText(evidence, `Branch diff ${range}`),
    git(repo, "diff", "--no-ext-diff", "--no-textconv", "--submodule=diff", "--find-renames", range));
  assert.equal(context.incomplete, false);
});

test("paged submodule patches retain commit, staged, and unstaged distinctions", async (t) => {
  const source = repository(t);
  writeFileSync(path.join(source, "file.txt"), "base\n".repeat(80_000));
  git(source, "add", ".");
  git(source, "commit", "-qm", "base");
  const repo = repository(t);
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "vendor/lib");
  git(repo, "commit", "-qm", "submodule");
  const submodule = path.join(repo, "vendor/lib");
  git(submodule, "config", "user.name", "Test");
  git(submodule, "config", "user.email", "test@example.invalid");
  const base = git(submodule, "rev-parse", "HEAD").trim();
  writeFileSync(path.join(submodule, "file.txt"), "committed\n".repeat(80_000));
  git(submodule, "commit", "-qam", "advance");
  const head = git(submodule, "rev-parse", "HEAD").trim();
  writeFileSync(path.join(submodule, "file.txt"), "staged\n".repeat(80_000));
  git(submodule, "add", ".");
  writeFileSync(path.join(submodule, "file.txt"), "current\n".repeat(80_000));
  const scope = await resolveScope({ cwd: repo, scope: "working-tree" });
  const evidence = store(t);
  const context = await collectReviewContext(scope, { evidence });
  assert.equal(context.incomplete, false);
  const shared = ["--no-ext-diff", "--no-textconv", "--find-renames"];
  assert.equal(sectionText(evidence, `Submodule vendor/lib commit change ${base}..${head}`),
    git(submodule, "diff", ...shared, `${base}..${head}`));
  assert.equal(sectionText(evidence, "Submodule vendor/lib staged diff"),
    git(submodule, "diff", "--cached", "--submodule=diff", ...shared));
  assert.equal(sectionText(evidence, "Submodule vendor/lib unstaged diff"),
    git(submodule, "diff", "--ignore-submodules=all", ...shared));
});

test("real evidence limits remain partial even with every available page attested", async (t) => {
  const repo = aggregateFixture(t);
  const evidence = store(t, { maxBytes: 5000 });
  const scope = await resolveScope({ cwd: repo, scope: "working-tree" });
  const context = await collectReviewContext(scope, { evidence });
  assert.equal(context.incomplete, true);
  assert.match(context.limitations.join(" "), /evidence byte limit/);
  const receipt = JSON.stringify({ reviewed: pages(evidence).map(({ id, receipt }) => ({ id, receipt })) });
  const report = evidence.annotateReport(`No findings.\n<review-coverage>${receipt}</review-coverage>`, context);
  assert.match(report, /Evidence coverage: limited/);
  assert.match(report, /Capture limitations/);
});

test("missing, forged, and duplicate page receipts cannot imply complete coverage", (t) => {
  const evidence = store(t);
  evidence.add("patch", "-before\n+after\n");
  evidence.required = true;
  const context = evidence.finish({ repoRoot: "/repo", label: "test" }, { limitations: [] });
  const [{ id, receipt }] = pages(evidence);
  assert.match(evidence.annotateReport("No findings.", context), /limited; 0\/1/);
  for (const reviewed of [[{ id, receipt: "forged" }], [{ id, receipt }, { id, receipt }]]) {
    assert.match(evidence.annotateReport(`No findings.\n<review-coverage>${JSON.stringify({ reviewed })}</review-coverage>`, context), /Evidence coverage: limited/);
  }
  const report = evidence.annotateReport(`No findings.\n<review-coverage>${JSON.stringify({ reviewed: [{ id, receipt }] })}</review-coverage>`, context);
  assert.match(report, /reviewer-attested; 1\/1/);
  assert.doesNotMatch(report, new RegExp(receipt));
});

test("streaming pages preserve UTF-8, BOMs and arbitrarily split input", (t) => {
  const evidence = store(t);
  const original = `\uFEFF${"🙂\n\"\\".repeat(10_000)}`;
  const bytes = Buffer.from(original);
  const stream = evidence.start("unicode");
  for (let i = 0; i < bytes.length; i += 71) stream.write(bytes.subarray(i, i + 71));
  stream.end();
  assert.equal(sectionText(evidence, "unicode"), original);
});

test("evidence capture observes cancellation and deadlines", (t) => {
  const controller = new AbortController();
  const evidence = store(t, { signal: controller.signal });
  controller.abort(new Error("test cancellation"));
  assert.throws(() => evidence.add("patch", "text"), /test cancellation/);
  const expired = store(t, { deadlineAt: Date.now() - 1 });
  assert.throws(() => expired.add("patch", "text"), (error) => error.timedOut === true);
});

for (const provider of ["claude", "cursor"]) {
  test(`${provider} adapter exposes evidence through read-only directory access and cleans it`, async (t) => {
    const repo = aggregateFixture(t);
    const helperDir = mkdtempSync(path.join(os.tmpdir(), "jig-evidence-provider-"));
    t.after(() => rmSync(helperDir, { recursive: true, force: true }));
    const capturePath = path.join(helperDir, "capture.json");
    const fake = path.join(helperDir, "provider.mjs");
    writeFileSync(fake, `#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const dir = args[args.indexOf('--add-dir') + 1];
const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json')));
const pages = readdirSync(dir).filter(n => /^page-\\d+\\.json$/.test(n)).sort().map(n => JSON.parse(readFileSync(path.join(dir,n))));
writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({args, dir, manifest, pages}));
process.stdin.resume();
const report = 'No findings.\\n<review-coverage>' + JSON.stringify({reviewed: pages.map(({id,receipt}) => ({id,receipt}))}) + '</review-coverage>';
process.stdout.write(${JSON.stringify(provider)} === 'claude' ? JSON.stringify({result: report}) : report);
`);
    chmodSync(fake, 0o755);
    const initial = await captureFingerprint({ cwd: repo, scope: "working-tree" });
    const options = { cwd: repo, scope: "working-tree", model: "opus", effort: "high",
      expectedFingerprint: initial.fingerprint, timeoutMs: 10_000 };
    const report = provider === "claude"
      ? await runClaudeReview(options, { claudeBin: fake })
      : await runCursorReview(options, { cursorBin: fake });
    const captured = JSON.parse(readFileSync(capturePath));
    assert.ok(captured.pages.length > 1);
    if (provider === "claude") {
      assert.ok(captured.args.includes("--restricted"));
      assert.equal(captured.args[captured.args.indexOf("--tools") + 1], "Read,Glob,Grep");
    } else {
      assert.equal(captured.args[captured.args.indexOf("--mode") + 1], "ask");
      assert.equal(captured.args[captured.args.indexOf("--sandbox") + 1], "enabled");
    }
    assert.match(report, /Evidence coverage: reviewer-attested/);
    assert.equal(existsSync(captured.dir), false);
    assert.equal((await captureFingerprint({ cwd: repo, scope: "working-tree" })).fingerprint, initial.fingerprint);
  });

  for (const failure of ["provider error", "deadline", "cancellation", "scope mutation"]) {
    test(`${provider} cleans paged evidence after ${failure}`, async (t) => {
      const repo = aggregateFixture(t);
      const helperDir = mkdtempSync(path.join(os.tmpdir(), "jig-evidence-failure-"));
      t.after(() => rmSync(helperDir, { recursive: true, force: true }));
      const captured = path.join(helperDir, "directory.txt");
      const fake = path.join(helperDir, "provider.mjs");
      writeFileSync(fake, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(captured)}, args[args.indexOf('--add-dir') + 1]);
process.stdin.resume();
${failure === "provider error" ? "process.exit(1);" : failure === "scope mutation"
    ? `writeFileSync(${JSON.stringify(path.join(repo, "mutation.txt"))}, 'changed'); process.stdout.write(${JSON.stringify(provider === "claude" ? '{"result":"stale report"}' : 'stale report')});`
    : "setInterval(() => {}, 1000);"}
`);
      chmodSync(fake, 0o755);
      const controller = new AbortController();
      const initial = await captureFingerprint({ cwd: repo, scope: "working-tree" });
      const options = { cwd: repo, scope: "working-tree", model: "opus", effort: "high",
        expectedFingerprint: initial.fingerprint, timeoutMs: 10_000 };
      const dependencies = {
        claudeBin: fake, cursorBin: fake, signal: controller.signal,
        ...(failure === "deadline" ? { providerTimeout: () => 300 } : {}),
      };
      let timer;
      if (failure === "cancellation") {
        timer = setInterval(() => {
          if (existsSync(captured)) controller.abort(Object.assign(new Error("test cancellation"), { cancelled: true }));
        }, 10);
        t.after(() => clearInterval(timer));
      }
      await assert.rejects(provider === "claude"
        ? runClaudeReview(options, dependencies) : runCursorReview(options, dependencies),
      (error) => failure === "deadline" ? error.timedOut === true
        : failure === "cancellation" ? error.cancelled === true
          : failure === "scope mutation" ? error.scopeChanged === true : error.exitCode === 1);
      clearInterval(timer);
      assert.equal(existsSync(readFileSync(captured, "utf8")), false);
    });
  }
}
