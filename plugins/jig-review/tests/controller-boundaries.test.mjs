import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { advance, createRun, prune, release, status, submit, TERMINAL } from "../skills/review-fix-loop/scripts/review-fix-loop.mjs";
import { discoverValidation } from "../skills/review-fix-loop/scripts/task-contract.mjs";
import { parseArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";
import { loadRun, locked, readJSON } from "../skills/review-fix-loop/scripts/run-store.mjs";
import { reservedOverlays } from "../skills/review-fix-loop/scripts/repository.mjs";
import { assertStorage, storageLimits } from "../skills/review-fix-loop/scripts/storage-budget.mjs";
import { defaultValidationSandbox, validationSandboxCommand } from "../skills/review-fix-loop/scripts/validation-sandbox.mjs";

const cli = fileURLToPath(new URL("../skills/review-fix-loop/scripts/review-fix-loop.mjs", import.meta.url));
const stub = fileURLToPath(new URL("./fixtures/loop-provider.mjs", import.meta.url));
const put = (root, name, text) => { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), text); };
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jig-boundary-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  put(root, "value.cjs", "module.exports = 2;\n");
  const contract = { goal: "Required behavior", acceptanceCriteria: [{ id: "value", description: "Required check passes" }], nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: [],
    requiredValidation: [{ id: "unit", argv: [process.execPath, "-e", "require('node:assert/strict').equal(require('./value.cjs'),2)"] }] };
  return { root, contract, async start(extra = {}) {
    const run = await createRun({ cwd: root, contract, ...extra });
    t.after(() => rmSync(path.dirname(run.workspaceRoot), { recursive: true, force: true }));
    return run;
  } };
}
const clean = () => ({ complete: true, findings: [], acceptance: [{ criterionId: "value", status: "satisfied", evidence: "Required check verifies the source", validationIds: ["unit"] }] });
async function drive(run, respond = a => a.role === "review" ? clean() : { decisions: [] }, observe = () => false) {
  for (let i = 0; i < 400; i++) {
    run = await advance(run.directory);
    if (await observe(run)) return run;
    if (TERMINAL.has(run.phase) && !run.cleanup?.length && !run.cleanupOverlays?.length) return run;
    if (run.pending && !run.pending.command) {
      const a = run.pending.assignment;
      await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint, ...respond(a, run) });
    }
    if (run.validationCycle?.job || run.pending?.command || run.cleanup?.length) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Run did not terminate: ${run.phase}`);
}
function sandboxAvailable(t) {
  if (process.platform === "linux" && spawnSync("bwrap", ["--unshare-net", "--ro-bind", "/", "/", "--", "true"]).status !== 0) { t.skip("Bubblewrap/user namespaces unavailable"); return false; }
  return true;
}

function repairResponse(a, run, recovery = false) {
  const fixed = readFileSync(path.join(run.root, "value.cjs"), "utf8").includes("= 2;");
  if (a.role === "review") return { ...clean(), findings: fixed ? [] : [{ key: "value", path: "value.cjs", severity: "medium", title: "Wrong export", evidence: "Expected 2" }] };
  if (a.role === "triage") return { decisions: a.findings.map(f => ({ id: f.id, status: fixed && run.validation.some(v => v.outcome === "succeeded") ? "fixed" : "actionable", evidence: "Checked export and controller validation" })) };
  return { edits: [{ path: "value.cjs", content: `module.exports = ${recovery && run.round === 1 ? 3 : 2};\n`, reason: "Correct export", findingIds: a.findings.map(f => f.id) }] };
}

for (const boundary of ["after-apply", "before-terminal", "after-terminal"]) test(`late descriptor writes remain recovery obligations ${boundary}`, async t => {
  const f = fixture(t); put(f.root, "value.cjs", "module.exports = 1;\n");
  const fd = fs.openSync(path.join(f.root, "value.cjs"), "r+"); t.after(() => fs.closeSync(fd));
  let injected = false;
  const writeLate = () => { fs.writeSync(fd, Buffer.from("USER\n"), 0, 5, 0); injected = true; };
  let run = await drive(await f.start(), repairResponse, r => {
    if (!injected && (boundary === "after-apply" && r.completedApplications?.length || boundary === "before-terminal" && r.pass > 1 && r.phase === "TRIAGE" && r.reports.length === 2)) writeLate();
  });
  if (boundary === "after-terminal") { assert.equal(run.phase, "CONVERGED"); writeLate(); }
  else assert.equal(run.phase, "SCOPE_CHANGED", JSON.stringify(status(run)));
  assert.equal(injected, true); assert.equal(run.completedApplications.length, 1);
  const backup = run.completedApplications[0].changes[0].backup;
  assert.equal(run.apply, null); assert.equal(status(run).applicationRecovery.resolved, false);
  assert.match(readFileSync(backup, "utf8"), /^USER/);
  await assert.rejects(prune(run.directory), /active or unresolved recovery/);
  await assert.rejects(release(run.directory, f.root), /[Uu]nresolved.*recovery/);
  await assert.rejects(f.start(), /Unresolved application recovery/);
  run = await advance(run.directory);
  assert.equal(status(run).applicationRecovery.resolved, false);
  assert.equal(readJSON(path.join(run.runsRoot, "active.json")).state, undefined);
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 2;\n");
  assert.match(readFileSync(backup, "utf8"), /^USER/);
});

test("settlement receipts recheck retained backups even when workflow metadata is archived", async t => {
  const f = fixture(t); put(f.root, "value.cjs", "module.exports = 1;\n");
  const run = await drive(await f.start(), repairResponse), backup = run.completedApplications[0].changes[0].backup;
  const active = path.join(run.runsRoot, "active.json"), receipt = readJSON(active);
  assert.equal(receipt.backups.length, 1);
  renameSync(path.join(run.directory, "run.json"), path.join(run.directory, "run.json.saved"));
  put(path.dirname(backup), path.basename(backup), "late user work\n");
  await assert.rejects(release(run.directory, f.root), /Unresolved application recovery/);
  await assert.rejects(f.start(), /Unresolved application recovery/);
  assert.deepEqual(readJSON(active), receipt); assert.equal(readFileSync(backup, "utf8"), "late user work\n");
});

for (const archived of [false, true]) test(`successive runs retain earlier backup obligations${archived ? " with archived workflow metadata" : ""}`, async t => {
  const f = fixture(t), original = "module.exports = 1;\n"; put(f.root, "value.cjs", original);
  const fd = fs.openSync(path.join(f.root, "value.cjs"), "r+"); t.after(() => fs.closeSync(fd));
  const first = await drive(await f.start(), repairResponse);
  assert.equal(first.phase, "CONVERGED");
  const record = path.join(first.directory, "run.json");
  if (archived) renameSync(record, `${record}.saved`);
  const second = await drive(await f.start());
  assert.equal(second.phase, "CONVERGED"); assert.equal(second.completedApplications.length, 0);
  const active = path.join(first.runsRoot, "active.json"), receipt = readFileSync(active);
  fs.writeSync(fd, Buffer.from("USER\n"), 0, 5, 0);
  assert.equal(status(first).applicationRecovery.resolved, false);
  await assert.rejects(f.start(), /Unresolved application recovery/);
  assert.deepEqual(readFileSync(active), receipt);
  if (archived) renameSync(`${record}.saved`, record);
  await assert.rejects(prune(first.directory), /active or unresolved recovery/);
  // Reconcile the displaced work, then explicitly retire its backup obligation.
  fs.writeSync(fd, Buffer.from(original), 0, Buffer.byteLength(original), 0);
  assert.equal((await prune(first.directory)).phase, "PRUNED");
  assert.deepEqual(readFileSync(active), receipt, "Pruning the older run must preserve the current receipt");
  const third = await drive(await f.start());
  assert.equal(third.phase, "CONVERGED");
});

test("pruning the latest run cannot retire an older run's backup obligations", async t => {
  const f = fixture(t); put(f.root, "value.cjs", "module.exports = 1;\n");
  const fd = fs.openSync(path.join(f.root, "value.cjs"), "r+"); t.after(() => fs.closeSync(fd));
  const first = await drive(await f.start(), repairResponse);
  put(f.root, "value.cjs", "module.exports = 1;\n");
  const second = await drive(await f.start(), repairResponse);
  assert.equal(second.phase, "CONVERGED"); assert.equal(second.completedApplications.length, 1);
  assert.equal((await prune(second.directory)).phase, "PRUNED");
  assert.equal(existsSync(path.join(first.runsRoot, "active.json")), false);
  fs.writeSync(fd, Buffer.from("USER\n"), 0, 5, 0);
  await assert.rejects(f.start(), /Unresolved application recovery/);
  assert.match(readFileSync(first.completedApplications[0].changes[0].backup, "utf8"), /^USER/);
});

test("all completed rounds retain backup history without constraining later destination edits", async t => {
  const f = fixture(t); put(f.root, "value.cjs", "module.exports = 1;\n");
  const fd = fs.openSync(path.join(f.root, "value.cjs"), "r+"); t.after(() => fs.closeSync(fd));
  const run = await drive(await f.start(), (a, r) => repairResponse(a, r, true));
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run))); assert.equal(run.round, 2);
  assert.equal(run.completedApplications.length, 2);
  fs.unlinkSync(path.join(f.root, "value.cjs")); // A later user deletion is not interrupted publication.
  assert.equal((await release(run.directory, f.root)).phase, "RELEASED");
  fs.writeSync(fd, Buffer.from("USER\n"), 0, 5, 0);
  await assert.rejects(prune(run.directory), /active or unresolved recovery/);
  assert.equal(status(run).applicationRecovery.unresolvedPaths[0].path, "value.cjs");
});

test("legacy settlement cannot waive unjournaled backups or missing recovery metadata", async t => {
  const f = fixture(t); put(f.root, "value.cjs", "module.exports = 1;\n");
  const run = await drive(await f.start(), repairResponse), record = readJSON(path.join(run.directory, "run.json"));
  delete record.completedApplications;
  writeFileSync(path.join(run.directory, "run.json"), JSON.stringify(record));
  writeFileSync(path.join(run.runsRoot, "active.json"), JSON.stringify({ version: 1, state: "settled", directory: run.directory }));
  await assert.rejects(f.start(), /Unresolved application recovery/);
  await assert.rejects(release(run.directory, f.root), /active or unresolved recovery/);
  await assert.rejects(prune(run.directory), /active or unresolved recovery/);
  renameSync(path.join(run.directory, "run.json"), path.join(run.directory, "run.json.saved"));
  await assert.rejects(f.start(), /Restore any missing run records/);
  await assert.rejects(release(run.directory, f.root), /Unknown recovery state is not bypassed/);
});

test("isolated validation reclaims cycle scratch and actual cache output across recovery rounds", async t => {
  if (!sandboxAvailable(t)) return;
  const f = fixture(t); put(f.root, "value.cjs", "module.exports = 1;\n");
  f.contract.requiredValidation[0].argv[2] = "const fs=require('node:fs'),p=require('node:path');fs.mkdirSync(process.env.XDG_CACHE_HOME,{recursive:true});fs.writeFileSync(p.join(process.env.XDG_CACHE_HOME,'cache'),Buffer.alloc(512*1024));require('node:assert/strict').equal(require('./value.cjs'),2)";
  const scratches = new Set(), verifiedCaches = new Set();
  const run = await drive(await f.start({ config: { validationMode: "isolated" } }), (a, r) => repairResponse(a, r, true), r => {
    const scratch = r.validationCycle?.scratch;
    if (scratch && !scratches.has(scratch)) {
      for (const old of scratches) assert.equal(existsSync(old), false, "Previous cycle scratch must be gone before allocation");
      scratches.add(scratch);
      assert.ok(reservedOverlays(r).includes(scratch));
    }
    if (scratch && r.validationCycle.results.length && !verifiedCaches.has(scratch)) {
      assert.equal(statSync(path.join(scratch, "cache/cache")).size, 512 * 1024, "Cache bytes must come from the actual sandboxed validator");
      verifiedCaches.add(scratch);
    }
  });
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run))); assert.equal(run.round, 2); assert.equal(scratches.size, 2);
  assert.equal(verifiedCaches.size, 2);
  for (const scratch of scratches) assert.equal(existsSync(scratch), false);
  assert.deepEqual(reservedOverlays(run), []);
});

async function lockReleased(run) {
  const deadline = Date.now() + 3000;
  for (;;) {
    try { await locked(run.runsRoot, () => {}); return; }
    catch (error) { if (!/holds this repository lock/.test(error.message) || Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
  }
}
for (const point of ["allocation", "deletion"]) test(`interrupted scratch ${point} resumes without validation replay`, async t => {
  const f = fixture(t);
  let scratch;
  let run = await drive(await f.start(), undefined, r => {
    scratch ??= r.validationCycle?.scratch;
    return point === "allocation" ? r.phase === "VALIDATE" && !r.validationCycle : scratch && r.cleanupOverlays?.includes(scratch);
  });
  const inject = fileURLToPath(new URL(`./fixtures/interrupt-${point === "allocation" ? "resource" : "cleanup"}.mjs`, import.meta.url));
  const env = { ...process.env, ...(point === "allocation" ? { JIG_TEST_SCRATCH_FAULT: "kill" } : { JIG_TEST_CLEANUP_TARGET: scratch }) };
  const killed = spawnSync(process.execPath, ["--import", inject, cli, "advance", "--run", run.directory], { env, encoding: "utf8", timeout: 30000 });
  assert.equal(killed.signal, "SIGKILL", killed.stderr); await lockReleased(run);
  if (point === "allocation") scratch = reservedOverlays(run).find(p => path.basename(p).startsWith("scratch-"));
  assert.ok(scratch);
  run = await drive(loadRun(run.directory));
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run))); assert.equal(run.validation.length, 1);
  assert.equal(existsSync(scratch), false); assert.deepEqual(reservedOverlays(run), []);
});

for (const policy of ["balanced", "strict"]) test(`${policy} filters unavailable providers before counting a transient failed invocation`, async t => {
  const f = fixture(t); let failed = false;
  const providers = policy === "balanced" ? [{ id: "claude" }, { id: "codex" }]
    : [{ id: "claude", command: [process.execPath, stub, "success"] }, { id: "codex" }, { id: "cursor" }];
  const run = await drive(await f.start({ options: parseArgs(["--review-policy", policy, "--reviewers", providers.map(p => p.id).join(",")]), config: { reviewers: providers } }), a => {
    if (a.role !== "review") return { decisions: [] };
    if (!failed) { failed = true; return { error: "One completed transient failure" }; }
    return clean();
  });
  assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome));
  assert.equal(run.attempts.length, 3); assert.ok(run.attempts.every(a => a.id));
  assert.equal(run.slots.reduce((sum, slot) => sum + slot.attempts, 0), 3);
});

test("discovery and init use the same root and run the failing subpackage check", async t => {
  const f = fixture(t), app = path.join(f.root, "packages/app");
  put(f.root, "package.json", JSON.stringify({ scripts: { test: "echo ROOT" } }));
  put(f.root, "packages/app/package.json", JSON.stringify({ scripts: { test: "echo APP; exit 1" } }));
  const discovery = JSON.parse(execFileSync(process.execPath, [cli, "plan-validation", "--cwd", app], { encoding: "utf8" }));
  assert.deepEqual(discovery, discoverValidation(f.root));
  const { source, ...check } = discovery.candidates.find(c => c.source === "packages/app/package.json");
  assert.equal(check.cwd, "packages/app");
  f.contract.requiredValidation = [{ id: "unit", ...check }];
  const run = await drive(await f.start({ cwd: app }), a => a.role === "review" ? clean() : {
    decisions: a.findings.map(f => ({ id: f.id, status: "blocked", evidence: "App check really failed" })) });
  assert.equal(run.root, f.root); assert.notEqual(run.phase, "CONVERGED");
  assert.equal(run.validation[0].exitCode, 1); assert.match(run.validation[0].stdout, /APP/);
  assert.equal(run.validation[0].context.cwd, app);
});

for (const filename of ["__proto__", "constructor", "toString", "hasOwnProperty"]) for (const remove of [false, true]) {
  test(`prototype filename ${filename} ${remove ? "deletion" : "creation"} survives persisted repair and validation`, async t => {
    const f = fixture(t);
    if (remove) put(f.root, filename, "before");
    f.contract.requiredValidation[0].argv = [process.execPath, "-e", `require('node:assert/strict').equal(require('node:fs').existsSync(${JSON.stringify(filename)}),${!remove})`];
    const done = () => existsSync(path.join(f.root, filename)) !== remove;
    const run = await drive(await f.start(), a => a.role === "review" ? { ...clean(), findings: done() ? [] : [{ key: "file", path: filename, severity: "low", title: "Required file state", evidence: "File presence differs" }] }
      : a.role === "triage" ? { decisions: a.findings.map(f => ({ id: f.id, status: done() ? "fixed" : "actionable", evidence: "Verified file presence" })) }
        : { edits: [{ path: filename, ...(remove ? { delete: true } : { content: "after" }), reason: "Correct required file state", findingIds: a.findings.map(f => f.id) }] });
    assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome)); assert.equal(done(), true);
    assert.equal(Object.getPrototypeOf(loadRun(run.directory).expected.files), null);
  });
}

test("unsandboxed isolated validation stops before publishing a run", async t => {
  const f = fixture(t);
  await assert.rejects(f.start({ config: { validationMode: "isolated", validationSandbox: "host" } }), e => e.code === "UNSUPPORTED_REPOSITORY");
  assert.equal(existsSync(path.join(f.root, ".git/jig/review-fix/active.json")), false);
});

test("isolated validation cannot resolve ignored original workspace links or directly read original source", async t => {
  if (!sandboxAvailable(t)) return;
  const f = fixture(t);
  put(f.root, ".gitignore", "node_modules/\n");
  put(f.root, "packages/foo/index.js", "module.exports = 1;\n");
  mkdirSync(path.join(f.root, "node_modules")); symlinkSync("../packages/foo", path.join(f.root, "node_modules/foo"));
  put(f.root, "packages/bar/check.cjs", "require('node:assert/strict').equal(require('foo'),1); console.log('OLD-SOURCE-PASSED')");
  f.contract.requiredValidation[0].argv = [process.execPath, "packages/bar/check.cjs"];
  const run = await drive(await f.start({ config: { validationMode: "isolated" } }), a => a.role === "review" ? clean() : {
    decisions: a.findings.map(f => ({ id: f.id, status: "blocked", evidence: "Prepared dependencies are unavailable" })) });
  assert.notEqual(run.phase, "CONVERGED"); assert.notEqual(run.validation[0].exitCode, 0);
  assert.doesNotMatch(run.validation[0].stdout, /OLD-SOURCE-PASSED/);
  assert.equal(run.workspaceRoot.startsWith(f.root + path.sep), false);
  const overlay = path.join(path.dirname(run.workspaceRoot), "probe"), scratch = path.join(overlay, "scratch"); mkdirSync(scratch, { recursive: true });
  const command = validationSandboxCommand(defaultValidationSandbox(), overlay, scratch, [process.execPath, "-e", `require('node:assert/strict').throws(()=>require('node:fs').readFileSync(${JSON.stringify(path.join(f.root, "packages/foo/index.js"))}))`], [], f.root);
  const result = spawnSync(command.argv[0], command.argv.slice(1), { cwd: overlay, env: { ...process.env, ...command.environment }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(f.root, "packages/foo/index.js"), "utf8"), "module.exports = 1;\n");
});

test("source and retained storage limits stop before allocation without pruning existing data", async t => {
  const f = fixture(t);
  await assert.rejects(f.start({ config: { storage: { maxSourceBytes: 8 } } }), e => e.code === "STORAGE_LIMIT");
  const saved = path.join(f.root, ".git/jig/review-fix/retained/source"); put(f.root, ".git/jig/review-fix/retained/source", "keep"); truncateSync(saved, 40 * 1024 * 1024);
  await assert.rejects(f.start({ config: { storage: { maxSourceBytes: 1024 * 1024, maxRunBytes: 64 * 1024 * 1024, maxRetainedBytes: 64 * 1024 * 1024 } } }), e => e.code === "STORAGE_LIMIT");
  assert.equal(existsSync(saved), true); assert.equal(existsSync(path.join(f.root, ".git/jig/review-fix/active.json")), false);
  assert.throws(() => storageLimits({ maxSourceBytes: -1 }), /Invalid storage/);
});

test("ignored Rust-sized build artifacts do not consume retention limits during repair or validation", async t => {
  if (!sandboxAvailable(t)) return;
  const f = fixture(t), artifactBytes = 12 * 1024 ** 3;
  put(f.root, ".gitignore", "target/\n");
  put(f.root, "target/user-cache", "user build");
  truncateSync(path.join(f.root, "target/user-cache"), artifactBytes);
  put(f.root, "value.cjs", "module.exports = 1;\n");
  f.contract.requiredValidation.unshift({ id: "build", argv: [process.execPath, "-e",
    `const fs=require('node:fs');fs.mkdirSync('target',{recursive:true});fs.writeFileSync('target/generated','');fs.truncateSync('target/generated',${artifactBytes})`] });
  let repairs = 0;
  const run = await drive(await f.start({ config: { validationMode: "isolated" } }), (a, current) => {
    if (a.role !== "repair") return repairResponse(a, current);
    repairs++;
    put(a.repository, "target/diagnostic", "diagnostic build");
    truncateSync(path.join(a.repository, "target/diagnostic"), artifactBytes);
    put(a.repository, "value.cjs", "module.exports = 2;\n");
    return { workspaceEdits: [{ path: "value.cjs", reason: "Correct export", findingIds: a.findings.map(f => f.id) }] };
  });
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.equal(repairs, 1); assert.equal(run.round, 1);
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 2;\n");
  assert.equal(statSync(path.join(f.root, "target/user-cache")).size, artifactBytes);
  assert.equal(existsSync(path.join(f.root, "target/generated")), false);
  assert.equal(existsSync(path.join(f.root, "target/diagnostic")), false);
  assert.ok(run.validation.some(v => v.checkId === "build" && v.outcome === "succeeded"));
  assert.ok(run.validation.some(v => v.checkId === "unit" && v.outcome === "succeeded"));
  assert.deepEqual(reservedOverlays(run), []);
});

test("temporary build storage still enforces available disk space on its filesystem", async t => {
  const f = fixture(t), run = await f.start();
  mkdirSync(run.workspaceRoot, { recursive: true });
  const original = fs.statfsSync, inspected = [];
  fs.statfsSync = location => {
    inspected.push(location);
    return { bsize: 4096, bavail: location === run.workspaceRoot ? 0 : 1024 ** 3 };
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => assertStorage(run, 1024), e => e.code === "STORAGE_LIMIT" && /free reserve/.test(e.message));
    assert.ok(inspected.includes(run.directory)); assert.ok(inspected.includes(run.workspaceRoot));
  } finally { fs.statfsSync = original; syncBuiltinESMExports(); }
});

test("explicit pruning refuses active runs and removes only the named settled run", async t => {
  const f = fixture(t); let run = await f.start();
  await assert.rejects(prune(run.directory), /active or unresolved/);
  run = await drive(run);
  const source = readFileSync(path.join(f.root, "value.cjs"));
  const result = JSON.parse(execFileSync(process.execPath, [cli, "prune", "--run", run.directory], { encoding: "utf8" }));
  assert.equal(result.phase, "PRUNED"); assert.ok(result.removedBytes > 0);
  assert.equal(existsSync(run.directory), false); assert.equal(existsSync(path.dirname(run.workspaceRoot)), false);
  assert.deepEqual(readFileSync(path.join(f.root, "value.cjs")), source);
  assert.equal(existsSync(path.join(run.runsRoot, "active.json")), false);
});

test("pruning verifies Git ownership rather than trusting a self-consistent run record", async t => {
  const f = fixture(t), run = await f.start(), other = path.join(f.root, run.id);
  const record = readJSON(path.join(run.directory, "run.json"));
  put(other, "task-contract.json", readFileSync(path.join(run.directory, "task-contract.json")));
  put(other, "run.json", JSON.stringify({ ...record, directory: other, runsRoot: f.root, phase: "CONVERGED" }));
  put(other, "keep", "not a controller run");
  await assert.rejects(prune(other), /Invalid run ownership/);
  assert.equal(readFileSync(path.join(other, "keep"), "utf8"), "not a controller run");
  assert.equal(existsSync(run.directory), true);
});

test("an oversized repair stops once with its source and recovery budget preserved", async t => {
  const f = fixture(t), before = readFileSync(path.join(f.root, "value.cjs"));
  const run = await drive(await f.start({ config: { storage: { maxSourceBytes: 1024 } } }), a => a.role === "review"
    ? { ...clean(), findings: [{ key: "repair", path: "value.cjs", severity: "medium", title: "Repair requested", evidence: "Concrete repair input" }] }
    : a.role === "triage" ? { decisions: a.findings.map(f => ({ id: f.id, status: "actionable", evidence: "Verified requested correction" })) }
      : { edits: [{ path: "value.cjs", content: "x".repeat(2048), reason: "Oversized candidate", findingIds: a.findings.map(f => f.id) }] });
  assert.equal(run.phase, "BLOCKED"); assert.equal(run.outcome.code, "STORAGE_LIMIT");
  assert.equal(run.assignmentAttempts.filter(a => a.role === "repair").length, 1);
  assert.equal(run.round, 1); assert.deepEqual(readFileSync(path.join(f.root, "value.cjs")), before);
  assert.equal((await advance(run.directory)).round, 1);
});

for (const optional of [false, true]) test(`uncertain ${optional ? "optional" : "required"} validation stops before any recovery assignment`, async t => {
  const f = fixture(t), log = path.join(f.root, ".git/check-invocations");
  const check = { id: "timeout", optional, timeoutMs: 500, argv: [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(log)},'once\\n');setInterval(()=>{},1000)`] };
  f.contract.requiredValidation = optional ? [...f.contract.requiredValidation, check] : [{ ...check, id: "unit" }];
  let recoveries = 0;
  const run = await drive(await f.start(), a => {
    if (a.role === "review") return clean();
    if (a.role === "repair") { recoveries++; return { edits: [{ path: "value.cjs", content: "module.exports = 3;\n", reason: "Recovery", findingIds: a.findings.map(f => f.id) }] }; }
    return { decisions: a.findings.map(f => ({ id: f.id, status: "actionable", evidence: "Would request recovery" })) };
  });
  assert.equal(run.phase, "VALIDATION_FAILED"); assert.equal(run.outcome.code, "EXECUTION_UNCERTAIN");
  assert.equal(run.round, 0); assert.equal(recoveries, 0);
  assert.equal(run.validation.at(-1).execution, "uncertain"); assert.equal(run.validation.at(-1).outcome, "timed_out");
  assert.equal(readFileSync(log, "utf8"), "once\n");
  assert.equal((await advance(run.directory)).validation.length, run.validation.length);
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 2;\n");
});

for (const role of ["triage", "repair"]) for (const change of ["ignored-cache", "source", "index"]) {
  test(`${role} allows ${change === "ignored-cache" ? "ignored caches" : `a bounded retry after ${change} mutation`} without checkout drift`, async t => {
    const f = fixture(t); put(f.root, ".gitignore", ".cache/\n"); put(f.root, "value.cjs", "module.exports = 1;\n");
    let exercised = false;
    const run = await drive(await f.start(), (a, run) => {
      const fixed = readFileSync(path.join(a.repository, "value.cjs"), "utf8").includes("= 2;");
      if (a.role === role && !exercised) {
        exercised = true;
        assert.match(a.instructions, role === "repair" ? /Edit source files directly in assignment.repository/ : /source files and the Git index read-only/);
        if (change === "ignored-cache") put(a.repository, ".cache/output", "diagnostic cache");
        else if (change === "source") put(a.repository, "value.cjs", "unapproved mutation");
        else execFileSync("git", ["add", "value.cjs"], { cwd: a.repository });
      }
      if (a.role === "review") return { ...clean(), findings: fixed ? [] : [{ key: "value", path: "value.cjs", severity: "medium", title: "Wrong value", evidence: "Export is 1" }] };
      if (a.role === "triage") return { decisions: a.findings.map(f => ({ id: f.id, status: fixed && run.validation.some(v => v.outcome === "succeeded") ? "fixed" : "actionable", evidence: "Checked export and validation" })) };
      return { edits: [{ path: "value.cjs", content: "module.exports = 2;\n", reason: "Correct export", findingIds: a.findings.map(f => f.id) }] };
    });
    assert.equal(exercised, true); assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome));
    assert.equal(run.round, 1); assert.equal(existsSync(path.join(f.root, ".cache")), false);
    assert.equal(existsSync(path.join(f.root, ".git/index")), false);
    const failures = run.assignmentAttempts.filter(a => a.code === "ASSIGNMENT_CHANGED");
    assert.equal(failures.length, change === "ignored-cache" ? 0 : 1);
    assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 2;\n");
  });
}

for (const mask of [0o002, 0o022, 0o077]) test(`workspace additions normalize editor umask ${mask.toString(8)}`, async t => {
  const f = fixture(t); put(f.root, "value.cjs", "module.exports = 1;\n");
  const run = await drive(await f.start(), (a, run) => {
    if (a.role !== "repair") return repairResponse(a, run);
    put(a.repository, "value.cjs", "module.exports = 2;\n");
    const originalMask = process.umask(mask);
    try {
      writeFileSync(path.join(a.repository, "added.txt"), "ordinary editor creation\n");
      writeFileSync(path.join(a.repository, "added.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o777 });
    } finally { process.umask(originalMask); }
    assert.equal(statSync(path.join(a.repository, "added.txt")).mode & 0o777, 0o666 & ~mask);
    assert.equal(statSync(path.join(a.repository, "added.sh")).mode & 0o777, 0o777 & ~mask);
    return { workspaceEdits: ["value.cjs", "added.txt", "added.sh"].map(name => ({
      path: name, reason: "Correct export and add required supporting files", findingIds: a.findings.map(f => f.id),
    })) };
  });
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.equal(statSync(path.join(f.root, "added.txt")).mode & 0o777, 0o644);
  assert.equal(statSync(path.join(f.root, "added.sh")).mode & 0o777, 0o755);
  assert.equal(readFileSync(path.join(f.root, "added.txt"), "utf8"), "ordinary editor creation\n");
  assert.equal(existsSync(path.join(f.root, ".git/index")), false);
});

test("workspace editor replacements preserve all existing permissions and script execution", async t => {
  const f = fixture(t); put(f.root, "value.cjs", "module.exports = 1;\n");
  f.contract.requiredValidation.push({ id: "script", argv: ["./shared.sh"] });
  for (const [name, mode] of [["private.txt", 0o600], ["private.sh", 0o600], ["shared.sh", 0o775]]) {
    put(f.root, name, "before\n"); fs.chmodSync(path.join(f.root, name), mode);
  }
  const run = await drive(await f.start(), (a, run) => {
    if (a.role !== "repair") return repairResponse(a, run);
    put(a.repository, "value.cjs", "module.exports = 2;\n");
    for (const [name, mode] of [["private.txt", 0o644], ["private.sh", 0o777], ["shared.sh", 0o600]]) {
      const temporary = path.join(a.repository, name + ".tmp");
      writeFileSync(temporary, "#!/bin/sh\nexit 0\n"); fs.chmodSync(temporary, mode);
      renameSync(temporary, path.join(a.repository, name));
    }
    return { workspaceEdits: ["value.cjs", "private.txt", "private.sh", "shared.sh"].map(name => ({
      path: name, reason: "Correct export and supporting source permissions", findingIds: a.findings.map(f => f.id),
    })) };
  });
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  for (const [name, mode] of [["private.txt", 0o600], ["private.sh", 0o600], ["shared.sh", 0o775]]) {
    assert.equal(statSync(path.join(f.root, name)).mode & 0o777, mode);
    assert.equal(readFileSync(path.join(f.root, name), "utf8"), "#!/bin/sh\nexit 0\n");
  }
});

test("workspace edits explicitly set modes on existing and new files without chmod or file images", async t => {
  const f = fixture(t); put(f.root, "value.cjs", "module.exports = 1;\n");
  const script = "#!/bin/sh\nexit 0\n";
  for (const [name, mode] of [["enable.sh", 0o600], ["disable.sh", 0o755]]) {
    put(f.root, name, script); fs.chmodSync(path.join(f.root, name), mode);
  }
  f.contract.requiredValidation.push({ id: "script", argv: ["./enable.sh"] });
  const run = await drive(await f.start(), (a, run) => {
    if (a.role !== "repair") return repairResponse(a, run);
    put(a.repository, "value.cjs", "module.exports = 2;\n");
    put(a.repository, "new.sh", script);
    return { workspaceEdits: [["value.cjs"], ["enable.sh", "0755"], ["disable.sh", "0644"], ["new.sh", "0755"]].map(([name, mode]) => ({
      path: name, ...(mode ? { mode } : {}), reason: "Correct export and script permissions", findingIds: a.findings.map(f => f.id),
    })) };
  });
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  for (const [name, mode] of [["enable.sh", 0o755], ["disable.sh", 0o644], ["new.sh", 0o755]]) {
    assert.equal(statSync(path.join(f.root, name)).mode & 0o777, mode);
    assert.equal(readFileSync(path.join(f.root, name), "utf8"), script);
  }
  assert.equal(existsSync(path.join(f.root, ".git/index")), false);
});

for (const damage of ["source", "index", "filter"]) for (const execution of ["completed", "uncertain"]) test(`partial workspace repair preserves a ${execution} provider error after ${damage} changes`, async t => {
  const f = fixture(t); put(f.root, "value.cjs", "module.exports = 1;\n");
  const run = await drive(await f.start(), (a, run) => {
    if (a.role !== "repair") return repairResponse(a, run);
    put(a.repository, "value.cjs", "module.exports = 2;\n");
    if (damage === "index") execFileSync("git", ["add", "value.cjs"], { cwd: a.repository });
    if (damage === "filter") put(a.repository, ".gitattributes", "value.cjs filter=unsupported\n");
    return { error: "Provider failed after editing: quota exhausted", execution };
  });
  assert.equal(run.phase, "BLOCKED", JSON.stringify(status(run)));
  assert.match(run.outcome.reason, /Provider failed after editing: quota exhausted/);
  assert.equal(run.assignmentAttempts.filter(a => a.role === "repair").length, execution === "uncertain" ? 1 : 3);
  for (const attempt of run.assignmentAttempts.filter(a => a.role === "repair")) {
    assert.equal(attempt.error, "Provider failed after editing: quota exhausted");
    assert.equal(attempt.execution, execution); assert.equal(attempt.code, undefined);
  }
  if (execution === "uncertain") assert.equal(run.outcome.code, "EXECUTION_UNCERTAIN");
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 1;\n");
  assert.equal(run.mutations.length, 0); assert.equal(run.validation.length, 0);
  assert.equal(existsSync(path.join(f.root, ".git/index")), false);
  assert.equal((await advance(run.directory)).assignmentAttempts.length, run.assignmentAttempts.length);
});

for (const scenario of ["tracked", "untracked", "attempt-limit"]) test(`workspace file-to-directory rejection supports ${scenario} retries without publication`, async t => {
  const f = fixture(t); put(f.root, "value.cjs", "module.exports = 1;\n"); put(f.root, "tool", "original tool\n");
  execFileSync("git", ["add", "value.cjs", ...(scenario === "untracked" ? [] : ["tool"])], { cwd: f.root });
  const index = readFileSync(path.join(f.root, ".git/index"));
  let attempts = 0;
  const run = await drive(await f.start({ options: parseArgs(["--max-provider-attempts", "2"]) }), (a, run) => {
    if (a.role !== "repair") return repairResponse(a, run);
    attempts++;
    assert.equal(readFileSync(path.join(a.repository, "tool"), "utf8"), "original tool\n", "Retries start from a fresh copy");
    assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 1;\n", "Rejected candidates never publish partial edits");
    put(a.repository, "value.cjs", "module.exports = 2;\n");
    const names = ["value.cjs"];
    if (attempts === 1 || scenario === "attempt-limit") {
      rmSync(path.join(a.repository, "tool")); put(a.repository, "tool/check.cjs", "module.exports = 2;\n");
      names.push("tool", "tool/check.cjs");
    }
    return { workspaceEdits: names.map(name => ({ path: name, reason: "Correct export and tool layout", findingIds: a.findings.map(f => f.id) })) };
  });
  assert.equal(run.phase, scenario === "attempt-limit" ? "BLOCKED" : "CONVERGED", JSON.stringify(status(run)));
  assert.equal(attempts, 2); assert.equal(run.round, 1);
  const failures = readJSON(path.join(run.directory, "run.json")).assignmentAttempts.filter(a => a.role === "repair" && a.error);
  assert.equal(failures.length, scenario === "attempt-limit" ? 2 : 1);
  for (const attempt of failures) {
    assert.match(attempt.error, /Repair replaces a file with a directory: tool/);
    assert.equal(attempt.code, undefined); assert.equal(attempt.execution, "completed");
  }
  assert.equal(run.mutations.length, scenario === "attempt-limit" ? 0 : 1);
  assert.equal(readFileSync(path.join(f.root, "tool"), "utf8"), "original tool\n");
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), index);
});

for (const defect of ["unattributed", "unchanged", "both-attribution", "mode-deletion", "mode-unchanged", "duplicate", "excluded", "index", "symlink", "symlink-deletion", "ignored", "ignored-mode", "ignored-and-unchanged", "hidden-source", "special-bits", "unknown-finding", "unsafe-path"]) {
  test(`workspace repairs reject ${defect} before publication`, async t => {
    const f = fixture(t); put(f.root, "value.cjs", "module.exports = 1;\n");
    put(f.root, ".gitignore", ".cache/\n"); put(f.root, "preserved.txt", "user work\n");
    fs.chmodSync(path.join(f.root, ".gitignore"), 0o644);
    if (defect === "symlink-deletion") symlinkSync("preserved.txt", path.join(f.root, "link.txt"));
    const options = parseArgs(["--max-provider-attempts", "1", "--exclude-path", "preserved.txt"]);
    const run = await drive(await f.start({ options }), (a, run) => {
      if (a.role !== "repair") return repairResponse(a, run);
      put(a.repository, "value.cjs", "module.exports = 2;\n");
      const item = name => ({ path: name, reason: "Correct the demonstrated defect", findingIds: a.findings.map(f => f.id) });
      const workspaceEdits = [item("value.cjs")];
      if (["unattributed", "both-attribution"].includes(defect)) put(a.repository, "surprise.txt", "unreported\n");
      if (["unchanged", "both-attribution", "ignored-and-unchanged"].includes(defect)) workspaceEdits.push(item(".gitignore"));
      if (defect === "mode-deletion") { rmSync(path.join(a.repository, "value.cjs")); workspaceEdits[0].mode = "0755"; }
      if (defect === "mode-unchanged") workspaceEdits.push({ ...item(".gitignore"), mode: "0644" });
      if (defect === "duplicate") workspaceEdits.push(item("value.cjs"));
      if (defect === "excluded") { put(a.repository, "preserved.txt", "changed\n"); workspaceEdits.push(item("preserved.txt")); }
      if (defect === "index") execFileSync("git", ["add", "value.cjs"], { cwd: a.repository });
      if (defect === "symlink") { symlinkSync("value.cjs", path.join(a.repository, "link.txt")); workspaceEdits.push(item("link.txt")); }
      if (defect === "symlink-deletion") { rmSync(path.join(a.repository, "link.txt")); workspaceEdits.push(item("link.txt")); }
      if (["ignored", "ignored-mode", "ignored-and-unchanged"].includes(defect)) {
        put(a.repository, ".cache/output", "ignored\n");
        workspaceEdits.push({ ...item(".cache/output"), ...(defect === "ignored-mode" ? { mode: "0644" } : {}) });
      }
      if (defect === "hidden-source") {
        put(a.repository, ".gitignore", ".cache/\nvalue.cjs\n"); workspaceEdits.push(item(".gitignore"));
      }
      if (defect === "special-bits") fs.chmodSync(path.join(a.repository, "value.cjs"), 0o4755);
      if (defect === "unknown-finding") workspaceEdits[0].findingIds = ["invented"];
      if (defect === "unsafe-path") workspaceEdits[0].path = "../outside";
      return { workspaceEdits };
    });
    assert.equal(run.phase, "BLOCKED", JSON.stringify(status(run)));
    const expected = {
      unattributed: /every changed source path/, unchanged: /every changed source path/, duplicate: /unique, included/,
      "both-attribution": /every changed source path/, "mode-deletion": /workspace mode requires a regular file/, "mode-unchanged": /every changed source path/,
      excluded: /unique, included/, index: /Assignment changed/, symlink: /Symlink repair/, "symlink-deletion": /Symlink repair/,
      ignored: /Ignored or unmanaged paths/, "ignored-mode": /Ignored or unmanaged paths/, "ignored-and-unchanged": /Ignored or unmanaged paths/, "hidden-source": /Ignored or unmanaged paths/,
      "special-bits": /Unsupported repair permissions/, "unknown-finding": /Malformed repair result/, "unsafe-path": /Unsafe repository path/,
    };
    assert.match(run.outcome.reason, expected[defect]);
    const attempt = readJSON(path.join(run.directory, "run.json")).assignmentAttempts.find(a => a.role === "repair");
    if (["unattributed", "both-attribution"].includes(defect)) assert.match(attempt.error, /Changed but unlisted: \["surprise\.txt"\]/);
    if (["unchanged", "both-attribution", "mode-unchanged", "ignored-and-unchanged"].includes(defect)) assert.match(attempt.error, /listed but unchanged: \["\.gitignore"\]/);
    if (["ignored", "ignored-mode", "ignored-and-unchanged"].includes(defect)) {
      assert.match(attempt.error, /Ignored or unmanaged paths: \["\.cache\/output"\]/);
      assert.doesNotMatch(attempt.error, /listed but unchanged: \[[^\]]*\.cache/);
      assert.match(attempt.error, /Keep generated outputs in validation or make source paths Git-visible/);
    }
    assert.equal(run.assignmentAttempts.filter(a => a.role === "repair").length, 1);
    assert.equal(run.mutations.length, 0); assert.equal(run.validation.length, 0);
    assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 1;\n");
    assert.equal(readFileSync(path.join(f.root, "preserved.txt"), "utf8"), "user work\n");
    assert.equal(existsSync(path.join(f.root, ".git/index")), false);
  });
}

test("settlement receipts survive archived records and do not release another active run", async t => {
  const f = fixture(t), run = await drive(await f.start()), active = path.join(run.runsRoot, "active.json");
  assert.deepEqual(readJSON(active), { version: 2, state: "settled", directory: run.directory, backups: [] });
  renameSync(run.directory, run.directory + "-archived");
  assert.equal((await release(run.directory, f.root)).phase, "RELEASED");
  const next = await f.start();
  await assert.rejects(release(run.directory, f.root), /Another run owns/);
  await assert.rejects(release(next.directory, f.root), /active or unresolved recovery/);
  assert.equal(readJSON(active).directory, next.directory);
});

test("reconciling runs pin version 12 and cannot resume version-11 records", async t => {
  const f = fixture(t), run = await f.start(), file = path.join(run.directory, "run.json");
  assert.equal(run.version, 12, "A reconciling run must not be admitted by a version-11 controller");
  assert.equal(loadRun(run.directory).version, 12);
  const record = readJSON(file); record.version = 11;
  writeFileSync(file, JSON.stringify(record));
  const before = readFileSync(file);
  await assert.rejects(advance(run.directory), /older runs require their original controller/);
  assert.deepEqual(readFileSync(file), before, "An incompatible run is not migrated or consumed");
});

for (const version of [4, 5, 6, 7, 8, 9, 10, 11]) test(`explicit release inspects settled v${version} records without migration or deletion`, async t => {
  const f = fixture(t), run = await drive(await f.start()), file = path.join(run.directory, "run.json"), active = path.join(run.runsRoot, "active.json");
  const record = readJSON(file); record.version = version;
  if (version < 8) { delete record.fixPolicy; delete record.options.fixMode; }
  writeFileSync(file, JSON.stringify(record)); writeFileSync(active, JSON.stringify({ directory: run.directory }));
  const before = readFileSync(file);
  await assert.rejects(advance(run.directory), /older runs require their original controller/);
  assert.deepEqual(readFileSync(file), before);
  const result = JSON.parse(execFileSync(process.execPath, [cli, "release", "--cwd", f.root, "--run", run.directory], { encoding: "utf8" }));
  assert.equal(result.phase, "RELEASED"); assert.deepEqual(readFileSync(file), before);
  assert.equal((await release(run.directory, f.root)).phase, "RELEASED");
  assert.equal((await f.start()).phase, "INIT");
});

test("missing unreceipted run records stop precisely until restored, without clearing recovery", async t => {
  const f = fixture(t), run = await drive(await f.start()), active = path.join(run.runsRoot, "active.json");
  writeFileSync(active, JSON.stringify({ directory: run.directory }));
  renameSync(run.directory, run.directory + "-saved");
  await assert.rejects(f.start(), /active\.json.*Restore any missing run records.*release --cwd/);
  await assert.rejects(release(run.directory, f.root), /Unknown recovery state is not bypassed/);
  assert.deepEqual(readJSON(active), { directory: run.directory });
  renameSync(run.directory + "-saved", run.directory);
  assert.equal((await release(run.directory, f.root)).phase, "RELEASED");
  assert.equal((await f.start()).phase, "INIT");
});

test("cross-filesystem linked worktrees stop before run allocation or review", async t => {
  if (process.platform !== "linux") { t.skip("Real second-filesystem fixture uses Linux /dev/shm; portable device-guard coverage runs separately"); return; }
  const f = fixture(t), worktree = mkdtempSync("/dev/shm/jig-boundary-");
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  execFileSync("git", ["add", "."], { cwd: f.root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"], { cwd: f.root });
  execFileSync("git", ["worktree", "add", "-q", "-b", "cross-device", worktree], { cwd: f.root });
  assert.notEqual(statSync(f.root).dev, statSync(worktree).dev);
  const before = readFileSync(path.join(worktree, "value.cjs"));
  await assert.rejects(f.start({ cwd: worktree }), e => e.code === "UNSUPPORTED_REPOSITORY" && /must share a filesystem/.test(e.message));
  assert.equal(existsSync(path.join(f.root, ".git/jig/review-fix")), false);
  assert.deepEqual(readFileSync(path.join(worktree, "value.cjs")), before);
});

test("destination filesystem checks reject a whole batch before publishing any addition", async t => {
  const f = fixture(t), mounted = path.join(f.root, "mounted"); mkdirSync(mounted);
  const original = fs.lstatSync;
  // Model a separately mounted empty destination directory on either platform.
  fs.lstatSync = (file, ...args) => { const stat = original(file, ...args); if (file === mounted) stat.dev++; return stat; };
  syncBuiltinESMExports(); t.after(() => { fs.lstatSync = original; syncBuiltinESMExports(); });
  const run = await drive(await f.start(), a => a.role === "review"
    ? { ...clean(), findings: [{ key: "support", path: "value.cjs", severity: "medium", title: "Support needed", evidence: "Need supporting files" }] }
    : a.role === "triage" ? { decisions: a.findings.map(f => ({ id: f.id, status: "actionable", evidence: "Verified support requirement" })) }
      : { edits: ["a-first", "mounted/later"].map(p => ({ path: p, content: "support", reason: "Support correction", findingIds: a.findings.map(f => f.id) })) });
  assert.equal(run.phase, "BLOCKED"); assert.equal(run.outcome.code, "UNSUPPORTED_REPOSITORY");
  assert.equal(existsSync(path.join(f.root, "a-first")), false); assert.equal(existsSync(path.join(mounted, "later")), false);
});
