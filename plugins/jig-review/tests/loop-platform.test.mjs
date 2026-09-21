import assert from "node:assert/strict";
import childProcess, { execFile, spawn, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { identity, ownedAlive, killOwned, groupRunning } from "../skills/review-fix-loop/scripts/process-ownership.mjs";
import { locked } from "../skills/review-fix-loop/scripts/run-store.mjs";
import { alternateObjectDirectories, makeOverlay, safePath } from "../skills/review-fix-loop/scripts/repository.mjs";
import { createWorkingTreeRun as createRun } from "./fixtures/working-tree-loop.mjs";
import { defaultValidationSandbox, validationSandboxCommand } from "../skills/review-fix-loop/scripts/validation-sandbox.mjs";

const exec = promisify(execFile);
test("macOS identity probes consume one deadline, including time between helpers", () => {
  const source = new URL("../skills/review-fix-loop/scripts/process-ownership.mjs", import.meta.url).href;
  const code = `import assert from 'node:assert/strict';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process,'platform',{value:'darwin'});
let now=1000, calls=[];Date.now=()=>now;
cp.execFileSync=(command,args,options)=>{calls.push(options.timeout);now+=30;return command.includes('sysctl')?'boot':JSON.stringify({token:'start',running:true});};
syncBuiltinESMExports();const {identity}=await import(${JSON.stringify(source)});
assert.equal(identity(123,{deadlineAt:1100}).token,'boot:start');assert.deepEqual(calls,[100,70]);
const fresh=await import(${JSON.stringify(source + "?exhausted")});calls=[];now=2000;
cp.execFileSync=(command,args,options)=>{calls.push(command);now=2100;return 'boot';};syncBuiltinESMExports();
assert.throws(()=>fresh.identity(123,{deadlineAt:2100}),/deadline exceeded/);assert.deepEqual(calls,['/usr/sbin/sysctl']);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});
test("macOS process-group API distinguishes inspection errors, stale errno, and PID-buffer capacity", () => {
  const runtime = fileURLToPath(new URL("../skills/review-fix-loop/scripts/macos-runtime.py", import.meta.url));
  const code = `import ctypes, errno, importlib.util, types
spec = importlib.util.spec_from_file_location("runtime", ${JSON.stringify(runtime)})
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
def failure(*args):
    ctypes.set_errno(errno.EPERM)
    return 0
library = types.SimpleNamespace(proc_listpgrppids=failure)
runtime.ctypes.CDLL = lambda *args, **kwargs: library
try:
    runtime.group_running(123)
    raise AssertionError("inspection error was treated as an empty group")
except RuntimeError:
    pass
library.proc_listpgrppids = lambda *args: 0
ctypes.set_errno(errno.EPERM)
assert runtime.group_running(123) is False
sizes = []
def full_then_one(pgid, pids, byte_capacity):
    sizes.append(len(pids))
    assert byte_capacity == len(pids) * ctypes.sizeof(ctypes.c_int)
    pids[0] = 123
    return len(pids) if len(sizes) == 1 else 1
library.proc_listpgrppids = full_then_one
runtime.process_identity = lambda pid: {"running": True}
assert runtime.group_running(123) is True
assert sizes == [4096, 8192]
`;
  const result = spawnSync("python3", ["-I", "-B", "-c", code], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});
function temporary(t, base = os.tmpdir()) {
  const dir = realpathSync(mkdtempSync(path.join(base, "jig-platform-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function sandbox(t) {
  const dir = temporary(t), overlay = path.join(dir, "overlay"), scratch = path.join(dir, "scratch");
  mkdirSync(overlay); mkdirSync(scratch);
  const mode = defaultValidationSandbox();
  if (mode === "bubblewrap" && spawnSync("bwrap", ["--unshare-net", "--ro-bind", "/", "/", "--", "true"]).status !== 0) {
    t.skip("Bubblewrap/user namespaces unavailable"); return null;
  }
  const run = (code, ...args) => {
    const cmd = validationSandboxCommand(mode, overlay, scratch, [process.execPath, "-e", code, ...args]);
    return exec(cmd.argv[0], cmd.argv.slice(1), { cwd: overlay, env: { ...process.env, ...cmd.environment }, timeout: 10000 });
  };
  return { dir, overlay, scratch, run };
}

test("process identity is stable, rejects stale tokens, and detects an exited owned process", async () => {
  const current = identity(process.pid);
  assert.ok(current?.token); assert.equal(current.running, true);
  assert.deepEqual(identity(process.pid), current);
  assert.equal(ownedAlive({ pid: process.pid, token: `${current.token}-stale` }), false);
  assert.equal(identity(-1), null);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const closed = new Promise(resolve => child.once("close", resolve));
  const owner = { pid: child.pid, token: identity(child.pid)?.token };
  try { assert.equal(ownedAlive(owner), true); } finally { killOwned(owner); }
  await closed;
  assert.equal(ownedAlive(owner), false);
});

for (const size of [1, 2, 3]) test(`live process group with ${size} members is detected, including after anchor loss`, async () => {
  const code = `const cp=require('node:child_process');const pids=[];for(let i=1;i<${size};i++)pids.push(cp.spawn(process.execPath,['-e','setInterval(()=>{},1000);setTimeout(()=>process.exit(),20000)'],{stdio:'ignore'}).pid);process.stdout.write(JSON.stringify(pids)+'\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  const pids = await new Promise((resolve, reject) => { child.stdout.once("data", data => resolve(JSON.parse(data))); child.once("error", reject); });
  const owner = { pid: child.pid, token: identity(child.pid)?.token };
  const descendants = pids.map(pid => ({ pid, token: identity(pid)?.token }));
  try {
    assert.equal(groupRunning(owner), true);
    child.kill("SIGKILL"); await closed;
    assert.equal(ownedAlive(owner), false);
    assert.equal(groupRunning(owner), size > 1);
  } finally {
    killOwned(owner);
    // These children were created by this test. Signal only their verified PID,
    // not a group whose anchor has deliberately been removed.
    for (const descendant of descendants) if (ownedAlive(descendant)) process.kill(descendant.pid, "SIGKILL");
    await closed;
  }
  const deadline = Date.now() + 3000;
  while (groupRunning(owner) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(groupRunning(owner), false);
});

test("kernel lock excludes another controller and releases when the owning controller is killed", async t => {
  const dir = temporary(t);
  const storeUrl = new URL("../skills/review-fix-loop/scripts/run-store.mjs", import.meta.url).href;
  const source = `import {locked} from ${JSON.stringify(storeUrl)}; await locked(${JSON.stringify(dir)}, async () => { process.stdout.write('locked\\n'); setInterval(() => {}, 1000); await new Promise(() => {}); });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); child.once("exit", code => reject(new Error(`Lock owner exited ${code}`))); });
  try { await assert.rejects(locked(dir, () => {}), /holds this repository lock/); }
  finally { child.kill("SIGKILL"); await closed; }
  const deadline = Date.now() + 2000;
  for (;;) {
    try { await locked(dir, () => {}); break; }
    catch (error) {
      if (!/holds this repository lock/.test(error.message) || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
});

for (const throws of [false, true]) test(`kernel lock outlives its acquisition helper and releases after ${throws ? "throw" : "return"}`, async t => {
  const dir = temporary(t), helpers = [], original = childProcess.spawn;
  childProcess.spawn = (...args) => {
    const child = original(...args);
    if (args[0] === (process.platform === "darwin" ? "python3" : "flock")) helpers.push({ child, closed: new Promise(resolve => child.once("close", resolve)) });
    return child;
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawn = original; syncBuiltinESMExports(); });
  const failure = new Error("Action failed");
  const action = locked(dir, async () => {
    const { child, closed } = helpers[0];
    // Exercise the previous live-helper design too: eliminate only processes
    // owned by this fixture. The replacement helper has already exited.
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === "linux") {
        const { stdout } = await promisify(execFile)("pgrep", ["-P", String(child.pid)]);
        for (const pid of stdout.trim().split("\n").map(Number)) {
          const owner = { pid, token: identity(pid)?.token };
          if (ownedAlive(owner)) process.kill(pid, "SIGKILL");
        }
      } else child.kill("SIGKILL");
    }
    await closed;
    await assert.rejects(locked(dir, () => assert.fail("Overlapping protected actions")), /holds this repository lock/);
    if (throws) throw failure;
    return "protected";
  });
  if (throws) await assert.rejects(action, error => error === failure);
  else assert.equal(await action, "protected");
  assert.equal(await locked(dir, () => "released"), "released");
});

test("lock acquisition requires successful helper exit, not stdout", async t => {
  const dir = temporary(t), original = childProcess.spawn;
  childProcess.spawn = (_command, _args, options) => original(process.execPath,
    ["-e", "process.stdout.write('locked\\n');setTimeout(()=>process.kill(process.pid,'SIGKILL'),50)"], options);
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawn = original; syncBuiltinESMExports(); });
  let entered = false;
  await assert.rejects(locked(dir, () => { entered = true; }), /Controller locking/);
  assert.equal(entered, false);
});

test("validation sandbox allows its copy and scratch while denying outside writes and symlink escapes", async t => {
  const s = await sandbox(t); if (!s) return;
  // Linux replaces /tmp with private scratch space; test a real host file
  // outside that mount instead of writing a harmless copy in the new /tmp.
  const hostDirectory = temporary(t, process.platform === "linux" ? "/var/tmp" : os.tmpdir());
  const outside = path.join(hostDirectory, "preserved.txt"); writeFileSync(outside, "user work");
  symlinkSync(outside, path.join(s.overlay, "outside-link"));
  await s.run("const fs=require('node:fs'),os=require('node:os'),p=require('node:path');fs.writeFileSync('allowed','copy');fs.writeFileSync(p.join(os.tmpdir(),'scratch-test'),'scratch');for(const dir of [process.env.HOME,process.env.XDG_CACHE_HOME,process.env.XDG_CONFIG_HOME]){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(p.join(dir,'tool-cache'),'cache');}");
  assert.equal(readFileSync(path.join(s.overlay, "allowed"), "utf8"), "copy");
  assert.equal(readFileSync(path.join(s.scratch, "scratch-test"), "utf8"), "scratch");
  for (const directory of [s.scratch, path.join(s.scratch, "cache"), path.join(s.scratch, "config")]) assert.equal(readFileSync(path.join(directory, "tool-cache"), "utf8"), "cache");
  await s.run(`const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(process.env.HOME,${JSON.stringify(s.scratch)});assert.equal(require('node:os').tmpdir(),${JSON.stringify(s.scratch)});assert.equal(fs.readFileSync(process.env.XDG_CACHE_HOME+'/tool-cache','utf8'),'cache');`);
  for (const target of [outside, "outside-link"]) await s.run(`const fs=require('node:fs'),assert=require('node:assert/strict'); assert.throws(()=>fs.writeFileSync(process.argv[1],'bad'),e=>['EPERM','EACCES','EROFS','ENOENT'].includes(e.code));`, target);
  assert.equal(readFileSync(outside, "utf8"), "user work");
});

test("validation sandbox denies network access without falling back to host execution", async t => {
  const s = await sandbox(t); if (!s) return;
  await s.run("const net=require('node:net');const socket=net.connect({host:'192.0.2.1',port:80});socket.on('connect',()=>process.exit(2));socket.on('error',e=>{if(!['EPERM','EACCES','ENETUNREACH','EHOSTUNREACH'].includes(e.code))process.exitCode=3});setTimeout(()=>process.exit(4),2000).unref();");
  assert.throws(() => validationSandboxCommand(process.platform === "darwin" ? "bubblewrap" : "seatbelt", s.overlay, s.scratch, ["true"]), /no automatic host fallback/);
});

test("Git metadata aliases cannot become repair paths on a case-insensitive filesystem", () => {
  for (const value of [".git/config", ".GIT/config", "sub/.Git/HEAD"]) assert.throws(() => safePath(value), /Unsafe repository path/);
});

test("isolated Git can read recursive object alternates under temporary paths but cannot write them", async t => {
  const s = await sandbox(t); if (!s) return;
  const original = path.join(s.dir, "original"), shared = path.join(s.dir, "shared"), checkout = path.join(s.dir, "checkout");
  mkdirSync(original);
  const git = (cwd, ...args) => exec("git", args, { cwd });
  await git(original, "init", "-q", "-b", "main");
  writeFileSync(path.join(original, "value.txt"), "before\n");
  await git(original, "add", "value.txt");
  await git(original, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
  await git(s.dir, "clone", "-q", "--shared", original, shared);
  await git(shared, "worktree", "add", "-q", "-b", "exercise", checkout, "HEAD");
  writeFileSync(path.join(checkout, "value.txt"), "after\n");
  const run = await createRun({ cwd: checkout, contract: {
    goal: "Read the changed value", nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: [],
    acceptanceCriteria: [{ id: "value", description: "Value changes" }], requiredValidation: [{ id: "git", argv: ["git", "diff", "HEAD"] }],
  } });
  const overlay = makeOverlay(run, run.expected, "git-validation");
  const objects = alternateObjectDirectories(overlay, run.expected.repositories);
  assert.ok(objects.includes(path.join(original, ".git/objects")));
  assert.ok(objects.includes(path.join(shared, ".git/objects")));
  const command = validationSandboxCommand(defaultValidationSandbox(), overlay, s.scratch, [process.execPath, "-e", `
    const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');
    assert.match(cp.execFileSync('git',['diff','HEAD'],{encoding:'utf8'}),/\\+after/);
    assert.throws(()=>fs.readFileSync(${JSON.stringify(path.join(checkout, "value.txt"))}),e=>['EPERM','EACCES','ENOENT'].includes(e.code));
    for(const object of process.argv.slice(1)) assert.throws(()=>fs.writeFileSync(object+'/forbidden','no'),e=>['EPERM','EACCES','EROFS'].includes(e.code));
  `, ...objects], objects, checkout);
  await exec(command.argv[0], command.argv.slice(1), { cwd: overlay, env: { ...process.env, ...command.environment }, timeout: 10000 });
  assert.equal(readFileSync(path.join(checkout, "value.txt"), "utf8"), "after\n");
});
