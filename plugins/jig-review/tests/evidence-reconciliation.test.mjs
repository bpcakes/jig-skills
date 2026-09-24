import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { advance, createRun, runUntilBoundary, submit, TERMINAL } from "../skills/review-fix-loop/scripts/review-fix-loop.mjs";
import { parseArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";
import { loadRun } from "../skills/review-fix-loop/scripts/run-store.mjs";

async function fixture(t, { validationDrift = false, invalidValidationOutput = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "jig-evidence-reconciliation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(path.join(root, "value.txt"), "0\n"); writeFileSync(path.join(root, "notes.txt"), "initial\n");
  writeFileSync(path.join(root, "receipts.jsonl"), '{"initial":true}\n');
  git("add", "."); git("commit", "-qm", "base"); writeFileSync(path.join(root, "value.txt"), "0");
  const check = `const fs=require('node:fs'),assert=require('node:assert/strict');
const n=Number(fs.readFileSync('value.txt','utf8'));assert.ok(Number.isInteger(n)&&n>=0&&n<=4);
fs.appendFileSync('.git/check-calls',String(n)+'\\n');
${validationDrift ? "if(n===4&&!fs.existsSync('.git/drifted')){fs.writeFileSync('.git/drifted','yes');fs.appendFileSync('notes.txt','validator output\\n');}" : ""}
${invalidValidationOutput ? "fs.writeFileSync('receipts.jsonl','{\"replacement\":true}\\n');" : ""}`;
  const contract = { goal: "Reach value 4", nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: [],
    acceptanceCriteria: [{ id: "value", description: "Value equals 4" }],
    evidenceOutputs: [{ path: "receipts.jsonl", format: "jsonl" }],
    requiredValidation: [{ id: "unit", argv: [process.execPath, "-e", check] }] };
  const run = await createRun({ cwd: root, contract, config: { reviewConcurrency: 1 },
    options: parseArgs(["--commit-mode", "none", "--max-rounds", "4", "--exclude-path", "receipts.jsonl"]) });
  t.after(() => rmSync(path.dirname(run.workspaceRoot), { recursive: true, force: true }));
  return { root, run };
}
const envelope = (a, result) => ({ assignmentId: a.id, fingerprint: a.fingerprint, ...result });
async function drive(f, { mixed = false } = {}) {
  let run = f.run;
  for (let n = 0; n < 40; n++) {
    run = await runUntilBoundary(run.directory);
    if (TERMINAL.has(run.phase)) return loadRun(run.directory);
    const a = run.pending.assignment, value = Number(readFileSync(path.join(f.root, "value.txt"), "utf8"));
    let result;
    if (a.role === "review") result = { complete: true,
      findings: value < 4 ? [{ key: "value", path: "value.txt", severity: "medium", title: "Value below target", evidence: `Value ${value} is below required 4` }] : [],
      acceptance: [{ criterionId: "value", status: value === 4 ? "satisfied" : "unsatisfied", evidence: `Current value ${value}`, validationIds: ["unit"] }] };
    else if (a.role === "triage") result = {
      decisions: a.findings.map(finding => ({ id: finding.id, status: value < 4 ? "actionable" : a.validationAssessment ? "needs-validation" : "fixed",
        evidence: `Current value ${value}, target 4; assess required assertion against the current source` })),
      ...(a.validationAssessment ? { validationImpact: a.validationAssessment.checks.map(check => ({ assignmentId: check.assignmentId, status: "rerun",
        evidence: "Conservatively rerun after validator changed notes; test must preserve the remaining unrelated-source budget" })) } : {}),
    };
    else {
      assert.equal(a.role, "repair");
      writeFileSync(path.join(f.root, "value.txt"), String(value + 1));
      appendFileSync(path.join(f.root, "receipts.jsonl"), JSON.stringify({ round: run.round }) + "\n");
      if (mixed) appendFileSync(path.join(f.root, "notes.txt"), `unclaimed change ${run.round}\n`);
      result = { workspaceEdits: [{ path: "value.txt", reason: "Increment fixture repair toward target", findingIds: a.findings.map(finding => finding.id) }] };
    }
    await submit(run.directory, a.id, envelope(a, result));
  }
  assert.fail(`No terminal outcome: ${run.phase}`);
}

for (const validationDrift of [false, true]) test(`four declared repair appends preserve the drift budget (validation drift: ${validationDrift})`, async t => {
  const f = await fixture(t, { validationDrift }), run = await drive(f);
  assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome)); assert.equal(run.round, 4);
  const records = run.sourceReconciliations;
  assert.equal(records.filter(record => record.repairEvidenceOnly).length, 4);
  assert.equal(records.filter(record => !record.repairEvidenceOnly && !record.validationOnly).length, validationDrift ? 1 : 0);
  for (const record of records.filter(record => record.repairEvidenceOnly)) {
    assert.deepEqual(record.paths, ["receipts.jsonl"]);
    const evidence = JSON.parse(readFileSync(record.evidence));
    assert.deepEqual(evidence.repairEvidencePaths, ["receipts.jsonl"]);
  }
  const calls = readFileSync(path.join(f.root, ".git/check-calls"), "utf8").trim().split("\n");
  assert.deepEqual(calls, validationDrift ? ["1", "2", "3", "4", "4"] : ["1", "2", "3", "4"]);
  assert.equal(run.validation.length, calls.length, "declared appends never substitute for real check executions");
  assert.equal(run.reports.length, 2);
  assert.ok(run.reports.every(report => report.fingerprint === run.fingerprint.fingerprint));
  assert.equal(run.preservationBaseline.files["receipts.jsonl"].blob, run.expected.files["receipts.jsonl"].blob);
  assert.equal(readFileSync(path.join(f.root, "receipts.jsonl"), "utf8").trim().split("\n").length, 5);
});

test("mixed receipt and unclaimed source edits still stop at the unrelated-drift limit", async t => {
  const f = await fixture(t), run = await drive(f, { mixed: true });
  assert.equal(run.phase, "BLOCKED"); assert.equal(run.round, 4);
  assert.match(run.outcome.reason, /Three source reconciliations/);
  assert.equal(run.sourceReconciliations.length, 3);
  assert.ok(run.sourceReconciliations.every(record => !record.repairEvidenceOnly && record.paths.includes("notes.txt")));
  assert.equal(readFileSync(path.join(f.root, "value.txt"), "utf8"), "4", "failed repair stays visible");
  assert.equal(readFileSync(path.join(f.root, "receipts.jsonl"), "utf8").trim().split("\n").length, 5);
});

for (const mutation of ["overwrite", "delete", "mode", "invalid-json"]) test(`declared-output ${mutation} during review is classified as scope drift`, async t => {
  const f = await fixture(t); let run = await runUntilBoundary(f.run.directory);
  assert.equal(run.pending.role, "review");
  const file = path.join(f.root, "receipts.jsonl");
  if (mutation === "overwrite") writeFileSync(file, '{"replacement":true}\n');
  if (mutation === "delete") rmSync(file);
  if (mutation === "mode") chmodSync(file, 0o755);
  if (mutation === "invalid-json") appendFileSync(file, '{invalid}\n');
  run = await advance(run.directory);
  assert.equal(run.phase, "SCOPE_CHANGED", JSON.stringify(run.outcome));
  assert.deepEqual(run.outcome.paths, ["receipts.jsonl"]);
  assert.doesNotMatch(run.outcome.reason, /Controller preparation failed/);
  assert.ok(run.outcome.reason.length > 0);
});

test("invalid declared output from a completed validator retains scope-change detail and settles cleanup", async t => {
  const f = await fixture(t, { invalidValidationOutput: true }), run = await drive(f);
  assert.equal(run.phase, "SCOPE_CHANGED", JSON.stringify(run.outcome));
  assert.deepEqual(run.outcome.paths, ["receipts.jsonl"]);
  assert.match(run.outcome.reason, /Evidence output is not an append/);
  assert.equal(readFileSync(path.join(f.root, "receipts.jsonl"), "utf8"), '{"replacement":true}\n');
  assert.deepEqual(run.cleanup, []); assert.deepEqual(run.cleanupOverlays, []);
});
