import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { skillReadEvidence } = await import(process.env.EVAL_TEST_LIBRARY || './run.mjs');
const root = process.env.EVAL_TEST_SOURCE || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = file => readFileSync(path.join(root, file), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');

test('read evidence has permutation-invariant, unique, disjoint set encoding', () => {
  const event = (command, output) => ({ type: 'item.completed', item: {
    type: 'command_execution', command, aggregated_output: output, exit_code: 0,
  } });
  const events = [event('cat .agents/skills/z/SKILL.md .agents/skills/a/SKILL.md', 'name: z\nname: a'),
    event('head -n3 .agents/skills/*/SKILL.md', 'name: y\nname: b\nname: z')];
  const expected = { reads: ['a', 'z'], uncertainReads: ['b', 'y'] };
  for (const names of [['z', 'y', 'b', 'a'], ['a', 'b', 'y', 'z'], ['y', 'a', 'z', 'b', 'z', 'b']]) {
    assert.deepEqual(skillReadEvidence(events, names, '/tmp/case'), expected);
    assert.deepEqual(skillReadEvidence([...events].reverse(), names, '/tmp/case'), expected);
  }
});

// Structural guards, not evidence of model behavior. Live cases test outcomes.
test('React entrypoint and detailed rules route to one neutral report contract', () => {
  const base = 'plugins/jig-typescript/skills/react-test-quality-review/';
  const entry = read(base + 'SKILL.md');
  const rules = read(base + 'references/test-quality-rules.md');
  for (const text of [entry, rules]) {
    assert.match(text, /\]\((?:references\/)?report-format\.md\)/);
    assert.doesNotMatch(text, /#### (?:Critical|\[Impact-supported severity\]):/);
    assert.doesNotMatch(text, /weak by default|Where accessible queries should replace/);
  }
  const format = read(base + 'references/report-format.md');
  assert.match(format, /#### \[Impact-supported severity\]:/);
  for (const field of ['Surviving regression:', 'Consequence and severity:', 'Counterevidence checked:']) {
    assert.ok(format.includes(field), field);
  }
  assert.match(format, /no findings/);
  assert.doesNotMatch(format, /#### (Critical|High|Medium|Low):/);
});

test('SQLx severity distinguishes minor defects from optional preferences', () => {
  const entry = read('plugins/jig-rust/skills/sqlx-query-safety-review/SKILL.md');
  for (const level of ['Critical', 'High', 'Medium', 'Low']) assert.ok(entry.includes(`**${level}**:`));
  assert.match(entry, /First establish a defect/);
  assert.match(entry, /Only then choose severity/);
  assert.match(entry, /Optional improvements:.*Do not report these as defects/);
});

test('Astra provenance sidecar identifies reports without claiming durable raw artifacts', () => {
  const provenance = JSON.parse(read('evals/results/2026-09-12-astra-provenance.json'));
  assert.equal(provenance.artifactPolicy.rawArtifactsCommitted, false);
  assert.equal(provenance.artifactPolicy.durability, 'machine-local-temporary');
  assert.equal(provenance.reports.length, 4);
  for (const entry of provenance.reports) {
    const bytes = read(`evals/results/${entry.file}`);
    const report = JSON.parse(bytes);
    assert.equal(entry.reportSha256, sha(bytes), entry.file);
    for (const key of ['sourceCommit', 'sourceRun', 'harnessHash', 'suiteHash']) {
      assert.equal(entry[key], report[key], `${entry.file} ${key}`);
    }
    assert.equal(entry.repositoryReverifiable, false);
    assert.match(entry.sourceRun, /^\/tmp\/jig-skill-evals-/);
  }
});
