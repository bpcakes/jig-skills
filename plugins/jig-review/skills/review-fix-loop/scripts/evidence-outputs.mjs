import path from "node:path";
import { readBlob, hash } from "./run-store.mjs";
import { readRegularFile, safePath } from "./repository.mjs";

export function validateEvidenceOutputs(outputs = []) {
  if (!Array.isArray(outputs)) throw new Error("evidenceOutputs must be an array of exact append-only JSONL paths.");
  const paths = new Set();
  for (const output of outputs) {
    if (!output || typeof output.path !== "string" || output.format !== "jsonl" || Object.keys(output).some(key => !["path", "format"].includes(key))) throw new Error("Evidence output requires path and format: jsonl.");
    safePath(output.path);
    if (!output.path.endsWith(".jsonl") || /[*?\[\]]/.test(output.path) || paths.has(output.path)
        || /^(AGENTS|CLAUDE|CONTRIBUTING)\./i.test(path.posix.basename(output.path))
        || /(?:^|\/)(?:\.git|\.gitignore|\.gitattributes|\.gitmodules|\.reviewignore|jig-contract)(?:[./]|$)/.test(output.path)) throw new Error("Evidence output must name a unique JSONL data file, never repository policy.");
    paths.add(output.path);
  }
  return paths;
}
// Declarations authorize only new complete JSON objects after the exact prior
// bytes. They do not establish validity or applicability of any claimed test.
export function evidenceChanges(run, before, after, root, outputs) {
  const accepted = new Set();
  for (const name of validateEvidenceOutputs(outputs)) {
    const prior = before[name], current = after[name];
    if (hash(prior ?? null) === hash(current ?? null)) continue;
    if (!current || current.type !== "file" || prior && (prior.type !== "file" || prior.mode !== current.mode)) throw new Error(`Evidence output changed kind, mode, or was deleted: ${name}`);
    const oldBytes = prior ? readBlob(run.directory, prior.blob) : Buffer.alloc(0);
    const bytes = readRegularFile(root, name).bytes;
    if (hash(bytes) !== current.blob || bytes.length <= oldBytes.length || !bytes.subarray(0, oldBytes.length).equals(oldBytes)
        || oldBytes.length && oldBytes.at(-1) !== 10 || bytes.at(-1) !== 10) throw new Error(`Evidence output is not an append of complete JSONL records: ${name}`);
    for (const line of bytes.subarray(oldBytes.length).toString("utf8").slice(0, -1).split("\n")) {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Evidence record must be a JSON object: ${name}`);
    }
    accepted.add(name);
  }
  return accepted;
}
