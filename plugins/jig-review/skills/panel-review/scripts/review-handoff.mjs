#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBrief, validateBrief } from "./review-brief.mjs";
import { captureFingerprint } from "./scope-fingerprint.mjs";
import { isExcludedPath, normalizeExcludePaths } from "./review-exclusions.mjs";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = value => typeof value === "string" && value.trim().length > 0;
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = message => { throw new Error(`REVIEW_HANDOFF_INVALID: ${message}`); };
function fields(value, names) {
  if (!value || Array.isArray(value) || typeof value !== "object"
      || Object.keys(value).some(key => !names.includes(key)) || names.some(key => !Object.hasOwn(value, key))) fail(`Expected fields: ${names.join(", ")}`);
}
function readInput(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) fail("Input must be a regular file of at most 4 MiB.");
  const bytes = readFileSync(file);
  if (bytes.length > 4 * 1024 * 1024) fail("Input exceeds 4 MiB.");
  return JSON.parse(bytes);
}
export function validateHandoff(handoff) {
  fields(handoff, ["version", "payload", "hash"]);
  if (handoff.version !== 1 || !hex(handoff.hash) || digest(handoff.payload) !== handoff.hash) fail("Version or content hash mismatch.");
  const p = handoff.payload;
  fields(p, ["capture", "brief", "reviewers", "findings"]);
  const c = p.capture;
  if (!c || c.complete !== true || !Array.isArray(c.issues) || c.issues.length || !hex(c.fingerprint)
      || !text(c.repoRoot) || !path.isAbsolute(c.repoRoot) || !["working-tree", "branch"].includes(c.scope)
      || (c.scope === "branch" && (!/^[a-f0-9]{40,64}$/.test(c.baseOid ?? "")
        || (c.includeWorkingTree !== true && c.checkoutClean !== true)))) fail("A complete concrete scope capture is required.");
  for (const key of ["explicitExcludePaths", "reviewIgnorePaths", "excludePaths"]) {
    if (!Array.isArray(c[key]) || JSON.stringify(normalizeExcludePaths(c[key])) !== JSON.stringify(c[key])) fail(`Invalid ${key}.`);
  }
  fields(p.brief, ["hash", "brief"]);
  if (!hex(p.brief.hash)) fail("Invalid brief hash.");
  validateBrief(p.brief.brief);
  if (!Array.isArray(p.reviewers) || !p.reviewers.length || p.reviewers.length > 3) fail("Reviewer outcomes are required.");
  const completed = new Set(), names = new Set();
  for (const r of p.reviewers) {
    fields(r, ["name", "status", "coverage", "limitations", "report"]);
    if (!["Claude", "Codex", "Cursor"].includes(r.name) || names.has(r.name)
        || !["completed", "failed", "timed out", "not started"].includes(r.status)
        || !["complete", "limited", "reviewer-attested", "none"].includes(r.coverage)
        || !Array.isArray(r.limitations) || !r.limitations.every(text) || typeof r.report !== "string") fail("Invalid reviewer outcome.");
    names.add(r.name);
    if (r.status === "completed") {
      if (!text(r.report) || r.coverage === "none") fail("A completed reviewer needs a frozen report and coverage.");
      completed.add(r.name);
    } else if (r.coverage !== "none") fail("An incomplete reviewer cannot claim coverage.");
  }
  if (!completed.size) fail("No completed reviewer report.");
  if (!Array.isArray(p.findings) || p.findings.length > 128) fail("At most 128 adjudicated findings are supported.");
  const keys = new Set();
  for (const f of p.findings) {
    fields(f, ["key", "path", "severity", "title", "evidence", "sources"]);
    if (![f.key, f.path, f.title, f.evidence].every(text) || !["critical", "high", "medium", "low"].includes(f.severity)
        || /[\\\0\r\n]/.test(f.path) || /^[A-Za-z]:/.test(f.path) || path.posix.isAbsolute(f.path)
        || f.path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
        || isExcludedPath(f.path, c.excludePaths)
        || !Array.isArray(f.sources) || !f.sources.length || new Set(f.sources).size !== f.sources.length
        || f.sources.some(source => !completed.has(source))) fail("Invalid or excluded finding, or unsupported source attribution.");
    const key = JSON.stringify([f.path, f.key]);
    if (keys.has(key)) fail("Duplicate finding identity.");
    keys.add(key);
  }
  if (Buffer.byteLength(JSON.stringify(handoff)) > 4 * 1024 * 1024) fail("Handoff exceeds 4 MiB.");
  return handoff;
}
export function createHandoff({ capture, brief, reviewers, findings }) {
  const payload = structuredClone({ capture, brief, reviewers, findings });
  return validateHandoff({ version: 1, payload, hash: digest(payload) });
}
export const readHandoff = file => validateHandoff(readInput(file));

// Recompute the original review mode, including committed-only branch scope.
// The loop may then pin its own branch-including-worktree capture for repairs.
export async function verifyHandoffScope(handoff, cwd) {
  validateHandoff(handoff);
  const c = handoff.payload.capture;
  if (realpathSync(cwd) !== realpathSync(c.repoRoot)) throw new Error("REVIEW_HANDOFF_STALE: repository differs; no discovery review was started.");
  const current = await captureFingerprint({ cwd, scope: c.scope, base: c.baseOid,
    includeWorkingTree: c.includeWorkingTree === true, excludePaths: c.explicitExcludePaths, timeoutMs: 300000 });
  if (!current.complete || current.fingerprint !== c.fingerprint
      || current.headOid !== c.headOid || current.baseOid !== c.baseOid
      || current.reviewIgnoreRevision !== c.reviewIgnoreRevision
      || JSON.stringify(current.excludePaths) !== JSON.stringify(c.excludePaths)) {
    throw new Error("REVIEW_HANDOFF_STALE: reviewed scope, source, or index changed; reconcile the findings and refresh the handoff explicitly. No discovery review was started.");
  }
  return current;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), flags = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!["--capture", "--brief", "--brief-hash", "--review", "--output"].includes(args[i]) || flags[args[i]] || !args[i + 1]) fail("Usage: review-handoff.mjs --capture capture.json --brief brief.json --brief-hash SHA256 --review review.json --output /tmp/handoff.json");
      flags[args[i]] = args[i + 1];
    }
    if (Object.keys(flags).length !== 5) fail("All five arguments are required.");
    const review = readInput(flags["--review"]);
    fields(review, ["reviewers", "findings"]);
    const handoff = createHandoff({ capture: readInput(flags["--capture"]), brief: readBrief(flags["--brief"], flags["--brief-hash"]), ...review });
    await verifyHandoffScope(handoff, handoff.payload.capture.repoRoot);
    const output = path.join(realpathSync(path.dirname(path.resolve(flags["--output"]))), path.basename(flags["--output"]));
    const root = realpathSync(handoff.payload.capture.repoRoot);
    if (output === root || output.startsWith(root + path.sep)) fail("Write the handoff outside the reviewed checkout.");
    writeFileSync(output, JSON.stringify(handoff, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(JSON.stringify({ handoff: output, hash: handoff.hash }) + "\n");
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
