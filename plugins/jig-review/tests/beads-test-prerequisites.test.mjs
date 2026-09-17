import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

for (const required of [true, false]) {
  test(`missing Beads ${required ? 'fails required coverage' : 'reports an explicit optional skip'}`, t => {
    const emptyPath = mkdtempSync(path.join(tmpdir(), 'jig-no-beads-'));
    t.after(() => rmSync(emptyPath, { recursive: true, force: true }));
    const env = { ...process.env, PATH: emptyPath, JIG_REVIEW_REQUIRE_BEADS: required ? '1' : '0' };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(new URL('./beads-findings.test.mjs', import.meta.url))], {
      cwd: emptyPath, env, encoding: 'utf8', timeout: 15_000,
    });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    if (required) {
      assert.equal(result.status, 1, output);
      assert.match(output, /Beads coverage cannot be skipped/);
    } else {
      assert.equal(result.status, 0, output);
      assert.match(output, /# SKIP br unavailable/);
      assert.match(output, /# pass 0\b/);
    }
  });
}
