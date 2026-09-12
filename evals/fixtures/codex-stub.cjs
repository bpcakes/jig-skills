#!/usr/bin/env node
// Deterministic CLI-boundary test double. Never use as live model evidence.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture-codex-stub'); process.exit(); }
const output = args[args.indexOf('--output-last-message') + 1];
let prompt = '';
process.stdin.on('data', data => { prompt += data; });
process.stdin.on('end', async () => {
  const phase = output.endsWith('agent.json') ? 'agent' : 'grade';
  // Controlled fault injection: agent work exceeds the grader's one-second
  // deadline. The test asserts phase completion, never elapsed wall-clock time.
  if (phase === 'agent' && process.env.EVAL_STUB_SCENARIO === 'grade-timeout') {
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  if (phase === 'grade' && process.env.EVAL_STUB_SCENARIO === 'tamper-grade-schema') {
    fs.appendFileSync(path.join(path.dirname(path.dirname(output)), 'schemas/grade.schema.json'), '\nChanged after grading.');
  }
  if (process.env.EVAL_STUB_SCENARIO === `signal-${phase}`) {
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    fs.writeFileSync(path.join(path.dirname(output), 'signal-ready.json'), JSON.stringify({
      pid: process.pid, descendant: descendant.pid, cwd: process.cwd(), phase,
    }));
    setInterval(() => {}, 1000);
    return;
  }
  const emit = item => console.log(JSON.stringify({ type: 'item.completed', item }));
  const change = (file, content, kind = 'update') => {
    if (content === null) fs.unlinkSync(file); else fs.writeFileSync(file, content);
    emit({ type: 'file_change', status: 'completed', changes: [{ path: path.resolve(file), kind }] });
  };
  if (output.endsWith('agent.json')) {
    const scenario = process.env.EVAL_STUB_SCENARIO;
    if (scenario === 'tamper-skill' || scenario === 'tamper-schema') {
      const run = path.dirname(path.dirname(output));
      const target = scenario === 'tamper-skill' ? 'skills/rust-simplify/SKILL.md' : 'schemas/response.schema.json';
      fs.appendFileSync(path.join(run, target), '\nChanged by deliberately unsandboxed test double.');
    }
    if (scenario === 'forbidden') {
      emit({ type: 'command_execution', command: 'node .agents/skills/review-fix-loop/scripts/loop-options.mjs', exit_code: 0, aggregated_output: '{}' });
    }
    if (scenario === 'forbidden-command') {
      emit({ type: 'command_execution', command: process.env.EVAL_STUB_COMMAND, exit_code: 0, aggregated_output: '' });
    }
    if (scenario === 'git-defaults') {
      fs.writeFileSync(path.join(path.dirname(output), 'stub-git.json'), JSON.stringify({
        tracked: execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n'),
        attribute: execFileSync('git', ['check-attr', 'custom-marker', '--', 'src/lib.rs'], { encoding: 'utf8' }),
      }));
    }
    if (scenario === 'restored') {
      const previous = fs.readFileSync('src/unrelated.rs', 'utf8');
      change('src/unrelated.rs', 'unsolicited edit');
      change('src/unrelated.rs', previous);
    }
    if (scenario === 'moved-restored') {
      const previous = fs.readFileSync('src/lib.rs', 'utf8');
      change('src/lib.rs', null, 'delete'); change('src/moved.rs', previous, 'add');
      change('src/moved.rs', null, 'delete'); change('src/lib.rs', previous, 'add');
    }
    if (!['negative-glob-read', 'preserve-staged'].includes(scenario)) change('src/lib.rs', 'pub fn classify(value: i32) -> bool { value > 0 }\n');
    if (scenario === 'multi-skill-read' || scenario === 'catalog-glob-read') {
      const files = scenario === 'multi-skill-read'
        ? ['rust-simplify', 'react-test-quality-review'].map(name => `.agents/skills/${name}/SKILL.md`)
        : fs.readdirSync('.agents/skills').map(name => `.agents/skills/${name}/SKILL.md`);
      emit({ type: 'command_execution', command: scenario === 'multi-skill-read'
        ? ['cat', ...files].join(' ') : 'head -n3 .agents/skills/*/SKILL.md', exit_code: 0,
        aggregated_output: execFileSync(scenario === 'multi-skill-read' ? 'cat' : 'head',
          scenario === 'multi-skill-read' ? files : ['-n3', ...files], { encoding: 'utf8' }) });
    }
    let instruction = scenario === 'foreign-read' ? process.env.EVAL_STUB_FOREIGN_SKILL : '.agents/skills/rust-simplify/SKILL.md';
    if (scenario === 'absolute-read') instruction = path.resolve(instruction);
    const readArgs = scenario === 'numbered-read' ? JSON.parse(process.env.EVAL_STUB_READ_ARGS) : ['cat'];
    emit({ type: 'command_execution', command: scenario === 'negative-glob-read'
      ? 'cat .agents/skills/rust-simpl*/SKILL.md' : [...readArgs, instruction].map(word => JSON.stringify(word)).join(' '),
      exit_code: 0, aggregated_output: execFileSync(readArgs[0], [...readArgs.slice(1), instruction], { encoding: 'utf8' }) });
    fs.writeFileSync(output, JSON.stringify({ answer: 'Simplified classify to value > 0.', findings: [] }));
  } else {
    if (process.env.EVAL_STUB_SCENARIO === 'grade-failure') { process.exitCode = 1; return; }
    if (process.env.EVAL_STUB_SCENARIO === 'grade-timeout') { setInterval(() => {}, 1000); return; }
    const data = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
    fs.writeFileSync(output, JSON.stringify({ checks: data.criteria.map(c => ({ id: c.id, passed: true, evidence: 'Test-double grade; no model judgment claimed.' })) }));
  }
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 15 } }));
});
