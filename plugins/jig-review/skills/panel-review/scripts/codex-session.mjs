#!/usr/bin/env node

// Starts one Codex CLI review session in the private home the adapter's shim
// prepared. It runs after the Codex home is known, which under a Jig launcher
// is only when Jig starts the shim, so the selected home's configuration can be
// honored while everything it would add besides model settings is excluded.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installAdapterCancellation, remainingAdapterTime } from "./adapter-runtime.mjs";
import { runCommand } from "./review-context.mjs";

const RENDER_TIMEOUT_MS = 60 * 1000;
const MAX_RENDER_BYTES = 64 * 1024 * 1024;
const PROJECT_DOC_OVERRIDES = Object.freeze(["-c", "project_doc_max_bytes=0"]);
const CONFIG_FILE = "config.toml";

// The selected home's config.toml applies, minus project trust and replacement
// base instructions. Trust would load the reviewed repository's own
// .codex/config.toml, which could add servers or redirect the model provider;
// an instructions file would replace the review instructions. Removing the
// lines is the only reliable form: a -c override merges into the projects
// table instead of replacing it. Other additions (MCP servers, hooks, apps,
// plugins, notify, developer instructions) are switched off on the command line.
function reviewerConfig(text) {
  const kept = [];
  let inProjects = false;
  for (const line of text.split("\n")) {
    const header = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(?:#.*)?\r?$/.exec(line);
    if (header) inProjects = /^projects(?:\s*$|\s*\.)/.test(header[1]);
    if (inProjects) continue;
    if (/^\s*projects\s*[.=]/.test(line)) continue;
    if (/^\s*(?:model|experimental)_instructions_file\s*=/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

function prepareHome(sourceHome, privateHome) {
  if (!sourceHome) throw new Error("the shim did not name the selected Codex home.");
  const source = path.join(sourceHome, CONFIG_FILE);
  if (!existsSync(source)) return false;
  writeFileSync(path.join(privateHome, CONFIG_FILE), reviewerConfig(readFileSync(source, "utf8")), { mode: 0o600 });
  return true;
}

function isolationError(message) {
  return Object.assign(new Error(`Codex isolation incomplete: ${message}`), { providerError: `Codex isolation incomplete: ${message}` });
}

function renderedText(value, parts = []) {
  if (typeof value === "string") parts.push(value);
  else if (Array.isArray(value)) for (const item of value) renderedText(item, parts);
  else if (value && typeof value === "object") for (const item of Object.values(value)) renderedText(item, parts);
  return parts.join("\n");
}

function inspectionOptions({ cwd, privateHome, deadlineAt, signal, environment }) {
  return {
    cwd,
    timeoutMs: deadlineAt == null ? RENDER_TIMEOUT_MS : Math.min(RENDER_TIMEOUT_MS, remainingAdapterTime(deadlineAt)),
    maxBuffer: MAX_RENDER_BYTES,
    signal,
    env: { ...(environment ?? process.env), CODEX_HOME: privateHome },
  };
}

// Codex's own renderer is the authority on what it would load for this working
// directory, home, and configuration. Rendering needs no credentials or network.
async function renderPrompt(codexBin, context) {
  const result = await runCommand(codexBin, ["debug", "prompt-input", ...context.overrides, "isolation check"], inspectionOptions(context));
  try {
    return renderedText(JSON.parse(result.stdout.toString("utf8")));
  } catch {
    throw isolationError("codex debug prompt-input did not return a JSON prompt rendering.");
  }
}

// Codex lists the MCP servers its configuration defines, with their effective
// enabled state, without starting them.
async function mcpServers(codexBin, context) {
  const result = await runCommand(codexBin, [...context.overrides, "mcp", "list", "--json"], inspectionOptions(context));
  let servers;
  try {
    servers = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw isolationError("codex mcp list did not return a JSON server list.");
  }
  if (!Array.isArray(servers) || servers.some((server) => typeof server?.name !== "string" || typeof server.enabled !== "boolean")) {
    throw isolationError("codex mcp list returned servers in an unrecognized format.");
  }
  return servers;
}

// Configuration overrides address a server by a dotted key, so only names that
// are bare TOML keys can be disabled; anything else fails isolation.
function mcpOverrides(names) {
  const unaddressable = names.filter((name) => !/^[A-Za-z0-9_-]+$/.test(name));
  if (unaddressable.length) throw isolationError(`MCP servers whose names cannot be disabled: ${unaddressable.join(", ")}`);
  return [...new Set(names)].sort().flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]);
}

// Skills are listed as "(file: rN/relative/SKILL.md)" under a roots table of
// "- `rN` = `absolute root`" lines. Anything else is unrecognized: an entry
// that cannot be resolved cannot be disabled, so it must fail isolation rather
// than pass as "no ambient skills".
function listedSkills(text) {
  // General instructions also mention the skill headings and file syntax.
  // Only the bounded skills block describes what Codex actually loaded.
  const blocks = [...text.matchAll(/^<skills_instructions>\r?\n([\s\S]*?)^<\/skills_instructions>\r?$/gm)];
  if (blocks.length !== 1) return { files: [], unrecognized: ["expected one skills instructions section"] };
  const section = blocks[0][1];
  const heading = /^### Available skills\r?$/m.exec(section);
  if (!heading) return { files: [], unrecognized: ["no available skills list"] };
  const rootsSection = section.slice(0, heading.index);
  if (!/^### Skill roots\r?$/m.test(rootsSection)) return { files: [], unrecognized: ["no skill roots table"] };
  const list = section.slice(heading.index + heading[0].length);
  const roots = new Map();
  for (const match of rootsSection.matchAll(/^- `(r\d+)` = `(.+)`\r?$/gm)) roots.set(match[1], match[2]);
  const files = [];
  const unrecognized = [];
  for (const match of list.matchAll(/\(file: ([^)]+)\)/g)) {
    const reference = match[1];
    const rooted = /^(r\d+)\/(.+)$/.exec(reference);
    if (rooted && roots.has(rooted[1])) files.push(path.join(roots.get(rooted[1]), rooted[2]));
    else if (path.isAbsolute(reference)) files.push(path.normalize(reference));
    else unrecognized.push(reference);
  }
  // Every entry under the skill list must carry a file reference.
  for (const line of list.split("\n")) {
    if (line.startsWith("- ") && !/\(file: [^)]+\)/.test(line)) unrecognized.push(line.trim());
  }
  return { files, unrecognized };
}

function within(file, directory) {
  const relative = path.relative(directory, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Everything Codex lists outside the private home is ambient: repository,
// user, or system skills. Codex's embedded skills live inside the private home.
function ambientSkills(text, privateHome) {
  let home = path.resolve(privateHome);
  try {
    home = realpathSync(privateHome);
  } catch {
    // The directory is created before rendering; fall back to the given path.
  }
  return [...new Set(listedSkills(text).files.filter((file) => {
    let real = file;
    try {
      real = realpathSync(file);
    } catch {
      // A listed but unreadable path is still ambient.
    }
    return !within(file, home) && !within(real, home);
  }))].sort();
}

function instructionsLoaded(text) {
  return /^# AGENTS\.md instructions for /m.test(text);
}

// No project AGENTS.md files, and every listed ambient skill disabled by its
// SKILL.md path, which is how skills.config identifies a skill. The list always
// replaces the configured one, so a home's own skills.config cannot re-enable
// anything.
function isolationOverrides(skillFiles = []) {
  const files = [...new Set(skillFiles)].sort();
  return [...PROJECT_DOC_OVERRIDES, "-c", `skills.config=[${files.map((file) => `{path=${JSON.stringify(file)},enabled=false}`).join(",")}]`];
}

function assertRecognizedSkills(text) {
  const { unrecognized } = listedSkills(text);
  if (unrecognized.length) throw isolationError(`Codex listed skills in an unrecognized format and they cannot be disabled: ${unrecognized.join(", ")}`);
}

// Ask Codex what it would load with the session's own pinned overrides, disable
// all of it, then prove that only its own embedded skills, no AGENTS.md
// instructions, and no enabled MCP server remain. Fails closed, including when
// a rendering uses a format this adapter cannot interpret.
async function isolate(codexBin, context) {
  const pinned = context.overrides ?? [];
  const servers = mcpOverrides((await mcpServers(codexBin, { ...context, overrides: pinned })).map((server) => server.name));
  // An empty skills.config shows every discoverable skill, including any the
  // home's configuration disables, since the override list replaces it.
  const baseline = await renderPrompt(codexBin, { ...context, overrides: [...pinned, ...servers, ...isolationOverrides()] });
  assertRecognizedSkills(baseline);
  const overrides = [...servers, ...isolationOverrides(ambientSkills(baseline, context.privateHome))];
  const verification = await renderPrompt(codexBin, { ...context, overrides: [...pinned, ...overrides] });
  assertRecognizedSkills(verification);
  const leftover = ambientSkills(verification, context.privateHome);
  if (leftover.length) throw isolationError(`Codex still lists skills outside the private home: ${leftover.join(", ")}`);
  if (instructionsLoaded(verification)) throw isolationError("AGENTS.md instructions still load.");
  const enabled = (await mcpServers(codexBin, { ...context, overrides: [...pinned, ...overrides] })).filter((server) => server.enabled);
  if (enabled.length) throw isolationError(`MCP servers are still enabled: ${enabled.map((server) => server.name).join(", ")}`);
  return overrides;
}

// The session's pinned settings are the -c values the adapter put in the exec
// arguments; inspection uses the same ones so it sees what exec would load.
function pinnedOverrides(args) {
  return args.flatMap((arg, index) => (args[index - 1] === "-c" ? ["-c", arg] : []));
}

// Codex runs in this process group, so the adapter's group termination reaches
// it directly; forwarding covers a signal sent to this process alone. The exit
// status is passed on unchanged, so the adapter classifies Codex's own result.
function execCodex(codexBin, args) {
  const child = spawn(codexBin, args, { stdio: "inherit" });
  const forward = (signal) => child.kill(signal);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, forward);
  child.on("error", (error) => {
    process.stderr.write(`codex-review: could not start Codex: ${error.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeListener(name, forward);
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

async function main() {
  const [codexBin, subcommand, ...rest] = process.argv.slice(2);
  if (subcommand !== "exec") throw new Error("codex-session only starts review sessions.");
  const privateHome = process.env.CODEX_HOME;
  prepareHome(process.env.JIG_REVIEW_SOURCE_HOME, privateHome);
  const cancellation = installAdapterCancellation();
  let overrides;
  try {
    overrides = await isolate(codexBin, { cwd: process.cwd(), privateHome, overrides: pinnedOverrides(rest), signal: cancellation.signal });
  } catch (error) {
    if (!cancellation.parentSignal) throw error;
  } finally {
    cancellation.dispose();
  }
  // A signal received while inspecting ends this process the same way it would
  // have ended Codex.
  if (cancellation.parentSignal) process.kill(process.pid, cancellation.parentSignal);
  else execCodex(codexBin, ["exec", ...overrides, ...rest]);
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    // Nothing is written to stdout, which carries Codex's event stream; this
    // diagnostic is the startup failure the adapter classifies.
    process.stderr.write(`codex-review: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export {
  PROJECT_DOC_OVERRIDES,
  ambientSkills,
  instructionsLoaded,
  isolate,
  isolationError,
  isolationOverrides,
  listedSkills,
  mcpOverrides,
  mcpServers,
  pinnedOverrides,
  prepareHome,
  renderPrompt,
  reviewerConfig,
};
