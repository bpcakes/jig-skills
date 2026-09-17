import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readBrief, reviewGuidance } from '../skills/comprehensive-review/scripts/review-brief.mjs';
import { buildReviewPrompt } from '../skills/comprehensive-review/scripts/review-context.mjs';
import { parseArgs } from '../skills/comprehensive-review/scripts/review-options.mjs';
import { parseArgs as loopArgs } from '../skills/review-fix-loop/scripts/loop-options.mjs';
import { runClaudeReview } from '../skills/comprehensive-review/scripts/claude-review.mjs';
import { runCursorReview } from '../skills/comprehensive-review/scripts/cursor-review.mjs';

const brief = { goal: 'Expose cancellation', requirements: [{ id: 'R1', text: 'Queued jobs can be cancelled.', source: 'User request' }], constraints: ['Retain running-job behavior'], nonGoals: [], unknowns: ['Persistence requirements unavailable'] };
test('native and external reviewers receive exactly the same pinned task context', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jig-brief-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'brief.json');
  writeFileSync(file, JSON.stringify(brief));
  const pinned = readBrief(file);
  assert.deepEqual(readBrief(file, pinned.hash), pinned);
  const prompt = buildReviewPrompt({ label: 'working tree' }, { text: 'diff' }, { taskBrief: pinned });
  assert.ok(prompt.includes(reviewGuidance(pinned)));
  assert.ok(prompt.includes(JSON.stringify(brief)));
  writeFileSync(file, JSON.stringify({ ...brief, goal: 'Different task' }));
  assert.throws(() => readBrief(file, pinned.hash), /TASK_BRIEF_CHANGED/);
  writeFileSync(file, JSON.stringify({ ...brief, requirements: [...brief.requirements, ...brief.requirements] }));
  assert.throws(() => readBrief(file), /Invalid task brief/);
});

test('Beads flag is opt-in, duplicate-safe, and cannot be silently lost by the controller', () => {
  assert.equal(parseArgs([]).logToBeads, undefined);
  assert.equal(parseArgs(['--log-to-beads']).logToBeads, true);
  assert.throws(() => parseArgs(['--log-to-beads', '--log-to-beads']), /Duplicate/);
  assert.throws(() => loopArgs(['--log-to-beads']), /comprehensive-review parent/);
});

for (const run of [runClaudeReview, runCursorReview]) {
  test(`${run.name} refuses an unpinned brief before launching a provider`, async () => {
    await assert.rejects(run({ expectedFingerprint: 'a'.repeat(64), taskBrief: '/missing/brief.json' }), /must be supplied together/);
    await assert.rejects(run({ expectedFingerprint: 'a'.repeat(64), taskBriefHash: 'b'.repeat(64) }), /must be supplied together/);
  });
}
