import { lstatSync, readlinkSync } from "node:fs";
import { validateEvidenceOutputs } from "./evidence-outputs.mjs";
import path from "node:path";
import { safePath, git, repositoryRoot, readRegularFile, unsupported } from "./repository.mjs";

export function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
export function command(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonempty);
}
export function timeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error("timeoutMs must be an integer between 1 and 2147483647.");
  return value;
}
export function validateContract(contract) {
  if (!contract || !nonempty(contract.goal)) throw new Error("Task contract requires a goal.");
  for (const name of ["nonGoals", "compatibilityConstraints", "permittedBehaviorChanges"]) {
    if (!Array.isArray(contract[name]) || !contract[name].every(nonempty)) throw new Error(`Task contract requires ${name} as an array of strings.`);
  }
  for (const name of ["acceptanceCriteria", "requiredValidation", ...(contract.prerequisites === undefined ? [] : ["prerequisites"])]) {
    if (!Array.isArray(contract[name]) || (!contract[name].length && name !== "prerequisites")) throw new Error(`Task contract requires nonempty ${name}.`);
    const ids = new Set();
    for (const item of contract[name]) {
      if (!item || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(item.id) || ids.has(item.id)) throw new Error(`Invalid or duplicate ${name} ID.`);
      ids.add(item.id);
      if (name === "acceptanceCriteria" && !nonempty(item.description)) throw new Error("Acceptance criterion requires description.");
      if (name !== "acceptanceCriteria") {
        if (item.requiredEnvironment !== undefined && (!Array.isArray(item.requiredEnvironment) || item.requiredEnvironment.some(name => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))) throw new Error("requiredEnvironment must contain variable names, never values.");
        if (name === "prerequisites" && item.optional) throw new Error("Prerequisites cannot be optional.");
        if (!command(item.argv)) throw new Error("Validation requires a nonempty argv array.");
        if (item.cwd && item.cwd !== ".") safePath(item.cwd);
        if (item.optional !== undefined && typeof item.optional !== "boolean") throw new Error("optional must be boolean.");
        if (item.timeoutMs !== undefined) timeout(item.timeoutMs);
      }
    }
  }
  if (!contract.requiredValidation.some(check => !check.optional)) throw new Error("At least one required validation command is necessary.");
  validateEvidenceOutputs(contract.evidenceOutputs);
  const normalized = structuredClone(contract);
  const validationIds = new Set(contract.requiredValidation.map(check => check.id));
  if (contract.prerequisites?.some(check => validationIds.has(check.id))) throw new Error("Prerequisite IDs must differ from validation IDs.");
  for (const check of [...normalized.requiredValidation, ...(normalized.prerequisites ?? [])]) if (check.cwd === ".") delete check.cwd;
  return normalized;
}

// Discovery is evidence for the planner, never authority to execute arbitrary
// package scripts. The host pins concrete argv commands in the task contract.
export function discoverValidation(root) {
  root = repositoryRoot(root);
  const files = git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard").toString().split("\0").filter(Boolean);
  const sources = [...new Set(files.filter(name => /(^|\/)(AGENTS\.md|CONTRIBUTING\.md|\.jig\.toml|jig-contract\.json|package\.json|Cargo\.toml|Makefile|Justfile|justfile|go\.mod|pyproject\.toml)$/.test(name) || /^\.github\/workflows\/.*\.ya?ml$/.test(name)))].sort();
  const candidates = [];
  const included = new Set(files);
  const readManifest = name => {
    const visited = new Set(); let target = name;
    for (;;) {
      if (!included.has(target) || visited.has(target)) throw unsupported(`Unsupported manifest target for ${name}: ${target} is untracked by discovery or cyclic.`);
      visited.add(target); safePath(target);
      let stat;
      try { stat = lstatSync(path.join(root, target)); }
      catch (error) { if (error.code === "ENOENT" && target === name && visited.size === 1) return null; throw error; }
      if (!stat.isSymbolicLink()) return readRegularFile(root, target).bytes;
      const link = readlinkSync(path.join(root, target));
      if (path.isAbsolute(link)) throw unsupported(`Unsupported manifest target for ${name}: absolute symlink ${target}.`);
      target = path.posix.normalize(path.posix.join(path.posix.dirname(target), link));
      try { safePath(target); } catch { throw unsupported(`Unsupported manifest target for ${name}: symlink leaves the supported repository paths.`); }
    }
  };
  for (const name of sources.filter(name => /(^|\/)package\.json$/.test(name))) {
    const bytes = readManifest(name);
    if (bytes === null) continue;
    let pkg;
    try { pkg = JSON.parse(bytes.toString("utf8")); }
    catch { continue; /* Invalid JSON remains a discovery source, never a command. */ }
    try {
      for (const key of Object.keys(pkg.scripts ?? {}).filter(key => /^(test|check|lint|typecheck|build|format:check)(:|$)/.test(key))) candidates.push({ source: name, argv: ["npm", "run", key], ...(path.dirname(name) === "." ? {} : { cwd: path.dirname(name) }) });
    } catch { /* A malformed package object remains a source to inspect. */ }
  }
  return { sources, candidates };
}
