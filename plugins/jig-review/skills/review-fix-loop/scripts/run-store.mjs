import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { streamFile } from "./file-content.mjs";
// V14 pins commit mode and journals controller-owned round commits.
// Older runs retain their original frozen instructions and controller.
export const RUN_VERSION = 15;

const canonical = value => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  : Array.isArray(value) ? value.map(canonical) : value;
export const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest("hex");
export const contentHash = files => hash(Object.fromEntries(Object.entries(files).filter(([, value]) => value !== null)));
export const dictionary = value => Object.assign(Object.create(null), value);
export const readJSON = file => JSON.parse(readFileSync(file, "utf8"));
export function storeBlob(directory, bytes) {
  const digest = hash(bytes), file = path.join(directory, "blobs", digest);
  if (!existsSync(file)) atomic(file, bytes);
  return digest;
}
export function storeFile(directory, file, options = {}) {
  const blobs = path.join(directory, "blobs");
  mkdirSync(blobs, { recursive: true, mode: 0o700 });
  const temporary = path.join(blobs, `${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    let value;
    try { value = streamFile(file, { ...options, destination: fd }); fsyncSync(fd); }
    finally { closeSync(fd); }
    const destination = path.join(blobs, value.blob);
    if (existsSync(destination)) unlinkSync(temporary);
    else renameSync(temporary, destination);
    const parent = openSync(blobs, "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
    return value;
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function copyBlob(directory, digest, destination) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid content reference.");
  const value = streamFile(path.join(directory, "blobs", digest), { destination });
  if (value.blob !== digest) throw new Error("Saved content changed.");
}
export function readBlob(directory, digest) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid content reference.");
  const bytes = readFileSync(path.join(directory, "blobs", digest));
  if (hash(bytes) !== digest) throw new Error("Saved content changed.");
  return bytes;
}
export function atomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  const parent = openSync(path.dirname(file), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
export const json = (file, value) => atomic(file, `${JSON.stringify(value, null, 2)}\n`);
// Large immutable snapshots stay outside hot workflow state. On resume they
// are lazy: polling a pending job need not read or parse any file inventory.
const manifestFields = { original: true, expected: true, preservationBaseline: true, sourceChanges: true, reconciledPaths: true, importedReview: true, pending: { before: true, metadata: true }, reviewQueue: { "*": { before: true, metadata: true } },
  retainedCheckout: { before: true, metadata: true },
  candidate: { files: true }, failedCandidate: { files: true }, appliedCandidate: { files: true },
  validationCycle: { files: true, metadata: true }, apply: { source: true } };
const references = new WeakMap(), values = new WeakMap();
function freezeManifest(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeManifest(child);
  }
  return value;
}
function storeManifest(directory, value) {
  const cached = values.get(value);
  if (cached?.directory === directory) return cached.reference;
  const reference = { $manifest: hash(value) }, file = path.join(directory, "manifests", `${reference.$manifest}.json`);
  if (!existsSync(file)) json(file, value);
  values.set(freezeManifest(value), { directory, reference });
  return reference;
}
function manifests(value, fields, directory, reading) {
  if (!value) return value;
  const result = {};
  for (const key of Object.keys(value)) {
    const field = Object.hasOwn(fields, key) ? fields[key] : fields["*"];
    if (field === undefined) { result[key] = value[key]; continue; }
    if (field !== true) { result[key] = manifests(value[key], field, directory, reading); continue; }
    if (!reading) {
      const getter = Object.getOwnPropertyDescriptor(value, key)?.get;
      result[key] = references.get(getter) ?? storeManifest(directory, value[key]);
      continue;
    }
    const reference = value[key];
    if (!reference || !/^[a-f0-9]{64}$/.test(reference.$manifest) || Object.keys(reference).length !== 1) throw new Error("Invalid snapshot manifest reference.");
    let loaded;
    const get = () => {
      if (!loaded) {
        loaded = readJSON(path.join(directory, "manifests", `${reference.$manifest}.json`));
        if (hash(loaded) !== reference.$manifest) throw new Error("Saved snapshot manifest changed.");
        // File names remain arbitrary dictionary keys after a process restart.
        if (["before", "files"].includes(key)) loaded = dictionary(loaded);
        else if (["original", "expected", "source"].includes(key)) loaded = { ...loaded, files: dictionary(loaded.files) };
        values.set(freezeManifest(loaded), { directory, reference });
      }
      return loaded;
    };
    references.set(get, reference);
    Object.defineProperty(result, key, { enumerable: true, configurable: true, get,
      set(next) { Object.defineProperty(this, key, { enumerable: true, configurable: true, writable: true, value: next }); } });
  }
  return result;
}
export function save(run, event, detail = {}) {
  run.events.push({ seq: run.events.length + 1, time: new Date().toISOString(), event, phase: run.phase, ...detail });
  json(path.join(run.directory, "run.json"), manifests(run, manifestFields, run.directory, false));
  // run.json is authoritative; replay repairs a crash between projection writes.
  atomic(path.join(run.directory, "events.jsonl"), run.events.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  json(path.join(run.directory, "validation.json"), run.validation);
}

// The controller owns the open file description. A short-lived helper acquires
// its lock through a duplicate descriptor; helper exit cannot release our copy.
export async function locked(directory, action) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockFile = path.join(directory, "controller.lock");
  const argv = process.platform === "darwin"
    ? ["python3", "-I", fileURLToPath(new URL("./macos-runtime.py", import.meta.url)), "lock", "3"]
    : ["flock", "-n", "-E", "75", "3"];
  const fd = openSync(lockFile, "a", 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "ignore", "ignore", fd], timeout: 5000, killSignal: "SIGKILL" });
      let failure;
      child.once("error", error => { failure = error; });
      child.once("close", (code, signal) => {
        if (!failure && code === 0 && !signal) resolve();
        else reject(new Error(code === 75 ? "Another controller holds this repository lock."
          : `Controller locking requires ${argv[0]} and a working kernel lock (${failure?.message ?? signal ?? `exit ${code}`}).`));
      });
    });
    return await action();
  } finally { closeSync(fd); }
}

function loadVersionedRun(directory, versions) {
  const run = readJSON(path.join(directory, "run.json"));
  if (path.resolve(directory) !== run.directory || !versions.includes(run.version)) throw new Error("Invalid run directory or version; older runs require their original controller. No state or counters were migrated or reset.");
  if (hash(readJSON(path.join(directory, "task-contract.json"))) !== run.contractHash) throw new Error("Frozen task contract changed.");
  return manifests(run, manifestFields, directory, true);
}
export const loadRun = directory => loadVersionedRun(directory, [RUN_VERSION]);
// V4 through V13 share the readable journal and manifest schema. This reader is
// exclusively for releasing a settled reference, never resuming old work.
export const loadRunForRelease = directory => loadVersionedRun(directory, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, RUN_VERSION]);
export function resultFile(run, id) { return path.join(run.directory, "assignments", id, "result.json"); }
export function hasResult(run, id) { return existsSync(resultFile(run, id)); }
