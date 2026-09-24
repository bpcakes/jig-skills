// Fixture oracles validate the scenarios, not whether a model diagnoses them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
function fixture(t, id) {
  const c = cases.find(item => item.id === id);
  assert.ok(c);
  const cwd = mkdtempSync(path.join(tmpdir(), 'jig-review-oracle-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(c.files)) writeFileSync(path.join(cwd, name), content);
  return { cwd, c, run: code => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    return result.status;
  } };
}
for (const [family, bad, good, oracle] of [
  ['intent', 'omitted', 'complete', "import assert from 'node:assert/strict'; import {parseLimit} from './limits.mjs'; assert.equal(parseLimit(undefined),20); for (const n of [1,100]) assert.equal(parseLimit(String(n)),n); for (const text of ['0','101','1.5','-1','abc','']) assert.throws(() => parseLimit(text),RangeError);"],
  ['layer', 'symptom', 'owner', "import assert from 'node:assert/strict'; import {checkoutTotal} from './checkout.mjs'; import {invoiceTotal} from './invoice.mjs'; for (const total of [checkoutTotal,invoiceTotal]) { assert.equal(total([{price:5,quantity:-2},{price:3,quantity:2}]),6); assert.equal(total([{price:4,quantity:0.5}]),2); }"],
  ['caller', 'misuse', 'valid', "import assert from 'node:assert/strict'; import {checkoutDollars} from './checkout.mjs'; import {invoiceCents} from './invoice.mjs'; const lines=[{priceCents:125,quantity:2}]; assert.equal(checkoutDollars(lines),2.5); assert.equal(invoiceCents(lines),250);"],
]) {
  test(`review ${family} pair discriminates the defect from a correct implementation`, t => {
    assert.notEqual(fixture(t, `review-${family}-${bad}`).run(oracle), 0);
    assert.equal(fixture(t, `review-${family}-${good}`).run(oracle), 0);
  });
}
for (const kind of ['equivalent', 'weakened']) {
  test(`review ${kind} coverage fixture measures surviving behavior mutations`, t => {
    const f = fixture(t, `review-coverage-${kind}`);
    assert.equal(f.run("await import('./ages.test.mjs')"), 0);
    for (const mutant of ['age >= 17 && age <= 65', 'age >= 18 && age < 65', 'true']) {
      writeFileSync(path.join(f.cwd, 'ages.mjs'), `export const accepts = age => ${mutant};\n`);
      assert.equal(f.run("await import('./ages.test.mjs')") === 0, kind === 'weakened');
    }
    writeFileSync(path.join(f.cwd, 'ages.mjs'), 'export const accepts = age => !(age < 18 || age > 65);\n');
    assert.equal(f.run("await import('./ages.test.mjs')"), 0);
  });
}

for (const kind of ['mock-assumption', 'compatible']) test(`real dependency ${kind} separates a passing mock from the consumer contract`, t => {
  const f = fixture(t, `review-real-dependency-${kind}`);
  assert.equal(f.run("await import('./create.test.mjs')"), 0, 'Both mocks pass');
  const probe = "import assert from 'node:assert/strict'; import {store} from './store.mjs'; import {createItem} from './create.mjs'; import {exportItem} from './export.mjs'; assert.equal(exportItem(await createItem(store,'MixedCase')).externalKey,'MixedCase');";
  assert.equal(f.run(probe) === 0, kind === 'compatible');
  if (kind === 'compatible') assert.equal(f.run("await import('./integration.test.mjs')"), 0);
});
