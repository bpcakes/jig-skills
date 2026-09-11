import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectOutput, copySkill, freezeSchemas, skillSnapshot, snapshot } from './run.mjs';

test('UTF-8 survives every split boundary in both captured streams', () => {
  const text = 'trace: “Prague” — Příliš žluťoučký 🦀\n';
  const bytes = Buffer.from(text);
  for (let split = 0; split <= bytes.length; split++) {
    const stream = new PassThrough();
    const captured = collectOutput(stream, 1024, () => assert.fail('unexpected output limit'));
    stream.write(bytes.subarray(0, split));
    stream.end(bytes.subarray(split));
    assert.equal(captured(), text, `split at byte ${split}`);
  }
});

test('output limit counts UTF-8 bytes and signals once while discarding later chunks', () => {
  const stream = new PassThrough(); let limits = 0;
  const captured = collectOutput(stream, 3, () => { limits++; });
  stream.write('€'); assert.equal(limits, 0);
  stream.write('x'); assert.equal(limits, 1);
  stream.end('discarded'); assert.equal(limits, 1);
  assert.equal(captured(), '€x');
});

test('bundle filtering retains authored untracked content without hiding task cache writes', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jig-eval-bundle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'), destination = path.join(dir, 'bundle');
  mkdirSync(path.join(source, 'references'), { recursive: true });
  writeFileSync(path.join(source, 'SKILL.md'), '---\nname: example\n---');
  writeFileSync(path.join(source, 'references/untracked.md'), 'New instructions not committed yet.');
  const clean = skillSnapshot(source), before = snapshot(source);
  mkdirSync(path.join(source, 'tests/__pycache__'), { recursive: true });
  writeFileSync(path.join(source, 'tests/__pycache__/test.pyc'), 'compiled cache');
  writeFileSync(path.join(source, '.DS_Store'), 'desktop metadata');
  assert.deepEqual(skillSnapshot(source), clean);
  assert.notDeepEqual(snapshot(source), before);
  copySkill(source, destination);
  assert.equal(existsSync(path.join(destination, 'tests/__pycache__')), false);
  assert.equal(existsSync(path.join(destination, '.DS_Store')), false);
  assert.equal(readFileSync(path.join(destination, 'references/untracked.md'), 'utf8'), 'New instructions not committed yet.');
  assert.deepEqual(skillSnapshot(destination), clean);
});

test('frozen schemas keep their original bytes after the live source changes', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jig-eval-schemas-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'); mkdirSync(source);
  for (const name of ['response.schema.json', 'grade.schema.json']) writeFileSync(path.join(source, name), '{"type":"object"}');
  const frozen = path.join(dir, 'frozen');
  const hashes = freezeSchemas(source, frozen);
  writeFileSync(path.join(source, 'response.schema.json'), '{}');
  assert.equal(readFileSync(path.join(frozen, 'response.schema.json'), 'utf8'), '{"type":"object"}');
  assert.deepEqual(Object.keys(hashes).sort(), ['grade.schema.json', 'response.schema.json']);
  assert.throws(() => freezeSchemas(source, frozen), /EEXIST/);
});
