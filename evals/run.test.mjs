import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { changedPaths, checkGrade, checkScope, disabledSkillPaths, observedSkillReads, skillReadEvidence, checkInvocation, parseTrace, snapshot } from './run.mjs';

test('incomplete and failed traces cannot pass as successful evaluations', () => {
  for (const raw of ['', '{broken', '{"type":"turn.started"}', '{"type":"turn.completed"}\n{"type":"error"}']) {
    assert.throws(() => parseTrace(raw));
  }
  assert.equal(parseTrace('{"type":"turn.completed"}').length, 1);
});

test('skill invocation needs a completed successful read with actual instructions', () => {
  const item = { type: 'command_execution', command: 'cat .agents/skills/example/SKILL.md', exit_code: 0, aggregated_output: '---\nname: example\n---' };
  const event = { type: 'item.completed', item };
  const workspace = path.resolve('/tmp/fixture');
  const reads = events => observedSkillReads(events, ['example'], workspace);
  assert.deepEqual(reads([event]), ['example']);
  assert.deepEqual(reads([{ ...event, item: { ...item, command: `cat '${workspace}/.agents/skills/example/SKILL.md'` } }]), ['example']);
  for (const changed of [
    { type: 'item.started', item },
    { ...event, item: { ...item, exit_code: 1 } },
    { ...event, item: { ...item, aggregated_output: 'No such file' } },
    { ...event, item: { ...item, command: 'cat /personal/.agents/skills/example/SKILL.md' } },
    { ...event, item: { ...item, command: 'cat ../other/.agents/skills/example/SKILL.md' } },
    { ...event, item: { ...item, command: 'cd /personal && cat .agents/skills/example/SKILL.md' } },
    { ...event, item: { type: 'agent_message', text: 'I read example/SKILL.md' } },
  ]) assert.deepEqual(reads([changed]), []);
});

test('personal skill disable list includes symlink aliases and resolved targets without following cycles', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jig-eval-skills-'));
  try {
    const base = path.join(dir, 'personal');
    const target = path.join(dir, 'external', 'example');
    mkdirSync(base); mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'SKILL.md'), '---\nname: example\n---');
    symlinkSync(target, path.join(base, 'example'), 'dir');
    symlinkSync(base, path.join(base, 'cycle'), 'dir');
    symlinkSync(path.join(dir, 'missing'), path.join(base, 'broken'), 'dir');
    const paths = disabledSkillPaths([base]);
    assert.deepEqual(new Set(paths), new Set([
      path.join(base, 'example/SKILL.md'), realpathSync(path.join(target, 'SKILL.md')),
    ]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('quoted and escaped skill paths with spaces preserve invocation evidence', () => {
  const workspace = '/tmp/eval space/case';
  const file = `${workspace}/.agents/skills/example/SKILL.md`;
  for (const command of [`cat "${file}"`, `cat '${file}'`, `cat ${file.replaceAll(' ', '\\ ')}`,
    `bash -lc 'cat "${file}"'`]) {
    const events = [{ type: 'item.completed', item: { type: 'command_execution', command, exit_code: 0,
      aggregated_output: '---\nname: example\n---' } }];
    assert.deepEqual(observedSkillReads(events, ['example'], workspace), ['example'], command);
  }
});

test('numbered read output preserves exact skill attribution without matching other names', () => {
  for (const prefix of ['     2\t', '2:']) {
    const item = { type: 'command_execution', command: 'nl -ba .agents/skills/example/SKILL.md', exit_code: 0,
      aggregated_output: `     1\t---\n${prefix}name: example\n     3\t---` };
    const evidence = skillReadEvidence([{ type: 'item.completed', item }], ['example', 'example-other'], '/tmp/case');
    assert.deepEqual(evidence, { reads: ['example'], uncertainReads: [] });
    assert.deepEqual(observedSkillReads([{ type: 'item.completed', item: { ...item, exit_code: 1 } }], ['example'], '/tmp/case'), []);
    assert.deepEqual(observedSkillReads([{ type: 'item.completed', item: { ...item,
      aggregated_output: `${prefix}name: example-other` } }], ['example'], '/tmp/case'), []);
  }
});

test('ambiguous skill reads are inconclusive, never a negative-discovery pass', () => {
  const c = { mode: 'negative', skill: 'example', expectInvoke: false };
  for (const command of ['cat .agents/skills/ex*/SKILL.md', 'cd .agents/skills/example && cat SKILL.md',
    'cat /personal/.agents/skills/example/SKILL.md']) {
    const events = [{ type: 'item.completed', item: { type: 'command_execution', command, exit_code: 0,
      aggregated_output: '---\nname: example\n---' } }];
    const evidence = skillReadEvidence(events, ['example'], '/tmp/case');
    assert.deepEqual(evidence.reads, []);
    assert.deepEqual(evidence.uncertainReads, ['example']);
    assert.equal(checkInvocation(c, evidence), null);
  }
  assert.equal(checkInvocation(c, { reads: [], uncertainReads: [] }), true);
  assert.equal(checkInvocation(c, { reads: ['example'], uncertainReads: [] }), false);
});

test('scope checks all writes, including reverted paths and both ends of moves', () => {
  const workspace = path.resolve('/tmp/fixture');
  const base = { workspace, beforeGit: { head: 'a', index: 'b' }, afterGit: { head: 'a', index: 'b' },
    changed: ['src/lib.rs'], writes: [], allowedChanges: ['src/lib.rs'], requiredChanges: ['src/lib.rs'] };
  assert.ok(checkScope(base)); // Net snapshots still cover shell-based edits.
  for (const p of ['src/lib.rs', './src/lib.rs', `${workspace}/src/lib.rs`]) {
    assert.ok(checkScope({ ...base, writes: [{ path: p, kind: 'update' }] }));
  }
  for (const writes of [
    [{ path: 'src/unrelated.rs', kind: 'update' }, { path: 'src/unrelated.rs', kind: 'update' }],
    [{ path: '../outside.rs', kind: 'update' }],
    [{ path: 'src/lib.rs', kind: 'delete' }, { path: 'src/other.rs', kind: 'add' }],
    [{ path: 'src/lib.rs', kind: { update: {} }, move_path: 'src/other.rs' }],
    [{ path: 'src/lib.rs', kind: { move_path: 'src/other.rs' } }],
    [{ kind: 'update' }],
  ]) assert.equal(checkScope({ ...base, writes }), false, JSON.stringify(writes));
  assert.equal(checkScope({ ...base, changed: [], requiredChanges: [] }), true);
  assert.equal(checkScope({ ...base, changed: [] }), false);
  assert.equal(checkScope({ ...base, afterGit: { head: 'new', index: 'b' } }), false);
  assert.equal(checkScope({ ...base, afterGit: { head: 'a', index: 'new' } }), false);
  assert.equal(checkScope({ ...base, allowedChanges: [], requiredChanges: [], changed: [], writes: [{ path: 'src/lib.rs' }] }), false);
});

test('grader omission, duplicate IDs, empty evidence, and failed criteria fail closed', () => {
  const criteria = [{ id: 'correctness' }, { id: 'scope' }];
  const checks = criteria.map(c => ({ ...c, passed: true, evidence: 'Observed result' }));
  assert.ok(checkGrade(criteria, { checks }));
  for (const invalid of [[], checks.slice(0, 1), [checks[0], checks[0]], [...checks, checks[0]],
    [checks[0], { ...checks[1], passed: false }], [checks[0], { ...checks[1], evidence: '' }]]) {
    assert.ok(!checkGrade(criteria, { checks: invalid }));
  }
});

test('snapshot detects source changes, added artifacts, deletion, and permission-only mutation', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jig-eval-test-'));
  try {
    writeFileSync(path.join(dir, 'a'), 'original');
    writeFileSync(path.join(dir, 'b'), 'keep');
    writeFileSync(path.join(dir, 'c'), 'remove');
    const before = snapshot(dir);
    writeFileSync(path.join(dir, 'a'), 'modified');
    chmodSync(path.join(dir, 'b'), 0o700);
    rmSync(path.join(dir, 'c'));
    writeFileSync(path.join(dir, 'extra-report.md'), 'unsolicited');
    assert.deepEqual(changedPaths(before, snapshot(dir)), ['a', 'b', 'c', 'extra-report.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
