import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions, traceMetrics } from './run.mjs';

test('explicit independent judge settings and legacy defaults', () => {
  const configured = parseOptions(['--model', 'gpt-6-astra', '--effort', 'medium', '--judge-model', 'fixed', '--judge-effort', 'high']);
  assert.equal(configured.model, 'gpt-6-astra');
  assert.equal(configured.judgeModel, 'fixed');
  assert.equal(configured.judgeEffort, 'high');
  const inherited = parseOptions(['--model', 'example', '--effort', 'low']);
  assert.equal(inherited.judgeModel, 'example');
  assert.equal(inherited.judgeEffort, 'low');
  assert.equal(parseOptions([]).model, undefined);
});

test('missing values and invalid efforts fail before launching any process', () => {
  for (const option of ['--case', '--model', '--effort', '--judge-model', '--judge-effort', '--output', '--repeat', '--timeout', '--grade-timeout']) {
    assert.throws(() => parseOptions([option]), /Missing value/);
    assert.throws(() => parseOptions([option, '--live']), /Missing value/);
  }
  for (const effort of ['none', 'max', 'ultra', 'typo']) {
    assert.throws(() => parseOptions(['--effort', effort]), /Invalid reasoning/);
  }
  for (const role of ['--model', '--judge-model']) {
    for (const effort of ['none', 'minimal']) {
      assert.throws(() => parseOptions([role, 'gpt-6-astra', role === '--model' ? '--effort' : '--judge-effort', effort]), /requires low/);
    }
  }
});

test('trace metrics accept one terminal usage record without inventing or summing usage', () => {
  const command = (command, exit_code, aggregated_output) => ({ type: 'item.completed',
    item: { type: 'command_execution', command, exit_code, aggregated_output } });
  const completed = { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } };
  const events = [command('cat .agents/skills/a/SKILL.md', 0, 'é'), command('cargo test', 0, 'ok'), command('cargo test', 0, 'ok'), completed];
  assert.deepEqual(traceMetrics(events), { usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 },
    completedCommands: 3, repeatedCommands: [{ command: 'cargo test', count: 2 }], skillResourceMentionCommands: 1, skillResourceMentionOutputBytes: 2 });
  assert.deepEqual(traceMetrics([...events, completed]).usage,
    { input_tokens: null, cached_input_tokens: null, output_tokens: null });
  assert.equal(traceMetrics([command('cat missing/SKILL.md', 1, 'missing')]).skillResourceMentionCommands, 0);
  const proxy = traceMetrics([command('rg --files -g SKILL.md; printf unrelated', 0, 'SKILL.md\nunrelated')]);
  assert.equal(proxy.skillResourceMentionCommands, 1);
  assert.equal(proxy.skillResourceMentionOutputBytes, Buffer.byteLength('SKILL.md\nunrelated'));
});
