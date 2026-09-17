#!/usr/bin/env node
// Beads owns issue state. This helper only validates and appends final review findings.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureFingerprint } from './scope-fingerprint.mjs';

const priorities = { critical: 0, high: 1, medium: 2, low: 3 };
const active = new Set(['open', 'in_progress', 'blocked', 'deferred']);
const sha = value => createHash('sha256').update(value).digest('hex');
const identity = file => { const s = statSync(file); return { path: realpathSync(file), dev: s.dev, ino: s.ino }; };
function environment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BD_|BEADS_|BR_)/.test(key)));
}
function executable() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, 'br');
    try { accessSync(file, constants.X_OK); return realpathSync(file); } catch {}
  }
  throw new Error('Beads logging requires the existing br CLI on PATH.');
}
function invokeText(receipt, args, acceptedStatuses = []) {
  try {
    return execFileSync(receipt.br.path, [
      '--db', receipt.database.path, '--no-auto-import', '--no-auto-flush', ...args,
    ], { cwd: receipt.cwd, env: environment(), encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    if (acceptedStatuses.includes(error.status) && !error.signal && typeof error.stdout === 'string') return error.stdout;
    throw error;
  }
}
function invoke(receipt, args, acceptedStatuses) {
  return JSON.parse(invokeText(receipt, [...args, '--json'], acceptedStatuses));
}
function requireDatabaseMode(receipt) {
  // config get merges project/user configuration and normalizes no_db to no-db.
  // The dotted alias is distinct; --db does not override any of these settings.
  for (const key of ['no-db', 'no.db']) {
    const config = invoke(receipt, ['config', 'get', key]);
    if (!Object.hasOwn(config, 'value') || (config.value !== null
        && !/^(0|false|no|n|off)$/i.test(String(config.value).trim()))) {
      throw new Error('Beads logging requires database mode; JSONL-only (no-db) or unrecognized storage configuration is unsupported.');
    }
  }
}

export function preflight(cwd) {
  cwd = realpathSync(cwd);
  const br = identity(executable());
  // Discovery must not initialize, import, export, or migrate a tracker.
  const route = JSON.parse(execFileSync(br.path, ['--no-db', 'where', '--json'], {
    cwd, env: environment(), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
  }));
  const store = identity(route.path);
  const database = identity(route.database_path);
  if (!['.beads', '_beads'].some(name => store.path === path.join(cwd, name))
      || path.dirname(database.path) !== store.path
      || path.resolve(route.path) !== store.path
      || path.resolve(route.database_path) !== database.path) {
    throw new Error('Beads logging requires an existing local .beads or _beads store and database; redirects and symlinks are unsupported.');
  }
  const receipt = { version: 1, cwd, br, store, database, excludePaths: [path.basename(store.path)] };
  requireDatabaseMode(receipt);
  // Unlike sync --status, doctor inspects a database-family snapshot without
  // opening the live database through Beads' automatic recovery/migration path.
  // Exit 1 means diagnostics found warnings/errors; inspect the report below.
  const health = invoke(receipt, ['doctor'], [1]);
  const checks = Array.isArray(health.checks) ? health.checks : [];
  const sync = checks.find(check => check.name === 'sync.metadata')?.details;
  const allowedAnomalies = new Set(['db_newer']);
  if (sync?.db_newer === true) {
    allowedAnomalies.add('db_jsonl_count_mismatch');
    allowedAnomalies.add('db_jsonl_id_set_mismatch');
  }
  if (sync?.jsonl_newer !== false || sync?.pending_import !== false
      || !['healthy', 'degraded'].includes(health.workspace_health)
      || checks.some(check => !['ok', 'warn'].includes(check.status))
      || ['schema.tables', 'schema.columns', 'sqlite.integrity_check', 'db.recoverable_anomalies', 'sync.merge_pending']
        .some(name => !checks.some(check => check.name === name && check.status === 'ok'))
      || !Array.isArray(health.reliability_audit?.anomalies)
      || health.reliability_audit.anomalies.some(item => !allowedAnomalies.has(item.code))) {
    throw new Error('Beads store needs reconciliation or repair; inspect br doctor before logging findings.');
  }
  return receipt;
}

function validateFindings(findings) {
  if (!Array.isArray(findings)) throw new Error('findings must be an array.');
  const keys = new Set();
  for (const finding of findings) {
    if (!finding || ['causalKey', 'title', 'location', 'rootCause', 'impact', 'recommendation', 'evidence'].some(
      key => typeof finding[key] !== 'string' || !finding[key].trim(),
    ) || !Object.hasOwn(priorities, finding.severity)
      || !['substantive defect', 'supporting obligation'].includes(finding.kind)
      || !Array.isArray(finding.sources) || !finding.sources.length
      || finding.sources.some(source => !['Claude', 'Codex', 'Cursor'].includes(source))
      || (finding.reuseIssueId != null && (typeof finding.reuseIssueId !== 'string' || !finding.reuseIssueId.trim()))) {
      throw new Error('Invalid final finding: causalKey, title, location, rootCause, impact, recommendation, evidence, severity, kind, and sources required.');
    }
    if (keys.has(finding.causalKey)) throw new Error('Deduplicate final findings by causalKey before logging.');
    keys.add(finding.causalKey);
  }
}

function selectIssue(issues, finding) {
  const reference = `comprehensive-review:${sha(finding.causalKey)}`;
  if (finding.reuseIssueId) {
    const issue = issues.find(item => item.id === finding.reuseIssueId);
    if (!issue || !active.has(issue.status)) throw new Error(`Cannot reuse inactive or missing issue ${finding.reuseIssueId}.`);
    return { issue, reference };
  }
  let candidate = reference;
  let recurrenceOf = null;
  for (let i = 0; i <= issues.length; i++) {
    const matches = issues.filter(item => item.external_ref === candidate);
    if (matches.length > 1) throw new Error(`Ambiguous Beads external reference ${candidate}.`);
    const issue = matches[0];
    if (!issue) return { reference: candidate, recurrenceOf };
    if (active.has(issue.status)) return { issue, reference: candidate };
    if (!['closed', 'tombstone'].includes(issue.status)) throw new Error(`Unsupported issue status ${issue.status}.`);
    recurrenceOf = issue.id;
    candidate = `${reference}:after:${sha(issue.id)}`;
  }
  throw new Error('Invalid Beads recurrence chain.');
}

function issueMetadata(csv) {
  const rows = [];
  let row = [];
  const field = /(?:"((?:[^"]|"")*)"|([^",\r\n]*))(,|\r?\n|$)/y;
  let offset = 0;
  while (offset < csv.length) {
    field.lastIndex = offset;
    const match = field.exec(csv);
    if (!match || field.lastIndex === offset) throw new Error('Invalid Beads metadata CSV.');
    row.push(match[1] === undefined ? match[2] : match[1].replaceAll('""', '"'));
    offset = field.lastIndex;
    if (match[3] !== ',') { rows.push(row); row = []; }
  }
  if (row.length || JSON.stringify(rows.shift()) !== JSON.stringify(['id', 'status', 'external_ref'])
      || rows.some(fields => fields.length !== 3 || !fields[0] || !fields[1])) {
    throw new Error('Invalid or incomplete Beads metadata CSV.');
  }
  return rows.map(([id, status, external_ref]) => ({
    // br escapes spreadsheet formulas. Valid IDs can begin with '-', but cannot
    // contain apostrophes. Our comprehensive-review: references need no decoding.
    id: id.startsWith("'-") ? id.slice(1) : id, status, external_ref,
  }));
}

function listIssues(receipt) {
  const issues = new Map();
  const pageSize = 128;
  // br's "all" still omits tombstones; query them explicitly for recurrence keys.
  for (const status of ['all', 'tombstone']) {
    for (let offset = 0; ; offset += pageSize) {
      const rows = issueMetadata(invokeText(receipt, ['list', '--status', status,
        '--sort', 'created_at', '--limit', String(pageSize), '--offset', String(offset),
        '--format', 'csv', '--fields', 'id,status,external_ref']));
      for (const issue of rows) issues.set(issue.id, issue);
      if (rows.length < pageSize) break;
    }
  }
  return [...issues.values()];
}

export async function logFindings(receipt, result) {
  validateFindings(result.findings);
  const current = preflight(receipt.cwd);
  if (JSON.stringify(current) !== JSON.stringify(receipt)) throw new Error('Beads destination changed since preflight.');
  if (!result.scope || !receipt.excludePaths.every(p => result.scope.excludePaths?.includes(p))) {
    throw new Error('The Beads store must be excluded before the initial review fingerprint.');
  }
  const capture = await captureFingerprint({ ...result.scope, cwd: receipt.cwd });
  if (!capture.complete || capture.repoRoot !== receipt.cwd || capture.fingerprint !== result.fingerprint) throw new Error('Final review scope is incomplete or changed; no findings logged.');
  const issues = listIssues(receipt);
  // Validate all explicit references before the first write.
  const planned = result.findings.map(finding => ({ finding, ...selectIssue(issues, finding) }));
  const outcomes = [];
  const directory = mkdtempSync(path.join(tmpdir(), 'jig-beads-findings-'));
  try {
    for (const { finding, issue, reference, recurrenceOf } of planned) {
      if (issue) { outcomes.push({ causalKey: finding.causalKey, id: issue.id, action: 'reused' }); continue; }
      const body = [
        `Location: ${finding.location}`, `Severity: ${finding.severity}`, `Kind: ${finding.kind}`,
        `Sources: ${finding.sources.join(', ')}`, `Scope fingerprint: ${result.fingerprint}`,
        `Scope: ${JSON.stringify(result.scope)}`, `Causal key: ${finding.causalKey}`,
        ...(recurrenceOf ? [`Recurrence of: ${recurrenceOf}`] : []),
        '', `Root cause: ${finding.rootCause}`, `Impact: ${finding.impact}`, `Evidence: ${finding.evidence}`,
        `Recommendation: ${finding.recommendation}`,
      ].join('\n');
      const bodyPath = path.join(directory, 'description.md');
      try {
        writeFileSync(bodyPath, body, { mode: 0o600 });
        const created = invoke(receipt, ['create', `--title=${finding.title}`, '--description-file', bodyPath,
          '--type', finding.kind === 'substantive defect' ? 'bug' : 'task', '--priority', String(priorities[finding.severity]),
          '--external-ref', reference, '--labels', 'comprehensive-review', '--status', 'open']);
        if (typeof created.id !== 'string') throw new Error('Create returned no confirmed issue ID.');
        outcomes.push({ causalKey: finding.causalKey, id: created.id, action: 'created' });
      } catch (error) {
        // A timeout may follow a committed write. Requery without retrying the mutation.
        try {
          const found = listIssues(receipt).filter(item => item.external_ref === reference);
          if (found.length === 1) outcomes.push({ causalKey: finding.causalKey, id: found[0].id, action: 'confirmed-after-error' });
        } catch {}
        return { complete: false, outcomes, failedCausalKey: finding.causalKey, error: error.message };
      }
    }
    return { complete: true, outcomes };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, first, second, ...extra] = process.argv.slice(2);
    let output;
    if (command === 'preflight' && first && !second) output = preflight(first);
    else if (command === 'log' && first && second && !extra.length) {
      output = await logFindings(JSON.parse(readFileSync(first, 'utf8')), JSON.parse(readFileSync(second, 'utf8')));
      if (!output.complete) process.exitCode = 1;
    } else throw new Error('Usage: beads-findings.mjs preflight <repository> | log <receipt.json> <final-findings.json>');
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) { process.stderr.write(`beads-findings: ${error.message}\n`); process.exitCode = 1; }
}
