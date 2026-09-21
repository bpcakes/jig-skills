import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs, { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { advance, createRun, status, submit, TERMINAL } from "../skills/review-fix-loop/scripts/review-fix-loop.mjs";
import { parseArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";
import { loadRun } from "../skills/review-fix-loop/scripts/run-store.mjs";
import { prepareRoundCommit, publishRoundCommit } from "../skills/review-fix-loop/scripts/round-commits.mjs";
import { defaultValidationSandbox } from "../skills/review-fix-loop/scripts/validation-sandbox.mjs";

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(t, { dirty = true, value = 0 } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jig-round-commits-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(path.join(root, "value.cjs"), `module.exports = ${value};\n`);
  git(root, "add", "."); git(root, "commit", "-qm", "original");
  const base = git(root, "rev-parse", "HEAD");
  if (dirty) writeFileSync(path.join(root, "value.cjs"), "module.exports = 1;\n");
  const contract = { goal: "Correct the export", acceptanceCriteria: [{ id: "value", description: "Export 2" }],
    nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: [], requiredValidation: [{ id: "unit", argv: [process.execPath, "-e",
      "require('node:assert/strict').equal(require('./value.cjs'),2);require('node:assert/strict').equal(require('node:child_process').execFileSync('git',['status','--porcelain'],{encoding:'utf8'}),'')"] }] };
  return { root, base, contract, start: extra => createRun({ cwd: root, contract, ...extra }) };
}
async function drive(run, { secondRepair = false, failFirst = false, reviewRanges = [] } = {}) {
  for (let i = 0; i < 350; i++) {
    run = await advance(run.directory);
    if (TERMINAL.has(run.phase) && !run.cleanup?.length && !run.cleanupOverlays?.length) return run;
    if (run.pending && !run.pending.command) {
      const a = run.pending.assignment;
      const correct = readFileSync(path.join(a.repository, "value.cjs"), "utf8").includes("= 2;");
      let result;
      if (a.role === "review") {
        assert.equal(a.commitMode, "per-round");
        assert.equal(a.scope.checkoutClean, true);
        assert.equal(a.scope.includeWorkingTree, false);
        assert.equal(a.commitRange.tip, git(run.root, "rev-parse", "HEAD"));
        reviewRanges.push(a.commitRange);
        const findings = !correct ? [{ key: "value", path: "value.cjs", severity: "medium", title: "Wrong export", evidence: "Export must equal 2" }]
          : secondRepair && !existsSync(path.join(run.root, "support.txt")) ? [{ key: "support", path: "support.txt", severity: "low", title: "Missing support", evidence: "Required neighboring path is absent" }] : [];
        result = { complete: true, findings, acceptance: [{ criterionId: "value", status: correct ? "satisfied" : "unsatisfied", evidence: "Inspected export and pinned validation command", validationIds: ["unit"] }] };
      } else if (a.role === "triage") {
        result = { decisions: a.findings.map(f => ({ id: f.id,
          status: f.key === "support" ? existsSync(path.join(run.root, "support.txt")) ? "fixed" : "actionable" : correct ? "fixed" : "actionable",
          evidence: "Checked current source and matching validation" })) };
      } else {
        const name = correct ? "support.txt" : "value.cjs";
        writeFileSync(path.join(a.repository, name), correct ? "ready\n" : `module.exports = ${failFirst && run.round === 1 ? 3 : 2};\n`);
        result = { workspaceEdits: [{ path: name, reason: "Repair the supported failure", findingIds: a.findings.map(f => f.id) }] };
      }
      await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...result });
    }
    if (run.validationCycle?.job || run.pending?.command) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`No terminal outcome: ${JSON.stringify(status(run))}`);
}

test("default appends one commit per repair round and terminal reviews cover one full stable range", async t => {
  const f = fixture(t), reviewRanges = [];
  const run = await drive(await f.start(), { secondRepair: true, reviewRanges });
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.equal(run.round, 2);
  assert.deepEqual(run.commits.map(c => c.round), [0, 1, 2]);
  assert.equal(git(f.root, "rev-list", "--count", `${f.base}..HEAD`), "3");
  assert.equal(git(f.root, "status", "--porcelain"), "");
  assert.equal(git(f.root, "show", `${f.base}:value.cjs`), "module.exports = 0;");
  for (let i = 0; i < run.commits.length; i++) assert.equal(run.commits[i].parent, i ? run.commits[i - 1].oid : f.base);
  assert.ok(reviewRanges.every(r => r.base === f.base));
  assert.deepEqual(reviewRanges.at(-1), reviewRanges.at(-2));
  assert.equal(reviewRanges.at(-1).tip, git(f.root, "rev-parse", "HEAD"));
  assert.equal(run.reports.length, 2);
  assert.ok(run.reports.every(r => r.fingerprint === run.fingerprint.fingerprint));
  assert.equal(status(run).indexNeedsRestaging, false);
  assert.equal(status(loadRun(run.directory)).commitRange.range, `${f.base}..${git(f.root, "rev-parse", "HEAD")}`);
});

test("failed validation keeps its round commit and recovery appends another", async t => {
  const f = fixture(t);
  const run = await drive(await f.start(), { failFirst: true });
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.deepEqual(run.commits.map(c => c.round), [0, 1, 2]);
  assert.equal(git(f.root, "show", `${run.commits[1].oid}:value.cjs`), "module.exports = 3;");
  assert.equal(git(f.root, "show", "HEAD:value.cjs"), "module.exports = 2;");
  assert.ok(run.validation.some(v => v.exitCode !== 0));
});

test("already clean committed work needs no empty checkpoint or repair commit", async t => {
  const f = fixture(t, { dirty: false, value: 2 });
  const run = await drive(await f.start());
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.deepEqual(run.commits, []);
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.base);
});

test("default commit mode also supports command-backed reviewers and repairs", async t => {
  const f = fixture(t);
  const command = [process.execPath, new URL("./fixtures/loop-provider.mjs", import.meta.url).pathname, "workspace"];
  const run = await drive(await f.start({ config: { reviewers: [{ id: "codex", command }], triageCommand: command, repairCommand: command } }));
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.deepEqual(run.commits.map(c => c.round), [0, 1]);
  assert.equal(git(f.root, "status", "--porcelain"), "");
});

test("isolated validation checks the committed round, including Git-aware checks", async t => {
  if (process.platform === "linux" && spawnSync("bwrap", ["--unshare-net", "--ro-bind", "/", "/", "--", "true"]).status !== 0) {
    t.skip("Bubblewrap/user namespaces unavailable"); return;
  }
  const f = fixture(t);
  const run = await drive(await f.start({ config: { validationMode: "isolated", validationSandbox: defaultValidationSandbox() } }));
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.deepEqual(run.commits.map(c => c.round), [0, 1]);
  assert.ok(run.validation.every(v => v.context.mode === "isolated"));
  assert.equal(git(f.root, "status", "--porcelain"), "");
});

test("baseline publication uses final working contents and preserves staged ignored additions", async t => {
  const f = fixture(t);
  git(f.root, "add", "value.cjs");
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  writeFileSync(path.join(f.root, ".gitignore"), "*.dat\n");
  const binary = Buffer.from([0, 128, 255, 10]);
  writeFileSync(path.join(f.root, "kept.dat"), binary);
  git(f.root, "add", "-f", "kept.dat");
  const run = await drive(await f.start());
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.equal(run.commits.length, 1);
  assert.equal(git(f.root, "show", "HEAD:value.cjs"), "module.exports = 2;");
  assert.deepEqual(execFileSync("git", ["show", "HEAD:kept.dat"], { cwd: f.root }), binary);
});

test("explicit branch base retains pre-existing branch changes and stays pinned when base ref moves", async t => {
  const f = fixture(t, { dirty: false, value: 2 });
  git(f.root, "checkout", "-qb", "feature");
  writeFileSync(path.join(f.root, "feature.txt"), "existing work\n");
  git(f.root, "add", "."); git(f.root, "commit", "-qm", "feature work");
  const initialHead = git(f.root, "rev-parse", "HEAD");
  const started = await f.start({ options: parseArgs(["--base", "main"]) });
  git(f.root, "update-ref", "refs/heads/main", initialHead);
  const run = await drive(started);
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.equal(status(run).commitRange.base, f.base);
  assert.equal(status(run).commitRange.tip, initialHead);
  assert.equal(git(f.root, "diff", "--name-only", status(run).commitRange.range), "feature.txt");
});

test("diverged branch base retains its exclusion policy while reviewing from the merge base", async t => {
  const f = fixture(t, { dirty: false, value: 2 });
  writeFileSync(path.join(f.root, ".reviewignore"), "private.txt\n");
  git(f.root, "add", "."); git(f.root, "commit", "-qm", "base review policy");
  const baseTip = git(f.root, "rev-parse", "HEAD");
  git(f.root, "checkout", "-qb", "feature", f.base);
  writeFileSync(path.join(f.root, "private.txt"), "excluded branch content\n");
  git(f.root, "add", "."); git(f.root, "commit", "-qm", "existing feature");
  const run = await drive(await f.start({ options: parseArgs(["--base", "main"]) }));
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.equal(status(run).commitRange.base, f.base);
  assert.equal(run.args.base, baseTip);
  assert.ok(run.fingerprint.excludePaths.includes("private.txt"));
});

test("dirty excluded paths are rejected before committing or allocating a run", async t => {
  const f = fixture(t);
  const index = readFileSync(path.join(f.root, ".git/index"));
  await assert.rejects(f.start({ options: parseArgs(["--exclude-path", "value.cjs"]) }), /Dirty excluded path/);
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.base);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), index);
  assert.equal(existsSync(path.join(f.root, ".git/jig/review-fix")), false);
});

test("index publication resumes after HEAD update without duplicating a commit", async t => {
  const f = fixture(t);
  const run = await f.start();
  prepareRoundCommit(run, "Checkpoint for recovery");
  const oid = run.commitJournal.oid;
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === path.join(f.root, ".git/index")) throw new Error("simulated interruption"); return rename(from, to); };
  syncBuiltinESMExports();
  try { assert.throws(() => publishRoundCommit(run), /simulated interruption/); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(git(f.root, "rev-parse", "HEAD"), oid);
  assert.equal(existsSync(path.join(f.root, ".git/index.lock")), true);
  const resumed = await advance(run.directory);
  assert.equal(resumed.commitJournal, null, JSON.stringify(status(resumed)));
  assert.equal(resumed.commits.length, 1);
  assert.equal(git(f.root, "rev-list", "--count", `${f.base}..HEAD`), "1");
  assert.equal(git(f.root, "status", "--porcelain"), "");
});

test("an intervening index edit is preserved and blocks prepared publication", async t => {
  const f = fixture(t), run = await f.start();
  prepareRoundCommit(run, "Checkpoint");
  writeFileSync(path.join(f.root, "other.txt"), "other work\n");
  git(f.root, "add", "other.txt");
  const index = readFileSync(path.join(f.root, ".git/index"));
  const stopped = await advance(run.directory);
  assert.equal(stopped.phase, "BLOCKED");
  assert.equal(stopped.outcome.code, "COMMIT_RECOVERY");
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.base);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), index);
  assert.ok(status(stopped).commitRecovery);
});

test("later edits cannot create a second commit in an already published round", async t => {
  const f = fixture(t), run = await f.start();
  prepareRoundCommit(run, "Baseline");
  const committed = await advance(run.directory);
  const head = git(f.root, "rev-parse", "HEAD");
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 3;\n");
  assert.throws(() => prepareRoundCommit(committed, "Second checkpoint"), /already has a commit/);
  assert.equal(git(f.root, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 3;\n");
  assert.equal(committed.commitJournal, null);
});

test("a foreign commit during review is not absorbed into the run", async t => {
  const f = fixture(t, { dirty: false, value: 2 });
  let run = await f.start();
  for (let i = 0; i < 10 && !run.pending; i++) run = await advance(run.directory);
  git(f.root, "commit", "--allow-empty", "-qm", "external commit");
  run = await advance(run.directory);
  assert.equal(run.phase, "SCOPE_CHANGED");
  assert.equal(git(f.root, "log", "-1", "--format=%s"), "external commit");
});
