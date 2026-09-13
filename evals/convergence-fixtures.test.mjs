import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
  return { c, write, run };
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
});
