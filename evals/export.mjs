#!/usr/bin/env node
// Export one complete run, without silently mixing evaluator or skill versions.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, snapshot, skillSnapshot, skillBundlePolicy, schemaNames, skillDirs, parseTrace, completedCommands, skillReadEvidence, checkInvocation, changedPaths, checkScope, checkGrade, checkCommands } from './run.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const requireEqual = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Evidence mismatch: ${label}`);
};

export function createReport(runDirectory, sourceRoot = root, { allowPartial = false } = {}) {
  const run = path.resolve(runDirectory);
  const summary = json(path.join(run, 'summary.json'));
  if (summary.formatVersion !== 3) throw new Error('Legacy run: verify with its original evaluator revision; planned trials and lifecycle provenance were not recorded');
  requireEqual(summary.skillBundlePolicy, skillBundlePolicy, 'skill bundle policy');
  const cases = json(path.join(sourceRoot, 'evals/cases.json'));
  requireEqual(sha(readFileSync(path.join(sourceRoot, 'evals/run.mjs'))), summary.harnessHash, 'current harness');
  requireEqual(sha(readFileSync(path.join(sourceRoot, 'evals/cases.json'))), summary.suiteHash, 'current suite');
  requireEqual(Object.keys(summary.schemaHashes ?? {}).sort(), [...schemaNames].sort(), 'schema inventory');
  for (const name of schemaNames) {
    requireEqual(sha(readFileSync(path.join(sourceRoot, 'evals', name))), summary.schemaHashes[name], `current schema ${name}`);
    requireEqual(sha(readFileSync(path.join(run, 'schemas', name))), summary.schemaHashes[name], `frozen schema ${name}`);
  }
  const catalog = skillDirs(path.join(sourceRoot, 'plugins'));
  const names = catalog.map(dir => path.basename(dir));
  const evaluated = new Set();
  requireEqual(Object.keys(summary.skillHashes).sort(), [...names].sort(), 'catalog');
  for (const dir of catalog) {
    const name = path.basename(dir);
    const frozen = path.join(run, 'skills', name);
    requireEqual(sha(JSON.stringify(skillSnapshot(frozen))), summary.skillHashes[name], `frozen skill ${name}`);
    // Every entrypoint participates in discovery. Full reference checks follow
    // trial validation, using actual targets and independently recomputed reads.
    requireEqual(sha(readFileSync(path.join(dir, 'SKILL.md'))), sha(readFileSync(path.join(frozen, 'SKILL.md'))), `current entrypoint ${name}`);
  }
  const selected = new Set(summary.results.map(r => r.id));
  const missingCases = cases.filter(c => !selected.has(c.id)).map(c => c.id);
  const plan = summary.plannedTrials;
  if (!Array.isArray(plan) || !plan.length || !['running', 'completed', 'interrupted', 'failed'].includes(summary.state)) throw new Error('Invalid trial plan/state');
  const planned = new Set();
  for (const trial of plan) {
    const key = `${trial.id}-${trial.iteration}`;
    if (!cases.some(c => c.id === trial.id) || !Number.isInteger(trial.iteration) || trial.iteration < 1 || planned.has(key)) throw new Error('Invalid planned trial');
    planned.add(key);
  }
  const recorded = new Set(summary.results.map(r => `${r.id}-${r.iteration}`));
  if ([...recorded].some(key => !planned.has(key))) throw new Error('Unplanned trial result');
  const missingTrials = plan.filter(t => !recorded.has(`${t.id}-${t.iteration}`));
  const runComplete = summary.state === 'completed' && missingTrials.length === 0;
  if (!allowPartial && !runComplete) throw new Error('Evidence mismatch: incomplete planned trials or run state');
  if (!allowPartial && missingCases.length) throw new Error('Evidence mismatch: complete case coverage');
  const seen = new Set();
  const results = summary.results.map(result => {
    const c = cases.find(c => c.id === result.id);
    evaluated.add(c.skill);
    if (!Number.isInteger(result.iteration) || result.iteration < 1) throw new Error('Invalid iteration');
    const key = `${result.id}-${result.iteration}`;
    if (seen.has(key)) throw new Error(`Duplicate trial: ${key}`);
    seen.add(key);
    const artifacts = path.join(run, key);
    const caseFile = path.join(artifacts, 'case.json');
    // Fixture setup can fail before case.json is saved. The matching suite hash
    // still identifies its intended definition; preserve that failure honestly.
    if (existsSync(caseFile)) requireEqual(json(caseFile), c, `${key} case`);
    else if (!result.error) throw new Error(`Missing case evidence: ${key}`);
    if (result.error) {
      requireEqual(result.passed, false, `${key} error verdict`);
      return { id: c.id, iteration: result.iteration, skill: c.skill, passed: false, error: result.error,
        artifactHash: sha(JSON.stringify(snapshot(artifacts))) };
    }
    const events = parseTrace(readFileSync(path.join(artifacts, 'agent.jsonl'), 'utf8'));
    parseTrace(readFileSync(path.join(artifacts, 'grade.jsonl'), 'utf8'));
    const answer = json(path.join(artifacts, 'agent.json'));
    const grade = json(path.join(artifacts, 'grade.json'));
    const readEvidence = skillReadEvidence(events, names, result.workspace);
    const { reads, uncertainReads } = readEvidence;
    requireEqual(result.reads, reads, `${key} reads`);
    requireEqual(result.uncertainReads, uncertainReads, `${key} uncertainReads`);
    for (const name of [...reads, ...uncertainReads]) evaluated.add(name);
    const changed = changedPaths(json(path.join(artifacts, 'before.json')), json(path.join(artifacts, 'after.json')));
    const writes = events.filter(e => e.type === 'item.completed' && e.item?.type === 'file_change').flatMap(e => e.item.changes ?? []);
    const commands = completedCommands(events).map(item => item.command);
    const checks = {
      invocation: checkInvocation(c, readEvidence),
      scope: checkScope({ workspace: result.workspace, beforeGit: json(path.join(artifacts, 'before-git.json')),
        afterGit: json(path.join(artifacts, 'after-git.json')), changed, writes, ...c }),
      findings: Number.isInteger(answer.findings?.length) && answer.findings.length >= c.findings.min && answer.findings.length <= c.findings.max,
      trace: checkCommands(c, commands),
      outcome: checkGrade(c.criteria, grade),
    };
    for (const [name, value] of Object.entries(checks)) requireEqual(result[name], value, `${key} ${name}`);
    requireEqual(result.passed, Object.values(checks).every(Boolean), `${key} verdict`);
    return { id: c.id, iteration: result.iteration, skill: c.skill, mode: c.mode, passed: result.passed,
      checks, changed, reads, uncertainReads, commands, answer, grade, artifactHash: sha(JSON.stringify(snapshot(artifacts))) };
  });
  // An unselected, unread skill's references may evolve independently. Ambiguous
  // successful reads still require matching references; they are not non-reads.
  for (const dir of catalog) {
    const name = path.basename(dir);
    if (evaluated.has(name)) requireEqual(sha(JSON.stringify(skillSnapshot(dir))), summary.skillHashes[name], `current skill ${name}`);
  }
  return { schemaVersion: 3, sourceRun: run, sourceSummaryHash: sha(readFileSync(path.join(run, 'summary.json'))),
    skillBundlePolicy, schemaHashes: summary.schemaHashes,
    coverage: { allowPartial, completeSuite: missingCases.length === 0 && runComplete, missingCases, missingTrials,
      plannedTrials: plan, runState: summary.state, runComplete, runError: summary.error ?? null },
    startedAt: summary.startedAt, cli: summary.cli, model: summary.model, sourceCommit: summary.commit,
    harnessHash: summary.harnessHash, suiteHash: summary.suiteHash, exporterHash: sha(readFileSync(fileURLToPath(import.meta.url))), skillHashes: summary.skillHashes,
    passed: results.filter(r => r.passed).length, total: results.length, skillsEvaluated: new Set(results.map(r => r.skill)).size,
    limits: ['One regression-suite run, not an exhaustive or held-out benchmark.',
      'Semantic grades are separate Codex judgments, not an independent model family.',
      'Current source verification covers every discovery entrypoint and all files of recorded target skills and skills read or possibly read in completed trials; unused references of other skills may differ.',
      'Raw artifacts must remain available at sourceRun to reverify; hashes are not an adversarial authenticity guarantee.'], results };
}

export function verifyReport(file, sourceRoot = root) {
  const saved = json(file);
  requireEqual(createReport(saved.sourceRun, sourceRoot, { allowPartial: saved.coverage.allowPartial }), saved, 'exported report');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [first, second, ...extra] = process.argv.slice(2);
    if (!first || !second || extra.some(arg => arg !== '--partial') || extra.length > 1 || (first === '--verify' && extra.length)) {
      throw new Error('Usage: node evals/export.mjs RUN_DIRECTORY NEW_JSON [--partial] | --verify JSON');
    }
    if (first === '--verify') { verifyReport(second); console.log('Evidence and current source hashes verified.'); }
    else {
      const report = createReport(first, root, { allowPartial: extra.includes('--partial') });
      writeFileSync(second, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log(`Exported ${report.passed}/${report.total} trials to ${second}`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
