import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { advance, createRun, prune, release, status, submit, TERMINAL } from "../skills/review-fix-loop/scripts/review-fix-loop.mjs";
import { parseArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";
import { identity, ownedAlive } from "../skills/review-fix-loop/scripts/process-ownership.mjs";
import { loadRun } from "../skills/review-fix-loop/scripts/run-store.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jig-direct-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(root, "value.cjs"), "module.exports = 1;\n");
  writeFileSync(path.join(root, ".gitignore"), "target/\n");
  writeFileSync(path.join(root, "notes.txt"), "initial\n");
  git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  writeFileSync(path.join(root, "notes.txt"), "user staged work\n"); git("add", "notes.txt");
  writeFileSync(path.join(root, "notes.txt"), "user unstaged work\n");
  mkdirSync(path.join(root, "target")); writeFileSync(path.join(root, "target/cache"), "existing build cache");
  const index = readFileSync(path.join(root, ".git/index"));
  return { root, index, async start(maxRounds = 1, config = {}, maxAttempts = 3) {
    const run = await createRun({ cwd: root, config, options: parseArgs(["--max-rounds", String(maxRounds), "--max-provider-attempts", String(maxAttempts)]), contract: {
      goal: "Export 2", acceptanceCriteria: [{ id: "value", description: "Export 2" }],
      nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: ["Correct value"],
      requiredValidation: [{ id: "unit", argv: [process.execPath, "-e", `const a=require('node:assert/strict');a.equal(process.cwd(),${JSON.stringify(root)});a.equal(require('./value.cjs'),2);a.equal(require('node:fs').readFileSync('target/cache','utf8'),'existing build cache')`] }],
    } });
    t.after(() => rmSync(path.dirname(run.workspaceRoot), { recursive: true, force: true }));
    return run;
  } };
}
const response = a => a.role === "review" ? { complete: true,
  findings: readFileSync(path.join(a.repository, "value.cjs"), "utf8").includes("= 2") ? []
    : [{ key: "value", path: "value.cjs", severity: "medium", title: "Wrong value", evidence: "Module must export 2" }],
  acceptance: [{ criterionId: "value", status: "satisfied", evidence: "Inspect module and check unit receipt", validationIds: ["unit"] }],
} : { decisions: a.findings.map(f => ({ id: f.id, status: readFileSync(path.join(a.repository, "value.cjs"), "utf8").includes("= 2") ? "fixed" : "actionable", evidence: "Compared module with required value and validation" })) };
const send = (run, result) => submit(run.directory, run.pending.id, { assignmentId: run.pending.id, fingerprint: run.pending.assignment.fingerprint, ...result });
async function drive(run, stop = () => false) {
  for (let n = 0; n < 300; n++) {
    run = await advance(run.directory);
    if (stop(run) || (TERMINAL.has(run.phase) && (run.cleanupBlocked || !run.cleanup?.length && !run.cleanupOverlays?.length))) return run;
    if (run.pending && !run.pending.command) {
      assert.equal(run.pending.assignment.repository, run.root);
      if (run.pending.role === "review") assert.match(run.pending.assignment.instructions, /Do not seek out, read, or use controller run records/);
      assert.notEqual(run.pending.role, "repair", "repair must be handled explicitly");
      await send(run, response(run.pending.assignment));
    }
    if (run.validationCycle?.job) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Run did not finish");
}
async function repair(t, maxRounds = 1) {
  const f = fixture(t);
  const run = await drive(await f.start(maxRounds), r => r.pending?.role === "repair");
  assert.equal(run.pending.assignment.repository, f.root);
  return { ...f, run };
}
const edits = run => [{ path: "value.cjs", reason: "Correct exported value", findingIds: run.pending.assignment.findings.map(f => f.id) }];

for (const bit of [0o4000, 0o2000, 0o1000]) test(`direct repair rejects unlisted special permission bit ${bit.toString(8)}`, async t => {
  const f = fixture(t);
  let run = await drive(await f.start(), r => r.pending?.role === "repair");
  const a = run.pending.assignment, note = path.join(f.root, "notes.txt");
  const mode = lstatSync(note).mode & 0o777;
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  chmodSync(note, mode | bit);
  await submit(run.directory, a.id, { assignmentId: a.id, fingerprint: a.fingerprint,
    workspaceEdits: [{ path: "value.cjs", reason: "Correct export", findingIds: a.findings.map(f => f.id) }] });
  run = await advance(run.directory);
  assert.equal(run.phase, "BLOCKED", JSON.stringify(status(run)));
  assert.match(run.outcome.reason, /Unsupported.*permissions.*notes.txt/);
  assert.equal(run.mutations.length, 0);
  assert.equal(run.validation.length, 0);
  assert.equal(status(run).indexNeedsRestaging, true);
  assert.match(status(run).restagingInspectionError, /Unsupported.*permissions.*notes.txt/);
  assert.equal(lstatSync(note).mode & 0o7777, mode | bit, "unsupported checkout edits are retained");
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 2;\n");
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
});

test("failed retained checkout capture reports uncertain staging from a clean start", async t => {
  const f = fixture(t);
  execFileSync("git", ["add", "."], { cwd: f.root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "clean starting state"], { cwd: f.root });
  const index = readFileSync(path.join(f.root, ".git/index"));
  const run = await drive(await f.start(), r => r.pending?.role === "repair");
  assert.equal(status(run).indexNeedsRestaging, false);
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  const note = path.join(f.root, "notes.txt"), mode = lstatSync(note).mode & 0o777;
  chmodSync(note, mode | 0o4000);
  await send(run, { workspaceEdits: edits(run) });
  const cli = fileURLToPath(new URL("../skills/review-fix-loop/scripts/review-fix-loop.mjs", import.meta.url));
  for (const action of ["advance", "run", "status"]) {
    const command = spawnSync(process.execPath, [cli, action, "--run", run.directory], { encoding: "utf8", timeout: 15000 });
    assert.equal(command.status, 0, command.stderr);
    const report = JSON.parse(command.stdout);
    assert.equal(report.phase, "BLOCKED");
    assert.match(report.retainedCheckout.checkoutInspectionError, /Unsupported.*permissions.*notes.txt/);
    assert.equal(report.indexNeedsRestaging, true);
    assert.equal(report.restagingInspectionError, report.retainedCheckout.checkoutInspectionError);
  }
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 2;\n");
  assert.equal(lstatSync(note).mode & 0o7777, mode | 0o4000);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), index);
});

test("retained file-to-directory replacements remain reportable through every status CLI", async t => {
  const f = fixture(t);
  execFileSync("git", ["add", "."], { cwd: f.root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "clean starting state"], { cwd: f.root });
  const index = readFileSync(path.join(f.root, ".git/index"));
  const run = await drive(await f.start(), r => r.pending?.role === "repair"), a = run.pending.assignment;
  const source = path.join(f.root, "value.cjs");
  rmSync(source); mkdirSync(source); writeFileSync(path.join(source, "index.cjs"), "module.exports = 2;\n");
  await send(run, { workspaceEdits: ["value.cjs", "value.cjs/index.cjs"].map(name => ({
    path: name, reason: "Replace module file with directory", findingIds: a.findings.map(f => f.id),
  })) });
  const cli = fileURLToPath(new URL("../skills/review-fix-loop/scripts/review-fix-loop.mjs", import.meta.url));
  for (const action of ["advance", "run", "status"]) {
    const command = spawnSync(process.execPath, [cli, action, "--run", run.directory], { encoding: "utf8", timeout: 15000 });
    assert.equal(command.status, 0, command.stderr);
    const report = JSON.parse(command.stdout);
    assert.equal(report.phase, "BLOCKED");
    assert.ok(report.filesChanged.includes("value.cjs"));
    assert.ok(report.retainedCheckout.evidence);
    assert.equal(report.indexNeedsRestaging, true);
    assert.match(report.restagingInspectionError, /Unsupported non-regular file: value.cjs/);
  }
  assert.equal(readFileSync(path.join(source, "index.cjs"), "utf8"), "module.exports = 2;\n");
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), index);
});

for (const drift of ["none", "source", "index"]) test(`interrupted direct preparation checks ${drift} drift before publishing its assignment`, async t => {
  const f = fixture(t);
  let run = await drive(await f.start(), r => r.phase === "REPAIR" && !r.pending);
  const cli = fileURLToPath(new URL("../skills/review-fix-loop/scripts/review-fix-loop.mjs", import.meta.url));
  const interrupt = fileURLToPath(new URL("./fixtures/interrupt-settlement.mjs", import.meta.url));
  const stopped = spawnSync(process.execPath, ["--import", interrupt, cli, "advance", "--run", run.directory], {
    env: { ...process.env, JIG_TEST_SETTLEMENT_POINT: "prepared" }, encoding: "utf8", timeout: 15000,
  });
  assert.equal(stopped.signal, "SIGKILL", stopped.stderr);
  run = loadRun(run.directory);
  assert.equal(run.pending.preparing, true);
  const id = run.pending.id;
  if (drift === "source") writeFileSync(path.join(f.root, "notes.txt"), "edited before assignment preparation completed\n");
  if (drift === "index") execFileSync("git", ["add", "notes.txt"], { cwd: f.root });
  const index = readFileSync(path.join(f.root, ".git/index"));
  run = await advance(run.directory);
  if (drift === "none") {
    assert.equal(run.pending.id, id);
    assert.equal(run.pending.preparing, undefined);
    writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
    await send(run, { workspaceEdits: edits(run) });
    run = await drive(run);
    assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome));
    assert.equal(run.assignmentAttempts.filter(a => a.role === "repair").length, 1);
  } else {
    assert.equal(run.phase, "SCOPE_CHANGED", JSON.stringify(run.outcome));
    assert.equal(existsSync(path.join(run.directory, "assignments", id, "request.json")), false);
    assert.equal(run.expected.contentHash, run.original.contentHash, "preparation cannot accept a new baseline");
    assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 1;\n");
  }
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), index);
});

test("default workflow edits and validates the real checkout without source copies or publication", async t => {
  const f = await repair(t);
  assert.equal(existsSync(f.run.workspaceRoot), false);
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  const pending = await advance(f.run.directory);
  assert.equal(pending.pending.id, f.run.pending.id, "polling must not reconcile the agent's own edits");
  await send(pending, { workspaceEdits: edits(pending) });
  const done = await drive(pending);
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.equal(done.mutations.length, 1);
  assert.equal(done.mutations[0].direct, true);
  assert.equal(done.completedApplications.length, 0);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
  assert.equal(readFileSync(path.join(f.root, "notes.txt"), "utf8"), "user unstaged work\n");
  assert.equal(existsSync(path.join(done.directory, "backups")), false);
  assert.deepEqual(readdirSync(done.workspaceRoot), [], "only settled validation scratch was allocated");
});

test("failed direct validation retains the visible repair without marking findings fixed", async t => {
  const f = await repair(t);
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 3;\n");
  await send(f.run, { workspaceEdits: edits(f.run) });
  const done = await drive(f.run);
  assert.equal(done.phase, "VALIDATION_FAILED");
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 3;\n");
  assert.ok(Object.values(done.ledger).every(f => f.status !== "fixed"));
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
});

test("unrelated checkout edits during repair survive without another repair round", async t => {
  const f = await repair(t);
  writeFileSync(path.join(f.root, "notes.txt"), "concurrent user notes\n");
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  await send(f.run, { workspaceEdits: edits(f.run) });
  const done = await drive(f.run);
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.equal(done.round, 1);
  assert.deepEqual(done.mutations[0].paths, ["value.cjs"]);
  assert.deepEqual(done.sourceChanges.paths, ["notes.txt"]);
  assert.deepEqual(status(done).filesChanged.sort(), ["notes.txt", "value.cjs"]);
  assert.equal(readFileSync(path.join(f.root, "notes.txt"), "utf8"), "concurrent user notes\n");
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
});

test("a counted recovery repairs the failed checkout in place and then obtains fresh review", async t => {
  const f = await repair(t, 2);
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 3;\n");
  await send(f.run, { workspaceEdits: edits(f.run) });
  const recovery = await drive(f.run, r => r.pending?.role === "repair");
  assert.equal(recovery.round, 2);
  assert.equal(recovery.pending.assignment.repository, f.root);
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 3;\n");
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  await send(recovery, { workspaceEdits: edits(recovery) });
  const done = await drive(recovery);
  assert.equal(done.phase, "CONVERGED", JSON.stringify(done.outcome));
  assert.deepEqual(done.mutations.map(m => m.direct), [true, true]);
  assert.equal(done.completedApplications.length, 0);
  assert.equal(done.reports.length, 2);
  assert.ok(done.reports.every(r => r.fingerprint === done.fingerprint.fingerprint));
});

test("repair failure after direct edits preserves them and does not start a replacement", async t => {
  const f = await repair(t);
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  await send(f.run, { error: "Interrupted after editing" });
  const done = await drive(f.run);
  assert.equal(done.phase, "BLOCKED");
  assert.equal(done.outcome.code, "REPAIR_INCOMPLETE");
  assert.deepEqual(done.outcome.changedPaths, ["value.cjs"]);
  assert.equal(done.assignmentAttempts.filter(a => a.role === "repair").length, 1);
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 2;\n");
});

test("terminal interruption cannot settle before retained checkout capture", async t => {
  const f = await repair(t);
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  await send(f.run, { error: "Interrupted repair" });
  const cli = fileURLToPath(new URL("../skills/review-fix-loop/scripts/review-fix-loop.mjs", import.meta.url));
  const interrupt = fileURLToPath(new URL("./fixtures/interrupt-settlement.mjs", import.meta.url));
  const stopped = spawnSync(process.execPath, ["--import", interrupt, cli, "advance", "--run", f.run.directory], {
    env: { ...process.env, JIG_TEST_SETTLEMENT_POINT: "terminal" }, encoding: "utf8", timeout: 15000,
  });
  assert.equal(stopped.signal, "SIGKILL", stopped.stderr);
  let run = loadRun(f.run.directory);
  assert.equal(run.phase, "BLOCKED");
  assert.equal(run.pending, null);
  assert.deepEqual(run.cleanup, []);
  assert.equal(run.retainedCheckout.observation, undefined);
  assert.equal(status(run).waiting, true, "a terminal verdict alone cannot settle unfinished evidence capture");
  await assert.rejects(release(run.directory, f.root), /unresolved recovery obligations/);
  await assert.rejects(prune(run.directory), /unresolved recovery obligations/);
  await assert.rejects(f.start(), /Resume the active run/);
  assert.equal(JSON.parse(readFileSync(path.join(run.runsRoot, "active.json"), "utf8")).state, undefined);
  const outcome = run.outcome;
  run = await advance(run.directory);
  assert.deepEqual(run.outcome, outcome, "resume captures evidence without changing the verdict");
  assert.equal(status(run).waiting, false);
  assert.deepEqual(run.retainedCheckout.observation.changedPaths, ["value.cjs"]);
  assert.ok(existsSync(run.retainedCheckout.observation.evidence));
  assert.equal((await release(run.directory, f.root)).phase, "RELEASED");
  assert.equal((await f.start()).phase, "INIT");
});

for (const first of ["direct", "inline"]) for (const restoration of ["direct", "inline"]) {
  test(`${restoration} restoration after failed ${first} repair restores and stops without convergence`, async t => {
    const f = fixture(t), original = readFileSync(path.join(f.root, "value.cjs"), "utf8");
    const staged = () => execFileSync("git", ["ls-files", "--stage", "-v", "-z"], { cwd: f.root });
    const originalIndex = staged();
    let run = await drive(await f.start(2), r => r.pending?.role === "repair");
    if (first === "direct") {
      writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 3;\n");
      await send(run, { workspaceEdits: edits(run) });
    } else await send(run, { edits: edits(run).map(edit => ({ ...edit, content: "module.exports = 3;\n" })) });
    run = await drive(run, r => r.pending?.role === "repair" && r.round === 2);
    assert.equal(run.validation.length, 1);
    assert.notEqual(run.validation[0].outcome, "succeeded");
    if (restoration === "direct") {
      writeFileSync(path.join(f.root, "value.cjs"), original);
      await send(run, { workspaceEdits: edits(run) });
    } else await send(run, { edits: edits(run).map(edit => ({ ...edit, content: original })) });
    run = await drive(run);
    assert.equal(run.phase, "BLOCKED", JSON.stringify(status(run)));
    assert.equal(run.outcome.code, "RESTORED_ORIGINAL");
    assert.deepEqual(run.outcome.restoredPaths, ["value.cjs"]);
    assert.equal(run.validation.length, 1, "restoration is not reported as newly validated");
    assert.equal(run.attempts.length, 2, "restoration does not launch fresh reviewers");
    assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), original);
    assert.equal(readFileSync(path.join(f.root, "notes.txt"), "utf8"), "user unstaged work\n");
    // Restoring index-matching bytes permits Git to refresh inode/stat caches.
    // The staged objects, modes, stages, paths, and flags must stay unchanged.
    assert.deepEqual(staged(), originalIndex);
  });
}

test("index edits during direct repair are detected and never silently reset", async t => {
  const f = await repair(t);
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  execFileSync("git", ["add", "value.cjs"], { cwd: f.root });
  const changedIndex = readFileSync(path.join(f.root, ".git/index"));
  await send(f.run, { workspaceEdits: edits(f.run) });
  const done = await drive(f.run);
  assert.equal(done.phase, "BLOCKED");
  assert.equal(done.outcome.code, "ASSIGNMENT_CHANGED");
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), changedIndex);
});

test("unclaimed visibility changes cannot silently shrink direct repair coverage", async t => {
  const f = await repair(t);
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  writeFileSync(path.join(f.root, ".gitignore"), "target/\nnotes.txt\n");
  await send(f.run, { workspaceEdits: edits(f.run) });
  const done = await drive(f.run);
  assert.equal(done.phase, "BLOCKED");
  assert.match(done.outcome.reason, /visibility policy/);
  assert.equal(done.validation.length, 0);
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 2;\n");
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
});

test("index-only drift on failed direct repair is retained and requires re-staging", async t => {
  const f = fixture(t);
  execFileSync("git", ["add", "notes.txt"], { cwd: f.root });
  const run = await drive(await f.start(), r => r.pending?.role === "repair");
  assert.equal(status(run).indexNeedsRestaging, false);
  execFileSync("git", ["reset", "--quiet", "HEAD", "--", "notes.txt"], { cwd: f.root });
  const changedIndex = readFileSync(path.join(f.root, ".git/index"));
  await send(run, { error: "Repair failed after changing the index" });
  const done = await drive(run);
  assert.equal(done.phase, "BLOCKED");
  assert.deepEqual(status(done).retainedCheckout.changedPaths, [], "no working-tree bytes changed");
  assert.equal(status(done).retainedCheckout.gitMetadataChanged, true);
  assert.equal(status(done).indexNeedsRestaging, true);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), changedIndex);
});

test("an attributed ignore change cannot hide a pre-existing dangling symlink", async t => {
  const f = fixture(t);
  symlinkSync("missing-target", path.join(f.root, "dangling"));
  const run = await drive(await f.start(), r => r.pending?.role === "repair");
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  writeFileSync(path.join(f.root, ".gitignore"), "target/\ndangling\n");
  await send(run, { workspaceEdits: [...edits(run), { path: ".gitignore", reason: "Update ignored outputs", findingIds: edits(run)[0].findingIds }] });
  const done = await drive(run);
  assert.equal(done.phase, "BLOCKED");
  assert.match(done.outcome.reason, /hidden from Git: dangling/);
  assert.equal(done.validation.length, 0);
  assert.equal(done.expected.files.dangling.type, "symlink");
  assert.equal(lstatSync(path.join(f.root, "dangling")).isSymbolicLink(), true);
});

for (const [role, execution] of [["review", "uncertain"], ["triage", "uncertain"], ["triage", "completed"]]) test(`failed checkout ${role} retains outside edits after ${execution} execution`, async t => {
  const f = fixture(t);
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qam", "clean fixture"], { cwd: f.root });
  const index = readFileSync(path.join(f.root, ".git/index"));
  const run = await drive(await f.start(1, {}, 1), r => r.pending?.role === role);
  assert.equal(status(run).indexNeedsRestaging, false);
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  await send(run, { error: "Assignment failed while another writer edited the checkout", execution });
  const done = await drive(run);
  assert.equal(done.phase, role === "review" ? "REVIEW_INCOMPLETE" : "BLOCKED");
  assert.deepEqual(status(done).filesChanged, ["value.cjs"]);
  assert.equal(status(done).indexNeedsRestaging, true);
  assert.deepEqual(status(done).retainedCheckout.changedPaths, ["value.cjs"]);
  assert.ok(status(done).retainedCheckout.evidence);
  assert.equal(done.expected.contentHash, done.original.contentHash, "failure observations cannot accept unverified edits");
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), index);
});

async function until(predicate) {
  for (let n = 0; n < 300; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for test process");
}
for (const boundary of ["lost-worker", "cleanup-blocked"]) for (const stage of [false, true]) test(`direct repair reports retained edits after ${boundary}, staged=${stage}`, async t => {
  const f = fixture(t), marker = path.join(f.root, "target/provider-pid");
  const code = `const fs=require('node:fs');fs.writeFileSync('value.cjs','module.exports = 2;\\n');${stage ? "require('node:child_process').execFileSync('git',['add','value.cjs']);" : ""}fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`;
  let run = await drive(await f.start(1, { repairCommand: [process.execPath, "-e", code], cleanupTimeoutMs: 100 }), r => r.pending?.role === "repair");
  await until(() => existsSync(marker));
  const job = path.join(run.directory, "assignments", run.pending.id);
  const owner = JSON.parse(readFileSync(path.join(job, boundary === "lost-worker" ? "claimed" : "child.json"), "utf8"));
  const pid = Number(readFileSync(marker, "utf8")), provider = { pid, token: identity(pid)?.token };
  const changedIndex = readFileSync(path.join(f.root, ".git/index"));
  try {
    process.kill(owner.pid, "SIGKILL");
    await until(() => !ownedAlive(owner));
    run = await drive(run);
    assert.equal(run.phase, "BLOCKED");
    assert.equal(run.outcome.code, boundary === "lost-worker" ? "EXECUTION_UNCERTAIN" : "CLEANUP_BLOCKED");
    assert.deepEqual(run.outcome.changedPaths, ["value.cjs"]);
    assert.equal(run.outcome.gitMetadataChanged, stage);
    assert.deepEqual(status(run).filesChanged, ["value.cjs"]);
    assert.equal(run.assignmentAttempts.filter(a => a.role === "repair").length, 1);
    assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), changedIndex);
    assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 2;\n");
  } finally {
    if (boundary === "cleanup-blocked") writeFileSync(path.join(f.root, "notes.txt"), "late writer change\n");
    if (ownedAlive(provider)) process.kill(provider.pid, "SIGKILL");
    await until(() => !ownedAlive(provider));
    run = await drive(run);
    assert.ok(status(run).retainedCheckout.evidence);
    if (boundary === "cleanup-blocked") assert.ok(status(run).retainedCheckout.changedPaths.includes("notes.txt"), "inspect again after remaining writers settle");
  }
});
