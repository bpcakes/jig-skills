import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { advance, createRun, status, submit, TERMINAL } from "../skills/review-fix-loop/scripts/review-fix-loop.mjs";
import { git } from "../skills/review-fix-loop/scripts/repository.mjs";
import { loadRun, readJSON } from "../skills/review-fix-loop/scripts/run-store.mjs";
import { parseArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-reconcile-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(path.join(root, "value.cjs"), "module.exports = 0;\n");
  writeFileSync(path.join(root, "notes.txt"), "original note\n");
  git(root, "add", "."); git(root, "commit", "-qm", "initial");
  writeFileSync(path.join(root, "value.cjs"), "module.exports = 1;\n");
  const index = readFileSync(path.join(root, ".git/index"));
  const contract = { goal: "Correct export", acceptanceCriteria: [{ id: "value", description: "Exports 2" }], nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: ["Correct export"],
    requiredValidation: [{ id: "unit", argv: [process.execPath, "-e", "require('node:assert/strict').equal(require('./value.cjs'),2)"] }] };
  return { root, index, contract, async start(extra = {}) {
    const run = await createRun({ cwd: root, contract, ...extra });
    t.after(() => rmSync(path.dirname(run.workspaceRoot), { recursive: true, force: true }));
    return run;
  } };
}
function result(a, run) {
  const correct = readFileSync(path.join(a.repository, "value.cjs"), "utf8").includes("= 2;");
  if (a.role === "review") return { complete: true, findings: correct ? [] : [{ key: "value", path: "value.cjs", severity: "medium", title: "Wrong export", evidence: "Expected 2" }],
    acceptance: [{ criterionId: "value", status: correct ? "satisfied" : "unsatisfied", evidence: "Read export", validationIds: ["unit"] }] };
  if (a.role === "triage") return { decisions: a.findings.map(f => ({ id: f.id, status: correct && run.validation.some(v => v.outcome === "succeeded" && v.fingerprint === run.fingerprint.fingerprint) ? "fixed" : correct && a.sourceChanges ? "needs-validation" : "actionable", evidence: "Checked source and matching validation" })) };
  const file = path.join(a.repository, "value.cjs");
  writeFileSync(file, readFileSync(file, "utf8").replace(/= \d+;/, "= 2;"));
  return { workspaceEdits: [{ path: "value.cjs", findingIds: a.findings.map(f => f.id), reason: "Correct export" }] };
}
async function drive(run, observe = () => false, respond = result) {
  for (let n = 0; n < 700; n++) {
    run = await advance(run.directory);
    if (observe(run)) return run;
    if (TERMINAL.has(run.phase) && !status(run).waiting) return run;
    if (run.pending && !run.pending.command) {
      const a = run.pending.assignment;
      await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...respond(a, run) });
    }
    if (run.pending?.command || run.validationCycle?.job) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Unsettled run: ${JSON.stringify(status(run))}`);
}

for (const change of ["add", "edit", "delete", "rename"]) test(`unrelated ${change} during a native repair preserves that repair and continues`, async t => {
  const f = fixture(t);
  let run = await drive(await f.start(), r => r.pending?.role === "repair");
  const a = run.pending.assignment, edits = result(a, run), originalFingerprint = run.fingerprint.fingerprint;
  const note = path.join(f.root, "notes.txt");
  if (change === "add") writeFileSync(path.join(f.root, "new-note"), "user addition\n");
  if (change === "edit") writeFileSync(note, "user edit\n");
  if (change === "delete") rmSync(note);
  if (change === "rename") renameSync(note, path.join(f.root, "renamed-note"));
  // A pending native task keeps its original immutable assignment identity.
  run = await advance(run.directory);
  assert.equal(run.pending.id, a.id); assert.equal(run.fingerprint.fingerprint, originalFingerprint);
  await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...edits });
  run = await advance(run.directory);
  assert.equal(run.phase, "VALIDATE"); assert.equal(run.sourceReconciliations.length, 1);
  assert.equal(run.candidate.patch.length, 1); assert.equal(run.candidate.patch[0].path, "value.cjs");
  assert.equal(run.reports.length, 0); assert.notEqual(run.fingerprint.fingerprint, originalFingerprint);
  run = await drive(loadRun(run.directory));
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.equal(run.round, 1); assert.equal(run.assignmentAttempts.filter(a => a.role === "repair").length, 1);
  assert.equal(run.reports.length, 2); assert.ok(run.reports.every(r => r.fingerprint === run.fingerprint.fingerprint));
  assert.ok(run.validation.some(v => v.outcome === "succeeded" && v.fingerprint === run.fingerprint.fingerprint));
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
  if (change === "add") assert.equal(readFileSync(path.join(f.root, "new-note"), "utf8"), "user addition\n");
  if (change === "edit") assert.equal(readFileSync(note, "utf8"), "user edit\n");
  if (change === "delete" || change === "rename") assert.equal(existsSync(note), false);
  if (change === "rename") assert.equal(readFileSync(path.join(f.root, "renamed-note"), "utf8"), "original note\n");
  assert.ok(readJSON(run.sourceReconciliations[0].evidence).reports.length > 0);
});

test("a review of the old snapshot contributes findings but never fresh acceptance", async t => {
  const f = fixture(t);
  let run = await drive(await f.start(), r => r.pending?.role === "review");
  const a = run.pending.assignment;
  writeFileSync(path.join(f.root, "new-note"), "concurrent note");
  await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...result(a, run) });
  run = await advance(run.directory);
  assert.equal(run.phase, "TRIAGE"); assert.equal(run.reports.length, 0);
  assert.equal(run.attempts.length, 1); assert.ok(Object.values(run.ledger).some(f => f.key === "value"));
  const history = readJSON(run.sourceReconciliations[0].evidence);
  assert.equal(history.reports.length, 1); assert.equal(history.reports[0].fingerprint, a.fingerprint);
  run = await drive(run);
  assert.equal(run.phase, "CONVERGED"); assert.equal(run.attempts.length, 3, "No repeated two-review discovery pass");
});

test("command-backed repairs are consumed once across source reconciliation", async t => {
  const f = fixture(t), log = path.join(tmpdir(), `jig-reconcile-calls-${path.basename(f.root)}`);
  t.after(() => rmSync(log, { force: true }));
  const command = [process.execPath, fileURLToPath(new URL("./fixtures/loop-provider.mjs", import.meta.url)), "workspace", log];
  let run = await drive(await f.start({ config: { reviewers: [{ id: "codex", command }], triageCommand: command, repairCommand: command } }), r => r.pending?.role === "repair");
  writeFileSync(path.join(f.root, "new-note"), "preserve");
  run = await drive(run);
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(new Set(calls).size, calls.length); assert.equal(calls.filter(id => id.endsWith("-repair")).length, 1);
  assert.equal(run.sourceReconciliations.length, 1); assert.equal(readFileSync(path.join(f.root, "new-note"), "utf8"), "preserve");
});

test("edits that already fix a pending review finding are validated without a repair or discovery restart", async t => {
  const f = fixture(t);
  let run = await drive(await f.start(), r => r.pending?.role === "review");
  const a = run.pending.assignment, oldResult = result(a, run);
  const newer = "module.exports = 2;\n// newer user work\n";
  writeFileSync(path.join(f.root, "value.cjs"), newer);
  await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...oldResult });
  run = await advance(run.directory);
  assert.equal(run.phase, "TRIAGE"); assert.deepEqual(run.sourceChanges.affectedPaths, ["value.cjs"]);
  run = await drive(run, r => Object.values(r.ledger).some(f => f.status === "needs-validation"));
  assert.ok(!run.validation.some(v => v.outcome === "succeeded"));
  run = await drive(run);
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.equal(run.round, 0); assert.equal(run.assignmentAttempts.filter(a => a.role === "repair").length, 0);
  assert.equal(run.attempts.length, 3); assert.equal(run.reports.length, 2);
  assert.ok(Object.values(run.ledger).every(f => f.status === "fixed"));
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), newer);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
});

test("unrelated edits before validation re-triage invalidated provisional findings", async t => {
  const f = fixture(t);
  let run = await drive(await f.start(), r => r.pending?.role === "review");
  const a = run.pending.assignment, oldResult = result(a, run);
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...oldResult });
  run = await drive(run, r => r.phase === "VALIDATE" && !r.validationCycle);
  for (let n = 1; n <= 2; n++) {
    assert.ok(Object.values(run.ledger).some(f => f.status === "needs-validation"));
    writeFileSync(path.join(f.root, "notes.txt"), `unrelated edit ${n}\n`);
    run = await advance(run.directory);
    assert.deepEqual(run.sourceChanges.affectedPaths, []);
    assert.equal(run.phase, "TRIAGE", JSON.stringify(status(run)));
    assert.equal(run.triaged, false);
    assert.ok(Object.values(run.ledger).some(f => f.status === "unresolved"));
    assert.equal(run.validation.length, 0);
    run = await drive(loadRun(run.directory), r => r.phase === "VALIDATE" && !r.validationCycle);
  }
  run = await drive(loadRun(run.directory));
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.equal(run.sourceReconciliations.length, 3);
  assert.equal(run.round, 0); assert.equal(run.assignmentAttempts.filter(a => a.role === "repair").length, 0);
  assert.equal(run.attempts.length, 3, "Original review plus two fresh terminal reviews, without repeated discovery");
  assert.equal(run.validation.length, 1); assert.equal(run.validation[0].outcome, "succeeded");
  assert.ok(Object.values(run.ledger).every(f => f.status === "fixed"));
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 2;\n");
  assert.equal(readFileSync(path.join(f.root, "notes.txt"), "utf8"), "unrelated edit 2\n");
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
});

for (const prematureFixed of [false, true]) test(`retained candidate needs its own validation${prematureFixed ? " and cannot claim fixed from checkout evidence" : " when checkout validation is reused"}`, async t => {
  const f = fixture(t);
  const staged = git(f.root, "ls-files", "--stage", "-v", "-z");
  f.contract.acceptanceCriteria[0].description = "Exports a supported numeric value";
  f.contract.requiredValidation[0].argv[2] = "require('node:assert/strict').ok([1,2].includes(require('./value.cjs')))";
  const respond = (a, run) => {
    const correct = readFileSync(path.join(a.repository, "value.cjs"), "utf8").includes("= 2;");
    if (a.role === "review") return { complete: true,
      findings: run.sourceReconciliations?.length && !correct ? [
        { key: "value", path: "value.cjs", severity: "medium", title: "Proposed correction", evidence: "Inspect export" },
        { key: "notes", path: "notes.txt", severity: "medium", title: "Questionable note", evidence: "Inspect note" },
      ] : [], acceptance: [{ criterionId: "value", status: "satisfied", evidence: "Valid numeric export", validationIds: ["unit"] }] };
    if (a.role === "triage") return { decisions: a.findings.map(f => ({ id: f.id,
      status: f.key === "notes" ? "rejected" : correct ? run.candidate ? "needs-validation" : "fixed" : "actionable",
      evidence: "Inspect the actual assignment source and its validation" })) };
    return result(a, run);
  };
  let run = await drive(await f.start(), r => !r.validationCycle && r.validation.some(v => v.outcome === "succeeded"), respond);
  const validatedFingerprint = run.fingerprint.fingerprint;
  writeFileSync(path.join(f.root, "notes.txt"), "temporary external note\n");
  run = await drive(run, r => r.pending?.role === "repair", respond);
  const repair = run.pending.assignment;
  await submit(run.directory, repair.id, { assignmentId: repair.id, fingerprint: repair.fingerprint, ...respond(repair, run) });
  writeFileSync(path.join(f.root, "notes.txt"), "original note\n");
  run = await drive(run, r => r.pending?.role === "triage" && Boolean(r.candidate), respond);
  assert.equal(run.fingerprint.fingerprint, validatedFingerprint);
  assert.ok(run.validation.some(v => v.outcome === "succeeded" && v.fingerprint === validatedFingerprint && v.candidateHash === run.expected.contentHash));
  const triage = run.pending.assignment;
  const publicationIndex = readFileSync(path.join(f.root, ".git/index"));
  assert.equal(readFileSync(path.join(triage.repository, "value.cjs"), "utf8"), "module.exports = 2;\n");
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 1;\n");
  const response = respond(triage, run);
  if (prematureFixed) for (const decision of response.decisions) if (decision.status === "needs-validation") decision.status = "fixed";
  await submit(run.directory, triage.id, { assignmentId: triage.id, fingerprint: triage.fingerprint, ...response });
  run = await advance(run.directory);
  if (prematureFixed) assert.match(run.assignmentAttempts.find(a => a.id === triage.id).error ?? "", /Fixed findings require validation/);
  else assert.equal(run.assignmentAttempts.find(a => a.id === triage.id).error, undefined);
  run = await drive(loadRun(run.directory), () => false, respond);
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.equal(run.round, 1); assert.equal(run.assignmentAttempts.filter(a => a.role === "repair").length, 1);
  assert.ok(run.validation.some(v => v.outcome === "succeeded" && v.candidateHash === run.expected.contentHash && v.fingerprint === run.fingerprint.fingerprint));
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 2;\n");
  // Restoring a clean file can refresh Git's stat cache. Preserve staged
  // objects/modes/flags across that refresh and exact bytes during publication.
  assert.deepEqual(git(f.root, "ls-files", "--stage", "-v", "-z"), staged);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), publicationIndex);
});

for (const triageFailures of [1, 3]) test(`reassessment has its own retry budget after two repair failures: ${triageFailures} triage failures`, async t => {
  const f = fixture(t);
  let run = await drive(await f.start(), r => r.pending?.role === "repair");
  for (let n = 1; n <= 2; n++) {
    const a = run.pending.assignment;
    if (n === 2) writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 1;\n// external edit\n");
    await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, error: `Repair failure ${n}` });
    run = await advance(run.directory);
    if (n === 1) run = await drive(run, r => r.pending?.role === "repair");
  }
  assert.equal(run.phase, "TRIAGE"); assert.equal(run.round, 1);
  const reassessmentIds = [];
  let failures = 0;
  run = await drive(loadRun(run.directory), () => false, (a, current) => {
    if (a.role === "triage" && current.round === 1) {
      reassessmentIds.push(a.id);
      if (failures++ < triageFailures) return { error: "Transient reassessment failure" };
    }
    return result(a, current);
  });
  assert.equal(run.phase, triageFailures === 1 ? "CONVERGED" : "BLOCKED", JSON.stringify(status(run)));
  assert.deepEqual(run.assignmentAttempts.filter(a => a.role === "repair" && a.round === 1).map(a => a.attempt), [1, 2]);
  assert.deepEqual(run.assignmentAttempts.filter(a => reassessmentIds.includes(a.id)).map(a => a.attempt), triageFailures === 1 ? [1, 2] : [1, 2, 3]);
  assert.equal(run.round, triageFailures === 1 ? 2 : 1);
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), `module.exports = ${triageFailures === 1 ? 2 : 1};\n// external edit\n`);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
});

for (const comment of ["", "// newer user work\n"]) test(`overlapping edits allow reassessment of an unapplied repair${comment ? " preserving newer comments" : " to identical bytes"}`, async t => {
  const f = fixture(t);
  let run = await drive(await f.start(), r => r.pending?.role === "repair");
  const a = run.pending.assignment, oldRepair = result(a, run);
  const newer = `module.exports = 3;\n${comment}`;
  writeFileSync(path.join(f.root, "value.cjs"), newer);
  await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...oldRepair });
  run = await advance(run.directory);
  assert.equal(run.phase, "TRIAGE"); assert.equal(run.candidate, null);
  assert.equal(run.sourceChanges.supersededRepair[0].path, "value.cjs");
  assert.ok(readJSON(run.sourceReconciliations[0].evidence).candidate);
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), newer);
  run = await drive(run);
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.equal(run.round, 2); assert.equal(run.assignmentAttempts.filter(a => a.role === "repair").length, 2);
  assert.equal(run.mutations.length, 1); assert.equal(run.mutations[0].round, 2);
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), newer.replace("= 3;", "= 2;"));
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
});

for (const publication of ["checkout", "isolated", "denied"]) test(`retained disjoint repair dispositions follow ${publication} publication`, async t => {
  if (publication !== "checkout" && process.platform === "linux" && spawnSync("bwrap", ["--unshare-net", "--ro-bind", "/", "/", "--", "true"]).status !== 0) { t.skip("Bubblewrap/user namespaces unavailable"); return; }
  const f = fixture(t);
  let reassessedCandidate = false;
  const respond = (a, run) => {
    const response = result(a, run);
    if (a.role === "review" && !a.sourceChanges && run.round === 0) response.findings.push({ key: "notes", path: "notes.txt", severity: "medium", title: "Questionable note", evidence: "Inspect note" });
    if (a.role === "triage") {
      for (const decision of response.decisions) if (a.findings.find(f => f.id === decision.id).key === "notes") decision.status = "rejected";
      if (a.sourceChanges && run.candidate) {
        reassessedCandidate = true;
        assert.equal(readFileSync(path.join(a.repository, "notes.txt"), "utf8"), "new external note\n");
        assert.equal(readFileSync(path.join(a.repository, "value.cjs"), "utf8"), "module.exports = 2;\n");
        assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 1;\n", "Candidate is assessed before publication");
      }
    }
    return response;
  };
  let run = await drive(await f.start({ config: { validationMode: publication === "checkout" ? "checkout" : "isolated" } }), r => r.pending?.role === "repair", respond);
  const a = run.pending.assignment;
  await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...result(a, run) });
  writeFileSync(path.join(f.root, "notes.txt"), "new external note\n");
  const originalOpen = fs.openSync;
  let denied = false;
  if (publication === "denied") {
    // Inject the same filesystem failure even when tests run as root.
    fs.openSync = function(file, ...args) {
      if (path.dirname(String(file)) === f.root && path.basename(String(file)).startsWith(".jig-apply-")) {
        denied = true; throw Object.assign(new Error("EACCES: publication directory is read-only"), { code: "EACCES" });
      }
      return originalOpen(file, ...args);
    };
    syncBuiltinESMExports();
  }
  try { run = await drive(loadRun(run.directory), () => false, respond); }
  finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }
  if (publication === "denied") {
    assert.equal(denied, true); assert.equal(run.phase, "SCOPE_CHANGED"); assert.match(run.outcome.reason, /EACCES/);
    assert.ok(run.validation.some(v => v.outcome === "succeeded"));
    assert.equal(run.mutations.length, 0);
    assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 1;\n");
    const resumed = loadRun(run.directory);
    assert.ok(Object.values(resumed.ledger).some(f => f.status === "needs-validation"));
    assert.ok(status(resumed).findings.every(f => f.status !== "fixed"));
    assert.ok(Object.values(resumed.ledger).every(f => !f.history.some(h => h.event === "reconciled-fix-validated")));
    return;
  }
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.equal(reassessedCandidate, true);
  assert.equal(run.round, 1); assert.equal(run.assignmentAttempts.filter(a => a.role === "repair").length, 1);
  assert.equal(run.mutations.length, 1); assert.equal(run.validation.filter(v => !v.applied).length, 1);
  for (const finding of Object.values(run.ledger).filter(f => f.key !== "notes")) {
    assert.equal(finding.status, "fixed");
    assert.ok(finding.history.some(h => h.event === "reconciled-fix-validated" && h.fingerprint === run.fingerprint.fingerprint));
  }
  assert.equal(readFileSync(path.join(f.root, "notes.txt"), "utf8"), "new external note\n");
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 2;\n");
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
});

test("repeated reassessment reuses an unstarted repair round at the limit", async t => {
  const f = fixture(t);
  let run = await drive(await f.start({ options: parseArgs(["--max-rounds", "1"]) }), r => r.phase === "REPAIR" && !r.pending);
  assert.equal(run.round, 1);
  for (let n = 1; n <= 2; n++) {
    writeFileSync(path.join(f.root, "value.cjs"), `module.exports = 1;\n// edit ${n}\n`);
    run = await advance(run.directory);
    assert.equal(run.phase, "TRIAGE");
    run = await drive(loadRun(run.directory), r => r.phase === "REPAIR" && !r.pending);
    assert.equal(run.phase, "REPAIR", JSON.stringify(status(run)));
    assert.equal(run.round, 1);
    assert.equal(run.assignmentAttempts.filter(a => a.role === "repair").length, 0);
  }
  run = await drive(loadRun(run.directory));
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.equal(run.round, 1); assert.equal(run.assignmentAttempts.filter(a => a.role === "repair").length, 1);
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 2;\n// edit 2\n");
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
});

for (const disposition of ["all-rejected", "mixed-edits", "shared-attribution"]) test(`retained repair honors reassessed attribution: ${disposition}`, async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, "extra.cjs"), "module.exports = 1;\n");
  f.contract.acceptanceCriteria[0].description = "Exports a supported numeric value";
  f.contract.requiredValidation[0].argv[2] = "require('node:assert/strict').ok([1,2].includes(require('./value.cjs')))";
  let repairs = 0, reassessedCheckout = false;
  const respond = (a, run) => {
    if (a.role === "review") return { complete: true,
      findings: run.round === 0 ? [
        { key: "value", path: "value.cjs", severity: "medium", title: "Proposed value correction", evidence: "Inspect export" },
        { key: "extra", path: disposition === "shared-attribution" ? "value.cjs" : "extra.cjs", severity: "medium", title: "Another proposed correction", evidence: "Inspect export" },
        { key: "notes", path: "notes.txt", severity: "medium", title: "Questionable note", evidence: "Inspect note" },
      ] : [], acceptance: [{ criterionId: "value", status: "satisfied", evidence: "Valid numeric export", validationIds: ["unit"] }] };
    if (a.role === "triage") {
      if (a.sourceChanges && !run.candidate && !run.mutations.length && disposition === "mixed-edits") {
        reassessedCheckout = true;
        assert.equal(readFileSync(path.join(a.repository, "value.cjs"), "utf8"), "module.exports = 1;\n");
        assert.equal(readFileSync(path.join(a.repository, "extra.cjs"), "utf8"), "module.exports = 1;\n");
      }
      return { decisions: a.findings.map(f => {
        let state = "actionable";
        if (f.key === "notes" || a.sourceChanges && (disposition === "all-rejected" || f.key === "extra")) state = "rejected";
        else if (readFileSync(path.join(a.repository, f.path), "utf8").includes("= 2;")) state = run.candidate ? "needs-validation" : "fixed";
        return { id: f.id, status: state, evidence: "Reassessed whether this correction is supported" };
      }) };
    }
    repairs++;
    const paths = [...new Set(a.findings.map(f => f.path))];
    for (const name of paths) writeFileSync(path.join(a.repository, name), "module.exports = 2;\n");
    return { workspaceEdits: paths.map(name => ({ path: name, reason: "Proposed correction", findingIds: a.findings.filter(f => f.path === name).map(f => f.id) })) };
  };
  let run = await drive(await f.start(), r => r.pending?.role === "repair", respond);
  const a = run.pending.assignment;
  await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...respond(a, run) });
  writeFileSync(path.join(f.root, "notes.txt"), "new external note\n");
  run = await drive(loadRun(run.directory), () => false, respond);
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), `module.exports = ${disposition === "all-rejected" ? 1 : 2};\n`);
  assert.equal(readFileSync(path.join(f.root, "extra.cjs"), "utf8"), "module.exports = 1;\n");
  assert.equal(readFileSync(path.join(f.root, "notes.txt"), "utf8"), "new external note\n");
  assert.equal(repairs, disposition === "mixed-edits" ? 2 : 1);
  assert.equal(run.round, repairs);
  assert.equal(run.mutations.length, disposition === "all-rejected" ? 0 : 1);
  if (disposition === "mixed-edits") assert.equal(reassessedCheckout, true);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
});

test("new source can address an earlier validation failure without manufacturing another repair", async t => {
  const f = fixture(t);
  f.contract.requiredValidation[0].argv[2] += ";require('node:assert/strict').ok(require('node:fs').existsSync('ready'))";
  let run = await drive(await f.start(), r => Boolean(r.validationFailure));
  assert.equal(run.phase, "TRIAGE"); assert.equal(run.round, 1);
  writeFileSync(path.join(f.root, "ready"), "external prerequisite fix");
  run = await drive(run);
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.equal(run.round, 1); assert.equal(run.assignmentAttempts.filter(a => a.role === "repair").length, 1);
  assert.equal(run.validation.length, 2); assert.notEqual(run.validation[0].fingerprint, run.validation[1].fingerprint);
  assert.equal(readFileSync(path.join(f.root, "ready"), "utf8"), "external prerequisite fix");
});

test("a candidate already tried by isolated validation remains protected against oscillation", async t => {
  if (process.platform === "linux" && spawnSync("bwrap", ["--unshare-net", "--ro-bind", "/", "/", "--", "true"]).status !== 0) { t.skip("Bubblewrap/user namespaces unavailable"); return; }
  const f = fixture(t);
  f.contract.requiredValidation[0].argv = [process.execPath, "-e", "process.exit(1)"];
  const run = await drive(await f.start({ config: { validationMode: "isolated" } }));
  assert.equal(run.phase, "BLOCKED", JSON.stringify(status(run)));
  assert.match(run.outcome.reason, /Oscillating/);
  assert.equal(run.round, 2); assert.equal(run.validation.length, 1);
  assert.equal(run.validation[0].exitCode, 1);
  assert.equal(run.mutations.length, 0);
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 1;\n");
});

test("provisional fixes cannot waive or repeatedly rerun a failed required check", async t => {
  const f = fixture(t);
  f.contract.requiredValidation[0].argv = [process.execPath, "-e", "process.exit(1)"];
  let run = await drive(await f.start(), r => r.pending?.role === "review");
  const a = run.pending.assignment, oldResult = result(a, run);
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...oldResult });
  run = await drive(run);
  assert.equal(run.phase, "BLOCKED", JSON.stringify(status(run)));
  assert.equal(run.validation.length, 1); assert.equal(run.round, 0);
  assert.ok(Object.values(run.ledger).every(f => f.status !== "fixed"));
});

for (const conflict of ["index", "visibility"]) test(`${conflict} changes still stop with specific drift evidence`, async t => {
  const f = fixture(t);
  let run = await drive(await f.start(), r => r.pending?.role === "repair");
  if (conflict === "index") git(f.root, "add", "value.cjs");
  if (conflict === "visibility") writeFileSync(path.join(f.root, ".gitignore"), "notes.txt\n");
  run = await advance(run.directory);
  assert.equal(run.phase, "SCOPE_CHANGED"); assert.equal(run.sourceReconciliations, undefined);
  if (conflict === "index") assert.match(run.outcome.reason, /Git index/);
  else assert.ok(run.outcome.conflicts.length);
});

test("reconciliation is bounded and retains accepted edits in the recovery baseline", async t => {
  const f = fixture(t); let run = await f.start();
  for (let n = 1; n <= 3; n++) {
    writeFileSync(path.join(f.root, "notes.txt"), `note ${n}\n`);
    run = await advance(run.directory);
    assert.equal(run.phase, "INIT"); assert.equal(run.sourceReconciliations.length, n);
    assert.equal(run.round, 0); assert.equal(run.attempts.length, 0);
    assert.equal(run.preservationBaseline.files["notes.txt"].blob, run.expected.files["notes.txt"].blob);
    assert.notEqual(run.original.files["notes.txt"].blob, run.expected.files["notes.txt"].blob);
  }
  writeFileSync(path.join(f.root, "notes.txt"), "one more edit\n");
  run = await advance(run.directory);
  assert.equal(run.phase, "SCOPE_CHANGED"); assert.match(run.outcome.reason, /Three source reconciliations/);
  assert.equal(run.sourceReconciliations.length, 3);
  assert.equal(readFileSync(path.join(f.root, "notes.txt"), "utf8"), "one more edit\n");
});

test("large reconciliation inventories stay complete on disk and bounded in assignment context", async t => {
  const f = fixture(t); let run = await f.start();
  for (let n = 0; n < 300; n++) writeFileSync(path.join(f.root, `note-${n}`), "external note\n");
  run = await advance(run.directory);
  assert.equal(run.phase, "INIT"); assert.equal(run.sourceChanges.pathCount, 300);
  assert.equal(run.sourceChanges.changeCount, 300); assert.equal(run.sourceChanges.truncated, true);
  assert.ok(run.sourceChanges.paths.length <= 128);
  assert.ok(Buffer.byteLength(JSON.stringify(run.sourceChanges)) <= 64 * 1024);
  assert.equal(readJSON(run.sourceReconciliations[0].evidence).paths.length, 300);
  assert.equal(Object.keys(run.expected.files).length, 302);
  assert.equal(run.sourceReconciliations[0].pathCount, 300); assert.equal(run.sourceReconciliations[0].pathsTruncated, true);
});
