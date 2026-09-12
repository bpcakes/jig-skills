import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = process.env.EVAL_TEST_RUNNER || path.join(here, 'run.mjs');
const alive = pid => {
  try {
    process.kill(pid, 0);
    // An exited, unreaped descendant is not a running provider process.
    if (process.platform === 'linux' && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
    return true;
  } catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) return false; throw error; }
};
async function until(predicate, label) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(20);
  }
}

test('terminal SIGINT during fixture Git setup starts no provider or subsequent trial', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jig-eval-setup-cancel-'));
  const bin = path.join(dir, 'bin'), scratch = path.join(dir, 'tmp'), out = path.join(dir, 'run');
  mkdirSync(bin); mkdirSync(scratch);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  for (const [name, file] of [['codex', 'codex-stub.cjs'], ['git', 'git-interrupt-stub.cjs']]) {
    writeFileSync(path.join(bin, name), readFileSync(path.join(here, 'fixtures', file)), { mode: 0o755 });
  }
  const marker = path.join(dir, 'git-ready.json');
  const child = spawn(process.execPath, [runner, '--live', '--case', 'rust-implicit-simplify', '--repeat', '2', '--output', out], {
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TMPDIR: scratch,
      EVAL_REAL_GIT: realGit, EVAL_GIT_READY: marker, EVAL_STUB_SCENARIO: 'allowed' },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let closed = false, exit, output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  child.on('close', code => { closed = true; exit = code; });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} rmSync(dir, { recursive: true, force: true }); });
  await until(() => existsSync(marker) || closed, 'synchronous Git readiness');
  assert.equal(closed, false, output);
  const git = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(alive(git.pid), true);
  process.kill(-child.pid, 'SIGINT'); // Terminal-style signal to runner AND Git.
  await until(() => closed, 'setup cancellation');
  assert.equal(exit, 1, output);
  const summary = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.state, 'interrupted');
  assert.equal(summary.results.length, 1, 'must not advance to another trial');
  assert.match(summary.results[0].error, /Interrupted by SIGINT/);
  assert.deepEqual(summary.results[0].phases, { agent: 'not-started', judge: 'not-started' });
  assert.equal(existsSync(path.join(out, 'rust-implicit-simplify-1/agent.command.json')), false);
  assert.equal(existsSync(path.join(out, 'rust-implicit-simplify-2')), false);
});

for (const [phase, signal] of [['agent', 'SIGINT'], ['grade', 'SIGTERM']]) {
  test(`cancellation terminates ${phase} process group and retains incomplete trial evidence`, async t => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jig-eval-cancel-'));
    const bin = path.join(dir, 'bin'), scratch = path.join(dir, 'tmp'), out = path.join(dir, 'run');
    mkdirSync(bin); mkdirSync(scratch);
    writeFileSync(path.join(bin, 'codex'), readFileSync(path.join(here, 'fixtures/codex-stub.cjs')), { mode: 0o755 });
    const child = spawn(process.execPath, [runner, '--live', '--case', 'rust-implicit-simplify', '--repeat', '2', '--output', out], {
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TMPDIR: scratch, EVAL_STUB_SCENARIO: `signal-${phase}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', closed = false, exit;
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('close', (code, sig) => { closed = true; exit = { code, signal: sig }; });
    let ready;
    t.after(() => {
      child.kill('SIGKILL');
      // Also clean deliberately orphaned baseline providers after the assertions.
      if (ready) { try { process.kill(-ready.pid, 'SIGKILL'); } catch {} }
      rmSync(dir, { recursive: true, force: true });
    });
    const marker = path.join(out, 'rust-implicit-simplify-1/signal-ready.json');
    await until(() => existsSync(marker) || closed, 'provider readiness');
    assert.equal(closed, false, output);
    ready = JSON.parse(readFileSync(marker, 'utf8'));
    const summaryPath = path.join(out, 'summary.json');
    const before = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : null;
    assert.equal(alive(ready.pid), true);
    assert.equal(alive(ready.descendant), true);
    child.kill(signal);
    await until(() => closed, 'runner termination');
    assert.equal(alive(ready.pid), false, 'provider must stop with the runner');
    assert.equal(alive(ready.descendant), false, 'provider descendants must stop with the runner');
    assert.equal(exit.code, 1, output);
    assert.equal(before?.state, 'running');
    assert.deepEqual(before.plannedTrials, [{ id: 'rust-implicit-simplify', iteration: 1 }, { id: 'rust-implicit-simplify', iteration: 2 }]);
    const summary = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8'));
    assert.equal(summary.state, 'interrupted');
    assert.equal(summary.results.length, 1);
    assert.equal(summary.results[0].passed, false);
    assert.match(summary.results[0].error, new RegExp(signal));
    assert.deepEqual(summary.results[0].phases,
      phase === 'agent' ? { agent: 'attempted', judge: 'not-started' } : { agent: 'completed', judge: 'attempted' });
    const execution = JSON.parse(readFileSync(path.join(out, `rust-implicit-simplify-1/${phase}.execution.json`), 'utf8'));
    assert.equal(execution.stopReason, 'cancelled');
    assert.equal(execution.timedOut, false);
    assert.equal(existsSync(path.join(out, 'rust-implicit-simplify-2')), false);
    if (phase === 'grade') assert.equal(existsSync(ready.cwd), false);
  });
}
