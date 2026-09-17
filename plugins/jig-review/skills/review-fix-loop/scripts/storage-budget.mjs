import { existsSync, lstatSync, readdirSync, statfsSync } from "node:fs";
import path from "node:path";

const MiB = 1024 * 1024;
export const DEFAULT_STORAGE = Object.freeze({ maxSourceBytes: 1024 * MiB, maxRunBytes: 4096 * MiB, maxRetainedBytes: 8192 * MiB, minFreeBytes: 64 * MiB });
export const storageLimit = message => Object.assign(new Error(`Storage capacity: ${message}. Workflow stopped; no data was pruned.`), { code: "STORAGE_LIMIT" });
export function storageLimits(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("storage must be an object of byte limits.");
  for (const [key, limit] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULT_STORAGE, key) || !Number.isSafeInteger(limit) || limit < 1) throw new Error(`Invalid storage limit: ${key}`);
  }
  const limits = { ...DEFAULT_STORAGE, ...value };
  if (limits.maxSourceBytes > limits.maxRunBytes || limits.maxRunBytes > limits.maxRetainedBytes) throw new Error("Storage limits require maxSourceBytes <= maxRunBytes <= maxRetainedBytes.");
  return limits;
}
// Count logical bytes without following links or opening source contents. This
// is admission accounting for controller allocations, not a filesystem quota
// on arbitrary validation commands or unrelated processes.
export function storedBytes(directory) {
  if (!existsSync(directory)) return 0;
  const stat = lstatSync(directory);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(directory).reduce((sum, name) => sum + storedBytes(path.join(directory, name)), 0);
}
export function assertStorage(run, additionalBytes) {
  const limits = storageLimits(run.config?.storage);
  const external = run.workspaceRoot ? storedBytes(run.workspaceRoot) : 0;
  const current = storedBytes(run.directory) + external;
  const retained = storedBytes(run.runsRoot ?? path.dirname(run.directory)) + external;
  if (current + additionalBytes > limits.maxRunBytes) throw storageLimit(`run needs ${current + additionalBytes} bytes; maxRunBytes=${limits.maxRunBytes}`);
  if (retained + additionalBytes > limits.maxRetainedBytes) throw storageLimit(`retained runs need ${retained + additionalBytes} bytes; maxRetainedBytes=${limits.maxRetainedBytes}`);
  const devices = new Map();
  for (let location of [run.directory, run.workspaceRoot].filter(Boolean)) {
    while (!existsSync(location)) location = path.dirname(location);
    const stat = lstatSync(location), fs = statfsSync(location);
    devices.set(stat.dev, fs.bavail * fs.bsize);
  }
  for (const available of devices.values()) if (available < additionalBytes + limits.minFreeBytes) throw storageLimit(`need ${additionalBytes} allocation bytes and ${limits.minFreeBytes} free reserve; available=${available}`);
}
