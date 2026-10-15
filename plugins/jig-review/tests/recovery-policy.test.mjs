import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkingTreeRun as createRun } from "./fixtures/working-tree-loop.mjs";
import { runUntilBoundary, status, submit, TERMINAL } from "../skills/review-fix-loop/scripts/review-fix-loop.mjs";
import { parseArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";
import { reviewAssignment } from "../skills/review-fix-loop/scripts/provider-bridge.mjs";
import { resultSchema } from "../skills/review-fix-loop/scripts/assignment-schema.mjs";
import { commandEnvironment } from "../skills/review-fix-loop/scripts/job-runtime.mjs";
import { currentAdjudication, findingAnchor, recordRecovery, recoveryContext, recoveryDecision, signalRecovery } from "../skills/review-fix-loop/scripts/recovery-policy.mjs";

function unitRun() {
  return { id: "run", round: 2, pass: 3, contractHash: "contract", expected: { contentHash: "source" }, mutations: [], validation: [],
    ledger: { f: { id: "f", key: "claim", path: "source.js", evidence: "original claim", status: "actionable", history: [] } } };
}
test("signals survive resume and disappear from pending context only after a recorded diagnosis", () => {
  let run = unitRun();
  signalRecovery(run, "oscillation", ["f"], "patch/round-2.json");
  run = JSON.parse(JSON.stringify(run));
  signalRecovery(run, "oscillation", ["f"], "patch/round-2.json");
  assert.equal(recoveryContext(run).signals.length, 1);
  recordRecovery(run, { signalIds: [run.recoverySignals[0].id] });
  assert.equal(recoveryContext(run).signals.length, 0);
  assert.equal(run.recoverySignals.length, 1);
});
test("removing recovery history permits a repeated strategy; retaining it rejects the same failed strategy", () => {
  const run = unitRun(), assignment = { id: "triage", fingerprint: "fp", contentHash: "source" };
  const decision = { diagnosis: "wrong-design", strategy: "move-validation-to-owner", findingIds: ["f"], evidence: "Boundary probe", nextAction: "Owner validates before publishing" };
  const dispositions = [{ id: "f", status: "actionable" }];
  const first = recoveryDecision(run, decision, assignment, dispositions, () => true);
  assert.equal(first.route, "reimplement");
  recordRecovery(run, first);
  run.expected.contentHash = "changed-source";
  assert.throws(() => recoveryDecision(run, decision, assignment, dispositions, () => true), /strategy already failed/);
  assert.equal(recoveryDecision({ ...run, recoveries: [] }, decision, assignment, dispositions, () => true).route, "reimplement");
  assert.equal(recoveryDecision(run, { ...decision, strategy: "serialize-publication-at-owner" }, assignment, dispositions, () => true).route, "reimplement");
});
test("noise routing cannot lower the threshold or waive required gates", () => {
  const run = unitRun(), assignment = { id: "triage" };
  const decision = { diagnosis: "reviewer-noise", findingIds: ["f"], evidence: "Unrelated optional assertion", nextAction: "Track later" };
  assert.throws(() => recoveryDecision(run, decision, assignment, [{ id: "f", status: "actionable" }], () => true), /cannot defer/);
  assert.equal(recoveryDecision(run, decision, assignment, [{ id: "f", status: "actionable" }], () => false).route, "follow-up");
  run.ledger.f.required = true;
  assert.throws(() => recoveryDecision(run, decision, assignment, [{ id: "f", status: "rejected" }], () => true), /cannot defer/);
});
test("a flat finding count can accompany real progress, but productive labels cannot bypass oscillation", () => {
  const run = unitRun(), assignment = { id: "triage", contentHash: "stage-1" };
  const decision = { diagnosis: "productive", strategy: "complete-stages", findingIds: ["f"],
    evidence: "Stage 1 is complete; three remain", nextAction: "Complete the next stage" };
  const dispositions = [{ id: "f", status: "actionable" }];
  recordRecovery(run, recoveryDecision(run, decision, assignment, dispositions, () => true));
  assert.throws(() => recoveryDecision(run, decision, assignment, dispositions, () => true), /new progress evidence/);
  const progressed = { ...decision, evidence: "Stage 2 is complete; two remain" };
  assert.equal(recoveryDecision(run, progressed, { ...assignment, contentHash: "stage-2" }, dispositions, () => true).route, "repair");
  signalRecovery(run, "oscillation", ["f"], "An already attempted state returned");
  assert.throws(() => recoveryDecision(run, progressed, { ...assignment, contentHash: "stage-2" }, dispositions, () => true), /cannot waive/);
});
for (const diagnosis of ["local-repair", "wrong-design"]) test(`productive continuation retains a strategy selected by ${diagnosis}`, () => {
  const run = unitRun(), assignment = { id: "triage", contentHash: "stage-0" };
  const dispositions = [{ id: "f", status: "actionable" }];
  const decision = { diagnosis, strategy: "complete-stages", findingIds: ["f"], evidence: "Use the staged correction", nextAction: "Complete stage 1" };
  recordRecovery(run, recoveryDecision(run, decision, assignment, dispositions, () => true));
  const progress = { ...decision, diagnosis: "productive", evidence: "Stage 1 is validated; continue to stage 2" };
  assert.equal(recoveryDecision(run, progress, { ...assignment, contentHash: "stage-1" }, dispositions, () => true).route, "repair");
  assert.throws(() => recoveryDecision(run, progress, assignment, dispositions, () => true), /new progress evidence/);
  signalRecovery(run, "no-change", ["f"], "The attempted stage did not change source");
  recordRecovery(run, recoveryDecision(run, { ...decision, strategy: "replace-stage-boundary" }, assignment, dispositions, () => true));
  assert.equal(recoveryContext(run).signals.length, 0);
  assert.throws(() => recoveryDecision(run, progress, { ...assignment, contentHash: "stage-2" }, dispositions, () => true), /cannot waive/,
    "An abandoned strategy cannot be revived by a productive label after another strategy consumes its failure signal");
});
for (const verdict of ["upheld", "rejected", "needs-input"]) test(`an applicable ${verdict} verdict prevents another adjudication`, () => {
  const run = unitRun(), finding = run.ledger.f;
  finding.history.push({ status: "rejected", evidence: "Earlier rejection rationale" });
  run.adjudications = [{ findingId: "f", anchor: findingAnchor(run, finding), verdict }];
  const decision = { diagnosis: "disputed-finding", findingIds: ["f"], evidence: "Same claim again", nextAction: "Ask another judge" };
  assert.throws(() => recoveryDecision(run, decision, { id: "triage" }, [], () => true), /applicable adjudication is binding/);
  run.expected.contentHash = "changed source";
  assert.equal(recoveryDecision(run, decision, { id: "triage" }, [], () => true).route, "adjudicate");
});
test("judge decisions bind exact claim evidence and source, not the finding ID forever", () => {
  const run = unitRun(), finding = run.ledger.f;
  run.adjudications = [{ findingId: "f", anchor: findingAnchor(run, finding), verdict: "rejected" }];
  assert.equal(currentAdjudication(run, finding).verdict, "rejected");
  finding.title = "A different causal claim";
  assert.equal(currentAdjudication(run, finding), undefined);
  delete finding.title;
  finding.evidence = "New reproduction disproves the earlier assumption";
  assert.equal(currentAdjudication(run, finding), undefined);
  finding.evidence = "original claim";
  run.expected.contentHash = "changed caller";
  assert.equal(currentAdjudication(run, finding), undefined);
  run.expected.contentHash = "source";
  run.answers = [{ questionId: "q1", answer: "The public contract must retain compatibility" }];
  assert.equal(currentAdjudication(run, finding), undefined);
  run.answers = [];
  finding.history.push({ event: "adjudication-reopened", evidence: "A production caller disproves the assumed contract" });
  finding.reportEvidence = "original claim";
  assert.equal(currentAdjudication(run, finding), undefined, "A repeated old report must not erase newer research evidence");
});

test("partial recovery cannot consume a signal for an unrelated actionable failure", () => {
  const run = unitRun();
  run.ledger.g = { ...run.ledger.f, id: "g", key: "other" };
  signalRecovery(run, "oscillation", ["g"], "second attempted state");
  const decision = recoveryDecision(run, { diagnosis: "local-repair", strategy: "fix-first-boundary", findingIds: ["f"],
    evidence: "First boundary is independently repairable", nextAction: "Fix it" }, { id: "triage" },
  [{ id: "f", status: "actionable" }, { id: "g", status: "actionable" }], () => true);
  recordRecovery(run, decision);
  assert.equal(recoveryContext(run).signals.length, 1);
});

async function fixture(t, args = [], config = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "jig-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...argv) => execFileSync("git", argv, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(path.join(root, "value.txt"), "-1"); git("add", "."); git("commit", "-qm", "base");
  writeFileSync(path.join(root, "value.txt"), "0");
  const contract = { goal: "Complete four stages", nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: ["Complete stages"],
    acceptanceCriteria: [{ id: "stages", description: "All four stages complete" }],
    requiredValidation: [{ id: "unit", argv: [process.execPath, "-e", "require('node:assert/strict').ok(Number(require('node:fs').readFileSync('value.txt','utf8')) >= 0)"] }] };
  const run = await createRun({ cwd: root, options: parseArgs(args), config: { reviewConcurrency: 1, ...config }, contract });
  t.after(() => rmSync(path.dirname(run.workspaceRoot), { recursive: true, force: true }));
  return run;
}
async function drive(run, options = {}) {
  for (let i = 0; i < 100; i++) {
    run = await runUntilBoundary(run.directory);
    if (TERMINAL.has(run.phase)) return run;
    const a = run.pending.assignment;
    const value = Number(readFileSync(path.join(a.repository, "value.txt"), "utf8"));
    let result;
    if (a.role === "review") result = { complete: true,
      findings: [1, 2, 3, 4].filter(n => n > value).map(n => ({ key: `stage-${n}`, path: "value.txt", severity: "medium", title: `Stage ${n} incomplete`, evidence: `Current stage ${value} is below ${n}` })),
      acceptance: [{ criterionId: "stages", status: value === 4 ? "satisfied" : "unsatisfied", evidence: `Source completes ${value} stages`, validationIds: ["unit"] }] };
    else if (a.role === "triage") {
      result = { decisions: a.findings.map(f => ({ id: f.id,
        status: (f.required ? value === 4 : Number(f.key.slice(6)) <= value) ? "fixed" : "actionable", evidence: `Verified source stage ${value} and required receipts` })) };
      if (a.recoveryContext.signals.some(s => ["oscillation", "no-change"].includes(s.kind)) && !options.omitDiagnosis) {
        result.recovery = { diagnosis: "wrong-design", strategy: "complete-required-stages-together",
          evidence: "The two partial states alternated; the retained patch proves the prior approach cannot finish.",
          nextAction: "Use the contract's final stage 4 and preserve prior attempts as constraints.",
          findingIds: result.decisions.filter(d => d.status === "actionable").map(d => d.id) };
      }
    } else {
      const next = options.oscillate && run.round === 2 ? 0
        : options.oscillate && run.round > 2 ? options.repeatStrategy ? value : 4 : value + 1;
      if (options.oscillate && run.round === 3) {
        assert.equal(value, 1, "The oscillating inline proposal must not overwrite the checkout");
        assert.equal(a.recovery.route, "reimplement");
      }
      result = { edits: [{ path: "value.txt", content: String(next), reason: "Complete required stages", findingIds: a.findings.map(f => f.id) }] };
    }
    await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...result });
  }
  assert.fail("Recovery did not reach a boundary");
}
test("productive repairs can converge on the fourth round without resetting history", async t => {
  const run = await drive(await fixture(t));
  assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome));
  assert.equal(run.round, 4);
  assert.equal(run.assignmentAttempts.filter(a => a.role === "repair").length, 4);
  assert.equal(run.reports.length, 2);
});
async function continueRecoveredStages(run, diagnosis, failValidation = false) {
  for (let n = 0; n < 80; n++) {
    run = await runUntilBoundary(run.directory);
    if (TERMINAL.has(run.phase)) return run;
    const a = run.pending.assignment, value = Number(readFileSync(path.join(a.repository, "value.txt"), "utf8"));
    let result;
    if (a.role === "review") result = { complete: true,
      findings: value < 4 ? [{ key: "all-stages", path: "value.txt", severity: "medium", title: "Incomplete stages", evidence: "All four stages are required" }] : [],
      acceptance: [{ criterionId: "stages", status: value === 4 ? "satisfied" : "unsatisfied", evidence: `Source completes ${value} stages`, validationIds: ["unit"] }] };
    else if (a.role === "triage") {
      result = { decisions: a.findings.map(f => ({ id: f.id, status: value === 4 ? "fixed" : "actionable", evidence: `Stage ${value} is complete; ${4 - value} remain` })) };
      if (a.recoveryContext.signals.length && result.decisions.some(d => d.status === "actionable")) result.recovery = {
        diagnosis: a.recoveryContext.decisions.length ? "productive" : diagnosis, strategy: "complete-stages-sequentially",
        findingIds: result.decisions.filter(d => d.status === "actionable").map(d => d.id),
        evidence: `Source stage ${value} and current checks support the next stage`, nextAction: "Complete the next stage while retaining completed stages" };
    } else result = { edits: [{ path: "value.txt", content: String(run.round === 1 ? value : failValidation ? -2 : value + 1),
      reason: "Complete the next stage", findingIds: a.findings.map(f => f.id) }] };
    await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...result });
  }
  assert.fail("Recovered strategy did not reach a terminal outcome");
}
for (const diagnosis of ["local-repair", "wrong-design"]) test(`${diagnosis} can continue productively through multiple validated stages`, async t => {
  const run = await continueRecoveredStages(await fixture(t), diagnosis);
  assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome));
  assert.equal(run.round, 5);
  assert.deepEqual(run.recoveries.filter(r => r.strategy).map(r => r.diagnosis), [diagnosis, "productive", "productive", "productive"]);
  assert.equal(new Set(run.recoveries.filter(r => r.strategy).map(r => r.strategy)).size, 1);
});
test("a productive label cannot bypass failed validation of a recovered strategy", async t => {
  const run = await continueRecoveredStages(await fixture(t), "wrong-design", true);
  assert.equal(run.phase, "BLOCKED", JSON.stringify(run.outcome));
  assert.equal(run.round, 2);
  assert.match(run.outcome.reason, /successful validation of the current published source/);
});
test("an explicit three-round budget parks the same workload with all evidence retained", async t => {
  const run = await drive(await fixture(t, ["--max-rounds", "3"]));
  assert.equal(run.phase, "ROUND_LIMIT", JSON.stringify(run.outcome));
  assert.equal(run.round, 3); assert.equal(status(run).recovery.diagnosis, "budget");
  assert.equal(status(run).runId, status(run).recovery.runId, "Orchestration registers the same identity before and after recovery");
  assert.equal(readFileSync(path.join(run.root, "value.txt"), "utf8"), "3");
});
test("oscillation routes to a different design and resumes without publishing the failed proposal", async t => {
  const run = await drive(await fixture(t), { oscillate: true });
  assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome));
  assert.equal(run.round, 3);
  assert.ok(existsSync(path.join(run.directory, "patches", "round-2-stalled.json")));
  assert.ok(run.recoveries.some(r => r.route === "reimplement"));
});
for (const [name, options] of [["missing diagnosis", { omitDiagnosis: true }], ["repeated failed strategy", { repeatStrategy: true }]]) {
  test(`${name} cannot spin indefinitely after oscillation`, async t => {
    const run = await drive(await fixture(t), { oscillate: true, ...options });
    assert.equal(run.phase, "BLOCKED", JSON.stringify(run.outcome));
    assert.ok(run.round <= 3);
    assert.match(run.outcome.reason, options.omitDiagnosis ? /diagnosis/ : /strategy already failed/);
    assert.ok(existsSync(path.join(run.directory, "patches", "round-2-stalled.json")));
  });
}

function disputedReport(value) {
  return { complete: true, findings: [
    ...(value === 4 ? [] : [{ key: "stage-4", path: "value.txt", severity: "medium", title: "Stage incomplete", evidence: "All four stages are required" }]),
    { key: "noise", path: "value.txt", severity: "low", title: "Disputed claim", evidence: "Claim about a consumer contract" }],
  acceptance: [{ criterionId: "stages", status: value === 4 ? "satisfied" : "unsatisfied", evidence: "Inspected stage and receipt", validationIds: ["unit"] }] };
}
for (const scenario of ["reopen", "unavailable", "repeat-upheld", "repeat-rejected", "fixed-upheld"]) test(`dispute lifecycle: ${scenario}`, async t => {
  const available = scenario !== "unavailable", repeat = scenario.startsWith("repeat-"), fixedUpheld = scenario === "fixed-upheld";
  const directory = mkdtempSync(path.join(os.tmpdir(), "jig-judge-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const adapter = path.join(directory, "judge.mjs"), log = path.join(directory, "calls.jsonl");
  writeFileSync(adapter, `import { readFileSync, appendFileSync } from 'node:fs';
const chunks = []; for await (const c of process.stdin) chunks.push(c);
const a = JSON.parse(Buffer.concat(chunks));
appendFileSync(process.argv[2], JSON.stringify({role:a.role, provider:a.provider, hasReports:!!a.reports})+'\\n');
const report = ${disputedReport.toString()};
const value = Number(readFileSync(a.repository+'/value.txt','utf8'));
const result = a.role === 'adjudicate' ? {verdicts:a.findings.map(f=>({findingId:f.id,verdict:${JSON.stringify(scenario.endsWith("upheld") ? "upheld" : "rejected")},evidence:'Independent consumer probe establishes the claim verdict'}))} : report(value);
process.stdout.write(JSON.stringify({assignmentId:a.id,fingerprint:a.fingerprint,...result}));`);
  let run = await fixture(t, available ? ["--reviewers", "codex,claude"] : [], available ? {
    reviewers: [{ id: "codex" }, { id: "claude", command: [process.execPath, adapter, log] }],
  } : {});
  let reopened = false;
  for (let n = 0; n < 40; n++) {
    run = await runUntilBoundary(run.directory);
    if (TERMINAL.has(run.phase)) break;
    const a = run.pending.assignment;
    const value = Number(readFileSync(path.join(a.repository, "value.txt"), "utf8"));
    let result;
    if (a.role === "review") result = disputedReport(value);
    else if (a.role === "repair") result = { edits: [{ path: "value.txt", content: "4", reason: "Complete required stages", findingIds: a.findings.map(f => f.id) }] };
    else if (a.adjudications.length && fixedUpheld) {
      result = { decisions: a.findings.map(f => ({ id: f.id, status: "fixed",
        evidence: "Required validation already passes; claim fixed without changing source or claim evidence" })) };
    } else if (a.adjudications.length && repeat) {
      result = { decisions: a.findings.map(f => ({ id: f.id,
        status: f.key === "noise" ? scenario === "repeat-upheld" ? "actionable" : "rejected" : "fixed", evidence: "Same source, claim and validated stages" })),
      recovery: { diagnosis: "disputed-finding", findingIds: a.findings.filter(f => f.key === "noise").map(f => f.id),
        evidence: "Unchanged claim disputed again", nextAction: "Ask another judge" } };
    } else if (a.adjudications.length && !reopened) {
      reopened = true;
      result = { reopen: { findingId: a.findings.find(f => f.key === "noise").id, evidence: "A newly located production caller changes the contract assumption; inspect its boundary probe" } };
    } else {
      result = { decisions: a.findings.map(f => ({ id: f.id, status: f.key === "noise" ? "rejected" : value === 4 ? "fixed" : "actionable",
        evidence: f.key === "noise" ? "Consumer evidence disproves the reported claim" : "Source and required checks verify the stage" })) };
      if (a.recoveryContext.signals.some(s => s.kind === "rejection-disputed") && !a.adjudications.length) {
        result.recovery = { diagnosis: "disputed-finding", findingIds: a.findings.filter(f => f.key === "noise").map(f => f.id),
          evidence: "Independent review re-raised the rejected claim; compare its evidence", nextAction: "Adjudicate the contract using an independent provider" };
      }
    }
    await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...result });
  }
  assert.equal(run.phase, repeat || fixedUpheld ? "BLOCKED" : available ? "CONVERGED" : "RECOVERY_REQUIRED", JSON.stringify(run.outcome));
  assert.equal(run.round, 1);
  if (repeat || fixedUpheld) {
    assert.match(run.outcome.reason, fixedUpheld ? /Triage cannot override a current adjudication/ : /applicable adjudication is binding/);
    assert.equal(run.adjudications.length, 1);
    assert.equal(run.adjudications[0].verdict, fixedUpheld ? "upheld" : scenario.slice(7));
    assert.equal(currentAdjudication(run, Object.values(run.ledger).find(f => f.key === "noise")).verdict, run.adjudications[0].verdict);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").map(JSON.parse).filter(c => c.role === "adjudicate").length, 1);
    assert.equal(Object.values(run.ledger).flatMap(f => f.history).filter(h => h.event === "adjudication-reopened").length, 0);
  } else if (available) {
    assert.equal(run.adjudications.length, 2);
    assert.ok(run.adjudications.every(a => a.provider === "claude"));
    assert.notEqual(run.adjudications[0].anchor, run.adjudications[1].anchor);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse).filter(c => c.role === "adjudicate");
    assert.equal(calls.length, 2); assert.ok(calls.every(c => !c.hasReports));
  } else assert.match(run.outcome.reason, /other than the triage host/);
});

test("the provider bridge uses the adjudication schema without demanding a review report", async () => {
  const assignment = { id: "judge", role: "adjudicate", provider: "claude", fingerprint: "source", repository: "/repo",
    scope: { scope: "working-tree", excludePaths: [] }, contract: {}, findings: [{ id: "f" }] };
  assignment.resultSchema = resultSchema(assignment);
  const reply = { assignmentId: "judge", fingerprint: "source", verdicts: [{ findingId: "f", verdict: "upheld", evidence: "Reproduction" }] };
  assert.deepEqual(await reviewAssignment(assignment, { runner: async (options, dependencies) => {
    assert.match(dependencies.promptSuffix, /Adjudicate the supplied dispute only/);
    return dependencies.parseReport(JSON.stringify(reply));
  } }), reply);
});

test("adjudication inherits only its selected provider's credentials and profile", () => {
  const inherited = { ANTHROPIC_API_KEY: "synthetic-claude", CLAUDE_CONFIG_DIR: "/selected-claude", CODEX_API_KEY: "synthetic-codex", CODEX_HOME: "/selected-codex" };
  const judge = commandEnvironment({ role: "adjudicate", assignment: { provider: "claude" } }, inherited);
  assert.equal(judge.ANTHROPIC_API_KEY, inherited.ANTHROPIC_API_KEY);
  assert.equal(judge.CLAUDE_CONFIG_DIR, inherited.CLAUDE_CONFIG_DIR);
  assert.equal(judge.CODEX_API_KEY, undefined); assert.equal(judge.CODEX_HOME, undefined);
  const triage = commandEnvironment({ role: "triage" }, inherited);
  assert.equal(triage.ANTHROPIC_API_KEY, undefined);
});
