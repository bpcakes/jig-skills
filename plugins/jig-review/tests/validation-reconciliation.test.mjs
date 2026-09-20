import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { advance, createRun, status, submit, TERMINAL } from "../skills/review-fix-loop/scripts/review-fix-loop.mjs";
import { parseArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";
import { groupRunning, ownedAlive } from "../skills/review-fix-loop/scripts/process-ownership.mjs";

async function fixture(t, commands, initialValue = 2) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jig-validation-drift-")), root = path.join(directory, "repo");
  mkdirSync(path.join(root, ".agent/state"), { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(root, "value.cjs"), `module.exports = ${initialValue};\n`);
  writeFileSync(path.join(root, ".agent/state/receipts.jsonl"), "");
  writeFileSync(path.join(root, ".agent/state/input.json"), "1");
  const git = (...args) => execFileSync("git", args, { cwd: root });
  git("init", "-q", "-b", "main"); git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  const index = readFileSync(path.join(root, ".git/index")), invocations = path.join(directory, "checks.jsonl");
  const checks = commands.map(({ id, code, timeoutMs, optional }) => ({ id, ...(optional ? { optional: true } : {}), ...(timeoutMs ? { timeoutMs } : {}), argv: [process.execPath, "-e",
    `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(invocations)},${JSON.stringify(id + "\n")});require('node:assert/strict').equal(require('./value.cjs'),2);${code}`] }));
  const run = await createRun({ cwd: root, options: parseArgs(["--max-rounds", "1"]), contract: {
    goal: "Export 2", acceptanceCriteria: [{ id: "value", description: "Export 2 with passing checks" }],
    nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: [], requiredValidation: checks,
  } });
  t.after(() => rmSync(path.dirname(run.workspaceRoot), { recursive: true, force: true }));
  return { run, root, index, calls: () => readFileSync(invocations, "utf8").trim().split("\n") };
}
const append = "fs.appendFileSync('.agent/state/receipts.jsonl',JSON.stringify({check:'done'})+'\\n');";
const send = (run, result) => submit(run.directory, run.pending.id, { assignmentId: run.pending.id, fingerprint: run.pending.assignment.fingerprint, ...result });
function response(run, impact = () => "unaffected") {
  const a = run.pending.assignment;
  assert.equal(a.repository, run.root);
  const correct = readFileSync(path.join(run.root, "value.cjs"), "utf8").includes("= 2;");
  if (a.role === "review") return { complete: true, findings: correct ? [] : [{ key: "wrong-value", path: "value.cjs", severity: "medium", title: "Wrong value", evidence: "Module must export 2" }], acceptance: [{ criterionId: "value", status: correct ? "satisfied" : "unsatisfied",
    evidence: "Read export and required check records", validationIds: a.contract.requiredValidation.filter(c => !c.optional).map(c => c.id) }] };
  if (a.role === "repair") {
    writeFileSync(path.join(a.repository, "value.cjs"), "module.exports = 2;\n");
    return { workspaceEdits: [{ path: "value.cjs", reason: "Correct the exported value", findingIds: a.findings.map(f => f.id) }] };
  }
  assert.equal(a.role, "triage");
  // Decide from the wire evidence available to a fresh adapter, not private
  // controller state or memory of the previous triage invocation.
  const required = a.contract.requiredValidation.filter(check => !check.optional).map(check =>
    a.validationPending?.includes(check.id) ? undefined : a.validation.findLast(v => v.checkId === check.id &&
      (v.fingerprint === a.fingerprint && v.candidateHash === a.contentHash ||
        a.validationReuse?.some(reuse => reuse.assignmentId === v.assignmentId && reuse.fingerprint === a.fingerprint && reuse.candidateHash === a.contentHash))));
  const passed = required.every(v => v?.outcome === "succeeded"), failed = required.some(v => v && v.outcome !== "succeeded");
  return { decisions: a.findings.map(f => ({ id: f.id,
    status: failed ? "blocked" : !correct ? "actionable" : passed ? "fixed" : "needs-validation",
    evidence: "Compared the export with the contract and the required validation evidence" })),
    ...(a.validationAssessment ? { validationImpact: a.validationAssessment.checks.map(check => {
      const status = impact(check);
      return { assignmentId: check.assignmentId, status,
        evidence: status === "rerun" ? "The check reads the changed state input; its earlier result used different inputs"
          : "The command reads the unchanged module; changed state is output only for this command" };
    }) } : {}) };
}
async function drive(run, { stop = () => false, impact } = {}) {
  for (let n = 0; n < 1000; n++) {
    run = await advance(run.directory);
    if (stop(run) || TERMINAL.has(run.phase) && !run.cleanup?.length && !run.cleanupOverlays?.length) return run;
    if (run.pending && !run.pending.command) await send(run, response(run, impact));
    if (run.validationCycle?.job) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Did not finish: ${run.phase}`);
}

test("a validation result arriving after the polling guard still reconciles receipt writes", async t => {
  const f = await fixture(t, [{ id: "receipt", code: append }]);
  let run = await drive(f.run, { stop: r => Boolean(r.validationCycle?.job) });
  const resultFile = path.join(run.directory, "assignments", run.validationCycle.job, "result.json");
  for (let n = 0; n < 500 && !fs.existsSync(resultFile); n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(resultFile));
  const child = JSON.parse(readFileSync(path.join(path.dirname(resultFile), "child.json"), "utf8"));
  for (let n = 0; n < 500 && groupRunning(child); n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(groupRunning(child), false, "consume a settled result rather than waiting for process cleanup");
  const exists = fs.existsSync;
  let hidden = false;
  fs.existsSync = function(file) {
    if (!hidden && String(file) === resultFile && new Error().stack.includes("at hasResult")) { hidden = true; return false; }
    return exists(file);
  };
  syncBuiltinESMExports();
  try { run = await advance(run.directory); }
  finally { fs.existsSync = exists; syncBuiltinESMExports(); }
  assert.equal(hidden, true, "simulate completion just after the first poll");
  assert.notEqual(run.phase, "SCOPE_CHANGED", JSON.stringify(run.outcome));
  const done = await drive(run);
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.deepEqual(f.calls(), ["receipt"]);
  assert.equal(done.validation.length, 1);
});

test("tracked validation receipts are assessed without replaying checks or exhausting reconciliation budget", async t => {
  const checks = ["targeted", "fmt", "test", "lint", "diff"].map(id => ({ id, code: append }));
  const f = await fixture(t, checks), done = await drive(f.run);
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.deepEqual(f.calls(), checks.map(c => c.id));
  assert.equal(done.validation.length, 5);
  assert.equal(done.sourceReconciliations.length, 5);
  assert.ok(done.sourceReconciliations.every(r => r.validationOnly));
  assert.ok(done.validation.every(r => r.fingerprint !== done.fingerprint.fingerprint));
  assert.ok(done.validationReuse.every(r => r.evidence && r.triageAssignmentId && r.sourceEvidence));
  assert.equal(done.reports.length, 2);
  assert.equal(done.attempts.length, 4, "only initial and final reviews; reassessment must not restart discovery");
  assert.equal(done.round, 0, "receipt assessment must not consume repair rounds");
  assert.ok(done.reports.every(r => r.fingerprint === done.fingerprint.fingerprint));
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
  assert.equal(readFileSync(path.join(f.root, ".agent/state/receipts.jsonl"), "utf8").trim().split("\n").length, 5);
  assert.deepEqual(status(done).filesChanged, [".agent/state/receipts.jsonl"]);
  assert.equal(status(done).indexNeedsRestaging, true);
});

async function useReconciliationBudget(f) {
  let run = await drive(f.run, { stop: r => r.phase === "VALIDATE" && !r.validationCycle });
  for (let value = 2; value <= 4; value++) {
    writeFileSync(path.join(f.root, ".agent/state/input.json"), String(value));
    run = await advance(run.directory);
    assert.equal(run.phase, "VALIDATE");
  }
  assert.equal(run.sourceReconciliations.length, 3);
  return run;
}

test("validation receipts are assessed even after ordinary reconciliation reaches its limit", async t => {
  const f = await fixture(t, [{ id: "first", code: append }, { id: "second", code: append }]);
  const done = await drive(await useReconciliationBudget(f));
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.deepEqual(f.calls(), ["first", "second"]);
  assert.equal(done.sourceReconciliations.filter(r => !r.validationOnly).length, 3);
  assert.equal(done.sourceReconciliations.filter(r => r.validationOnly).length, 2);
  assert.deepEqual(status(done).filesChanged.sort(), [".agent/state/input.json", ".agent/state/receipts.jsonl"]);
});

test("validation changes that invalidate evidence still stop at the reconciliation limit", async t => {
  const f = await fixture(t, [
    { id: "reads-state", code: "fs.readFileSync('.agent/state/input.json','utf8');" },
    { id: "writes-state", code: "fs.writeFileSync('.agent/state/input.json','5');" },
  ]);
  let run = await drive(await useReconciliationBudget(f), { stop: r => Boolean(r.pending?.assignment.validationAssessment) });
  assert.equal(run.pending?.role, "triage", "assess applicability before deciding whether the limit applies");
  await send(run, response(run, check => check.checkId === "reads-state" ? "rerun" : "unaffected"));
  run = await drive(run);
  assert.equal(run.phase, "SCOPE_CHANGED");
  assert.match(run.outcome.reason, /reconciliation limit/);
  assert.deepEqual(f.calls(), ["reads-state", "writes-state"], "do not replay a check after substantive drift exceeds the budget");
});

test("a pending validation assessment does not waive the limit for another source edit", async t => {
  const f = await fixture(t, [{ id: "receipts", code: append }]);
  let run = await drive(await useReconciliationBudget(f), { stop: r => Boolean(r.pending?.assignment.validationAssessment) });
  assert.equal(run.pending?.role, "triage");
  writeFileSync(path.join(f.root, ".agent/state/input.json"), "5");
  run = await advance(run.directory);
  assert.equal(run.phase, "SCOPE_CHANGED");
  assert.deepEqual(f.calls(), ["receipts"]);
  assert.equal(run.sourceReconciliations.length, 4, "only the already-completed validation gets a deferred assessment");
});

test("a state file consumed by a check invalidates only that check", async t => {
  const f = await fixture(t, [
    { id: "reads-state", code: "require('node:assert/strict').ok([1,2].includes(JSON.parse(fs.readFileSync('.agent/state/input.json','utf8'))));" },
    { id: "writes-state", code: "fs.writeFileSync('.agent/state/input.json','2');" },
  ]);
  const done = await drive(f.run, { impact: check => check.checkId === "reads-state" ? "rerun" : "unaffected" });
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.deepEqual(f.calls(), ["reads-state", "writes-state", "reads-state"]);
  assert.equal(done.validation.length, 3);
  assert.ok(done.validationReuse.every(r => done.validation.find(v => v.assignmentId === r.assignmentId).checkId === "writes-state"));
});

test("a repaired finding converges after validation appends tracked receipts", async t => {
  const f = await fixture(t, [{ id: "fmt", code: append }, { id: "test", code: append }], 1);
  const done = await drive(f.run);
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.equal(done.round, 1);
  assert.deepEqual(f.calls(), ["fmt", "test"]);
  assert.ok(Object.values(done.ledger).every(finding => finding.status === "fixed"));
  assert.equal(done.assignmentAttempts.filter(a => a.role === "repair").length, 1);
  assert.equal(done.attempts.length, 4);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
});

test("reconciliation still executes an unstarted optional check", async t => {
  const f = await fixture(t, [{ id: "required", code: append }, { id: "lint", optional: true, code: "fs.readFileSync('.agent/state/receipts.jsonl','utf8');" }]);
  const done = await drive(f.run);
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.deepEqual(f.calls(), ["required", "lint"]);
  assert.equal(done.validation.find(v => v.checkId === "lint").optional, true);
});

test("an optional check explicitly marked rerun is executed again", async t => {
  const f = await fixture(t, [{ id: "lint", optional: true, code: "fs.readFileSync('.agent/state/receipts.jsonl','utf8');" }, { id: "required", code: append }]);
  const done = await drive(f.run, { impact: check => check.checkId === "lint" ? "rerun" : "unaffected" });
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.deepEqual(f.calls(), ["lint", "required", "lint"]);
  assert.equal(done.validation.filter(v => v.checkId === "lint").length, 2);
});

test("an unaffected optional failure is retained without blocking or replaying it", async t => {
  const f = await fixture(t, [{ id: "lint", optional: true, code: "process.exit(7);" }, { id: "required", code: append }]);
  const done = await drive(f.run);
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.deepEqual(f.calls(), ["lint", "required"]);
  assert.equal(done.validation.find(v => v.checkId === "lint").exitCode, 7);
  assert.equal(done.validation.find(v => v.checkId === "lint").optional, true);
});

test("rechecking a changed state dependency can fail the required gate", async t => {
  const f = await fixture(t, [
    { id: "reads-state", code: "require('node:assert/strict').equal(JSON.parse(fs.readFileSync('.agent/state/input.json','utf8')),1);" },
    { id: "writes-state", code: "fs.writeFileSync('.agent/state/input.json','2');" },
  ]);
  const done = await drive(f.run, { impact: check => check.checkId === "reads-state" ? "rerun" : "unaffected" });
  assert.equal(done.phase, "BLOCKED", JSON.stringify(done.outcome));
  assert.deepEqual(f.calls(), ["reads-state", "writes-state", "reads-state"]);
  assert.deepEqual(done.validationFailure.checks, ["reads-state"]);
  assert.equal(done.validation.at(-1).exitCode, 1);
});

test("an unaffected failed command stays failed and is not replayed for its receipt", async t => {
  const f = await fixture(t, [{ id: "fails", code: append + "process.exit(7);" }]);
  const done = await drive(f.run);
  assert.equal(done.phase, "BLOCKED", JSON.stringify(done.outcome));
  assert.deepEqual(f.calls(), ["fails"]);
  assert.equal(done.validation[0].exitCode, 7);
  assert.ok(done.validationFailure);
  assert.ok(Object.values(done.ledger).every(finding => finding.status !== "fixed"));
});

test("receipt writes cannot waive uncertain execution", async t => {
  const f = await fixture(t, [{ id: "times-out", code: append + "setTimeout(()=>{},5000);", timeoutMs: 500 }]);
  const done = await drive(f.run);
  assert.equal(done.phase, "VALIDATION_FAILED", JSON.stringify(done.outcome));
  assert.equal(done.outcome.code, "EXECUTION_UNCERTAIN");
  assert.equal(done.validation[0].execution, "uncertain");
  assert.equal(done.validationReuse, undefined);
  assert.deepEqual(status(done).filesChanged, [".agent/state/receipts.jsonl"]);
  assert.equal(status(done).indexNeedsRestaging, true);
  const captured = JSON.parse(readFileSync(status(done).retainedCheckout.evidence, "utf8"));
  const digest = captured.files[".agent/state/receipts.jsonl"].blob;
  assert.notEqual(digest, done.expected.files[".agent/state/receipts.jsonl"].blob, "uncertain output must not replace the accepted baseline");
  assert.equal(readFileSync(path.join(done.directory, "blobs", digest), "utf8"), readFileSync(path.join(f.root, ".agent/state/receipts.jsonl"), "utf8"));
});

test("a lost validation worker retains tracked output after process cleanup", async t => {
  const f = await fixture(t, [{ id: "lost", code: append + "setInterval(()=>{},1000);" }]);
  let run = await drive(f.run, { stop: r => Boolean(r.validationCycle?.job) });
  for (let n = 0; n < 300 && !readFileSync(path.join(f.root, ".agent/state/receipts.jsonl"), "utf8"); n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(readFileSync(path.join(f.root, ".agent/state/receipts.jsonl"), "utf8"));
  const owner = JSON.parse(readFileSync(path.join(run.directory, "assignments", run.validationCycle.job, "claimed"), "utf8"));
  process.kill(owner.pid, "SIGKILL");
  for (let n = 0; n < 300 && ownedAlive(owner); n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ownedAlive(owner), false);
  run = await drive(run);
  assert.equal(run.phase, "VALIDATION_FAILED");
  assert.equal(run.outcome.code, "EXECUTION_UNCERTAIN");
  assert.deepEqual(status(run).filesChanged, [".agent/state/receipts.jsonl"]);
  assert.equal(status(run).indexNeedsRestaging, true);
  assert.deepEqual(run.cleanup, []);
  assert.equal(run.validation[0].execution, "uncertain");
  assert.ok(status(run).retainedCheckout.evidence);
  assert.deepEqual(f.calls(), ["lost"]);
});

test("staged changes during validation still stop without resetting the index", async t => {
  const f = await fixture(t, [{ id: "stages", code: append + "require('node:child_process').execFileSync('git',['add','.agent/state/receipts.jsonl']);" }]);
  const done = await drive(f.run);
  assert.equal(done.phase, "SCOPE_CHANGED");
  assert.match(done.outcome.reason, /Git index/);
  assert.equal(done.validationReuse, undefined);
  assert.notDeepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
});

test("validation assessment rejects duplicate identities without accepting partial reuse", async t => {
  const f = await fixture(t, [{ id: "first", code: "" }, { id: "second", code: append }]);
  let run = await drive(f.run, { stop: r => Boolean(r.pending?.assignment.validationAssessment) });
  const result = response(run);
  assert.equal(result.validationImpact.length, 2);
  result.validationImpact[1].assignmentId = result.validationImpact[0].assignmentId;
  await send(run, result);
  run = await advance(run.directory);
  assert.equal(run.validationReuse, undefined);
  assert.match(run.assignmentAttempts.at(-1).error, /exactly once/);
  const done = await drive(run);
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.deepEqual(f.calls(), ["first", "second"]);
});

test("validation assessment rejects whitespace evidence without accepting partial reuse", async t => {
  const f = await fixture(t, [{ id: "first", code: "" }, { id: "second", code: append }]);
  let run = await drive(f.run, { stop: r => Boolean(r.pending?.assignment.validationAssessment) });
  const result = response(run);
  assert.equal(result.validationImpact.length, 2);
  result.validationImpact[1].evidence = " \t\n\u2003";
  await send(run, result);
  run = await advance(run.directory);
  assert.equal(run.validationReuse, undefined);
  assert.match(run.assignmentAttempts.at(-1).error, /evidence/);
  const done = await drive(run);
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.deepEqual(f.calls(), ["first", "second"]);
});
