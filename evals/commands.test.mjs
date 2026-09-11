import test from 'node:test';
import assert from 'node:assert/strict';
import { launchesWorkflow } from './run.mjs';

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
