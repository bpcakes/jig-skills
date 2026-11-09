import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withControllerLeaseSync } from "../skills/review-fix-loop/scripts/controller-lease.mjs";

test("lease polling reuses only the location and checks current authority every time", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jig-lease-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const boundary = path.join(root, "boundary.py"), state = path.join(root, "controls.json");
  writeFileSync(state, JSON.stringify({ paused: false }));
  writeFileSync(boundary, `import fcntl,json,pathlib,sys
root=pathlib.Path(${JSON.stringify(root)})
mode=sys.argv[-2]
with (root/'calls').open('a') as out: out.write(mode+'\\n')
if mode=='--lease-path':
    (root/'lease').touch(mode=0o600,exist_ok=True)
    print(json.dumps({'path':str(root/'lease')}))
else:
    controls=json.loads((root/'controls.json').read_text())
    if controls.get('revoked'): sys.exit(2)
    fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)
    print(json.dumps(controls))
`);
  const run = { root, config: { executionBoundary: ["/usr/bin/python3", boundary] } };
  assert.equal(withControllerLeaseSync(run, controls => controls.paused), false);
  writeFileSync(state, JSON.stringify({ paused: true }));
  assert.equal(withControllerLeaseSync(run, controls => controls.paused), true);
  writeFileSync(state, JSON.stringify({ revoked: true }));
  assert.throws(() => withControllerLeaseSync(run, () => assert.fail("revoked callback")));
  const calls = readFileSync(path.join(root, "calls"), "utf8").trim().split("\n");
  assert.equal(calls.filter(line => line === "--lease-path").length, 1);
  assert.equal(calls.filter(line => line === "--lock-publication").length, 3);
  writeFileSync(state, JSON.stringify({ paused: false }));
  run.config.executionBoundary.push("changed-policy-identity");
  withControllerLeaseSync(run, () => {});
  assert.equal(readFileSync(path.join(root, "calls"), "utf8").match(/--lease-path/g).length, 2);
});
