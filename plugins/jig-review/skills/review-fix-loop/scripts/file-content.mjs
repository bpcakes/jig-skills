import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, writeSync } from "node:fs";
import { storageLimit } from "./storage-budget.mjs";

const identity = ["dev", "ino", "mode", "size", "mtimeMs", "ctimeMs"];
export const sameFile = (a, b) => identity.every(key => a[key] === b[key]);

// Keep the opened inode and its pathname stable across each synchronous read.
// Git can consume the descriptor directly without buffering its input in Node.
export function withRegularFile(file, action, expectedStat) {
  const before = expectedStat ?? lstatSync(file);
  if (!before.isFile()) throw Object.assign(new Error(`Unsupported non-regular file: ${file}. Workflow stopped; no fallback is permitted.`), { code: "UNSUPPORTED_REPOSITORY" });
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameFile(before, fstatSync(fd))) throw new Error(`File changed before read: ${file}`);
    const result = action(fd, before);
    if (!sameFile(before, fstatSync(fd)) || !sameFile(before, lstatSync(file))) throw new Error(`File changed during read: ${file}`);
    return result;
  } finally { closeSync(fd); }
}

// A single reusable buffer covers hashing, blob capture, and verified copying.
// Aggregate source/storage admission remains the caller's responsibility.
export function streamFile(file, { destination, expectedStat, maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
  return withRegularFile(file, (fd, stat) => {
    if (stat.size > maxBytes) throw storageLimit(`file exceeds remaining source allocation of ${maxBytes} bytes: ${file}`);
    const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    const deadline = Date.now() + 300000;
    let position = 0;
    while (position < stat.size) {
      if (Date.now() >= deadline) throw new Error(`File read exceeded its deadline: ${file}`);
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!count) throw new Error(`File changed during read: ${file}`);
      const chunk = buffer.subarray(0, count);
      digest.update(chunk);
      if (destination !== undefined) {
        let written = 0;
        while (written < count) {
          const amount = writeSync(destination, chunk, written, count - written);
          if (!amount) throw new Error(`File copy made no progress: ${file}`);
          written += amount;
        }
      }
      position += count;
    }
    return { blob: digest.digest("hex"), mode: stat.mode & 0o777 };
  }, expectedStat);
}
