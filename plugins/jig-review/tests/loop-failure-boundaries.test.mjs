import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { advance, createRun, status, TERMINAL } from "../skills/review-fix-loop/scripts/review-fix-loop.mjs";
import { json, loadRun, readJSON, locked, save } from "../skills/review-fix-loop/scripts/run-store.mjs";
import { identity, ownedAlive, killOwned, groupRunning } from "../skills/review-fix-loop/scripts/process-ownership.mjs";
import { cancelJob, executableCommand, launchJob } from "../skills/review-fix-loop/scripts/job-runtime.mjs";
import { makeOverlay, reservedOverlays, snapshot } from "../skills/review-fix-loop/scripts/repository.mjs";
import { discoverValidation } from "../skills/review-fix-loop/scripts/task-contract.mjs";
import { parseArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";
const cli = fileURLToPath(new URL("../skills/review-fix-loop/scripts/review-fix-loop.mjs", import.meta.url));
const worker = fileURLToPath(new URL("../skills/review-fix-loop/scripts/assignment-worker.mjs", import.meta.url));
const stub = fileURLToPath(new URL("./fixtures/loop-provider.mjs", import.meta.url));
const inject = fileURLToPath(new URL("./fixtures/interrupt-resource.mjs", import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
function fixture(t, format = "sha1") {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jig-boundary-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "repo"); mkdirSync(root);
  git(root, "init", "-q", "-b", "main", `--object-format=${format}`);
  git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(path.join(root, "value.cjs"), "module.exports = 0;\n"); git(root, "add", "."); git(root, "commit", "-qm", "base");
  writeFileSync(path.join(root, "value.cjs"), "module.exports = 1;\n");
  const contract = { goal: "Correct the value", acceptanceCriteria: [{ id: "value", description: "Exports 2" }], nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: [],
    requiredValidation: [{ id: "unit", argv: [process.execPath, "-e", "require('node:assert/strict').equal(require('./value.cjs'),2)"] }] };
  const log = path.join(directory, "calls");
  return { root, directory, contract, log, start: (scenario = "success", extra = {}) => {
    const argv = [process.execPath, stub, scenario, log];
    return createRun({ cwd: root, contract, config: { reviewers: [{ id: "codex", command: argv }], triageCommand: argv, repairCommand: argv }, ...extra });
  } };
}
async function until(check, description) {
  const end = Date.now() + 15000;
  while (!await check()) { assert.ok(Date.now() < end, description); await sleep(20); }
}
async function drive(run, stop = () => false) {
  for (let i = 0; i < 800; i++) {
    run = await advance(run.directory);
    if (stop(run) || TERMINAL.has(run.phase) && (!status(run).waiting || run.cleanupBlocked)) return run;
    await sleep(20);
  }
  assert.fail(JSON.stringify(status(run)));
}

const observationFault = fileURLToPath(new URL("./fixtures/controller-observation-fault.mjs", import.meta.url));
const faultyAdvance = (run, fault, action = "advance") => spawnSync(process.execPath, ["--import", observationFault, cli, action, "--run", run.directory], {
  env: { ...process.env, JIG_TEST_OBSERVATION_FAULT: fault }, encoding: "utf8", timeout: 15000,
});
async function liveObservationFixture(t, role) {
  let owner;
  t.after(async () => { if (owner) { killOwned(owner); await until(() => !groupRunning(owner), "fixture group cleanup"); } });
  const f = fixture(t), started = path.join(f.directory, "started");
  const command = [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(started)},'started\\n');setInterval(()=>{},1000);setTimeout(()=>process.exit(),30000)`];
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  if (role === "validate") f.contract.requiredValidation[0].argv = command;
  let run = await f.start("success", role === "review" ? { config: { reviewers: [{ id: "codex", command }] } } : {});
  t.after(() => rmSync(path.dirname(run.workspaceRoot), { recursive: true, force: true }));
  run = await drive(run, () => existsSync(started));
  const id = role === "review" ? run.pending.id : run.validationCycle.job;
  const job = path.join(run.directory, "assignments", id);
  owner = readJSON(path.join(job, "child.json"));
  return { ...f, run, id, job, started };
}

for (const role of ["review", "validate"]) test(`controller observation failure during ${role} persists failure and resumes cleanup without replay`, async t => {
  const f = await liveObservationFixture(t, role), initial = f.run;
  const index = readFileSync(path.join(f.root, ".git/index")), attempts = initial.attempts.length, round = initial.round;
  const failed = faultyAdvance(initial, "identity");
  assert.equal(failed.status, 0, failed.stderr);
  let run = loadRun(initial.directory);
  assert.equal(run.phase, role === "review" ? "REVIEW_INCOMPLETE" : "VALIDATION_FAILED");
  assert.match(run.outcome.reason, /identity deadline|process inspection timeout/);
  assert.equal(run.pending, null); assert.ok(run.cleanup.includes(f.id));
  assert.equal(existsSync(path.join(f.job, "cancel")), true);
  const outcome = run.outcome;
  await until(() => existsSync(path.join(f.job, "result.json")), "cancelled job settles");
  const result = readJSON(path.join(f.job, "result.json"));
  for (let pass = 0; pass < 2; pass++) {
    const events = run.events.length;
    const stopped = faultyAdvance(run, "group", "run"); assert.equal(stopped.status, 0, stopped.stderr);
    run = loadRun(run.directory);
    assert.match(run.cleanupBlocked, /inspection/); assert.deepEqual(run.outcome, outcome);
    if (pass) assert.equal(run.events.length, events, "An unchanged cleanup failure must not append duplicate events");
    assert.ok(run.cleanup.includes(f.id)); assert.ok(reservedOverlays(run).length);
    assert.notEqual(readJSON(path.join(run.runsRoot, "active.json")).state, "settled");
  }
  run = await drive(run);
  assert.deepEqual(run.outcome, outcome); assert.equal(run.cleanupBlocked, null);
  assert.deepEqual(run.cleanup, []); assert.deepEqual(reservedOverlays(run), []);
  assert.equal(run.attempts.length, attempts); assert.equal(run.round, round);
  assert.deepEqual(readJSON(path.join(f.job, "result.json")), result);
  assert.equal(readFileSync(f.started, "utf8"), "started\n");
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), index);
});

test("controller observation failure survives interruption before cancellation", async t => {
  const f = await liveObservationFixture(t, "review"), interrupted = faultyAdvance(f.run, "identity-interrupt");
  assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr); await release(f.run);
  let run = loadRun(f.run.directory);
  assert.equal(run.phase, "REVIEW_INCOMPLETE"); assert.ok(run.cleanup.includes(f.id));
  assert.equal(existsSync(path.join(f.job, "cancel")), false, "Failure must be durable before cancellation side effects");
  const attempts = run.attempts.length, outcome = run.outcome;
  run = await drive(run);
  assert.deepEqual(run.outcome, outcome); assert.equal(run.attempts.length, attempts);
  assert.equal(readFileSync(f.started, "utf8"), "started\n");
  assert.equal(existsSync(path.join(f.job, "cancel")), true);
  assert.deepEqual(run.cleanup, []); assert.deepEqual(reservedOverlays(run), []);
});

test("controller observation failure before dispatch retains resources until inspection recovers", async t => {
  const f = fixture(t); let run = await f.start("success", { config: {} });
  for (let i = 0; i < 3; i++) run = await advance(run.directory);
  const overlay = run.pending.overlay, attempts = run.attempts.length;
  const failed = faultyAdvance(run, "resources"); assert.equal(failed.status, 0, failed.stderr);
  run = loadRun(run.directory);
  assert.equal(run.phase, "REVIEW_INCOMPLETE"); assert.match(run.outcome.reason, /inspection failure/);
  assert.match(run.cleanupBlocked, /inspection failure/); assert.equal(existsSync(overlay), true);
  assert.notEqual(readJSON(path.join(run.runsRoot, "active.json")).state, "settled");
  const outcome = run.outcome;
  run = await drive(run);
  assert.deepEqual(run.outcome, outcome); assert.equal(run.attempts.length, attempts);
  assert.equal(existsSync(overlay), false); assert.deepEqual(reservedOverlays(run), []);
  assert.equal(existsSync(f.log), false);
});

for (const interrupted of [false, true]) test(`controller observation failure on a settled run blocks admission ${interrupted ? "after interruption" : "until recovery"}`, async t => {
  const f = fixture(t); writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  let run = await drive(await f.start());
  assert.equal(run.phase, "CONVERGED");
  const outcome = run.outcome, attempts = run.attempts.length, calls = readFileSync(f.log, "utf8");
  const active = path.join(run.runsRoot, "active.json");
  assert.equal(readJSON(active).state, "settled");
  const failed = faultyAdvance(run, interrupted ? "resources-interrupt" : "resources");
  if (interrupted) { assert.equal(failed.signal, "SIGKILL", failed.stderr); await release(run); }
  else assert.equal(failed.status, 0, failed.stderr);
  run = loadRun(run.directory);
  assert.equal(run.phase, "CONVERGED"); assert.deepEqual(run.outcome, outcome);
  assert.match(run.cleanupBlocked, /inspection failure/);
  assert.notEqual(readJSON(active).state, "settled");
  await assert.rejects(f.start(), /Resume the active run/);
  run = await advance(run.directory);
  assert.equal(run.cleanupBlocked, null); assert.deepEqual(run.outcome, outcome);
  assert.equal(readJSON(active).state, "settled"); assert.equal(run.attempts.length, attempts);
  assert.equal(readFileSync(f.log, "utf8"), calls);
});

for (const args of [["--scpoe", "branch"], ["--scope", "branch"], ["unexpected"]]) test(`plan-validation rejects leftover arguments ${args.join(" ")} before discovery`, t => {
  const f = fixture(t);
  const invalid = spawnSync(process.execPath, [cli, "plan-validation", "--cwd", f.root, ...args], { encoding: "utf8", timeout: 15000 });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Unknown arguments/); assert.equal(invalid.stdout, "");
  // Parsing must finish even before discovering whether the target is a repo.
  const outside = spawnSync(process.execPath, [cli, "plan-validation", "--cwd", f.directory, ...args], { encoding: "utf8", timeout: 15000 });
  assert.match(outside.stderr, /Unknown arguments/); assert.equal(outside.stdout, "");
  const valid = spawnSync(process.execPath, [cli, "plan-validation", "--cwd", f.root], { encoding: "utf8", timeout: 15000 });
  assert.equal(valid.status, 0, valid.stderr); assert.ok(Array.isArray(JSON.parse(valid.stdout).sources));
});

for (const cancelled of [false, true]) test(`a late worker ${cancelled ? "preserves cancellation" : "enforces its deadline without controller polling"} before executing anything`, t => {
  const f = fixture(t), job = path.join(f.directory, "late-job"), marker = path.join(f.directory, "executed"); mkdirSync(job);
  json(path.join(job, "request.json"), { role: "validate", cwd: f.root, assignment: {},
    command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`] });
  const launches = [{ started: Date.now() - 20000, deadlineAt: Date.now() - 1 }]; json(path.join(job, "launch.json"), launches);
  if (cancelled) cancelJob(job, "cancelled before start");
  const result = spawnSync(process.execPath, [worker, job], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const saved = readJSON(path.join(job, "result.json"));
  assert.equal(saved.execution, "not_started"); assert.equal(saved.outcome, cancelled ? "cancelled" : "infrastructure_failed");
  assert.equal(existsSync(marker), false); assert.equal(existsSync(path.join(job, "child.json")), false);
  launchJob(job, worker, 10, 600000);
  assert.deepEqual(readJSON(path.join(job, "launch.json")), launches);
  assert.deepEqual(readJSON(path.join(job, "result.json")), saved);
});
test("resuming an unclaimed launch cannot extend its recorded deadline", t => {
  const f = fixture(t), job = path.join(f.directory, "reserved-job"); mkdirSync(job);
  // Represents interruption after accounting for spawn, before saving its PID.
  const launches = [{ started: Date.now() - 10000, deadlineAt: Date.now() - 1 }]; json(path.join(job, "launch.json"), launches);
  launchJob(job, worker, 2, 600000);
  assert.deepEqual(readJSON(path.join(job, "launch.json")), launches);
  assert.equal(readJSON(path.join(job, "result.json")).execution, "not_started");
  assert.equal(existsSync(path.join(job, "child.json")), false);
});

for (const kind of ["oversized", "filter", "nested", "replacement", "grafts"]) test(`unsupported ${kind} repository stops initialization without a fallback or active run`, async t => {
  const f = fixture(t), index = readFileSync(path.join(f.root, ".git/index"));
  if (kind === "oversized") { writeFileSync(path.join(f.root, "large"), ""); truncateSync(path.join(f.root, "large"), 32 * 1024 * 1024 + 1); }
  if (kind === "filter") writeFileSync(path.join(f.root, ".gitattributes"), "value.cjs filter=custom\n");
  if (kind === "nested") { const nested = path.join(f.root, "nested"); mkdirSync(nested); git(nested, "init", "-q"); writeFileSync(path.join(nested, "kept"), "user work"); }
  if (kind === "replacement") git(f.root, "replace", "HEAD", git(f.root, "commit-tree", "HEAD^{tree}", "-m", "replacement"));
  if (kind === "grafts") writeFileSync(path.join(f.root, ".git/info/grafts"), `${git(f.root, "rev-parse", "HEAD")}\n`);
  const before = git(f.root, "--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all");
  await assert.rejects(f.start(), error => error.code === "UNSUPPORTED_REPOSITORY" && /Workflow stopped; no fallback/.test(error.message));
  assert.equal(existsSync(path.join(f.root, ".git/jig/review-fix")), false);
  assert.equal(existsSync(f.log), false);
  assert.equal(git(f.root, "--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"), before);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), index);
});

test("branch scope rejects a replaced base before allocating a run or invoking providers", async t => {
  const f = fixture(t);
  git(f.root, "switch", "-qc", "feature"); git(f.root, "add", "value.cjs"); git(f.root, "commit", "-qm", "feature");
  const originalDiff = git(f.root, "diff", "main", "HEAD");
  assert.match(originalDiff, /-module.exports = 0;/);
  // Replacement base has the feature tree but no parents. A copy sharing only
  // objects/HEAD would see originalDiff while the source sees an empty diff.
  git(f.root, "replace", "main", git(f.root, "commit-tree", "HEAD^{tree}", "-m", "replacement base"));
  assert.equal(git(f.root, "diff", "main", "HEAD"), "");
  const index = readFileSync(path.join(f.root, ".git/index"));
  await assert.rejects(f.start("success", { options: parseArgs(["--scope", "branch", "--base", "main"]) }), error => error.code === "UNSUPPORTED_REPOSITORY" && /replacement ref/.test(error.message));
  assert.equal(existsSync(path.join(f.root, ".git/jig/review-fix")), false);
  assert.equal(existsSync(f.log), false);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), index);
});

test("replacement refs introduced after initialization block resume before provider work", async t => {
  const f = fixture(t), run = await f.start();
  git(f.root, "replace", "HEAD", git(f.root, "commit-tree", "HEAD^{tree}", "-m", "replacement"));
  const stopped = await advance(run.directory);
  assert.equal(stopped.phase, "BLOCKED");
  assert.equal(stopped.outcome.code, "UNSUPPORTED_REPOSITORY");
  assert.match(stopped.outcome.reason, /replacement ref/);
  assert.equal(existsSync(f.log), false);
  assert.equal((await advance(run.directory)).phase, "BLOCKED");
});

test("grafts introduced after initialization block resume before provider work", async t => {
  const f = fixture(t), run = await f.start();
  writeFileSync(path.join(f.root, ".git/info/grafts"), `${git(f.root, "rev-parse", "HEAD")}\n`);
  const stopped = await advance(run.directory);
  assert.equal(stopped.phase, "BLOCKED");
  assert.equal(stopped.outcome.code, "UNSUPPORTED_REPOSITORY");
  assert.match(stopped.outcome.reason, /graft/);
  assert.equal(existsSync(f.log), false);
  assert.equal((await advance(run.directory)).phase, "BLOCKED");
});

for (const kind of ["root", "submodule", "linked-worktree"]) for (const scope of ["working-tree", "branch"]) test(`shallow ${kind} rejects ${scope} initialization before allocation`, async t => {
  const f = fixture(t);
  git(f.root, "add", "value.cjs"); git(f.root, "commit", "-qm", "second commit");
  const parent = git(f.root, "rev-parse", "HEAD^"), url = pathToFileURL(f.root).href;
  let root, shallow;
  if (kind === "submodule") {
    root = f.root; shallow = path.join(root, "module");
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", "--depth", "1", url, "module");
  } else {
    shallow = path.join(f.directory, "shallow");
    git(f.directory, "clone", "-q", "--depth=1", url, shallow); root = shallow;
    if (kind === "linked-worktree") { root = path.join(f.directory, "linked"); git(shallow, "worktree", "add", "-q", "-b", "linked", root); }
  }
  assert.equal(git(shallow, "rev-parse", "--is-shallow-repository"), "true");
  assert.equal(git(shallow, "rev-list", "--count", "HEAD"), "1");
  assert.throws(() => git(shallow, "cat-file", "-e", parent), "The fixture must really lack its parent object");
  const indexPath = git(root, "rev-parse", "--path-format=absolute", "--git-path", "index");
  const index = readFileSync(indexPath), before = git(root, "--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all");
  const options = parseArgs(scope === "branch" ? ["--base", "HEAD"] : ["--scope", "working-tree"]);
  await assert.rejects(f.start("success", { cwd: root, options }), error => error.code === "UNSUPPORTED_REPOSITORY" && /shallow repository/.test(error.message) && error.message.includes(kind === "submodule" ? shallow : root));
  const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  assert.equal(existsSync(path.join(common, "jig/review-fix")), false); assert.equal(existsSync(f.log), false);
  assert.deepEqual(readFileSync(indexPath), index);
  assert.equal(git(root, "--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"), before);
});

test("shallow history introduced after initialization stops resume without provider work", async t => {
  const f = fixture(t); git(f.root, "add", "value.cjs"); git(f.root, "commit", "-qm", "second commit");
  const root = path.join(f.directory, "clone"); git(f.directory, "clone", "-q", pathToFileURL(f.root).href, root);
  const run = await f.start("success", { cwd: root });
  git(root, "fetch", "-q", "--depth=1", "origin", "main");
  assert.equal(git(root, "rev-parse", "--is-shallow-repository"), "true");
  const stopped = await advance(run.directory);
  assert.equal(stopped.phase, "BLOCKED"); assert.equal(stopped.outcome.code, "UNSUPPORTED_REPOSITORY");
  assert.match(stopped.outcome.reason, /shallow repository/);
  assert.equal(stopped.attempts.length, 0); assert.equal(stopped.round, 0); assert.equal(existsSync(f.log), false);
  assert.equal((await advance(run.directory)).phase, "BLOCKED");
});

for (const role of ["review", "validate", "expired-review"]) test(`${role} cleanup wait survives interruption without replay or deadline reset`, async t => {
  const f = fixture(t); writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  let run = await f.start(); run.config.cleanupTimeoutMs = 30000; save(run, "test-cleanup-budget");
  run = await drive(run, r => role === "validate" ? Boolean(r.validationCycle?.job) : Boolean(r.pending?.command));
  const id = role === "validate" ? run.validationCycle.job : run.pending.id;
  const job = path.join(run.directory, "assignments", id);
  await until(() => existsSync(path.join(job, "result.json")), "completed command result");
  const result = readJSON(path.join(job, "result.json")), owner = readJSON(path.join(job, "child.json"));
  assert.equal(result.execution, "completed");
  await until(() => !groupRunning(owner), "actual group has exited before observation injection");
  const preload = fileURLToPath(new URL("./fixtures/transient-cleanup.mjs", import.meta.url));
  const env = { ...process.env, JIG_TEST_CLEANUP_PID: String(owner.pid) };
  const step = interrupt => spawnSync(process.execPath, ["--import", preload, cli, "advance", "--run", run.directory], {
    env: { ...env, ...(interrupt ? { JIG_TEST_CLEANUP_INTERRUPT: "1" } : {}) }, encoding: "utf8", timeout: 15000,
  });
  const killed = step(true); assert.equal(killed.signal, "SIGKILL", killed.stderr);
  await release(run); run = loadRun(run.directory);
  const deadline = run.cleanupWaits[id].deadlineAt, phase = run.phase, attempts = run.attempts.length, round = run.round;
  assert.equal(TERMINAL.has(phase), false);
  const pending = step(false); assert.equal(pending.status, 0, pending.stderr);
  run = loadRun(run.directory);
  assert.equal(run.phase, phase); assert.equal(run.cleanupWaits[id].deadlineAt, deadline);
  assert.equal(run.attempts.length, attempts); assert.equal(run.round, round);
  if (role === "expired-review") {
    run.cleanupWaits[id].deadlineAt = Date.now() - 1; save(run, "test-elapsed-cleanup-deadline");
    assert.equal(step(false).status, 0); run = loadRun(run.directory);
    assert.equal(run.phase, "REVIEW_INCOMPLETE"); assert.match(run.cleanupBlocked, /cleanup deadline/);
    assert.equal(run.attempts.length, attempts);
    run = await drive(run); assert.equal(run.phase, "REVIEW_INCOMPLETE"); assert.equal(status(run).waiting, false);
  } else {
    run = await advance(run.directory);
    assert.equal(run.cleanupWaits[id], undefined);
    assert.notEqual(run.pending?.id, id); assert.notEqual(run.validationCycle?.job, id);
    assert.equal(run.attempts.length, attempts);
    run = await drive(run); assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  }
  assert.deepEqual(readJSON(path.join(job, "result.json")), result);
  assert.equal(readJSON(path.join(job, "launch.json")).length, 1);
});
async function release(run) { await until(async () => { try { await locked(run.runsRoot, () => {}); return true; } catch { return false; } }, "lock release"); }

test("SHA-256 source and submodule copies retain their own object formats through convergence", async t => {
  const f = fixture(t, "sha256");
  // An initialized gitlink must be reconstructed using its repository metadata.
  const sub = path.join(f.root, "module"); mkdirSync(sub);
  git(sub, "init", "-q", "--object-format=sha256"); git(sub, "config", "user.name", "Test"); git(sub, "config", "user.email", "test@example.invalid");
  writeFileSync(path.join(sub, "kept"), "staged\n"); git(sub, "add", "."); git(sub, "commit", "-qm", "submodule"); git(f.root, "add", "module");
  writeFileSync(path.join(sub, "kept"), "unstaged\n"); writeFileSync(path.join(f.root, "untracked"), "keep\n");
  const before = snapshot(f.root), run = await drive(await f.start());
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.deepEqual(snapshot(f.root).repositories, before.repositories);
  assert.deepEqual(snapshot(f.root).files["module/kept"], before.files["module/kept"]);
  assert.equal(readFileSync(path.join(f.root, "untracked"), "utf8"), "keep\n");
});

test("wrong-platform sandbox is rejected before an active run is published", async t => {
  const f = fixture(t);
  await assert.rejects(f.start("success", { config: { validationSandbox: process.platform === "darwin" ? "bubblewrap" : "seatbelt" } }), /unavailable.*no automatic host fallback/);
  assert.equal(existsSync(path.join(f.root, ".git/jig/review-fix/active.json")), false);
  assert.equal(existsSync(f.log), false);
  assert.equal((await f.start()).phase, "INIT");
});

test("older run formats are rejected explicitly without resetting their state or launching work", async t => {
  const f = fixture(t), run = await f.start(), file = path.join(run.directory, "run.json");
  run.version = 2; run.round = 2;
  const saved = JSON.stringify(run); writeFileSync(file, saved);
  await assert.rejects(advance(run.directory), /older runs require their original controller/);
  await assert.rejects(f.start(), /older runs require their original controller/);
  assert.equal(readFileSync(file, "utf8"), saved); assert.equal(existsSync(f.log), false);
});

test("relative commands use the assignment cwd and require executable files", async t => {
  const f = fixture(t), bridge = path.join(f.root, "bridge");
  writeFileSync(bridge, `#!${process.execPath}\nawait import(${JSON.stringify(new URL("./fixtures/loop-provider.mjs", import.meta.url).href)});\n`);
  assert.equal(executableCommand({ role: "repair", cwd: f.root, command: ["./bridge"] }), false);
  chmodSync(bridge, 0o755);
  assert.equal(executableCommand({ role: "repair", cwd: f.root, command: ["bridge"] }, { PATH: "." }), true);
  const argv = ["./bridge", "success", f.log];
  const run = await drive(await f.start("success", { config: { reviewers: [{ id: "codex", command: argv }], triageCommand: argv, repairCommand: argv } }));
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
});

test("interruption during allocation resumes the same prepared assignment and cleans every owned copy", async t => {
  const f = fixture(t); let run = await f.start("success", { config: {} });
  run = await advance(run.directory); run = await advance(run.directory);
  const killed = spawnSync(process.execPath, ["--import", inject, cli, "advance", "--run", run.directory], { env: { ...process.env, JIG_TEST_COPY_FAULT: "kill" }, encoding: "utf8", timeout: 15000 });
  assert.equal(killed.signal, "SIGKILL", killed.stderr); await release(run);
  run = loadRun(run.directory); const id = run.pending.id;
  assert.equal(run.pending.preparing, true); assert.equal(reservedOverlays(run).length, 1);
  run = await advance(run.directory); assert.equal(run.pending.id, id); assert.equal(run.attempts.length, 1);
  // A copy reserved outside an assignment must also be reconciled after loss.
  const orphan = makeOverlay(run, run.expected, "abandoned-inspection");
  writeFileSync(path.join(f.root, "user-change"), "preserve\n"); run = await drive(run);
  assert.equal(run.phase, "SCOPE_CHANGED"); assert.equal(existsSync(orphan), false);
  assert.deepEqual(reservedOverlays(run), []); assert.deepEqual(readdirSync(run.workspaceRoot), []);
  assert.equal(readFileSync(path.join(f.root, "user-change"), "utf8"), "preserve\n");
});

test("preparation errors settle durably and do not strand the active run", async t => {
  const f = fixture(t); let run = await f.start();
  run = await advance(run.directory); run = await advance(run.directory);
  const failed = spawnSync(process.execPath, ["--import", inject, cli, "advance", "--run", run.directory], { env: { ...process.env, JIG_TEST_COPY_FAULT: "throw" }, encoding: "utf8", timeout: 15000 });
  assert.equal(failed.status, 0, failed.stderr);
  run = await drive(loadRun(run.directory)); assert.equal(run.phase, "REVIEW_INCOMPLETE");
  assert.match(run.outcome.reason, /Injected copy preparation failure/); assert.deepEqual(reservedOverlays(run), []);
  assert.equal((await f.start()).phase, "INIT"); assert.equal(existsSync(f.log), false);
});

for (const role of ["triage", "repair"]) test(`${role} retries settled reports within one logical assignment budget`, async t => {
  const f = fixture(t), run = await drive(await f.start(`${role}-failure-once`));
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run))); assert.equal(run.round, 1);
  const failures = run.assignmentAttempts.filter(a => a.role === role && a.error);
  assert.equal(failures.length, 1); assert.equal(failures[0].execution, "completed");
  const calls = readFileSync(f.log, "utf8").trim().split("\n"); assert.equal(calls.length, new Set(calls).size);
});

test("permanent repair report failure exhausts attempts without applying edits", async t => {
  const f = fixture(t), run = await drive(await f.start("repair-failure-always"));
  assert.equal(run.phase, "BLOCKED"); assert.equal(run.round, 1);
  assert.equal(run.assignmentAttempts.filter(a => a.role === "repair").length, 3);
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 1;\n");
});

test("triage launch recovery is counted without consuming a repair round", async t => {
  const f = fixture(t), bridge = path.join(f.directory, "triage");
  writeFileSync(bridge, `#!${process.execPath}\nawait import(${JSON.stringify(new URL("./fixtures/loop-provider.mjs", import.meta.url).href)});\n`); chmodSync(bridge, 0o755);
  const argv = [process.execPath, stub, "success", f.log];
  let run = await drive(await f.start("success", { config: { reviewers: [{ id: "codex", command: argv }], triageCommand: [bridge, "success", f.log], repairCommand: argv } }), r => r.phase === "TRIAGE");
  chmodSync(bridge, 0o644);
  run = await drive(run, r => Boolean(r.assignmentAttempts?.some(a => a.error)));
  assert.equal(run.assignmentRetry.infrastructureFailures, 1); assert.equal(run.round, 0);
  assert.equal(run.assignmentAttempts.at(-1).execution, "not_started");
  chmodSync(bridge, 0o755); run = await drive(run);
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run))); assert.equal(run.round, 1);
});

for (const kind of ["timeout", "reported"]) test(`uncertain triage execution (${kind}) stops without replay`, async t => {
  const f = fixture(t), argv = [process.execPath, stub, "success", f.log];
  const code = kind === "timeout" ? "process.stdin.resume();setInterval(()=>{},1000)"
    : "process.stdout.write(JSON.stringify({error:'Remote response was lost',execution:'uncertain'}))";
  const run = await drive(await f.start("success", { config: { reviewers: [{ id: "codex", command: argv }], triageCommand: [process.execPath, "-e", code], repairCommand: argv, timeoutMs: 500 } }));
  assert.equal(run.phase, "BLOCKED", JSON.stringify(status(run))); assert.equal(run.round, 0);
  assert.equal(run.outcome.role, "triage"); assert.equal(run.outcome.code, "EXECUTION_UNCERTAIN");
  assert.equal(run.assignmentAttempts.length, 1); assert.equal(run.assignmentAttempts[0].execution, "uncertain");
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 1;\n");
});

for (const kind of ["fifo", "external-symlink", "cycle", "oversized"]) test(`validation discovery stops on ${kind} manifests before allocation`, async t => {
  const f = fixture(t), manifest = path.join(f.root, "package.json");
  if (kind === "fifo") { writeFileSync(manifest, "{}"); git(f.root, "add", "package.json"); rmSync(manifest); execFileSync("mkfifo", [manifest]); }
  if (kind === "external-symlink") {
    const fifo = path.join(f.directory, "manifest.pipe"); execFileSync("mkfifo", [fifo]); symlinkSync(fifo, manifest);
    assert.equal(snapshot(f.root).files["package.json"].type, "symlink");
  }
  if (kind === "cycle") symlinkSync("package.json", manifest);
  if (kind === "oversized") { writeFileSync(manifest, ""); truncateSync(manifest, 32 * 1024 * 1024 + 1); }
  const result = spawnSync(process.execPath, [cli, "plan-validation", "--cwd", f.root], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 1);
  assert.match(result.stderr, /UNSUPPORTED_REPOSITORY/); assert.match(result.stderr, /package.json/);
  await assert.rejects(f.start(), error => error.code === "UNSUPPORTED_REPOSITORY");
  assert.equal(existsSync(path.join(f.root, ".git/jig/review-fix")), false); assert.equal(existsSync(f.log), false);
});
test("validation discovery supports included regular symlink targets and retains invalid JSON evidence", t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, "manifest.json"), JSON.stringify({ scripts: { test: "node test.cjs" } }));
  symlinkSync("manifest.json", path.join(f.root, "package.json"));
  assert.deepEqual(discoverValidation(f.root).candidates, [{ source: "package.json", argv: ["npm", "run", "test"] }]);
  writeFileSync(path.join(f.root, "manifest.json"), "not json");
  assert.deepEqual(discoverValidation(f.root), { sources: ["package.json"], candidates: [] });
});

test("unsupported capability discovered after validation retains the command outcome and stops", async t => {
  const f = fixture(t); writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  f.contract.requiredValidation[0].argv = [process.execPath, "-e", "const fs=require('node:fs');fs.mkdirSync('vendor');require('node:child_process').execFileSync('git',['init','-q'],{cwd:'vendor'});fs.writeFileSync('vendor/kept','preserve')"];
  let run = await drive(await f.start(), r => Boolean(r.validationCycle?.job));
  assert.ok(run.validationCycle?.job, JSON.stringify(status(run)));
  // This tests completed validation, not source capture racing with git init.
  const result = path.join(run.directory, "assignments", run.validationCycle.job, "result.json");
  await until(() => existsSync(result), "validation publishes its durable result");
  run = await drive(run);
  assert.equal(run.phase, "BLOCKED"); assert.equal(run.outcome.code, "UNSUPPORTED_REPOSITORY");
  assert.equal(run.validation.length, 1); assert.equal(run.validation[0].exitCode, 0);
  assert.match(run.validation[0].scopeChange, /Unsupported.*vendor/);
  assert.equal(readFileSync(path.join(f.root, "vendor/kept"), "utf8"), "preserve");
  assert.deepEqual(run.cleanup, []);
});

test("crash after the failure claim is published recovers a counted retry, never a lost worker", async t => {
  const f = fixture(t); let run = await f.start();
  const preload = fileURLToPath(new URL("./fixtures/interrupt-settlement.mjs", import.meta.url));
  const stopped = spawnSync(process.execPath, ["--import", preload, cli, "run", "--run", run.directory], {
    env: { ...process.env, JIG_TEST_SETTLEMENT_POINT: "assignment" }, encoding: "utf8", timeout: 15000,
  });
  assert.equal(stopped.signal, "SIGKILL", stopped.stderr); await release(run); run = loadRun(run.directory);
  const id = run.pending.id, job = path.join(run.directory, "assignments", id);
  assert.equal(existsSync(f.log), false);
  const runtime = new URL("../skills/review-fix-loop/scripts/job-runtime.mjs", import.meta.url).href;
  const crash = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e", `import {failWorkerStart} from ${JSON.stringify(runtime)};failWorkerStart(${JSON.stringify(job)},'injected startup failure');`], {
    env: { ...process.env, JIG_TEST_SETTLEMENT_POINT: "claim" }, encoding: "utf8", timeout: 15000,
  });
  assert.equal(crash.signal, "SIGKILL", crash.stderr);
  assert.equal(existsSync(path.join(job, "result.json")), false);
  assert.equal(readJSON(path.join(job, "claimed")).settlement.execution, "not_started");
  const late = spawnSync(process.execPath, [worker, job], { encoding: "utf8", timeout: 15000 });
  assert.equal(late.status, 0, late.stderr); assert.equal(existsSync(f.log), false);
  run = await drive(run);
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.equal(run.attempts.find(a => a.id === id).execution, "not_started");
  assert.equal(readJSON(path.join(job, "result.json")).error, "injected startup failure");
  const calls = readFileSync(f.log, "utf8").trim().split("\n");
  assert.equal(calls.includes(id), false); assert.equal(calls.length, new Set(calls).size);
  assert.equal(run.round, 1);
});

test("pre-start cancellation survives interruption before its result projection", t => {
  const f = fixture(t), job = path.join(f.directory, "cancel-job"), marker = path.join(f.directory, "unexpected"); mkdirSync(job);
  json(path.join(job, "request.json"), { role: "validate", cwd: f.root, assignment: {}, command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`] });
  const preload = fileURLToPath(new URL("./fixtures/interrupt-settlement.mjs", import.meta.url));
  const runtime = new URL("../skills/review-fix-loop/scripts/job-runtime.mjs", import.meta.url).href;
  const interrupted = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e", `import {cancelJob} from ${JSON.stringify(runtime)};cancelJob(${JSON.stringify(job)},'explicit cancellation');`], {
    env: { ...process.env, JIG_TEST_SETTLEMENT_POINT: "claim" }, encoding: "utf8", timeout: 15000,
  });
  assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr); assert.equal(existsSync(path.join(job, "result.json")), false);
  launchJob(job, worker, 2);
  assert.deepEqual(readJSON(path.join(job, "result.json")), { outcome: "cancelled", execution: "not_started", error: "explicit cancellation" });
  assert.equal(existsSync(path.join(job, "launch.json")), false);
  const late = spawnSync(process.execPath, [worker, job], { encoding: "utf8", timeout: 15000 });
  assert.equal(late.status, 0, late.stderr); assert.equal(existsSync(marker), false);
});

test("worker loss after command leader exit kills surviving descendants without replay", async t => {
  const f = fixture(t), pids = path.join(f.directory, "pids");
  const descendant = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);setTimeout(()=>process.exit(),15000)";
  const code = `const cp=require('node:child_process'),fs=require('node:fs'); const child=cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',process.stdout,process.stderr]}); fs.writeFileSync(${JSON.stringify(pids)},JSON.stringify({leader:process.pid,descendant:child.pid}));setTimeout(()=>process.exit(0),200);`;
  let run = await drive(await f.start("success", { config: { reviewers: [{ id: "codex", command: [process.execPath, "-e", code] }] } }), r => Boolean(r.pending));
  await until(() => existsSync(pids), "provider start");
  const values = readJSON(pids), owner = { pid: values.descendant, token: identity(values.descendant)?.token };
  const leader = { pid: values.leader, token: identity(values.leader)?.token };
  try {
    await until(() => !ownedAlive(leader), "command leader exit");
    const job = path.join(run.directory, "assignments", run.pending.id);
    process.kill(readJSON(path.join(job, "claimed")).pid, "SIGKILL");
    run = await drive(run);
    assert.equal(run.phase, "REVIEW_INCOMPLETE"); assert.equal(run.attempts.length, 1);
    assert.equal(ownedAlive(owner), false); assert.equal(groupRunning(readJSON(path.join(job, "child.json"))), false);
    assert.deepEqual(run.cleanup, []); assert.equal(run.cleanupBlocked, null);
  } finally { killOwned(owner); }
});

test("worker loss before anchor publication cannot start the command", async t => {
  const f = fixture(t), job = path.join(f.directory, "job"), marker = path.join(f.directory, "executed"); mkdirSync(job);
  writeFileSync(path.join(job, "request.json"), JSON.stringify({ role: "validate", cwd: f.root, command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], assignment: {} }));
  const killed = spawnSync(process.execPath, ["--import", inject, worker, job], { env: { ...process.env, JIG_TEST_ANCHOR_FAULT: "1" }, encoding: "utf8", timeout: 15000 });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  await until(() => existsSync(path.join(job, "result.json")), "anchor cancellation");
  assert.equal(readJSON(path.join(job, "result.json")).execution, "not_started"); assert.equal(existsSync(marker), false);
});

test("forced inherited-stream cleanup retains the known command exit code but fails validation", t => {
  const f = fixture(t), job = path.join(f.directory, "job"); mkdirSync(job);
  const code = "require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);setTimeout(()=>process.exit(),10000)\"],{stdio:['ignore',process.stdout,process.stderr]});setTimeout(()=>process.exit(0),200)";
  writeFileSync(path.join(job, "request.json"), JSON.stringify({ role: "validate", cwd: f.root, command: [process.execPath, "-e", code], timeoutMs: 5000, assignment: {} }));
  execFileSync(process.execPath, [worker, job], { timeout: 15000 });
  const result = readJSON(path.join(job, "result.json"));
  assert.equal(result.outcome, "failed"); assert.equal(result.exitCode, 0); assert.equal(result.signal, null);
  assert.match(result.error, /streams did not close/); assert.equal(groupRunning(readJSON(path.join(job, "child.json"))), false);
});

test("validation receives EOF while provider commands retain their JSON stdin protocol", t => {
  const f = fixture(t);
  for (const role of ["validate", "review"]) {
    const job = path.join(f.directory, `stdin-${role}`); mkdirSync(job);
    const code = `const fs=require('node:fs'),a=require('node:assert/strict');const input=fs.readFileSync(0,'utf8');a.equal(input,${JSON.stringify(role === "validate" ? "" : '{"marker":"assignment"}')});process.stdout.write('{"ok":true}');`;
    writeFileSync(path.join(job, "request.json"), JSON.stringify({ role, cwd: f.root, command: [process.execPath, "-e", code], assignment: { marker: "assignment" } }));
    execFileSync(process.execPath, [worker, job], { timeout: 15000 });
    const result = readJSON(path.join(job, "result.json"));
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    if (role === "validate") assert.equal(result.outcome, "succeeded");
    else assert.equal(result.ok, true);
  }
});

const logFault = fileURLToPath(new URL("./fixtures/validation-log-fault.mjs", import.meta.url));
for (const fault of ["open", "existing", "short", "zero", "write", "close"]) test(`validation log ${fault} follows the command execution boundary`, t => {
  const f = fixture(t), job = path.join(f.directory, "log-job"), marker = path.join(f.directory, "executed"); mkdirSync(job);
  const payload = "BEGIN-0123456789-END\n";
  json(path.join(job, "request.json"), { role: "validate", cwd: f.root, assignment: {}, timeoutMs: 5000,
    command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes');process.stdout.write(${JSON.stringify(payload)})`] });
  if (fault === "existing") writeFileSync(path.join(job, "stdout.log"), "retained evidence");
  const execution = spawnSync(process.execPath, [worker, job], { encoding: "utf8", timeout: 15000,
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(logFault).href}`, JIG_TEST_LOG_FAULT: fault } });
  assert.equal(execution.status, 0, execution.stderr);
  const result = readJSON(path.join(job, "result.json"));
  if (["open", "existing"].includes(fault)) {
    assert.equal(existsSync(marker), false); assert.equal(result.execution, "not_started");
    assert.equal(result.outcome, "infrastructure_failed"); assert.equal(result.infrastructure, true);
    assert.match(result.error, fault === "open" ? /EACCES/ : /EEXIST/);
    if (fault === "existing") assert.equal(readFileSync(path.join(job, "stdout.log"), "utf8"), "retained evidence");
  } else if (fault === "short") {
    assert.equal(existsSync(marker), true); assert.equal(result.outcome, "succeeded");
    assert.equal(result.stdout, payload); assert.equal(result.stdoutBytes, Buffer.byteLength(payload));
    assert.equal(readFileSync(result.log, "utf8"), payload); assert.equal(result.logTruncated, false);
  } else {
    assert.equal(existsSync(marker), true); assert.equal(result.outcome, "infrastructure_failed");
    assert.equal(result.execution, "uncertain"); assert.notEqual(result.infrastructure, true);
    assert.match(result.error, /Validation log/);
  }
});

for (const persistent of [false, true]) test(`validation log startup failure ${persistent ? "exhausts its bounded retry" : "recovers without a repair round"}`, async t => {
  const f = fixture(t), marker = path.join(f.directory, "validation-executions"), faults = path.join(f.directory, "log-fault-count");
  writeFileSync(path.join(f.root, "value.cjs"), "module.exports = 2;\n");
  f.contract.requiredValidation[0].argv[2] += `;require('node:fs').appendFileSync(${JSON.stringify(marker)},'executed\\n')`;
  const initial = await f.start();
  const completed = spawnSync(process.execPath, [cli, "run", "--run", initial.directory], { encoding: "utf8", timeout: 60000,
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(logFault).href}`, JIG_TEST_LOG_FAULT: "open",
      JIG_TEST_LOG_FAILURES: faults, JIG_TEST_LOG_FAILURE_LIMIT: persistent ? "10" : "1" } });
  assert.equal(completed.status, 0, completed.stderr);
  const run = loadRun(initial.directory);
  assert.equal(run.phase, persistent ? "VALIDATION_FAILED" : "CONVERGED", JSON.stringify(status(run)));
  assert.equal(run.round, 0); assert.equal(run.validation.length, 2);
  assert.equal(run.validation[0].execution, "not_started"); assert.equal(run.validation[0].infrastructure, true);
  assert.equal(run.events.filter(event => event.event === "infrastructure-retry").length, 1);
  if (persistent) { assert.equal(existsSync(marker), false); assert.equal(run.validation[1].execution, "not_started"); }
  else { assert.equal(readFileSync(marker, "utf8"), "executed\n"); assert.equal(run.validation[1].outcome, "succeeded"); }
});

for (const field of ["exitCode", "signal", "execution"]) test(`provider ${field} cannot masquerade as trusted transport metadata`, async t => {
  const f = fixture(t), value = field === "exitCode" ? 73 : field === "signal" ? "SIGTERM" : "completed";
  const code = `let text='';for await(const chunk of process.stdin)text+=chunk;const a=JSON.parse(text);process.stdout.write(JSON.stringify({assignmentId:a.id,fingerprint:a.fingerprint,complete:true,findings:[],acceptance:[{criterionId:'value',status:'satisfied',evidence:'fixture',validationIds:['unit']}],${field}:${JSON.stringify(value)}}));`;
  const run = await drive(await f.start("success", { options: parseArgs(["--max-provider-attempts", "1"]), config: { reviewers: [{ id: "codex", command: [process.execPath, "-e", code] }] } }), r => r.reports.length > 0);
  assert.equal(run.phase, "REVIEW_INCOMPLETE"); assert.equal(run.reports.length, 0); assert.equal(run.attempts.length, 1);
  const result = readJSON(path.join(run.directory, "assignments", run.attempts[0].id, "result.json"));
  assert.match(result.error, /[Rr]eserved.*transport|execution.*error/);
  assert.equal(result.exitCode, 0); assert.equal(result.signal, null); assert.equal(result.execution, "completed");
});

test("provider uncertainty remains a supported error result without forged exit facts", async t => {
  const f = fixture(t), code = "process.stdout.write(JSON.stringify({error:'Remote outcome unknown',execution:'uncertain'}))";
  const run = await drive(await f.start("success", { config: { reviewers: [{ id: "codex", command: [process.execPath, "-e", code] }] } }));
  assert.equal(run.phase, "REVIEW_INCOMPLETE"); assert.equal(run.outcome.code, "EXECUTION_UNCERTAIN"); assert.equal(run.attempts.length, 1);
  const result = readJSON(path.join(run.directory, "assignments", run.attempts[0].id, "result.json"));
  assert.equal(result.exitCode, 0); assert.equal(result.signal, null); assert.equal(result.execution, "uncertain");
});

test("lost group anchor cannot release a run while a verified test child remains alive", async t => {
  const f = fixture(t), marker = path.join(f.directory, "provider-pid");
  const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(),20000)`;
  let run = await drive(await f.start("success", { config: { reviewers: [{ id: "codex", command: [process.execPath, "-e", code] }] } }), r => Boolean(r.pending));
  await until(() => existsSync(marker), "provider running");
  const providerPid = Number(readFileSync(marker, "utf8")), provider = { pid: providerPid, token: identity(providerPid)?.token };
  const job = path.join(run.directory, "assignments", run.pending.id), anchor = readJSON(path.join(job, "child.json"));
  try {
    assert.equal(groupRunning(anchor), true);
    process.kill(anchor.pid, "SIGKILL");
    await until(() => existsSync(path.join(job, "result.json")), "uncertain result after anchor loss");
    run = await drive(run);
    assert.equal(run.phase, "REVIEW_INCOMPLETE");
    assert.match(run.cleanupBlocked, /surviving processes/);
    assert.equal(run.cleanup.length, 1); assert.equal(ownedAlive(provider), true);
    await assert.rejects(f.start(), /Resume the active run/);
  } finally {
    if (ownedAlive(provider)) process.kill(provider.pid, "SIGKILL");
    await until(() => !groupRunning(anchor), "test provider exit");
  }
  run = await drive(run); assert.deepEqual(run.cleanup, []);
  assert.equal((await f.start()).phase, "INIT");
});

test("fresh-process polling reads neither source files nor immutable inventories; result consumption still guards drift", async t => {
  const f = fixture(t), releaseFile = path.join(f.directory, "release"), marker = path.join(f.directory, "started");
  for (let i = 0; i < 400; i++) writeFileSync(path.join(f.root, `kept-${i}`), `kept ${i}\n`);
  const code = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'started');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseFile)})){clearInterval(timer);process.stdout.write(JSON.stringify({error:'Finished test invocation'}))}},20);setTimeout(()=>process.exit(),20000).unref()`;
  let run = await drive(await f.start("success", { config: { reviewers: [{ id: "codex", command: [process.execPath, "-e", code] }] } }), r => Boolean(r.pending));
  await until(() => existsSync(marker), "provider running");
  const raw = readJSON(path.join(run.directory, "run.json"));
  assert.deepEqual(raw.expected, raw.original);
  assert.ok(raw.expected.$manifest); assert.ok(raw.pending.before.$manifest);
  assert.ok(JSON.stringify(raw).length < 25000, "hot state must not contain 400-path inventories");
  const log = path.join(f.directory, "io"), observer = fileURLToPath(new URL("./fixtures/observe-poll.mjs", import.meta.url));
  try {
    for (let i = 0; i < 3; i++) {
      const result = spawnSync(process.execPath, ["--import", observer, cli, "advance", "--run", run.directory], {
        env: { ...process.env, JIG_TEST_SOURCE_ROOT: f.root, JIG_TEST_IO_LOG: log }, encoding: "utf8", timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).phase, "REVIEW");
    }
    assert.equal(existsSync(log), false, existsSync(log) ? readFileSync(log, "utf8") : "");
    assert.equal(readFileSync(path.join(f.directory, "started"), "utf8"), "started");
    writeFileSync(path.join(f.root, "kept-0"), "concurrent edit\n");
  } finally { writeFileSync(releaseFile, "finish"); }
  run = await drive(run);
  assert.equal(run.phase, "SCOPE_CHANGED"); assert.equal(run.attempts.length, 1); assert.equal(run.reports.length, 0);
  assert.equal(readFileSync(path.join(f.root, "kept-0"), "utf8"), "concurrent edit\n");
});

test("immutable inventories are reused across state saves and verified when read after resume", async t => {
  const f = fixture(t), run = await f.start();
  const before = readdirSync(path.join(run.directory, "manifests"));
  for (let i = 0; i < 5; i++) save(loadRun(run.directory), "test-event");
  assert.deepEqual(readdirSync(path.join(run.directory, "manifests")), before);
  const resumed = loadRun(run.directory);
  assert.equal(resumed.events.length, 6); assert.equal(resumed.expected.guard, run.expected.guard);
  assert.throws(() => { resumed.expected.files["value.cjs"].mode = 0o777; }, TypeError);
  const reference = readJSON(path.join(run.directory, "run.json")).expected.$manifest;
  writeFileSync(path.join(run.directory, "manifests", `${reference}.json`), "{}");
  assert.throws(() => loadRun(run.directory).expected, /Saved snapshot manifest changed/);
});
