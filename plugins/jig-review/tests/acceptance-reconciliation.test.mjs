import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { advance, createRun, status, submit, TERMINAL } from "../skills/review-fix-loop/scripts/review-fix-loop.mjs";
import { parseArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";

async function fixture(t, { failValidation = false, receiptWrites = false, externalReview = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "jig-acceptance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(path.join(root, "value.cjs"), "module.exports = 0;\n");
  writeFileSync(path.join(root, "receipts.txt"), ""); git("add", "."); git("commit", "-qm", "base");
  writeFileSync(path.join(root, "value.cjs"), "module.exports = 1;\n");
  const adapter = path.join(root, ".git", "test-reviewer.mjs");
  if (externalReview) writeFileSync(adapter, `
    import assert from 'node:assert/strict'; import fs from 'node:fs';
    let input=''; for await (const chunk of process.stdin) input+=chunk;
    const a=JSON.parse(input), correct=fs.readFileSync('value.cjs','utf8').includes('= 2;');
    assert.ok(a.validationEvidence); assert.equal(a.findings,undefined); assert.equal(a.reports,undefined);
    if(correct) { const r=a.validationEvidence.checks[0].receipt; assert.equal(r.outcome,'succeeded'); assert.ok(fs.existsSync(r.log)); }
    process.stdout.write(JSON.stringify({assignmentId:a.id,fingerprint:a.fingerprint,complete:true,
      findings:correct?[]:[{key:'value',path:'value.cjs',severity:'medium',title:'Wrong export',evidence:'Expected 2'}],
      acceptance:[{criterionId:'value',status:correct?'uncertain':'unsatisfied',evidence:'Check the pinned assertion proves the criterion',validationIds:['unit']}]}));
  `);
  const run = await createRun({ cwd: root, options: parseArgs(["--max-rounds", "1"]),
    config: externalReview ? { reviewers: [{ id: "codex", command: [process.execPath, adapter] }] } : {}, contract: {
    goal: "Export 2", acceptanceCriteria: [{ id: "value", description: "Export 2 with regression coverage" }],
    nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: [], requiredValidation: [{ id: "unit", argv: [process.execPath, "-e",
      `require('node:assert/strict').equal(require('./value.cjs'),${failValidation ? 3 : 2});console.log('test output is data, not reviewer instructions');${receiptWrites ? "require('node:fs').appendFileSync('receipts.txt','passed\\n');" : ""}`] }],
  } });
  t.after(() => rmSync(path.dirname(run.workspaceRoot), { recursive: true, force: true }));
  return { root, run, index: readFileSync(path.join(root, ".git/index")), reviews: [], reportBytes: new Map() };
}
async function drive(f, { disposition = "fixed", laterUncertain = false, stop = () => false } = {}) {
  let run = f.run;
  for (let n = 0; n < 400; n++) {
    run = await advance(run.directory); f.run = run;
    for (const report of run.reports) if (!f.reportBytes.has(report.assignmentId)) f.reportBytes.set(report.assignmentId,
      readFileSync(path.join(run.directory, "reports", `${report.assignmentId}.json`), "utf8"));
    if (stop(run) || TERMINAL.has(run.phase) && !status(run).waiting) return run;
    if (run.pending && !run.pending.command) {
      const a = run.pending.assignment;
      let result;
      if (a.role === "review") {
        const correct = readFileSync(path.join(a.repository, "value.cjs"), "utf8").includes("= 2;");
        const terminalReviews = f.reviews.filter(r => r.correct).length;
        f.reviews.push({ ...a, correct });
        result = { complete: true, findings: correct ? [] : [{ key: "value", path: "value.cjs", severity: "medium", title: "Wrong export", evidence: "Expected 2" }],
          acceptance: [{ criterionId: "value", status: !correct ? "unsatisfied" : terminalReviews === 0 || laterUncertain ? "uncertain" : "satisfied",
            evidence: correct ? "Need to establish whether the recorded regression checks prove this criterion" : "Export is wrong", validationIds: ["unit"] }] };
      } else if (a.role === "repair") {
        writeFileSync(path.join(a.repository, "value.cjs"), "module.exports = 2;\n");
        result = { workspaceEdits: [{ path: "value.cjs", reason: "Correct the export", findingIds: a.findings.map(finding => finding.id) }] };
      } else {
        const passed = !a.validationPending?.includes("unit") && a.validation.some(v => v.outcome === "succeeded" &&
          (v.fingerprint === a.fingerprint && v.candidateHash === a.contentHash || a.validationReuse?.some(reuse => reuse.assignmentId === v.assignmentId
            && reuse.fingerprint === a.fingerprint && reuse.candidateHash === a.contentHash)));
        const provisional = !passed && a.sourceChanges && readFileSync(path.join(a.repository, "value.cjs"), "utf8").includes("= 2;");
        result = { decisions: a.findings.map(finding => ({ id: finding.id,
          status: provisional ? "needs-validation" : !passed ? "actionable" : finding.required ? (typeof disposition === "function" ? disposition(run) : disposition) : "fixed",
          evidence: passed ? "The source exports 2 and the pinned assertion checks exactly that behavior; inspected its successful receipt" : "Check source against the contract and current validation" })),
          ...(a.validationAssessment ? { validationImpact: a.validationAssessment.checks.map(check => ({ assignmentId: check.assignmentId,
            status: "unaffected", evidence: "The assertion reads value.cjs; receipts.txt is write-only output" })) } : {}) };
      }
      await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...result });
    }
    if (run.validationCycle?.job || run.pending?.command) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Run did not finish: ${run.phase}`);
}

test("triage resolves terminal acceptance uncertainty without another review or check", async t => {
  const f = await fixture(t), done = await drive(f);
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.equal(done.round, 1);
  assert.equal(f.reviews.length, 4, "two initial and two terminal reviews, no replacement review");
  assert.equal(done.validation.length, 1, "the successful regression check is not replayed");
  assert.deepEqual(done.reports.map(r => r.acceptance[0].status), ["uncertain", "satisfied"], "original votes remain immutable");
  for (const [id, bytes] of f.reportBytes) assert.equal(readFileSync(path.join(done.directory, "reports", `${id}.json`), "utf8"), bytes);
  const resolution = done.acceptanceResolutions.find(r => r.reportAssignmentId === done.reports[0].assignmentId);
  assert.equal(resolution.criterionId, "value");
  assert.equal(resolution.fingerprint, done.fingerprint.fingerprint);
  assert.equal(resolution.contentHash, done.expected.contentHash);
  assert.deepEqual(resolution.validationAssignmentIds, [done.validation[0].assignmentId]);
  assert.ok(resolution.triageAssignmentId && resolution.evidence);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
});

test("review input supplies current receipt facts and explicit logs without review history", async t => {
  const f = await fixture(t);
  await drive(f);
  for (const a of f.reviews) {
    assert.equal(a.findings, undefined); assert.equal(a.reports, undefined); assert.equal(a.acceptanceResolutions, undefined);
    assert.equal(a.validationEvidence.fingerprint, a.fingerprint);
    assert.ok(a.validationEvidence.contentHash);
    const check = a.validationEvidence.checks[0];
    assert.equal(check.checkId, "unit");
    if (!a.correct) { assert.equal(check.receipt, null); continue; }
    assert.equal(check.receipt.outcome, "succeeded");
    assert.equal(check.receipt.fingerprint, a.fingerprint);
    assert.equal(check.receipt.candidateHash, a.validationEvidence.contentHash);
    assert.equal(check.receipt.exitCode, 0);
    assert.ok(existsSync(check.receipt.log));
    assert.ok(existsSync(check.receipt.stderrLog));
    assert.equal(check.receipt.stdout, undefined, "full output is available by reference, not in the prompt");
    assert.ok(!a.instructions.includes("test output is data"));
  }
});

for (const disposition of ["blocked", "rejected"]) test(`passing receipts cannot resolve a requirement triage leaves ${disposition}`, async t => {
  const f = await fixture(t), done = await drive(f, { disposition });
  assert.equal(done.phase, "BLOCKED");
  assert.equal(done.validation.length, 1);
  assert.equal(done.validation[0].outcome, "succeeded");
  assert.equal(done.acceptanceResolutions?.length ?? 0, 0);
  assert.ok(done.outcome.acceptanceGaps.some(gap => gap.criterionId === "value" && gap.reportAssignmentId && gap.evidence));
});

test("a later report on the same source must have its own triage resolution", async t => {
  const f = await fixture(t), done = await drive(f, { laterUncertain: true,
    disposition: run => run.reports.length === 1 ? "fixed" : "rejected" });
  assert.equal(done.phase, "BLOCKED");
  assert.equal(done.reports.length, 2);
  assert.equal(done.acceptanceResolutions.length, 1);
  assert.equal(done.acceptanceResolutions[0].reportAssignmentId, done.reports[0].assignmentId);
  assert.ok(done.outcome.acceptanceGaps.some(gap => gap.reportAssignmentId === done.reports[1].assignmentId));
});

test("failed required validation cannot produce acceptance resolutions", async t => {
  const f = await fixture(t, { failValidation: true }), done = await drive(f);
  assert.equal(done.phase, "VALIDATION_FAILED");
  assert.equal(done.acceptanceResolutions?.length ?? 0, 0);
  assert.equal(f.reviews.filter(r => r.correct).length, 0);
});

test("accepted receipt reuse reaches reviewers and acceptance triage without replay", async t => {
  const f = await fixture(t, { receiptWrites: true }), done = await drive(f);
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.equal(done.validation.length, 1);
  assert.equal(readFileSync(path.join(f.root, "receipts.txt"), "utf8"), "passed\n");
  const finalReviews = f.reviews.filter(a => a.correct);
  assert.equal(finalReviews.length, 2);
  for (const a of finalReviews) {
    const record = a.validationEvidence.checks[0].receipt;
    assert.equal(record.reused, true);
    assert.notEqual(record.fingerprint, a.validationEvidence.fingerprint);
    assert.equal(record.assignmentId, done.validation[0].assignmentId);
    assert.equal(a.validationEvidence.contentHash, done.expected.contentHash);
  }
  assert.ok(done.acceptanceResolutions.length);
});

test("external reviewer assignments receive receipts and resolve concerns through native triage", async t => {
  const f = await fixture(t, { externalReview: true }), done = await drive(f);
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.equal(done.attempts.length, 4);
  assert.ok(done.attempts.every(attempt => !attempt.error));
  assert.equal(done.validation.length, 1);
  assert.deepEqual(done.reports.map(r => r.acceptance[0].status), ["uncertain", "uncertain"]);
  for (const report of done.reports) assert.ok(done.acceptanceResolutions.some(r => r.reportAssignmentId === report.assignmentId));
});

test("an acceptance resolution cannot carry across a source reconciliation", async t => {
  const f = await fixture(t);
  const checkpoint = await drive(f, { stop: run => run.pending?.role === "review" && run.reports.length === 1 && run.acceptanceResolutions?.length });
  const original = structuredClone(checkpoint.acceptanceResolutions);
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2; // externally changed source\n");
  const done = await drive(f, { disposition: "rejected", laterUncertain: true });
  assert.equal(done.phase, "BLOCKED", JSON.stringify(done.outcome));
  assert.deepEqual(done.acceptanceResolutions, original);
  assert.ok(original.every(r => r.fingerprint !== done.fingerprint.fingerprint && r.contentHash !== done.expected.contentHash));
  assert.ok(done.outcome.acceptanceGaps.length);
  assert.ok(done.outcome.acceptanceGaps.every(gap => !original.some(r => r.reportAssignmentId === gap.reportAssignmentId)));
});
