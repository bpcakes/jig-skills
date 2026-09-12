import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { snapshot, skillBundlePolicy, traceMetrics } from './run.mjs';
import { pathToFileURL } from 'node:url';
const { createReport, verifyReport } = await import(process.env.EVAL_TEST_EXPORTER
  ? pathToFileURL(process.env.EVAL_TEST_EXPORTER).href : './export.mjs');

const sha = data => createHash('sha256').update(data).digest('hex');
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'jig-eval-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'), run = path.join(dir, 'run');
  const write = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const skill = path.join(source, 'plugins/demo/skills/example');
  write(path.join(skill, 'SKILL.md'), '---\nname: example\n---\nReview only.');
  write(path.join(source, 'evals/run.mjs'), '// fixture harness identity');
  const schemaHashes = {};
  for (const name of ['response.schema.json', 'grade.schema.json']) {
    const bytes = JSON.stringify({ type: 'object', required: ['evidence'] });
    write(path.join(source, 'evals', name), bytes);
    write(path.join(run, 'schemas', name), bytes);
    schemaHashes[name] = sha(bytes);
  }
  const c = { id: 'review', mode: 'explicit', skill: 'example', expectInvoke: true,
    files: { 'source.txt': 'unchanged' }, findings: { min: 0, max: 0 }, criteria: [{ id: 'answer' }] };
  write(path.join(source, 'evals/cases.json'), [c]);
  cpSync(skill, path.join(run, 'skills/example'), { recursive: true });
  const trial = path.join(run, 'review-1');
  const events = [
    { type: 'item.completed', item: { type: 'command_execution', exit_code: 0,
      command: 'cat .agents/skills/example/SKILL.md', aggregated_output: '---\nname: example\n---\nReview only.' } },
    { type: 'turn.completed' },
  ];
  const gradeEvents = [{ type: 'turn.completed' }];
  const grade = { checks: [{ id: 'answer', passed: true, evidence: 'No defect in the complete fixture.' }] };
  const execution = { requested: { model: null, effort: null }, reported: null,
    elapsedMs: 1, exitCode: 0, signal: null, timedOut: false, stopReason: null };
  for (const [name, value] of Object.entries({
    'case.json': c, 'agent.jsonl': events.map(e => JSON.stringify(e)).join('\n'),
    'grade.jsonl': gradeEvents.map(e => JSON.stringify(e)).join('\n'), 'agent.json': { answer: 'No findings.', findings: [] },
    'grade.json': grade, 'before.json': {}, 'after.json': {}, 'before-git.json': { head: 'same' }, 'after-git.json': { head: 'same' },
    'agent.command.json': [], 'grade.command.json': [],
    'agent.execution.json': execution, 'grade.execution.json': execution,
    'agent.prompt.txt': 'Task prompt.', 'grade.prompt.txt': 'Grade prompt.',
    'agent.stderr': '', 'grade.stderr': '',
  })) write(path.join(trial, name), value);
  const summary = { formatVersion: Number(process.env.EVAL_TEST_FORMAT || 4), skillBundlePolicy, schemaHashes,
    state: 'completed', plannedTrials: [{ id: 'review', iteration: 1 }],
    cli: 'fixture-only', model: 'CLI default (--ignore-user-config)',
    configuration: { agent: { model: null, effort: null }, judge: { model: null, effort: null } },
    commit: 'fixture', startedAt: '2026-09-11T00:00:00Z',
    harnessHash: sha(readFileSync(path.join(source, 'evals/run.mjs'))), suiteHash: sha(readFileSync(path.join(source, 'evals/cases.json'))),
    skillHashes: { example: sha(JSON.stringify(snapshot(skill))) },
    results: [{ id: 'review', iteration: 1, workspace: path.join(dir, 'workspace'), passed: true,
      phases: { agent: 'completed', judge: 'completed' },
      reads: ['example'], uncertainReads: [],
      agentExecution: execution, judgeExecution: execution,
      agentMetrics: traceMetrics(events), judgeMetrics: traceMetrics(gradeEvents),
      invocation: true, scope: true, findings: true, trace: true, outcome: true }] };
  write(path.join(run, 'summary.json'), summary);
  return { dir, source, run, trial, summary, c, write };
}

test('negative discovery export preserves uncertainty and rejects a forged pass', t => {
  const f = fixture(t);
  f.c.mode = 'implicit'; f.c.expectInvoke = false;
  f.write(path.join(f.source, 'evals/cases.json'), [f.c]);
  f.write(path.join(f.trial, 'case.json'), f.c);
  f.summary.suiteHash = sha(readFileSync(path.join(f.source, 'evals/cases.json')));
  f.write(path.join(f.trial, 'agent.jsonl'), [
    { type: 'item.completed', item: { type: 'command_execution', exit_code: 0,
      command: 'cat .agents/skills/exam*/SKILL.md', aggregated_output: '---\nname: example\n---\nReview only.' } },
    { type: 'turn.completed' },
  ].map(e => JSON.stringify(e)).join('\n'));
  Object.assign(f.summary.results[0], { invocation: null, passed: false, reads: [], uncertainReads: ['example'] });
  f.write(path.join(f.run, 'summary.json'), f.summary);
  const report = createReport(f.run, f.source);
  assert.equal(report.passed, 0);
  assert.equal(report.results[0].checks.invocation, null);
  assert.deepEqual(report.results[0].uncertainReads, ['example']);
  Object.assign(f.summary.results[0], { invocation: true, passed: true });
  f.write(path.join(f.run, 'summary.json'), f.summary);
  assert.throws(() => createReport(f.run, f.source), /invocation/);
});

test('single-run export rechecks verdicts and can be verified against raw artifacts', t => {
  const f = fixture(t);
  const report = createReport(f.run, f.source);
  assert.equal(report.schemaVersion, 4);
  assert.equal(report.passed, 1);
  assert.equal(report.total, 1);
  assert.equal(report.results[0].answer.answer, 'No findings.');
  const output = path.join(f.dir, 'export.json'); f.write(output, report);
  verifyReport(output, f.source);
  // A changed prompt/argv artifact must invalidate the saved export too.
  f.write(path.join(f.trial, 'agent.prompt.txt'), 'changed after export');
  assert.throws(() => verifyReport(output, f.source), /exported report/);
});

for (const label of ['agent', 'grade']) for (const suffix of ['prompt.txt', 'command.json', 'execution.json', 'jsonl', 'stderr', 'json']) {
  test(`completed ${label} phase requires ${suffix}`, t => {
    const f = fixture(t);
    rmSync(path.join(f.trial, `${label}.${suffix}`));
    assert.throws(() => createReport(f.run, f.source), new RegExp(`${label === 'grade' ? 'judge' : label}.*(artifact|phase|execution)`));
  });
}

function additionalSkill(f, { hasCase = false, read = null } = {}) {
  const skill = path.join(f.source, 'plugins/demo/skills/other');
  f.write(path.join(skill, 'SKILL.md'), '---\nname: other\n---\nRead references/rules.md when relevant.');
  f.write(path.join(skill, 'references/rules.md'), 'Original reference.');
  cpSync(skill, path.join(f.run, 'skills/other'), { recursive: true });
  f.summary.skillHashes.other = sha(JSON.stringify(snapshot(skill)));
  if (hasCase) {
    f.write(path.join(f.source, 'evals/cases.json'), [f.c, { ...f.c, id: 'unselected', skill: 'other' }]);
    f.summary.suiteHash = sha(readFileSync(path.join(f.source, 'evals/cases.json')));
  }
  if (read) {
    const events = readFileSync(path.join(f.trial, 'agent.jsonl'), 'utf8').split('\n').map(JSON.parse);
    events.splice(-1, 0, { type: 'item.completed', item: { type: 'command_execution', exit_code: 0,
      command: read === 'exact' ? 'cat .agents/skills/other/SKILL.md .agents/skills/other/references/rules.md'
        : 'cd .agents/skills/other && cat SKILL.md references/rules.md',
      aggregated_output: '---\nname: other\n---\nRead references/rules.md when relevant.\nOriginal reference.' } });
    f.write(path.join(f.trial, 'agent.jsonl'), events.map(e => JSON.stringify(e)).join('\n'));
    f.summary.results[0].agentMetrics = traceMetrics(events);
    if (read === 'exact') f.summary.results[0].reads.push('other');
    else f.summary.results[0].uncertainReads.push('other');
  }
  f.write(path.join(f.run, 'summary.json'), f.summary);
  return skill;
}

test('partial export permits changed references in an unselected unread skill', t => {
  const f = fixture(t), skill = additionalSkill(f, { hasCase: true });
  const report = createReport(f.run, f.source, { allowPartial: true });
  assert.deepEqual(report.coverage.missingCases, ['unselected']);
  f.write(path.join(skill, 'references/rules.md'), 'Unrelated update.');
  assert.deepEqual(createReport(f.run, f.source, { allowPartial: true }), report);
  const exported = path.join(f.dir, 'partial.json'); f.write(exported, report);
  assert.doesNotThrow(() => verifyReport(exported, f.source));
  f.write(path.join(skill, 'SKILL.md'), 'Changed discovery instructions.');
  assert.throws(() => createReport(f.run, f.source, { allowPartial: true }), /current entrypoint other/);
});

test('unselected frozen references still cannot change', t => {
  const f = fixture(t); additionalSkill(f, { hasCase: true });
  f.write(path.join(f.run, 'skills/other/references/rules.md'), 'Changed frozen evidence.');
  assert.throws(() => createReport(f.run, f.source, { allowPartial: true }), /frozen skill other/);
});

for (const read of ['exact', 'uncertain']) test(`export protects references of a non-target ${read} read`, t => {
  const f = fixture(t), skill = additionalSkill(f, { read });
  const report = createReport(f.run, f.source);
  assert.equal(report.passed, 1);
  assert.deepEqual(report.results[0][read === 'exact' ? 'reads' : 'uncertainReads'], read === 'exact' ? ['example', 'other'] : ['other']);
  f.write(path.join(skill, 'references/rules.md'), 'Changed referenced instructions.');
  assert.throws(() => createReport(f.run, f.source), /current skill other/);
});

for (const read of ['exact', 'uncertain']) test(`export rejects erased recorded ${read} reads`, t => {
  const f = fixture(t); additionalSkill(f, { read });
  const key = read === 'exact' ? 'reads' : 'uncertainReads';
  f.summary.results[0][key] = read === 'exact' ? ['example'] : [];
  f.write(path.join(f.run, 'summary.json'), f.summary);
  assert.throws(() => createReport(f.run, f.source), new RegExp(`review-1 ${key}`));
});

for (const key of ['reads', 'uncertainReads']) test(`export rejects missing ${key} evidence`, t => {
  const f = fixture(t);
  delete f.summary.results[0][key];
  f.write(path.join(f.run, 'summary.json'), f.summary);
  assert.throws(() => createReport(f.run, f.source), new RegExp(`review-1 ${key}`));
});

for (const name of ['response.schema.json', 'grade.schema.json']) {
  for (const location of ['source', 'frozen']) test(`export rejects a changed ${location} ${name}`, t => {
    const f = fixture(t);
    const file = location === 'source' ? path.join(f.source, 'evals', name) : path.join(f.run, 'schemas', name);
    f.write(file, { type: 'object' });
    assert.throws(() => createReport(f.run, f.source), new RegExp(`${location === 'source' ? 'current' : 'frozen'} schema`));
  });
}

test('cache artifacts do not invalidate skill provenance, but authored references do', t => {
  const f = fixture(t);
  const report = createReport(f.run, f.source);
  const skill = path.join(f.source, 'plugins/demo/skills/example');
  f.write(path.join(skill, 'tests/__pycache__/test.cpython-312.pyc'), 'generated bytecode');
  f.write(path.join(skill, '.DS_Store'), 'desktop metadata');
  assert.deepEqual(createReport(f.run, f.source), report);
  f.write(path.join(skill, 'references/new.md'), 'An authored, untracked reference.');
  assert.throws(() => createReport(f.run, f.source), /current skill example/);
});

test('legacy records do not silently acquire schema provenance', t => {
  const f = fixture(t);
  f.summary.formatVersion = 3;
  f.write(path.join(f.run, 'summary.json'), f.summary);
  assert.throws(() => createReport(f.run, f.source), /Legacy run/);
  delete f.summary.formatVersion;
  delete f.summary.schemaHashes;
  f.write(path.join(f.run, 'summary.json'), f.summary);
  assert.throws(() => createReport(f.run, f.source), /Legacy run/);
});

test('export rejects stale source, omitted trials, and forged pass summaries', t => {
  const f = fixture(t);
  f.write(path.join(f.source, 'evals/run.mjs'), '// changed harness');
  assert.throws(() => createReport(f.run, f.source), /current harness/);
  f.write(path.join(f.source, 'evals/run.mjs'), '// fixture harness identity');
  f.write(path.join(f.run, 'summary.json'), { ...f.summary, results: [] });
  assert.throws(() => createReport(f.run, f.source), /planned trials|case coverage/);
  f.write(path.join(f.run, 'summary.json'), f.summary);
  f.write(path.join(f.trial, 'agent.json'), { answer: 'An unsupported defect.', findings: [{}] });
  assert.throws(() => createReport(f.run, f.source), /findings/);
});

test('unfinished repetitions cannot export as a complete experiment', t => {
  const f = fixture(t);
  f.summary.plannedTrials.push({ id: 'review', iteration: 2 }, { id: 'review', iteration: 3 });
  f.summary.state = 'running';
  f.write(path.join(f.run, 'summary.json'), f.summary);
  assert.throws(() => createReport(f.run, f.source), /incomplete planned trials/);
  const partial = createReport(f.run, f.source, { allowPartial: true });
  assert.equal(partial.coverage.completeSuite, false);
  assert.equal(partial.coverage.runComplete, false);
  assert.deepEqual(partial.coverage.missingTrials, [{ id: 'review', iteration: 2 }, { id: 'review', iteration: 3 }]);
  // A premature completion marker must not conceal the absent results.
  f.summary.state = 'completed'; f.write(path.join(f.run, 'summary.json'), f.summary);
  assert.throws(() => createReport(f.run, f.source), /incomplete planned trials/);
});

test('all recorded trials still require terminal completion, including single trials', t => {
  const f = fixture(t);
  f.summary.state = 'running'; f.write(path.join(f.run, 'summary.json'), f.summary);
  assert.throws(() => createReport(f.run, f.source), /run state/);
  f.summary.state = 'completed'; f.write(path.join(f.run, 'summary.json'), f.summary);
  assert.equal(createReport(f.run, f.source).coverage.completeSuite, true);
});

test('trial inventory rejects duplicate plans and unplanned results', t => {
  const f = fixture(t);
  f.summary.plannedTrials.push({ id: 'review', iteration: 1 });
  f.write(path.join(f.run, 'summary.json'), f.summary);
  assert.throws(() => createReport(f.run, f.source), /Invalid planned trial/);
  f.summary.plannedTrials.pop(); f.summary.results[0].iteration = 2;
  f.write(path.join(f.run, 'summary.json'), f.summary);
  assert.throws(() => createReport(f.run, f.source), /Unplanned trial/);
});

test('selected-case exports require explicit partial mode and list every omitted case', t => {
  const f = fixture(t);
  f.write(path.join(f.source, 'evals/cases.json'), [f.c, { ...f.c, id: 'unrun' }]);
  f.summary.suiteHash = sha(readFileSync(path.join(f.source, 'evals/cases.json')));
  f.write(path.join(f.run, 'summary.json'), f.summary);
  assert.throws(() => createReport(f.run, f.source), /complete case coverage/);
  const report = createReport(f.run, f.source, { allowPartial: true });
  assert.equal(report.coverage.completeSuite, false);
  assert.deepEqual(report.coverage.missingCases, ['unrun']);
  assert.equal(report.total, 1);
});

test('export preserves a failed trial instead of selecting only successes', t => {
  const f = fixture(t);
  f.summary.results[0] = { ...f.summary.results[0], passed: false, error: 'agent: timeout' };
  f.write(path.join(f.run, 'summary.json'), f.summary);
  const report = createReport(f.run, f.source);
  assert.equal(report.passed, 0);
  assert.equal(report.total, 1);
  assert.equal(report.results[0].error, 'agent: timeout');
  assert.deepEqual(report.results[0].phases, {
    agent: { state: 'completed', requested: { model: null, effort: null }, execution: f.summary.results[0].agentExecution },
    judge: { state: 'completed', requested: { model: null, effort: null }, execution: f.summary.results[0].judgeExecution },
  });
  rmSync(path.join(f.trial, 'case.json'));
  for (const label of ['agent', 'grade']) for (const suffix of ['prompt.txt', 'command.json', 'execution.json', 'jsonl', 'stderr', 'json']) {
    rmSync(path.join(f.trial, `${label}.${suffix}`), { force: true });
  }
  f.summary.results[0].phases = { agent: 'not-started', judge: 'not-started' };
  delete f.summary.results[0].agentExecution;
  delete f.summary.results[0].judgeExecution;
  delete f.summary.results[0].agentMetrics;
  delete f.summary.results[0].judgeMetrics;
  f.summary.results[0].error = 'fixture setup failed before case.json';
  f.write(path.join(f.run, 'summary.json'), f.summary);
  const setupFailure = createReport(f.run, f.source).results[0];
  assert.equal(setupFailure.error, 'fixture setup failed before case.json');
  assert.deepEqual(setupFailure.phases, {
    agent: { state: 'not-started', requested: null, execution: null },
    judge: { state: 'not-started', requested: null, execution: null },
  });
});

test('failed trials verify attempted phase configuration and lifecycle artifacts', t => {
  const f = fixture(t);
  f.summary.results[0] = { ...f.summary.results[0], passed: false, error: 'grade: timeout',
    phases: { agent: 'completed', judge: 'attempted' } };
  const attemptedExecution = { ...f.summary.results[0].judgeExecution,
    exitCode: null, timedOut: true, stopReason: 'timeout' };
  delete f.summary.results[0].judgeExecution;
  delete f.summary.results[0].judgeMetrics;
  f.write(path.join(f.run, 'summary.json'), f.summary);
  assert.throws(() => createReport(f.run, f.source), /attempted phase is complete/);
  f.write(path.join(f.trial, 'grade.execution.json'), attemptedExecution);
  const report = createReport(f.run, f.source);
  assert.equal(report.results[0].phases.judge.state, 'attempted');
  assert.deepEqual(report.results[0].phases.judge.requested, { model: null, effort: null });
  assert.deepEqual(report.results[0].phases.judge.execution, attemptedExecution);

  f.summary.configuration.judge.model = 'forged-model';
  f.write(path.join(f.run, 'summary.json'), f.summary);
  assert.throws(() => createReport(f.run, f.source), /judge requested configuration/);

  f.summary.configuration.judge.model = null;
  f.summary.results[0].phases.judge = 'not-started';
  f.write(path.join(f.run, 'summary.json'), f.summary);
  assert.throws(() => createReport(f.run, f.source), /judge not-started phase/);
});

for (const suffix of ['prompt.txt', 'command.json', 'execution.json', 'jsonl', 'stderr']) {
  test(`attempted phase with execution requires ${suffix}`, t => {
    const f = fixture(t);
    f.summary.results[0] = { ...f.summary.results[0], passed: false, error: 'grade: timeout',
      phases: { agent: 'completed', judge: 'attempted' } };
    const attemptedExecution = { ...f.summary.results[0].judgeExecution,
      exitCode: null, timedOut: true, stopReason: 'timeout' };
    delete f.summary.results[0].judgeExecution;
    delete f.summary.results[0].judgeMetrics;
    f.write(path.join(f.trial, 'grade.execution.json'), attemptedExecution);
    rmSync(path.join(f.trial, `grade.${suffix}`));
    f.write(path.join(f.run, 'summary.json'), f.summary);
    assert.throws(() => createReport(f.run, f.source), /judge.*(artifact|phase|command)/);
  });
}

test('attempted phase response is optional after a recorded failed execution', t => {
  const f = fixture(t);
  f.summary.results[0] = { ...f.summary.results[0], passed: false, error: 'grade: timeout',
    phases: { agent: 'completed', judge: 'attempted' } };
  const execution = { ...f.summary.results[0].judgeExecution, exitCode: null, timedOut: true, stopReason: 'timeout' };
  delete f.summary.results[0].judgeExecution;
  delete f.summary.results[0].judgeMetrics;
  f.write(path.join(f.trial, 'grade.execution.json'), execution);
  rmSync(path.join(f.trial, 'grade.json'));
  f.write(path.join(f.run, 'summary.json'), f.summary);
  assert.equal(createReport(f.run, f.source).results[0].phases.judge.state, 'attempted');
});

for (const [name, mutate] of [
  ['missing timedOut', execution => { delete execution.timedOut; }],
  ['invalid exitCode', execution => { execution.exitCode = 'zero'; }],
  ['negative elapsedMs', execution => { execution.elapsedMs = -1; }],
  ['invalid signal', execution => { execution.signal = 9; }],
  ['invalid reported configuration', execution => { execution.reported = { model: 'unverified' }; }],
  ['unknown stop reason', execution => { execution.stopReason = 'other'; }],
  ['inconsistent timeout flag', execution => { execution.stopReason = 'timeout'; }],
  ['unexpected field', execution => { execution.extra = true; }],
]) test(`export rejects ${name} in execution provenance`, t => {
  const f = fixture(t);
  const executionFile = path.join(f.trial, 'agent.execution.json');
  const execution = JSON.parse(readFileSync(executionFile, 'utf8'));
  mutate(execution);
  f.write(executionFile, execution);
  assert.throws(() => createReport(f.run, f.source), /agent execution/);
});

test('attempted spawn without an execution record remains exportable', t => {
  const f = fixture(t);
  f.summary.results[0] = { id: 'review', iteration: 1, workspace: f.summary.results[0].workspace,
    passed: false, error: 'spawn codex ENOENT', phases: { agent: 'attempted', judge: 'not-started' } };
  for (const suffix of ['execution.json', 'jsonl', 'stderr', 'json']) {
    rmSync(path.join(f.trial, `agent.${suffix}`), { force: true });
  }
  for (const suffix of ['prompt.txt', 'command.json', 'execution.json', 'jsonl', 'stderr', 'json']) {
    rmSync(path.join(f.trial, `grade.${suffix}`), { force: true });
  }
  f.write(path.join(f.run, 'summary.json'), f.summary);
  const phase = createReport(f.run, f.source).results[0].phases;
  assert.deepEqual(phase.agent, { state: 'attempted', requested: { model: null, effort: null }, execution: null });
  assert.deepEqual(phase.judge, { state: 'not-started', requested: null, execution: null });
});

test('cancelled attempted phase is not mistaken for a completed phase', t => {
  const f = fixture(t);
  f.summary.results[0] = { ...f.summary.results[0], passed: false, error: 'Interrupted by SIGTERM',
    phases: { agent: 'completed', judge: 'attempted' } };
  const execution = { ...f.summary.results[0].judgeExecution, stopReason: 'cancelled' };
  delete f.summary.results[0].judgeExecution;
  delete f.summary.results[0].judgeMetrics;
  f.write(path.join(f.trial, 'grade.execution.json'), execution);
  f.write(path.join(f.run, 'summary.json'), f.summary);
  const phase = createReport(f.run, f.source).results[0].phases.judge;
  assert.deepEqual(phase, { state: 'attempted', requested: { model: null, effort: null }, execution });
});
