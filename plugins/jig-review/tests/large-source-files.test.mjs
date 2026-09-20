import assert from "node:assert/strict";
import fs, { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyFile, backupEntry, changes, entry, git, makeOverlay, pathsDifferFromIndex, snapshot } from "../skills/review-fix-loop/scripts/repository.mjs";
import { copyBlob, storeFile } from "../skills/review-fix-loop/scripts/run-store.mjs";
import { advance, createRun, runUntilBoundary, status } from "../skills/review-fix-loop/scripts/review-fix-loop.mjs";
import { parseArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";

const size = 36897688;
function largeFile(file, bytes = size) {
  const fd = openSync(file, "w"), digest = createHash("sha256");
  const chunk = Buffer.alloc(64 * 1024, "x");
  try {
    for (let offset = 0; offset < bytes; offset += chunk.length) {
      const part = chunk.subarray(0, Math.min(chunk.length, bytes - offset));
      writeSync(fd, part); digest.update(part);
    }
  } finally { closeSync(fd); }
  return digest.digest("hex");
}
function fixture(t) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-large-source-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "repo"), store = path.join(directory, "store");
  mkdirSync(root); mkdirSync(store);
  git(root, "init", "-q", "-b", "main"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
  const digest = largeFile(path.join(root, "latency.fixture"));
  writeFileSync(path.join(root, "value.cjs"), "module.exports = 0;\n");
  git(root, "add", "."); git(root, "commit", "-qm", "baseline");
  writeFileSync(path.join(root, "value.cjs"), "module.exports = 1;\n");
  const index = readFileSync(path.join(root, ".git/index"));
  const contract = { goal: "Repair export with benchmark fixture preserved", acceptanceCriteria: [{ id: "value", description: "Exports 2 and fixture is unchanged" }],
    nonGoals: [], compatibilityConstraints: ["Preserve fixture and index"], permittedBehaviorChanges: ["Correct export"],
    requiredValidation: [{ id: "unit", argv: [process.execPath, "-e", `const a=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');a.equal(require('./value.cjs'),2);a.equal(fs.statSync('latency.fixture').size,${size});const h=crypto.createHash('sha256');const s=fs.createReadStream('latency.fixture');s.on('data',c=>h.update(c));s.on('end',()=>a.equal(h.digest('hex'),'${digest}'));s.on('error',e=>{throw e});`] }] };
  return { root, directory: store, temporary: directory, digest, index, contract };
}
async function start(t, f, excluded = false, config = {}) {
  const run = await createRun({ cwd: f.root, contract: f.contract,
    options: parseArgs(["--scope", "working-tree", ...(excluded ? ["--exclude-path", "latency.fixture"] : [])]), config });
  t.after(() => rmSync(path.dirname(run.workspaceRoot), { recursive: true, force: true }));
  return run;
}

for (const excluded of [false, true]) test(`unchanged 35.2 MiB fixture survives repair and validation (excluded=${excluded})`, async t => {
  const f = fixture(t);
  const stub = fileURLToPath(new URL("./fixtures/loop-provider.mjs", import.meta.url));
  const command = [process.execPath, stub, "workspace"];
  let run = await start(t, f, excluded, { reviewers: [{ id: "codex", command }], triageCommand: command, repairCommand: command });
  run = await runUntilBoundary(run.directory);
  assert.equal(run.phase, "CONVERGED", JSON.stringify(status(run)));
  assert.equal(run.round, 1); assert.equal(run.attempts.length, 4);
  assert.ok(run.validation.some(v => v.outcome === "succeeded"));
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 2;\n");
  assert.equal(entry(f.root, "latency.fixture").blob, f.digest);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
  // Independently check a materialized copy, not just metadata or a clean diff.
  const overlay = makeOverlay(run, run.expected, "fixture-verification");
  execFileSync(process.execPath, f.contract.requiredValidation[0].argv.slice(1), { cwd: overlay });
  assert.equal(entry(overlay, "latency.fixture").blob, f.digest);
});

test("excluded large source edits are detected and recorded before continuing", async t => {
  const f = fixture(t), run = await start(t, f, true);
  appendFileSync(path.join(f.root, "latency.fixture"), "external edit");
  const stopped = await advance(run.directory);
  assert.equal(stopped.phase, "INIT");
  assert.deepEqual(stopped.sourceReconciliations[0].paths, ["latency.fixture"]);
  assert.notEqual(stopped.expected.files["latency.fixture"].blob, f.digest);
  assert.equal(stopped.attempts.length, 0);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
});

test("excluded large workspace files cannot be silently changed", t => {
  const f = fixture(t), before = snapshot(f.root, f.directory);
  const overlay = makeOverlay(f, before, "excluded-copy");
  appendFileSync(path.join(overlay, "latency.fixture"), "unexpected edit");
  assert.throws(() => changes(before.files, snapshot(overlay).files, ["latency.fixture"]), /Mutation of excluded path/);
  assert.equal(entry(f.root, "latency.fixture").blob, f.digest);
});

test("large source still respects aggregate storage budgets before allocation", async t => {
  const f = fixture(t);
  await assert.rejects(start(t, f, true, { storage: { maxSourceBytes: size - 1 } }), e => e.code === "STORAGE_LIMIT");
  assert.equal(existsSync(path.join(f.root, ".git/jig/review-fix")), false);
  assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), f.index);
  assert.equal(entry(f.root, "latency.fixture").blob, f.digest);
});

test("large repaired files preserve journal backups and accurate index comparisons", t => {
  const f = fixture(t), before = snapshot(f.root, f.directory), name = "latency.fixture";
  for (const flag of ["assume-unchanged", "skip-worktree"]) {
    git(f.root, "update-index", `--${flag}`, name);
    assert.equal(pathsDifferFromIndex(f.root, [name], before.repositories), false);
  }
  const replacement = path.join(f.temporary, "replacement");
  largeFile(replacement); appendFileSync(replacement, "repair\n");
  const after = { type: "file", ...storeFile(f.directory, replacement) };
  const edit = { path: name, before: before.files[name], after, temporary: ".jig-apply-abcd", backup: path.join(f.directory, "backup") };
  applyFile(f.root, edit, f.directory);
  assert.equal(entry(f.root, name).blob, after.blob);
  assert.deepEqual(backupEntry(edit), before.files[name]);
  assert.equal(pathsDifferFromIndex(f.root, [name], before.repositories), true);
  assert.equal(existsSync(path.join(f.root, edit.temporary)), false);
});

test("large blob corruption prevents publication over the original file", t => {
  const f = fixture(t), before = snapshot(f.root, f.directory), value = before.files["latency.fixture"];
  const blob = path.join(f.directory, "blobs", value.blob), fd = openSync(blob, "r+");
  try { writeSync(fd, Buffer.from("!"), 0, 1, 0); } finally { closeSync(fd); }
  const edit = { path: "value.cjs", before: before.files["value.cjs"], after: value, temporary: ".jig-apply-abcd", backup: path.join(f.directory, "backup") };
  assert.throws(() => applyFile(f.root, edit, f.directory), /Saved content changed/);
  assert.equal(readFileSync(path.join(f.root, "value.cjs"), "utf8"), "module.exports = 1;\n");
  assert.equal(existsSync(edit.backup), false);
});

for (const fault of ["mutation", "replacement", "short-write"]) test(`streaming handles ${fault} without publishing bad blobs`, t => {
  const f = fixture(t), file = path.join(f.root, "latency.fixture");
  const originalRead = fs.readSync, originalWrite = fs.writeSync;
  let injected = false;
  fs.readSync = (...args) => {
    const count = originalRead(...args);
    if (!injected && count && fault !== "short-write") {
      injected = true;
      if (fault === "mutation") appendFileSync(file, "concurrent write");
      else { renameSync(file, `${file}.original`); writeFileSync(file, "replacement"); }
    }
    return count;
  };
  fs.writeSync = (fd, bytes, offset, length, position) => originalWrite(fd, bytes, offset, Math.min(length, 4096), position);
  syncBuiltinESMExports();
  try {
    if (fault === "short-write") {
      const saved = storeFile(f.directory, file);
      assert.equal(saved.blob, f.digest);
      const output = path.join(f.temporary, "copied"), fd = openSync(output, "wx");
      try { copyBlob(f.directory, saved.blob, fd); } finally { closeSync(fd); }
      assert.equal(entry(f.temporary, "copied").blob, f.digest);
    } else {
      assert.throws(() => storeFile(f.directory, file), /File changed/);
      assert.deepEqual(readdirSync(path.join(f.directory, "blobs")), []);
    }
  } finally { fs.readSync = originalRead; fs.writeSync = originalWrite; syncBuiltinESMExports(); }
});

test("file-backed capture and copy use bounded memory", t => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-stream-memory-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const digest = largeFile(path.join(directory, "input"), 96 * 1024 * 1024);
  const module = new URL("../skills/review-fix-loop/scripts/repository.mjs", import.meta.url).href;
  const code = `import {entry,put} from ${JSON.stringify(module)};
    const root=${JSON.stringify(directory)};global.gc();const start=process.resourceUsage().maxRSS;
    const value=entry(root,'input',root+'/store');put(root,'output',value,root+'/store');
    const copied=entry(root,'output');console.log(JSON.stringify({value,copied,growthKiB:process.resourceUsage().maxRSS-start}));`;
  const result = JSON.parse(execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", code], { encoding: "utf8" }));
  assert.equal(result.value.blob, digest); assert.equal(result.copied.blob, digest);
  assert.ok(result.growthKiB < 48 * 1024, `96 MiB capture/copy grew resident memory by ${result.growthKiB} KiB`);
});
