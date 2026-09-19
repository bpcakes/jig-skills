import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkScope, isolatedGit, prepareReviewHandoff, snapshot } from './run.mjs';
import { readHandoff, verifyHandoffScope } from '../plugins/jig-review/skills/comprehensive-review/scripts/review-handoff.mjs';

test('follow-up fixture grants only owned scratch/state paths and pins the real checkout', async t => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'jig-eval-handoff-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const c = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url))).find(c => c.id === 'review-followup-address');
  isolatedGit(workspace, ['init', '-q', '--template=']);
  for (const [name, bytes] of Object.entries(c.files)) writeFileSync(path.join(workspace, name), bytes);
  isolatedGit(workspace, ['add', '.']); isolatedGit(workspace, ['commit', '-qm', 'Fixture']);
  const before = snapshot(workspace), index = readFileSync(path.join(workspace, '.git/index'));
  const fixture = await prepareReviewHandoff(workspace, c.reviewHandoff);
  t.after(() => rmSync(fixture.scratch, { recursive: true, force: true }));
  assert.deepEqual(fixture.writablePaths, [fixture.scratch, path.join(workspace, '.git/jig')]);
  assert.ok(!fixture.scratch.startsWith(workspace + path.sep));
  await verifyHandoffScope(readHandoff(fixture.handoff), workspace);
  assert.deepEqual(snapshot(workspace), before);
  assert.deepEqual(readFileSync(path.join(workspace, '.git/index')), index);
});

test('scratch permissions cover assignment-copy edits without relaxing source or index checks', () => {
  const base = { workspace: '/task', beforeGit: { index: 'unchanged' }, afterGit: { index: 'unchanged' },
    changed: ['value.cjs'], writes: [{ path: '/scratch/overlays/repair/value.cjs' }],
    allowedChanges: ['value.cjs'], requiredChanges: ['value.cjs'], scratchRoots: ['/scratch', '/task/.git/jig'] };
  assert.equal(checkScope(base), true);
  assert.equal(checkScope({ ...base, writes: [{ path: '/scratch/../elsewhere/value.cjs' }] }), false);
  assert.equal(checkScope({ ...base, writes: [{ path: '/scratchy/value.cjs' }] }), false);
  assert.equal(checkScope({ ...base, changed: ['notes.txt'] }), false);
  assert.equal(checkScope({ ...base, afterGit: { index: 'changed' } }), false);
  assert.equal(checkScope({ ...base, writes: [{ path: '/scratch/value.cjs', move_path: '/task/notes.txt' }] }), false);
});
