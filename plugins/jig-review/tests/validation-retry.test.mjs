import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { advance, createRun, status, submit, TERMINAL } from "../skills/review-fix-loop/scripts/review-fix-loop.mjs";
import { parseArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";
import { resultSchema } from "../skills/review-fix-loop/scripts/assignment-schema.mjs";

async function fixture(t, { commitMode = "per-round", alwaysFails = false, uncertain = false, maxRounds = 1, initiallyCorrect = false } = {}) {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jig-validation-retry-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(path.join(directory, "value.cjs"), `module.exports = ${initiallyCorrect ? 2 : 1};\n`);
  git("add", "."); git("commit", "-qm", "base");
  const calls = path.join(directory, ".git", "checks.jsonl");
  const marker = path.join(directory, ".git", "fixture-ready");
  const checks = ["fmt", "full"].map(id => ({ id, ...(uncertain && id === "full" ? { timeoutMs: 500 } : {}), argv: [process.execPath, "-e",
    `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},${JSON.stringify(id + "\n")});require('node:assert/strict').equal(require('./value.cjs'),2);` + (id === "fmt" ? "" : uncertain ? "setInterval(()=>{},1000);" :
      `if(${alwaysFails} || !fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'ready');console.error('fixture authentication failed');process.exit(1);}`)] }));
  const run = await createRun({ cwd: directory, options: parseArgs(["--commit-mode", commitMode, "--max-rounds", String(maxRounds)]), contract: {
    goal: "Export 2", acceptanceCriteria: [{ id: "value", description: "Export 2" }],
    nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: [], requiredValidation: checks,
  } });
  t.after(() => rmSync(path.dirname(run.workspaceRoot), { recursive: true, force: true }));
  return { run, git, calls: () => readFileSync(calls, "utf8").trim().split("\n"), reviews: [], retriesOffered: [] };
}

async function drive(f, { stop = () => false } = {}) {
  for (let n = 0; n < 500; n++) {
    const run = f.run = await advance(f.run.directory);
    if (stop(run) || TERMINAL.has(run.phase) && !status(run).waiting) return run;
    if (run.pending && !run.pending.command) {
      const a = run.pending.assignment;
      assert.deepEqual(a.resultSchema, resultSchema(a), "published result schema must match the submission contract");
      const correct = readFileSync(path.join(a.repository, "value.cjs"), "utf8").includes("= 2;");
      let result;
      if (a.role === "review") {
        f.reviews.push(a);
        result = { complete: true, findings: correct ? [] : [{ key: "value", path: "value.cjs", severity: "low", title: "Wrong export", evidence: "Expected 2" }],
          acceptance: [{ criterionId: "value", status: correct ? "satisfied" : "unsatisfied", evidence: "Read the export and required checks", validationIds: ["fmt", "full"] }] };
      } else if (a.role === "repair") {
        writeFileSync(path.join(a.repository, "value.cjs"), "module.exports = 2;\n");
        result = { workspaceEdits: [{ path: "value.cjs", reason: "Correct the export", findingIds: a.findings.map(finding => finding.id) }] };
      } else {
        f.retriesOffered.push(a.validationRetryAvailable);
        if (a.validationRetryAvailable) result = { validationRetry: { evidence: "The full check completed with a fixture authentication failure; source assertion passed and local readiness probe now passes. A full rerun is safe." } };
        else result = { decisions: a.findings.map(finding => ({ id: finding.id, status: !correct ? "actionable" : run.validationFailure ? "blocked" : "fixed",
          evidence: "Compared source with the contract and latest full validation receipts" })) };
      }
      await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...result });
    }
    if (run.validationCycle?.job) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Run did not finish: ${f.run.phase}`);
}

for (const commitMode of ["per-round", "none"]) test(`${commitMode}: a transient failure retries the full plan without another repair at the round limit`, async t => {
  const f = await fixture(t, { commitMode }), done = await drive(f);
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.equal(done.round, 1);
  assert.equal(done.assignmentAttempts.filter(a => a.role === "repair").length, 1);
  assert.deepEqual(f.calls(), ["fmt", "full", "fmt", "full"]);
  assert.deepEqual(done.validation.filter(v => v.checkId === "full").map(v => v.exitCode), [1, 0], "keep the original failure and new success");
  assert.equal(new Set(done.validation.map(v => v.fingerprint)).size, 1, "retry unchanged source");
  assert.ok(done.validationRetry.evidence && done.validationRetry.triageAssignmentId);
  assert.equal(done.validationRetry.pending, false);
  assert.equal(f.reviews.length, 4, "two discovery reviews and two final reviews still required");
  assert.ok(done.reports.every(r => r.fingerprint === done.fingerprint.fingerprint));
  if (commitMode === "per-round") {
    assert.equal(f.git("rev-list", "--count", "HEAD"), "2", "only base plus real repair commit");
    assert.equal(f.git("status", "--porcelain"), "");
    assert.deepEqual(f.reviews.at(-1).commitRange, f.reviews.at(-2).commitRange);
  }
});

for (const commitMode of ["per-round", "none"]) test(`${commitMode}: a transient failure recovers without a source repair`, async t => {
  const f = await fixture(t, { commitMode, initiallyCorrect: true });
  const checkpoint = await drive(f, { stop: r => r.pending?.role === "triage" && r.validationRetry && !r.validationFailure });
  assert.equal(checkpoint.phase, "TRIAGE", "successful retry must return the retained finding to triage");
  assert.equal(checkpoint.ledger["validation-full"].status, "unresolved", "successful execution alone must not resolve the finding");
  const done = await drive(f);
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.equal(done.ledger["validation-full"].status, "fixed");
  assert.equal(done.round, 0);
  assert.equal(done.assignmentAttempts.some(a => a.role === "repair"), false);
  assert.deepEqual(f.calls(), ["fmt", "full", "fmt", "full"]);
  assert.deepEqual(done.validation.filter(v => v.checkId === "full").map(v => v.exitCode), [1, 0]);
  assert.equal(f.reviews.length, 2, "retain the two complete reviews of unchanged source");
  assert.ok(done.reports.every(r => r.fingerprint === done.fingerprint.fingerprint));
  assert.equal(f.git("rev-list", "--count", "HEAD"), "1", "retry and triage need no new commit");
  assert.equal(f.git("status", "--porcelain"), "");
});

test("a repeated failure cannot obtain another validation retry across resumes", async t => {
  const f = await fixture(t, { alwaysFails: true, maxRounds: 3 });
  const checkpoint = await drive(f, { stop: r => Boolean(r.validationRetry && r.pending?.role === "triage") });
  const a = checkpoint.pending.assignment;
  await assert.rejects(submit(checkpoint.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint,
    validationRetry: { evidence: "Try the same check a third time" } }), /schema/);
  const done = await drive(f);
  assert.equal(done.phase, "BLOCKED");
  assert.deepEqual(f.calls(), ["fmt", "full", "fmt", "full"]);
  assert.equal(f.retriesOffered.filter(Boolean).length, 1);
  assert.equal(f.retriesOffered.at(-1), false);
  assert.equal(done.round, 1);
  assert.equal(f.reviews.length, 2, "failed checks cannot enter final review");
  assert.deepEqual(done.validationFailure.checks, ["full"]);
  assert.ok(done.failedCandidate.patch.some(edit => edit.path === "value.cjs"), "keep the original repair available for failure diagnosis");
});

test("uncertain execution stops without offering a transient retry", async t => {
  const f = await fixture(t, { uncertain: true }), done = await drive(f);
  assert.equal(done.phase, "VALIDATION_FAILED");
  assert.equal(done.outcome.code, "EXECUTION_UNCERTAIN");
  assert.deepEqual(f.calls(), ["fmt", "full"]);
  assert.equal(done.validationRetry, undefined);
  assert.equal(f.retriesOffered.some(Boolean), false);
});

test("a retry needs diagnostic evidence and cannot mark findings fixed", async t => {
  const f = await fixture(t);
  let run = await drive(f, { stop: r => Boolean(r.pending?.assignment.validationRetryAvailable) });
  const a = run.pending.assignment;
  const send = result => submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...result });
  await assert.rejects(send({ validationRetry: { evidence: "" } }), /schema/);
  await assert.rejects(send({ validationRetry: { evidence: "Transient fixture" }, decisions: [] }), /schema/);
  await send({ validationRetry: { evidence: "   " } });
  run = await advance(run.directory);
  assert.equal(run.validationRetry, undefined);
  assert.match(run.assignmentAttempts.at(-1).error, /diagnostic evidence/);
  f.run = run;
  const done = await drive(f);
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.equal(done.round, 1);
});
