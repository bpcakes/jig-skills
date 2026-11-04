import "./fixtures/no-default-launcher.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRun, reconcileUpstream, runUntilBoundary, submit, TERMINAL } from "../skills/review-fix-loop/scripts/review-fix-loop.mjs";
import { parseArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";
import { loadRun } from "../skills/review-fix-loop/scripts/run-store.mjs";

async function fixture(t, { prerequisites = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "jig-upstream-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(path.join(root, "value"), "base"); git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(path.join(root, "prerequisite"), "fixture fix"); git("add", "."); git("commit", "-qm", "upstream");
  const upstream = git("rev-parse", "HEAD");
  writeFileSync(path.join(root, "value"), "candidate"); git("add", "."); git("commit", "-qm", "dependent");
  const run = await createRun({ cwd: root, options: parseArgs(["--scope", "branch", "--base", base]),
    config: { reviewConcurrency: 1 }, contract: { goal: "Deliver candidate", nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: [],
      acceptanceCriteria: [{ id: "value", description: "Value is candidate" }],
      ...(prerequisites ? { prerequisites: [{ id: "ready", argv: [process.execPath, "-e", "process.exit(0)"] }] } : {}),
      requiredValidation: [{ id: "unit", argv: [process.execPath, "-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('value','utf8'),'candidate');require('node:assert/strict').equal(require('node:fs').existsSync('.git/fail-check'),false)"] }] } });
  t.after(() => rmSync(path.dirname(run.workspaceRoot), { recursive: true, force: true }));
  return { root, run, git, upstream, base };
}
async function finish(run, allowReview = true, uncertainAcceptance = false) {
  for (let i = 0; i < 20; i++) {
    run = await runUntilBoundary(run.directory);
    if (TERMINAL.has(run.phase)) return run;
    const a = run.pending.assignment;
    if (a.role === "review") assert.ok(allowReview, "upstream landing must not commission another reviewer");
    const result = a.role === "review" ? { complete: true, findings: [], acceptance: [{ criterionId: "value", status: uncertainAcceptance ? "uncertain" : "satisfied", evidence: "Inspected the combined source; acceptance depends on the pinned value assertion", validationIds: ["unit"] }] }
      : { decisions: [] };
    if (a.role === "triage" && uncertainAcceptance) {
      const passed = !a.validationPending?.includes("unit") && a.validation.some(v => v.checkId === "unit" && v.outcome === "succeeded"
        && v.fingerprint === a.fingerprint && v.candidateHash === a.contentHash);
      result.decisions = a.findings.map(finding => {
        assert.equal(finding.key, "requirement-value");
        return { id: finding.id, status: passed ? "fixed" : "awaiting-validation",
          evidence: "The combined value file is candidate; the required unit assertion checks exactly that value. " + (passed ? "Its current receipt passed and resolves the review concern." : "Await its required execution.") };
      });
    }
    await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...result });
  }
  assert.fail("Controller did not terminate");
}
function receipt(f, run) {
  return { from: run.fingerprint.fingerprint, upstream: { pr: 415, head: f.upstream, landing: f.upstream, target: f.upstream }, evidence: "Confirmed exact PR head landed in target",
    assessment: Object.fromEntries(["history", "environment", "tools", "generatedOutputs"].map(key => [key, { applicable: true, evidence: `Inspected ${key}; review conclusions remain applicable; all checks will rerun` }])) };
}
for (const rewrite of [false, true]) test(`upstream landing preserves immutable reports and reruns validation (new commit: ${rewrite})`, async t => {
  const f = await fixture(t, { prerequisites: true }); let run = await finish(f.run);
  assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome));
  const reports = structuredClone(run.reports), calls = run.validation.length, attempts = run.attempts.length;
  const bytes = reports.map(r => readFileSync(path.join(run.directory, "reports", `${r.assignmentId}.json`), "utf8"));
  if (rewrite) f.git("commit", "--amend", "-qm", "same program, new history");
  const proof = receipt(f, run);
  run = await reconcileUpstream(run.directory, proof);
  assert.equal(run.phase, "VALIDATE");
  assert.equal((await reconcileUpstream(run.directory, proof)).upstreamLandings.length, 1);
  run = await finish(run, false);
  assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome));
  assert.equal(run.validation.length, calls + 2);
  assert.deepEqual(run.validation.slice(calls).map(r => r.purpose), ["prerequisite", "validation"]); assert.equal(run.attempts.length, attempts);
  assert.deepEqual(run.reports, reports);
  assert.deepEqual(reports.map(r => readFileSync(path.join(run.directory, "reports", `${r.assignmentId}.json`), "utf8")), bytes);
  assert.equal(run.upstreamLandings.length, 1);
  assert.equal((await reconcileUpstream(run.directory, proof)).phase, "CONVERGED");
  assert.equal(run.fingerprint.headOid, f.git("rev-parse", "HEAD"));
});
for (const change of ["code", "excluded", "assessment", "upstream", "active", "contract", "comparison"]) test(`upstream reconciliation rejects ${change} drift without altering the run`, async t => {
  const f = await fixture(t); const run = await finish(f.run), proof = receipt(f, run);
  if (change === "code") { writeFileSync(path.join(f.root, "value"), "different"); f.git("add", "."); f.git("commit", "-qm", "changed code"); }
  if (change === "excluded") { writeFileSync(path.join(f.root, ".reviewignore"), "value\n"); f.git("add", "."); f.git("commit", "-qm", "changed coverage"); }
  if (change === "assessment") proof.assessment.tools.applicable = false;
  if (change === "upstream") proof.upstream.head = "a".repeat(40);
  if (change === "active") writeFileSync(path.join(run.runsRoot, "active.json"), JSON.stringify({ directory: "/another/run" }));
  if (change === "comparison") f.git("config", "diff.renames", "false");
  if (change === "contract") writeFileSync(path.join(run.directory, "task-contract.json"), "{}");
  const before = readFileSync(path.join(run.directory, "run.json"), "utf8");
  await assert.rejects(reconcileUpstream(run.directory, proof));
  assert.equal(readFileSync(path.join(run.directory, "run.json"), "utf8"), before);
});
test("a discovery wave cannot be promoted through upstream reconciliation", async t => {
  const f = await fixture(t); const run = await runUntilBoundary(f.run.directory);
  await assert.rejects(reconcileUpstream(run.directory, receipt(f, run)), /settled successful/);
  assert.equal(loadRun(run.directory).phase, "REVIEW");
});

test("failed history/environment validation after landing cannot inherit the old green result", async t => {
  const f = await fixture(t); const run = await finish(f.run);
  await reconcileUpstream(run.directory, receipt(f, run));
  writeFileSync(path.join(f.root, ".git/fail-check"), "changed environment");
  const failed = await runUntilBoundary(run.directory);
  assert.equal(failed.phase, "TRIAGE");
  assert.deepEqual(failed.validationFailure.checks, ["unit"]);
  assert.notEqual(failed.validation.at(-1).exitCode, 0);
});

for (const failRerun of [false, true]) test(`upstream landing carries resolved acceptance only with fresh passing validation (failure: ${failRerun})`, async t => {
  const f = await fixture(t); let run = await finish(f.run, true, true);
  assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome));
  assert.ok(run.reports.length >= 2);
  assert.ok(run.reports.every(report => report.acceptance[0].status === "uncertain"));
  const reports = structuredClone(run.reports), resolutions = structuredClone(run.acceptanceResolutions);
  for (const report of reports) assert.ok(resolutions.some(r => r.reportAssignmentId === report.assignmentId && r.criterionId === "value" && r.validationAssignmentIds.length));
  const bytes = reports.map(r => readFileSync(path.join(run.directory, "reports", `${r.assignmentId}.json`), "utf8"));
  const calls = run.validation.length, attempts = run.attempts.length, fingerprint = run.fingerprint.fingerprint;
  const proof = receipt(f, run);
  f.git("commit", "--amend", "-qm", "same candidate, changed history after resolved acceptance");
  run = await reconcileUpstream(run.directory, proof);
  assert.notEqual(run.fingerprint.fingerprint, fingerprint);
  if (failRerun) {
    writeFileSync(path.join(f.root, ".git/fail-check"), "changed environment");
    run = await runUntilBoundary(run.directory);
    assert.equal(run.phase, "TRIAGE");
    assert.deepEqual(run.validationFailure.checks, ["unit"]);
    assert.equal(run.validation.at(-1).outcome, "failed");
  } else {
    run = await finish(run, false);
    assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome));
    assert.equal(run.validation.at(-1).outcome, "succeeded");
  }
  assert.equal(run.validation.length, calls + 1);
  assert.equal(run.validation.at(-1).fingerprint, run.fingerprint.fingerprint);
  assert.equal(run.attempts.length, attempts, "reconciliation must not commission replacement reviews");
  assert.deepEqual(run.reports, reports);
  assert.deepEqual(run.acceptanceResolutions, resolutions, "original acceptance resolutions remain bound to their original evidence");
  assert.deepEqual(reports.map(r => readFileSync(path.join(run.directory, "reports", `${r.assignmentId}.json`), "utf8")), bytes);
});

test("merging a squash landing preserves reviews of the already-combined content", async t => {
  const f = await fixture(t); let run = await finish(f.run);
  const reports = structuredClone(run.reports), proof = receipt(f, run);
  const landing = f.git("commit-tree", f.git("rev-parse", `${f.upstream}^{tree}`), "-p", f.base, "-m", "squash prerequisite");
  f.git("merge", "--no-ff", "-m", "integrate landed prerequisite", landing);
  proof.upstream.landing = landing; proof.upstream.target = landing;
  proof.assessment.history.evidence = "Compared source and squash trees; merged landing into the combined candidate with no content changes";
  run = await reconcileUpstream(run.directory, proof);
  run = await finish(run, false);
  assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome));
  assert.deepEqual(run.reports, reports);
  assert.equal(run.upstreamLandings[0].upstream.landing, landing);
});
