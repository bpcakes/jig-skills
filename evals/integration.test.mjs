import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Allows the same regression tests to exercise a preserved, buggy runner.
const runner = process.env.EVAL_TEST_RUNNER || path.join(here, 'run.mjs');
const { createReport } = await import(process.env.EVAL_TEST_EXPORTER || './export.mjs');
const sourceRoot = path.dirname(path.dirname(runner));

function exercise(t, scenario, configure = () => ({}), caseId = 'rust-implicit-simplify') {
  const dir = mkdtempSync(path.join(tmpdir(), 'jig-eval-integration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scratch = path.join(dir, 'tmp'); mkdirSync(scratch);
  const bin = path.join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(path.join(bin, 'codex'), readFileSync(path.join(here, 'fixtures/codex-stub.cjs')), { mode: 0o755 });
  const foreign = path.join(dir, 'personal/rust-simplify/SKILL.md');
  mkdirSync(path.dirname(foreign), { recursive: true });
  writeFileSync(foreign, '---\nname: rust-simplify\n---\nUnversioned personal instructions.');
  const out = path.join(dir, 'result');
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TMPDIR: scratch,
    EVAL_STUB_SCENARIO: scenario, EVAL_STUB_FOREIGN_SKILL: foreign, ...configure(dir) };
  const child = spawnSync(process.execPath, [runner, '--live', '--case', caseId, '--output', out,
    ...(scenario === 'configured' ? ['--model', 'gpt-6-astra', '--effort', 'medium', '--judge-model', 'fixed-judge', '--judge-effort', 'high'] : []),
    ...(scenario.startsWith('tamper-') ? ['--repeat', '2'] : []),
    ...(scenario === 'grade-timeout' ? ['--timeout', '15', '--grade-timeout', '1'] : [])],
    { env, encoding: 'utf8', timeout: 60_000 });
  assert.ifError(child.error);
  const summary = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8'));
  const result = summary.results[0];
  // Clean only workspaces explicitly returned by this test's runner.
  t.after(() => {
    if (result.workspace?.startsWith(path.join(tmpdir(), 'jig-skill-case-'))) rmSync(result.workspace, { recursive: true, force: true });
  });
  return { child, result, dir, summary, artifacts: path.join(out, `${caseId}-1`) };
}

test('grader receives the committed baseline separately from task before and after files', t => {
  const { child, artifacts } = exercise(t, 'allowed');
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const prompt = readFileSync(path.join(artifacts, 'grade.prompt.txt'), 'utf8');
  const data = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
  assert.equal(data.gitBase?.['src/lib.rs'], 'pub fn classify(value: i32) -> bool { value >= 0 }\n');
  assert.match(data.initialDiff, /^-pub fn classify.*value >= 0/m);
  assert.match(data.initialDiff, /^\+    if value > 0/m);
  assert.match(data.before['src/lib.rs'], /if value > 0/);
  assert.equal(data.after['src/lib.rs'], 'pub fn classify(value: i32) -> bool { value > 0 }\n');
});

test('assembled runner accepts an in-scope implementation', t => {
  const { child, result } = exercise(t, 'allowed');
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(result.passed, true);
  assert.deepEqual(result.changed, ['src/lib.rs']);
});

test('runner preserves a pre-existing staged repair and exposes it to the grader', t => {
  const { child, result, artifacts } = exercise(t, 'preserve-staged', () => ({}), 'review-prior-authorized-stale-finding');
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(result.passed, true);
  assert.deepEqual(result.beforeGit, result.afterGit);
  assert.deepEqual(result.changed, []);
  const prompt = readFileSync(path.join(artifacts, 'grade.prompt.txt'), 'utf8');
  const data = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
  assert.match(data.initialDiff, /^-export function formatLabel.*toLowerCase/m);
  assert.match(data.initialDiff, /^\+export function formatLabel.*toUpperCase/m);
});

test('agent and judge configuration reaches separate CLI processes and verified exports', t => {
  const { child, summary, artifacts, result } = exercise(t, 'configured');
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.deepEqual(summary.configuration, { agent: { model: 'gpt-6-astra', effort: 'medium' },
    judge: { model: 'fixed-judge', effort: 'high' } });
  for (const [label, model, effort] of [['agent', 'gpt-6-astra', 'medium'], ['grade', 'fixed-judge', 'high']]) {
    const args = JSON.parse(readFileSync(path.join(artifacts, `${label}.command.json`)));
    assert.equal(args[args.indexOf('--model') + 1], model);
    assert.ok(args.includes(`model_reasoning_effort="${effort}"`));
  }
  assert.deepEqual(result.agentMetrics.usage, { input_tokens: 120, cached_input_tokens: 40, output_tokens: 15 });
  assert.equal(result.agentExecution.reported, null);
  assert.ok(result.agentExecution.elapsedMs >= 0);
  const report = createReport(path.dirname(artifacts), sourceRoot, { allowPartial: true });
  assert.deepEqual(report.configuration, summary.configuration);
  assert.deepEqual(report.results[0].agentMetrics, result.agentMetrics);
  const summaryFile = path.join(path.dirname(artifacts), 'summary.json');
  summary.results[0].agentMetrics.usage.input_tokens = 0;
  writeFileSync(summaryFile, JSON.stringify(summary));
  assert.throws(() => createReport(path.dirname(artifacts), sourceRoot, { allowPartial: true }), /agent metrics/);
  summary.results[0].agentMetrics.usage.input_tokens = 120;
  summary.configuration.agent.model = 'invented-effective-model';
  summary.model = 'invented-effective-model';
  writeFileSync(summaryFile, JSON.stringify(summary));
  assert.throws(() => createReport(path.dirname(artifacts), sourceRoot, { allowPartial: true }), /requested configuration/);
  summary.configuration.agent.model = 'gpt-6-astra';
  summary.model = 'gpt-6-astra';
  delete summary.configuration;
  writeFileSync(summaryFile, JSON.stringify(summary));
  assert.throws(() => createReport(path.dirname(artifacts), sourceRoot, { allowPartial: true }), /requested configuration/);
  summary.configuration = { agent: { model: 'gpt-6-astra', effort: 'medium' },
    judge: { model: 'fixed-judge', effort: 'high' } };
  summary.model = 'invented-summary-model';
  writeFileSync(summaryFile, JSON.stringify(summary));
  assert.throws(() => createReport(path.dirname(artifacts), sourceRoot, { allowPartial: true }), /task model summary/);
});

for (const scenario of ['multi-skill-read', 'catalog-glob-read']) {
  test(`runner evidence round-trips across flat and plugin-grouped catalogs: ${scenario}`, t => {
    const { child, result, artifacts } = exercise(t, scenario);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    if (scenario === 'multi-skill-read') {
      assert.deepEqual(new Set(result.reads), new Set(['react-test-quality-review', 'rust-simplify']));
    } else {
      assert.ok(result.uncertainReads.includes('react-test-quality-review'));
      assert.ok(result.uncertainReads.includes('rust-error-handling-review'));
    }
    const report = createReport(path.dirname(artifacts), sourceRoot, { allowPartial: true });
    assert.equal(report.passed, 1);
    assert.equal(report.total, 1);
    // Normalization must not conceal a genuine membership change.
    const summaryFile = path.join(path.dirname(artifacts), 'summary.json');
    const summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
    summary.results[0].reads = [];
    writeFileSync(summaryFile, JSON.stringify(summary));
    assert.throws(() => createReport(path.dirname(artifacts), sourceRoot, { allowPartial: true }), /Evidence mismatch/);
  });
}

test('source commit belongs to the explicit source repository despite inherited Git selectors', t => {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (cwd, args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
      '-c', 'user.name=Contract Test', '-c', 'user.email=contract@example.invalid', ...args],
    { cwd, env: { ...cleanEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const expected = git(sourceRoot, ['rev-parse', 'HEAD']);
  const { child, summary } = exercise(t, 'allowed', dir => {
    const foreign = path.join(dir, 'foreign'); mkdirSync(foreign);
    git(foreign, ['init', '-q', '--template=']);
    git(foreign, ['commit', '--allow-empty', '-qm', 'Unrelated repository']);
    assert.notEqual(git(foreign, ['rev-parse', 'HEAD']), expected);
    return { GIT_DIR: path.join(foreign, '.git'), GIT_WORK_TREE: foreign };
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(summary.commit, expected);
});

test('symlinked temporary roots accept legitimate absolute edits and skill reads', t => {
  const { child, result } = exercise(t, 'absolute-read', dir => {
    const alias = path.join(dir, 'tmp-alias'); symlinkSync(path.join(dir, 'tmp'), alias, 'dir');
    return { TMPDIR: alias };
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(result.passed, true);
  assert.equal(result.workspace, realpathSync(result.workspace));
});

for (const command of ["/usr/bin/bash -lc 'claude -p review'", '/usr/bin/bash -lc "cursor-agent --mode ask review"',
  'codex --model gpt-5 exec review', 'codex -C /tmp/task review', 'codex --profile audit e review',
  "(claude)", "bash -lc 'codex exec review'"]) test(`quoted workflow launch is rejected: ${command}`, t => {
  const { child, result } = exercise(t, 'forbidden-command', () => ({ EVAL_STUB_COMMAND: command }), 'loop-loaded-one-pass-fix');
  assert.equal(result.outcome, true);
  assert.equal(result.scope, true);
  assert.equal(result.trace, false);
  assert.equal(child.status, 1);
});

test('absolute skill reads work under a temporary root containing spaces', t => {
  const { child, result } = exercise(t, 'absolute-read', dir => {
    const scratch = path.join(dir, 'tmp with spaces'); mkdirSync(scratch);
    return { TMPDIR: scratch };
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(result.invocation, true);
});

for (const args of [['nl', '-ba'], ['cat', '-n'], ['grep', '-n', '']]) test(`numbered skill read passes invocation: ${args.join(' ')}`, t => {
  const { child, result } = exercise(t, 'numbered-read', () => ({ EVAL_STUB_READ_ARGS: JSON.stringify(args) }));
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(result.invocation, true);
  assert.deepEqual(result.reads, ['rust-simplify']);
});

for (const command of ['command -v claude cursor-agent', 'claude --version', 'cursor-agent --help']) {
  test(`reviewer availability check is permitted: ${command}`, t => {
    const { child, result } = exercise(t, 'forbidden-command', () => ({ EVAL_STUB_COMMAND: command }), 'loop-loaded-one-pass-fix');
    assert.equal(result.trace, true);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
}

test('negative discovery cannot pass an ambiguous successful skill read', t => {
  const { child, result } = exercise(t, 'negative-glob-read', undefined, 'rust-simplify-negative-discovery');
  assert.equal(result.scope, true);
  assert.equal(result.outcome, true);
  assert.equal(result.invocation, null);
  assert.deepEqual(result.uncertainReads, ['rust-simplify']);
  assert.equal(result.passed, false);
  assert.equal(child.status, 1);
});

for (const command of ['rg -n claude .agents/skills/review-fix-loop/SKILL.md',
  'grep -n "codex exec" .agents/skills/review-fix-loop/SKILL.md',
  'sed -n 1,20p .agents/skills/comprehensive-review/scripts/claude-review.mjs',
  '/usr/bin/bash -lc \'rg -n "node.*claude-review" .agents/skills/review-fix-loop/SKILL.md\'']) {
  test(`instruction search is not a workflow launch: ${command}`, t => {
    const { child, result } = exercise(t, 'forbidden-command', () => ({ EVAL_STUB_COMMAND: command }), 'loop-loaded-one-pass-fix');
    assert.equal(result.trace, true);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
}

for (const scenario of ['tamper-skill', 'tamper-schema', 'tamper-grade-schema']) test(`frozen input mutation fails the run: ${scenario}`, t => {
  const { child, result, summary } = exercise(t, scenario);
  assert.equal(child.status, 1);
  assert.equal(result.passed, false);
  assert.match(result.error, /Frozen evaluation inputs changed/);
  assert.equal(summary.state, 'failed');
  assert.equal(summary.plannedTrials.length, 2);
  assert.equal(summary.results.length, 1, 'do not run later trials with changed inputs');
});

test('task sandbox excludes ambient temporary write roots', t => {
  const { child, artifacts } = exercise(t, 'allowed');
  assert.equal(child.status, 0);
  const args = JSON.parse(readFileSync(path.join(artifacts, 'agent.command.json'), 'utf8'));
  assert.ok(args.includes('sandbox_workspace_write.exclude_tmpdir_env_var=true'));
  assert.ok(args.includes('sandbox_workspace_write.exclude_slash_tmp=true'));
});

test('XDG Git ignore and attributes cannot alter setup or agent Git commands', t => {
  const { child, result, artifacts } = exercise(t, 'git-defaults', dir => {
    const config = path.join(dir, 'xdg'); mkdirSync(path.join(config, 'git'), { recursive: true });
    writeFileSync(path.join(config, 'git/ignore'), 'src/\n.agents/\n');
    writeFileSync(path.join(config, 'git/attributes'), '*.rs custom-marker=ambient\n');
    return { XDG_CONFIG_HOME: config };
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(result.passed, true);
  const diagnostic = JSON.parse(readFileSync(path.join(artifacts, 'stub-git.json'), 'utf8'));
  assert.ok(diagnostic.tracked.includes('src/lib.rs'));
  assert.match(diagnostic.attribute, /custom-marker: unspecified/);
});

for (const scenario of ['allowed', 'grade-failure', 'grade-timeout']) test(`grader workspace is removed after ${scenario}`, t => {
  const { child, artifacts, result, summary } = exercise(t, scenario);
  assert.equal(child.status, scenario === 'allowed' ? 0 : 1);
  assert.deepEqual(result.phases, { agent: 'completed', judge: scenario === 'allowed' ? 'completed' : 'attempted' });
  const args = JSON.parse(readFileSync(path.join(artifacts, 'grade.command.json'), 'utf8'));
  assert.equal(existsSync(args[args.indexOf('--cd') + 1]), false);
  const report = createReport(path.dirname(artifacts), sourceRoot, { allowPartial: true });
  assert.equal(report.results[0].phases.judge.state, scenario === 'allowed' ? 'completed' : 'attempted');
  assert.equal(report.results[0].phases.judge.execution.stopReason, scenario === 'grade-timeout' ? 'timeout' : null);
  assert.equal(report.results[0].phases.judge.execution.timedOut, scenario === 'grade-timeout');
  if (scenario === 'grade-timeout') {
    assert.equal(result.scope, true, 'agent completed before grading');
    assert.match(result.error, /^grade: timeout/);
    assert.deepEqual(summary.timeouts, { agent: 15, grade: 1 });
  }
});

test('failed grader configuration is checked against its attempted command', t => {
  const { artifacts, summary } = exercise(t, 'grade-failure');
  const run = path.dirname(artifacts);
  summary.configuration.judge.model = 'forged-model';
  writeFileSync(path.join(run, 'summary.json'), JSON.stringify(summary));
  assert.throws(() => createReport(run, sourceRoot, { allowPartial: true }), /judge requested configuration/);
});

test('runner invokes both schemas from its frozen artifact bundle', t => {
  const { child, summary, artifacts } = exercise(t, 'allowed');
  assert.equal(child.status, 0);
  assert.equal(summary.formatVersion, 4);
  assert.equal(summary.state, 'completed');
  assert.deepEqual(summary.plannedTrials, [{ id: 'rust-implicit-simplify', iteration: 1 }]);
  for (const [label, name] of [['agent', 'response.schema.json'], ['grade', 'grade.schema.json']]) {
    const args = JSON.parse(readFileSync(path.join(artifacts, `${label}.command.json`), 'utf8'));
    const schema = args[args.indexOf('--output-schema') + 1];
    assert.equal(schema, path.join(path.dirname(artifacts), 'schemas', name));
    assert.equal(typeof summary.schemaHashes[name], 'string');
  }
});

for (const scenario of ['restored', 'moved-restored']) test(`assembled runner rejects ${scenario} unrelated writes even with a correct final answer`, t => {
  const { child, result } = exercise(t, scenario);
  assert.equal(result.outcome, true);
  assert.equal(result.invocation, true);
  assert.deepEqual(result.changed, ['src/lib.rs']);
  assert.equal(result.scope, false);
  assert.equal(result.passed, false);
  assert.equal(child.status, 1);
});

test('assembled runner rejects a same-name personal skill read', t => {
  const { child, result } = exercise(t, 'foreign-read');
  assert.equal(result.scope, true);
  assert.equal(result.outcome, true);
  assert.equal(result.invocation, false);
  assert.equal(child.status, 1);
});

test('assembled runner rejects a forbidden workflow launch even when the outcome grade passes', t => {
  const { child, result } = exercise(t, 'forbidden', undefined, 'loop-loaded-one-pass-fix');
  assert.equal(result.outcome, true);
  assert.equal(result.scope, true);
  assert.equal(result.trace, false);
  assert.equal(result.passed, false);
  assert.equal(child.status, 1);
});

test('fixture Git ignores inherited signing, hooks, and template configuration', t => {
  const { child, result, dir } = exercise(t, 'allowed', dir => {
    const hooks = path.join(dir, 'hooks'); mkdirSync(hooks);
    writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nprintf tampered > hook-ran\nexit 1\n', { mode: 0o755 });
    const template = path.join(dir, 'template'); mkdirSync(template);
    writeFileSync(path.join(template, 'template-marker'), 'ambient template');
    const config = path.join(dir, 'personal.gitconfig');
    writeFileSync(config, `[commit]\n gpgsign = true\n[gpg]\n program = /nonexistent/eval-test-signer\n[core]\n hooksPath = ${hooks}\n[init]\n templateDir = ${template}\n`);
    return { GIT_CONFIG_GLOBAL: config, GIT_TEMPLATE_DIR: template,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'true' };
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(result.passed, true);
  assert.equal(existsSync(path.join(result.workspace, 'hook-ran')), false);
  assert.equal(existsSync(path.join(result.workspace, '.git/template-marker')), false);
  assert.equal(existsSync(path.join(dir, 'hook-ran')), false);
});
