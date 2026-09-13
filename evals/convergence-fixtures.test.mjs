import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isolatedGit } from './run.mjs';

const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
function fixture(t, id) {
  const c = cases.find(c => c.id === id);
  const cwd = mkdtempSync(path.join(tmpdir(), 'jig-convergence-fixture-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const write = files => {
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(cwd, name), content);
  };
  const run = (...args) => {
    const env = { ...process.env };
    // Run an independent test runner, not a child of this test worker.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, args[0] === '--test' ? ['--test-reporter=tap', ...args] : args, { cwd, env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    return result;
  };
  write({ ...c.files, ...c.baseFiles });
  return { c, cwd, write, run };
}

test('mechanical fixture introduces both failures during repair and retains a discriminating oracle', t => {
  const { c, write, run } = fixture(t, 'loop-mechanical-stabilization');
  assert.equal(run('--test', 'classify.test.mjs').status, 0);
  assert.equal(run('check-format.mjs').status, 0);
  write(c.files);
  assert.notEqual(run('--test', 'classify.test.mjs').status, 0);
  assert.notEqual(run('check-format.mjs').status, 0);
  const imported = c.files['classify.test.mjs'].replace('{ strictAssert }', 'strictAssert');
  write({ 'classify.test.mjs': imported });
  assert.equal(run('--test', 'classify.test.mjs').status, 0);
  assert.notEqual(run('check-format.mjs').status, 0);
  write({ 'classify.test.mjs': imported.replaceAll('\t', '  ') });
  assert.equal(run('check-format.mjs').status, 0);
  assert.equal(run('--test', 'classify.test.mjs').status, 0);
  write({ 'classify.mjs': c.baseFiles['classify.mjs'] });
  assert.notEqual(run('--test', 'classify.test.mjs').status, 0);
});

test('closure fixture has a nonempty reviewed implementation change and a newly exposed defect', t => {
  const { c, write, run } = fixture(t, 'loop-closure-exposes-substantive');
  assert.notEqual(c.baseFiles['epics.mjs'], c.files['epics.mjs']);
  // The partial ordinary repair passes the earlier ambiguous regression.
  write({ 'epics.mjs': c.files['epics.mjs'] });
  assert.equal(run('--test', 'epics.test.mjs').status, 0);
  // The added closure regression independently exposes the missing own-title path.
  write(c.files);
  const failed = run('--test', 'epics.test.mjs');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, /not ok .*own title matches/);
  write({ 'epics.mjs': "export function epics(items, query) { return items.filter(e => e.title.includes(query) || e.children.some(c => c.title.includes(query))); }\n" });
  assert.equal(run('--test', 'epics.test.mjs').status, 0);
  // Each disjunct must work independently; neither alone may pass the suite.
  for (const mutant of [
    "items.filter(e => e.title.includes(query))",
    "items.filter(e => e.children.some(c => c.title.includes(query)))",
    'items',
  ]) {
    write({ 'epics.mjs': `export function epics(items, query) { return ${mutant}; }\n` });
    assert.notEqual(run('--test', 'epics.test.mjs').status, 0, mutant);
  }
  // A structurally different correct implementation must also pass.
  write({ 'epics.mjs': "export function epics(items, query) { return items.filter(e => [e, ...e.children].some(item => item.title.includes(query))); }\n" });
  assert.equal(run('--test', 'epics.test.mjs').status, 0);
});

test('validation recovery oracle rejects both earlier regressions and preserves the full interval', t => {
  const { c, write, run } = fixture(t, 'loop-validation-counted-recovery');
  const original = run('--test', 'ages.test.mjs');
  assert.notEqual(original.status, 0);
  assert.match(original.stdout, /age 17/);
  write(c.files);
  const failed = run('--test', 'ages.test.mjs');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, /age 66/);
  write({ 'ages.mjs': 'export const accepts = age => age >= 18 && age <= 65;\n' });
  assert.equal(run('--test', 'ages.test.mjs').status, 0);
  for (const mutant of ['age >= 17 && age <= 65', 'age >= 18 && age < 65']) {
    write({ 'ages.mjs': `export const accepts = age => ${mutant};\n` });
    assert.notEqual(run('--test', 'ages.test.mjs').status, 0);
  }
});

test('wrong closure expectation can be corrected without blessing a zero-boundary defect', t => {
  const { c, write, run } = fixture(t, 'loop-closure-wrong-expectation');
  assert.equal(run('--test', 'classify.test.mjs').status, 0);
  write({ 'classify.mjs': c.files['classify.mjs'] });
  assert.equal(run('--test', 'classify.test.mjs').status, 0);
  write(c.files);
  assert.notEqual(run('--test', 'classify.test.mjs').status, 0);
  write({ 'classify.test.mjs': c.files['classify.test.mjs'].replace('classify(0), true', 'classify(0), false') });
  assert.equal(run('--test', 'classify.test.mjs').status, 0);
  write({ 'classify.mjs': 'export const classify = value => value >= 0;\n' });
  assert.notEqual(run('--test', 'classify.test.mjs').status, 0);
});

for (const [id, changedPaths] of [
  ['loop-validation-counted-recovery', ['ages.mjs']],
  ['loop-validation-recovery-at-cap', ['ages.mjs']],
  ['loop-validation-recovery-oscillation', ['keys.test.mjs']],
  ['loop-closure-wrong-expectation', ['classify.mjs', 'classify.test.mjs']],
  ['loop-reviewer-recovery-decisions', ['classify.mjs']],
  ['loop-closure-mixed-failures-unused', ['epics.mjs', 'epics.test.mjs', 'smoke.test.mjs']],
  ['loop-closure-mixed-failures-exhausted', ['epics.mjs', 'epics.test.mjs', 'smoke.test.mjs']],
  ['loop-closure-mixed-failures-at-cap', ['epics.mjs', 'epics.test.mjs', 'smoke.test.mjs']],
]) {
  test(`${id} exposes the retained code or regression in Git without changing its contract`, t => {
    const { c, cwd, write } = fixture(t, id);
    const git = (...args) => isolatedGit(cwd, args).toString('utf8');
    git('init', '-q', '--template=');
    git('add', '.');
    git('commit', '-qm', 'Fixture');
    const head = git('rev-parse', 'HEAD');
    const index = git('ls-files', '--stage');
    write(c.files);
    assert.deepEqual(git('diff', '--name-only', 'HEAD').trim().split('\n'), changedPaths);
    for (const name of ['README.md', 'CONTRACT.md'].filter(name => name in c.files)) {
      assert.equal(git('show', `HEAD:${name}`), c.files[name]);
    }
    assert.equal(git('rev-parse', 'HEAD'), head);
    assert.equal(git('ls-files', '--stage'), index);
  });
}

test('oscillation retains a failing regression even when source repairs were undone', t => {
  const { c, write, run } = fixture(t, 'loop-validation-recovery-oscillation');
  assert.equal(run('--test', 'keys.test.mjs').status, 0);
  write(c.files);
  assert.notEqual(run('--test', 'keys.test.mjs').status, 0);
  // Deliberately make no claim about the unavailable signature consumer.
});

test('retained reviewer finding is introduced by the working-tree source change', t => {
  const { c, write, run } = fixture(t, 'loop-reviewer-recovery-decisions');
  const check = "import assert from 'node:assert/strict'; import { classify } from './classify.mjs'; assert.equal(classify(0), false);";
  assert.equal(run('--input-type=module', '-e', check).status, 0);
  write(c.files);
  assert.notEqual(run('--input-type=module', '-e', check).status, 0);
});

for (const allowance of ['unused', 'exhausted', 'at-cap']) {
  test(`mixed closure fixture (${allowance}) requires both supporting and substantive corrections`, t => {
    const { c, write, run } = fixture(t, `loop-closure-mixed-failures-${allowance}`);
    write({ 'epics.mjs': c.files['epics.mjs'] });
    assert.equal(run('--test', 'epics.test.mjs', 'smoke.test.mjs').status, 0);
    write(c.files);
    assert.notEqual(run('--test', 'smoke.test.mjs').status, 0);
    const failed = run('--test', 'epics.test.mjs');
    assert.notEqual(failed.status, 0);
    assert.match(failed.stdout, /not ok .*own title matches/);
    write({ 'smoke.test.mjs': c.files['smoke.test.mjs'].replace('{ strictAssert }', 'strictAssert') });
    assert.equal(run('--test', 'smoke.test.mjs').status, 0);
    assert.notEqual(run('--test', 'epics.test.mjs').status, 0);
    write({ 'epics.mjs': "export function epics(items, query) { return items.filter(e => e.title.includes(query) || e.children.some(c => c.title.includes(query))); }\n" });
    assert.equal(run('--test', 'epics.test.mjs', 'smoke.test.mjs').status, 0);
    // These mutations prove fixture causality, not permission to edit in exhausted/capped cases.
  });
}
