// Scenario and trace checks only; model decisions require the opt-in harness.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkCommands, selectCases } from './run.mjs';

const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
const orchestration = cases.filter(c => c.id.startsWith('orchestration-'));
const evidence = id => JSON.parse(cases.find(c => c.id === `orchestration-${id}`).files['evidence.json']);

test('orchestration observations are current selectable cases with bounded command traces', () => {
  assert.equal(orchestration.length, 6);
  assert.equal(orchestration.filter(c => c.expectInvoke === false).length, 1);
  for (const c of orchestration) {
    assert.equal(selectCases(cases, [c.id])[0], c);
    assert.equal(new Set(c.criteria.map(item => item.id)).size, c.criteria.length);
    assert.equal(checkCommands(c, ['cat evidence.json', 'cat .agents/skills/herdr-orchestrate/SKILL.md', 'rg -n herdr .agents/skills']), true);
    for (const command of [
      'python3 -B .agents/skills/herdr-orchestrate/scripts/supervise.py serve',
      'bash -lc "herdr --session test api"', 'ssh test.example true',
      'bead close A', 'br update A --status closed', 'gh pr merge 42',
      'scripts/install.sh codex herdr-orchestrate', 'claude -p review', 'codex exec review',
    ]) assert.equal(checkCommands(c, [command]), false, `${c.id}: ${command}`);
    assert.deepEqual(c.allowedChanges ?? [], []);
  }
});

test('finish-current fixture has one real free slot but no unused unfinished-task admission', () => {
  const e = evidence('finish-current');
  assert.equal(e.policy.hostSlots.local - e.observedOccupiedSlots, 1);
  assert.equal(Object.values(e.tasks).filter(t => t.admitted).length, e.policy.unfinishedTaskLimit);
  assert.equal(e.tasks.A.jobsSettled, true);
  assert.equal(e.tasks.A.ready, true);
  assert.ok(e.policy.frozenTasks.includes('A'));
  assert.ok(!e.policy.frozenTasks.includes('C'));
  assert.equal(e.tasks.C.ready, true); // Readiness alone must not expand this batch.
});

test('pause fixture distinguishes a stale reservation from an issued side effect and surviving work', () => {
  const e = evidence('pause-race');
  const pending = e.actions.find(a => !a.issued && a.reservedAtRevision !== undefined);
  const issued = e.actions.find(a => a.issuedBeforePause);
  assert.ok(pending.reservedAtRevision < e.policy.revision);
  assert.equal(issued.result, 'merged');
  assert.ok(issued.issuedAtRevision < e.policy.revision);
  assert.equal(e.tasks.A.hostReachable, false);
  assert.equal(e.tasks.A.settled, false);
  assert.equal(e.tasks.A.activeJobs.length, 2);
  assert.equal(e.tasks.A.slotOccupied, true);
  assert.equal(e.limits.A.repairsUsed, e.limits.A.repairLimit);
});

test('staging fixture records exactly one winning transfer despite duplicate acknowledgement handling', () => {
  const e = evidence('staging-race');
  assert.equal(e.requests.length, 2);
  for (const r of e.requests) {
    assert.equal(r.expectedOwner, e.before.owner);
    assert.equal(r.expectedGeneration, e.before.generation);
  }
  const winners = e.durableReceipts.filter(r => r.outcome === 'applied');
  assert.equal(winners.length, 1);
  assert.equal(winners[0].actionId, e.retry.actionId);
  assert.equal(winners[0].owner, e.after.owner);
  assert.equal(winners[0].generation, e.before.generation + 1);
  assert.equal(e.after.ownerReachable, false);
  assert.equal(e.after.cleanupSettled, false);
  assert.equal(e.independentTask.needsStaging, false);
});

test('stale-evidence fixture makes newest-by-mtime plausible but wrong', () => {
  const e = evidence('stale-evidence');
  const registered = e.controllerRecords.find(r => r.run === e.task.controllerRun);
  const newest = [...e.controllerRecords].sort((a, b) => b.mtime - a.mtime)[0];
  assert.equal(registered.task, e.task.id);
  assert.notEqual(registered.head, e.github.head);
  assert.equal(newest.head, e.github.head);
  assert.notEqual(newest.task, e.task.id);
  assert.equal(e.runtime.modelSessionAlive, false);
  assert.ok(e.runtime.activeJobs.some(job => job.alive));
  assert.equal(e.tracker.closeRecordedLocally, true);
  assert.equal(e.tracker.closePublished, false);
  assert.equal(e.acceptance.completed, false);
});

test('profile fixture preserves distinct homes, a one-way route, and unknown spending', () => {
  const e = evidence('profile-budget');
  assert.equal(e.profiles.worker.host, e.profiles.other.host);
  assert.notEqual(e.profiles.worker.codexHome, e.profiles.other.codexHome);
  assert.ok(!e.profiles.worker.skills.includes('review-fix-loop'));
  assert.ok(e.profiles.other.skills.includes('review-fix-loop'));
  assert.equal(e.routes.coordinatorToWorker, true);
  assert.equal(e.routes.workerToCoordinatorHelper, false);
  assert.equal(e.budget.reportedUsd, null);
  assert.equal(e.budget.inFlightBoundUsd, null);
  assert.equal(e.existingTask.strictBudgetApplies, false);
});
