import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preflight, logFindings } from '../skills/comprehensive-review/scripts/beads-findings.mjs';
import { captureFingerprint } from '../skills/comprehensive-review/scripts/scope-fingerprint.mjs';
import { gitEnvironment } from '../skills/comprehensive-review/scripts/git-environment.mjs';

const available = spawnSync('br', ['--version'], { timeout: 10_000 }).status === 0;
if (process.env.JIG_REVIEW_REQUIRE_BEADS === '1' && !available) {
  throw new Error('JIG_REVIEW_REQUIRE_BEADS=1 requires a working br executable on PATH; Beads coverage cannot be skipped.');
}
const skip = available ? false : 'br unavailable: install Beads to run tracker integration tests (CONTRIBUTING.md).';
const finding = { causalKey: 'scheduler/queued-cancellation', title: 'Cancel queued jobs', location: 'jobs.mjs:1', severity: 'medium', kind: 'substantive defect', sources: ['Codex'], rootCause: 'cancel only checks running state', impact: 'Queued jobs execute after cancellation', evidence: 'cancel queued; drain executes job', recommendation: 'Handle queued state in scheduler.cancel; verify both callers' };
function fixture(t, prefix = 'test') {
  const cwd = mkdtempSync(path.join(tmpdir(), 'jig-beads-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, env: gitEnvironment(), encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(path.join(cwd, 'jobs.mjs'), 'export const jobs = [];\n');
  git('add', 'jobs.mjs'); git('commit', '-qm', 'base');
  const br = (...args) => execFileSync('br', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  br('init', `--prefix=${prefix}`);
  br('sync', '--import-only');
  const receipt = preflight(cwd);
  const scope = { scope: 'working-tree', excludePaths: receipt.excludePaths };
  const payload = async (findings = [finding]) => ({ scope, fingerprint: (await captureFingerprint({ cwd, ...scope })).fingerprint, findings });
  const issues = () => JSON.parse(br('--no-auto-import', '--no-auto-flush', 'list', '--status', 'all', '--limit', '0', '--json')).issues;
  return { cwd, git, br, receipt, payload, issues };
}

function trackerSnapshot(store, { allowReaderMarks = false } = {}) {
  return Object.fromEntries(readdirSync(store, { recursive: true }).sort().map(name => {
    const file = path.join(store, name);
    const stat = statSync(file);
    return [name, { ino: stat.ino, mode: stat.mode,
      // Healthy SQLite read connections can update transient SHM reader marks.
      // Still require its identity/mode, and every durable file's exact bytes.
      ...(stat.isFile() && !(allowReaderMarks && name === 'beads.db-shm')
        ? { hash: createHash('sha256').update(readFileSync(file)).digest('hex') } : {}),
    }];
  }));
}

test('Beads preflight preserves healthy storage with pending exports', { skip }, t => {
  const f = fixture(t);
  f.br('--no-auto-import', '--no-auto-flush', 'create', '--title=Unexported work');
  const before = trackerSnapshot(f.receipt.store.path, { allowReaderMarks: true });
  assert.deepEqual(preflight(f.cwd), f.receipt);
  assert.deepEqual(trackerSnapshot(f.receipt.store.path, { allowReaderMarks: true }), before);
});

test('Beads preflight rejects pending imports without reconciling them', { skip }, t => {
  const f = fixture(t);
  f.br('create', '--title=Exported work');
  f.br('sync', '--flush-only');
  const jsonlPath = path.join(f.receipt.store.path, 'issues.jsonl');
  const issue = JSON.parse(readFileSync(jsonlPath, 'utf8').trim());
  writeFileSync(jsonlPath, JSON.stringify({ ...issue, title: 'Incoming edit', updated_at: '2099-01-01T00:00:00Z' }) + '\n');
  const before = trackerSnapshot(f.receipt.store.path, { allowReaderMarks: true });
  assert.throws(() => preflight(f.cwd), /needs reconciliation or repair/);
  assert.deepEqual(trackerSnapshot(f.receipt.store.path, { allowReaderMarks: true }), before);
});

test('Beads rejects corrupt storage without rebuilding it from valid JSONL', { skip }, async t => {
  const f = fixture(t);
  f.br('create', '--title=Exported work');
  f.br('sync', '--flush-only');
  const result = await f.payload();
  // Remove the fixture's database family, retaining valid recovery source data.
  for (const name of readdirSync(f.receipt.store.path)) {
    if (name.startsWith('beads.db')) rmSync(path.join(f.receipt.store.path, name), { recursive: true, force: true });
  }
  writeFileSync(f.receipt.database.path, 'corrupt database; do not repair\n');
  const before = trackerSnapshot(f.receipt.store.path);
  assert.throws(() => preflight(f.cwd), /needs reconciliation or repair/);
  assert.deepEqual(trackerSnapshot(f.receipt.store.path), before);
  await assert.rejects(logFindings(f.receipt, result), /needs reconciliation or repair/);
  assert.deepEqual(trackerSnapshot(f.receipt.store.path), before);
});

test('real Beads create, reuse, recurrence, and empty results preserve source and index', { skip }, async t => {
  const f = fixture(t);
  const index = readFileSync(path.join(f.cwd, '.git/index'));
  const result = await f.payload();
  const first = await logFindings(f.receipt, result);
  assert.equal(first.complete, true);
  const id = first.outcomes[0].id;
  assert.equal(first.outcomes[0].action, 'created');
  assert.equal(f.issues().length, 1);
  assert.match(f.issues()[0].description, /scheduler.cancel/);
  assert.equal((await logFindings(f.receipt, result)).outcomes[0].id, id);
  assert.equal(f.issues().length, 1);
  f.br('close', id);
  const recurrence = await logFindings(f.receipt, result);
  assert.equal(recurrence.complete, true);
  assert.notEqual(recurrence.outcomes[0].id, id);
  assert.equal(f.issues().length, 2);
  assert.match(f.issues().find(item => item.id !== id).description, new RegExp(`Recurrence of: ${id}`));
  assert.equal((await logFindings(f.receipt, result)).outcomes[0].id, recurrence.outcomes[0].id);
  assert.deepEqual(await logFindings(f.receipt, await f.payload([])), { complete: true, outcomes: [] });
  assert.deepEqual(readFileSync(path.join(f.cwd, '.git/index')), index);
  assert.equal(readFileSync(path.join(f.cwd, 'jobs.mjs'), 'utf8'), 'export const jobs = [];\n');
});

test('Beads stores the priority and issue type for every severity and finding kind', { skip }, async t => {
  const f = fixture(t);
  const cases = [];
  for (const [severity, priority] of [['critical', 0], ['high', 1], ['medium', 2], ['low', 3]]) {
    for (const [kind, issueType] of [['substantive defect', 'bug'], ['supporting obligation', 'task']]) {
      cases.push({ finding: { ...finding, causalKey: `metadata/${severity}/${issueType}`, severity, kind }, priority, issueType });
    }
  }
  const logged = await logFindings(f.receipt, await f.payload(cases.map(item => item.finding)));
  assert.equal(logged.complete, true, logged.error);
  assert.equal(logged.outcomes.length, cases.length);
  const stored = new Map(f.issues().map(issue => [issue.id, issue]));
  for (const { finding: input, priority, issueType } of cases) {
    const outcome = logged.outcomes.find(item => item.causalKey === input.causalKey);
    assert.equal(outcome.action, 'created');
    const issue = stored.get(outcome.id);
    assert.equal(issue.priority, priority, input.causalKey);
    assert.equal(issue.issue_type, issueType, input.causalKey);
  }
});

test('Beads checks all findings and final scope before any mutation', { skip }, async t => {
  const f = fixture(t);
  const good = await f.payload();
  await assert.rejects(logFindings(f.receipt, { ...good, findings: [finding, { ...finding, causalKey: 'other', severity: 'unknown' }] }), /Invalid final finding/);
  await assert.rejects(logFindings(f.receipt, { ...good, findings: [finding, { ...finding, causalKey: 'other', reuseIssueId: 'missing' }] }), /Cannot reuse/);
  await assert.rejects(logFindings(f.receipt, { ...good, scope: { scope: 'working-tree', excludePaths: [] } }), /must be excluded/);
  writeFileSync(path.join(f.cwd, 'jobs.mjs'), 'changed\n');
  await assert.rejects(logFindings(f.receipt, good), /scope is incomplete or changed/);
  assert.equal(f.issues().length, 0);
});

test('Beads reuses a manually created equivalent issue only by explicit active ID', { skip }, async t => {
  const f = fixture(t);
  const issue = JSON.parse(f.br('create', '--title', 'Existing issue', '--description', 'Original body', '--json'));
  const logged = await logFindings(f.receipt, await f.payload([{ ...finding, reuseIssueId: issue.id }]));
  assert.equal(logged.outcomes[0].action, 'reused');
  assert.equal(f.issues().length, 1);
  assert.equal(f.issues()[0].description, 'Original body');
  f.br('close', issue.id);
  await assert.rejects(logFindings(f.receipt, await f.payload([{ ...finding, reuseIssueId: issue.id }])), /Cannot reuse/);
});

test('Beads refuses a replaced database rather than writing another destination', { skip }, async t => {
  const f = fixture(t);
  const result = await f.payload();
  // A second real tracker supplies a coherent but different database identity.
  const replacement = fixture(t);
  renameSync(f.receipt.database.path, `${f.receipt.database.path}.retained`);
  writeFileSync(f.receipt.database.path, readFileSync(replacement.receipt.database.path));
  await assert.rejects(logFindings(f.receipt, result), /destination changed/);
});

test('Beads reports a committed write after command failure without retrying it', { skip }, async t => {
  const realBr = execFileSync('which', ['br'], { encoding: 'utf8' }).trim();
  const dir = mkdtempSync(path.join(tmpdir(), 'jig-br-wrapper-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wrapper = path.join(dir, 'br');
  writeFileSync(wrapper, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realBr)}, args, { stdio: 'inherit' });
process.exit(args.includes('create') && args.includes('--title=Fail after write') ? 1 : result.status ?? 1);
`);
  chmodSync(wrapper, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  const f = fixture(t);
  const result = await f.payload([finding, { ...finding, causalKey: 'second', title: 'Fail after write' }, { ...finding, causalKey: 'third' }]);
  const failed = await logFindings(f.receipt, result);
  assert.equal(failed.complete, false);
  assert.deepEqual(failed.outcomes.map(item => item.action), ['created', 'confirmed-after-error']);
  assert.equal(failed.failedCausalKey, 'second');
  assert.equal(f.issues().length, 2);
  const retried = await logFindings(f.receipt, result);
  assert.equal(retried.complete, true);
  assert.deepEqual(retried.outcomes.map(item => item.action), ['reused', 'reused', 'created']);
  assert.equal(f.issues().length, 3);
});

test('Beads treats tombstoned issues as previous occurrences', { skip }, async t => {
  const f = fixture(t);
  const result = await f.payload();
  const first = await logFindings(f.receipt, result);
  f.br('delete', first.outcomes[0].id);
  const again = await logFindings(f.receipt, result);
  assert.equal(again.complete, true);
  assert.notEqual(again.outcomes[0].id, first.outcomes[0].id);
  assert.equal((await logFindings(f.receipt, result)).outcomes[0].id, again.outcomes[0].id);
});

test('Beads preserves flag-like titles as data throughout a complete batch and retry', { skip }, async t => {
  const f = fixture(t);
  const titles = ['Normal title', '--log-to-beads loses findings', '-short option', '--status=closed', 'Quotes " and spaces', 'Final title'];
  const result = await f.payload(titles.map((title, index) => ({ ...finding, causalKey: `title/${index}`, title })));
  const first = await logFindings(f.receipt, result);
  assert.equal(first.complete, true, first.error);
  assert.equal(first.outcomes.length, titles.length);
  const stored = new Map(f.issues().map(issue => [issue.id, issue]));
  assert.deepEqual(first.outcomes.map(outcome => stored.get(outcome.id).title), titles);
  assert.ok([...stored.values()].every(issue => issue.status === 'open'));
  const again = await logFindings(f.receipt, result);
  assert.equal(again.complete, true, again.error);
  assert.deepEqual(again.outcomes.map(outcome => outcome.id), first.outcomes.map(outcome => outcome.id));
  assert.ok(again.outcomes.every(outcome => outcome.action === 'reused'));
  assert.equal(f.issues().length, titles.length);
});

test('Beads rejects effective JSONL-only settings before review and publication without writing', { skip }, async t => {
  const f = fixture(t);
  const result = await f.payload();
  const configPath = path.join(f.cwd, '.beads/config.yaml');
  const jsonlPath = path.join(f.cwd, '.beads/issues.jsonl');
  const originalJsonl = readFileSync(jsonlPath);
  for (const setting of ['no-db: true', 'no_db: true', 'no.db: true', 'no-db: "yes"']) {
    writeFileSync(configPath, `${setting}\n`);
    assert.throws(() => preflight(f.cwd), /requires database mode/, setting);
    await assert.rejects(logFindings(f.receipt, result), /requires database mode/, setting);
    assert.deepEqual(readFileSync(jsonlPath), originalJsonl);
  }
  writeFileSync(configPath, 'no-db: false\n');
  assert.equal(f.issues().length, 0);
  assert.equal((await logFindings(f.receipt, result)).complete, true);
  assert.equal(f.issues().length, 1);
  assert.deepEqual(readFileSync(jsonlPath), originalJsonl);
});

test('Beads publishes and reuses findings with descriptions larger than the command output budget', { skip }, async t => {
  const f = fixture(t);
  const dir = mkdtempSync(path.join(tmpdir(), 'jig-beads-large-body-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bodyPath = path.join(dir, 'body.txt');
  writeFileSync(bodyPath, 'x'.repeat(9 * 1024 * 1024));
  f.br('--no-auto-import', '--no-auto-flush', 'create', '--title=Large existing issue',
    '--description-file', bodyPath, '--external-ref', 'other,"quoted",reference');
  const result = await f.payload();
  const first = await logFindings(f.receipt, result);
  assert.equal(first.complete, true, first.error);
  assert.equal(first.outcomes[0].action, 'created');
  const again = await logFindings(f.receipt, result);
  assert.equal(again.complete, true, again.error);
  assert.deepEqual(again.outcomes, [{ ...first.outcomes[0], action: 'reused' }]);
});

test('Beads finds active and tombstoned occurrences beyond the first metadata page', { skip }, async t => {
  const f = fixture(t);
  const seed = JSON.parse(f.br('create', '--title=Seed', '--json'));
  const records = [seed];
  const sha = value => createHash('sha256').update(value).digest('hex');
  for (const status of ['open', 'tombstone']) {
    for (let i = 0; i < 130; i++) {
      const key = `${status}/${i}`;
      records.push({ ...seed, id: `test-${status}${i}`, title: key, status,
        created_at: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString(),
        external_ref: `comprehensive-review:${sha(key)}`,
        ...(status === 'tombstone' ? { deleted_at: seed.created_at } : {}),
      });
    }
  }
  writeFileSync(path.join(f.cwd, '.beads/issues.jsonl'), records.map(row => JSON.stringify(row)).join('\n') + '\n');
  f.br('sync', '--import-only');
  // Explicit import may replace the database; pin the completed fixture's identity.
  const receipt = preflight(f.cwd);
  // Both ends of each sorted inventory exercise pagination regardless of sort direction.
  const findings = ['open/0', 'open/129', 'tombstone/0', 'tombstone/129'].map(causalKey => ({ ...finding, causalKey }));
  const result = await f.payload(findings);
  const first = await logFindings(receipt, result);
  assert.equal(first.complete, true, first.error);
  assert.deepEqual(first.outcomes.map(item => item.action), ['reused', 'reused', 'created', 'created']);
  assert.deepEqual(first.outcomes.slice(0, 2).map(item => item.id), ['test-open0', 'test-open129']);
  for (const [index, key] of ['tombstone/0', 'tombstone/129'].entries()) {
    const issue = f.issues().find(item => item.id === first.outcomes[index + 2].id);
    assert.equal(issue.external_ref, `comprehensive-review:${sha(key)}:after:${sha(`test-${key.replace('/', '')}`)}`);
  }
  const again = await logFindings(receipt, result);
  assert.deepEqual(again.outcomes, first.outcomes.map(item => ({ ...item, action: 'reused' })));
});

test('Beads preserves IDs escaped by its CSV spreadsheet protection', { skip }, async t => {
  const f = fixture(t, '-test');
  const result = await f.payload();
  const first = await logFindings(f.receipt, result);
  assert.equal(first.complete, true, first.error);
  assert.ok(first.outcomes[0].id.startsWith('-test-'));
  const again = await logFindings(f.receipt, result);
  assert.deepEqual(again.outcomes, [{ ...first.outcomes[0], action: 'reused' }]);
  const explicit = await logFindings(f.receipt, await f.payload([{ ...finding, reuseIssueId: first.outcomes[0].id }]));
  assert.deepEqual(explicit.outcomes, again.outcomes);
  assert.equal(f.issues().length, 1);
});
