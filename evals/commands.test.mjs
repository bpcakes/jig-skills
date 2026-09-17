import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkCommands, launchesWorkflow, selectCases } from './run.mjs';

test('live case selection excludes the retired runtime and refuses explicit historical runs', () => {
  const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
  const selected = selectCases(cases);
  const historical = cases.filter(c => c.runtime === 'markdown-loop-v1');
  assert.equal(historical.length, 21);
  assert.equal(selected.length + historical.length, cases.length);
  assert.ok(selected.some(c => c.id === 'loop-loaded-one-pass-fix'));
  for (const c of historical) {
    assert.equal(selected.some(s => s.id === c.id), false);
    assert.throws(() => selectCases(cases, [c.id]), /Historical case.*original evaluator/);
  }
  assert.throws(() => selectCases(cases, ['missing-case']), /Unknown case/);
});

test('workflow detection follows executable positions and shell wrappers', () => {
  for (const command of ['claude -p review', 'pwd && /usr/bin/claude -p review',
    'env TEST=1 command claude', 'exec cursor-agent --mode ask',
    'bash -lc "node .agents/skills/review-fix-loop/scripts/loop-options.mjs"',
    'echo ok; codex review', '(claude)', 'pwd | cursor-agent']) {
    assert.equal(launchesWorkflow(command), true, command);
  }
  for (const command of ['rg -n claude instructions.md', 'grep -n "codex exec" instructions.md',
    'echo claude', 'cat scripts/claude-review.mjs', 'codex --version',
    'node checks.mjs claude-review', 'bash -lc \'rg -n "claude|cursor-agent" instructions.md\'']) {
    assert.equal(launchesWorkflow(command), false, command);
  }
});

test('Codex global option operands and exec alias do not hide launches', () => {
  for (const command of ['codex --model gpt-5 exec review', 'codex -C /tmp/task review',
    'codex --config model="gpt-5" --sandbox read-only e review',
    'codex --model=gpt-5 exec review', 'codex -mgpt-5 -C/tmp/task review',
    'bash -lc \'codex --enable feature --disable other --profile audit exec review\'']) {
    assert.equal(launchesWorkflow(command), true, command);
  }
  for (const command of ['codex --model review --version', 'codex --help exec',
    'codex --config label=exec completion bash', 'rg "codex --model gpt-5 exec" README.md']) {
    assert.equal(launchesWorkflow(command), false, command);
  }
});

test('availability and information checks do not launch reviewers', () => {
  for (const command of ['command -v claude cursor-agent', 'command -V codex', 'command -pv claude',
    'env TEST=1 command -p -v claude', 'bash -lc "command -v claude"',
    'claude --version', 'claude --help', 'claude -h', 'cursor-agent --version',
    'cursor-agent --help', 'cursor-agent -h', 'exec claude --version']) {
    assert.equal(launchesWorkflow(command), false, command);
  }
  for (const command of ['command -v claude && claude -p review',
    'command -- claude -p review', 'command -p claude -p review',
    'claude -p "Explain --help"', 'cursor-agent --mode ask "Explain --version"',
    'claude --version; codex exec review']) {
    assert.equal(launchesWorkflow(command), true, command);
  }
});

test('bounded loop cases permit local helpers but reject reviewer launches in executable positions', () => {
  const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'))
    .filter(c => c.prompt.startsWith('This is a bounded evaluation'));
  assert.ok(cases.length > 0);
  for (const c of cases) {
    for (const command of [
      'node .agents/skills/comprehensive-review/scripts/scope-fingerprint.mjs --scope working-tree',
      'node .agents/skills/review-fix-loop/scripts/loop-options.mjs',
      'bash -lc "node .agents/skills/comprehensive-review/scripts/review-options.mjs"',
      'cat .agents/skills/comprehensive-review/scripts/claude-review.mjs',
      'rg -n "claude|cursor-agent|codex exec" .agents/skills',
      'command -v claude cursor-agent', 'claude --version',
    ]) assert.equal(checkCommands(c, [command]), true, `${c.id}: ${command}`);
    for (const command of [
      'node .agents/skills/comprehensive-review/scripts/claude-review.mjs --scope working-tree',
      'node --no-warnings .agents/skills/comprehensive-review/scripts/cursor-review.mjs',
      'node scripts/scope-fingerprint.mjs && claude -p review',
      'bash -lc "node scripts/scope-fingerprint.mjs; node scripts/cursor-review.mjs"',
      'env PROFILE=review command cursor-agent --print review',
      'codex --model example exec review', 'codex -C /tmp/task e review',
      'codex review',
    ]) assert.equal(checkCommands(c, [command]), false, `${c.id}: ${command}`);
  }
});

test('reviewer-only enforcement preserves the stricter workflow prohibition', () => {
  const helper = ['node scripts/scope-fingerprint.mjs'];
  assert.equal(checkCommands({ forbidWorkflowLaunches: true }, helper), false);
  assert.equal(checkCommands({ forbidReviewerLaunches: true }, helper), true);
  assert.equal(checkCommands({ forbidReviewerLaunches: true, forbidWorkflowLaunches: true }, helper), false);
});
