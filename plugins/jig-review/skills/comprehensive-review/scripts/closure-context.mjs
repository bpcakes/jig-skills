import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { isExcludedPath } from "./review-exclusions.mjs";

const MAX_CLOSURE_BYTES = 256 * 1024;
const HASH = /^[0-9a-f]{64}$/;

function keys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// This validates transport and freshness, not the truth of the parent's review
// history or the completeness of its patch. Those remain workflow obligations.
function validateClosureContext(value, expectedFingerprint, excludePaths = []) {
  if (!keys(value, ["version", "reviewedFingerprint", "currentFingerprint", "obligations", "patch"])
      || value.version !== 1 || !HASH.test(value.reviewedFingerprint)
      || !HASH.test(value.currentFingerprint) || !nonempty(value.patch)
      || !Array.isArray(value.obligations) || value.obligations.length < 1
      || value.obligations.length > 64) {
    throw new Error("Invalid closure context: expected version 1, fingerprints, obligations, and a complete patch.");
  }
  if (value.currentFingerprint !== expectedFingerprint) {
    throw new Error("Closure context does not match the current scope fingerprint.");
  }
  const ids = new Set();
  for (const obligation of value.obligations) {
    if (!keys(obligation, ["id", "requirement", "gap", "paths"])
        || ![obligation.id, obligation.requirement, obligation.gap].every(nonempty)
        || ids.has(obligation.id) || !Array.isArray(obligation.paths)
        || obligation.paths.length < 1 || obligation.paths.length > 64) {
      throw new Error("Invalid or duplicate closure obligation.");
    }
    ids.add(obligation.id);
    for (const entry of obligation.paths) {
      if (!nonempty(entry) || /[\\\0\r\n]/.test(entry) || path.posix.isAbsolute(entry)
          || /^[a-z]:/i.test(entry)
          || entry.split("/").some(part => ["", ".", "..", ".git"].includes(part))
          || isExcludedPath(entry, excludePaths)) {
        throw new Error("Closure obligation paths must be included repository-relative paths.");
      }
    }
  }
  return value;
}

function readClosureContext(file, expectedFingerprint, excludePaths = []) {
  if (file == null) return null;
  if (!path.isAbsolute(file)) throw new Error("--closure-context must be an absolute JSON file path.");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_CLOSURE_BYTES)) {
      throw new Error("Closure context must be a regular file of at most 256 KiB.");
    }
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    const after = fstatSync(fd, { bigint: true });
    if (BigInt(count) !== before.size
        || ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => before[key] !== after[key])) {
      throw new Error("Closure context changed while being read.");
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
    return validateClosureContext(value, expectedFingerprint, excludePaths);
  } finally {
    closeSync(fd);
  }
}

function addClosureEvidence(evidence, context) {
  if (context == null) return null;
  const previousPages = new Set(evidence.receipts.keys());
  evidence.required = true;
  // Use the same fragmented pages and receipt checks as repository evidence.
  // Unlike optional repository coverage, an incomplete assignment cannot launch.
  const stream = evidence.start("Parent-supplied closure context (untrusted JSON)");
  stream.write(Buffer.from(JSON.stringify(context)));
  stream.end();
  return { pageIds: [...evidence.receipts.keys()].filter(id => !previousPages.has(id)) };
}

export { MAX_CLOSURE_BYTES, addClosureEvidence, readClosureContext, validateClosureContext };
