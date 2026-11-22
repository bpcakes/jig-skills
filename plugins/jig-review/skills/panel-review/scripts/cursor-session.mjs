import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { childEnvironment } from "./provider-launch.mjs";

function readProfile(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid Cursor profile file.");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

function authentication(env, useInstalledLogin) {
  if (env.CURSOR_API_KEY) return { CURSOR_API_KEY: env.CURSOR_API_KEY };
  if (env.CURSOR_AUTH_TOKEN) return { CURSOR_AUTH_TOKEN: env.CURSOR_AUTH_TOKEN };
  if (useInstalledLogin) {
    // Read one Cursor grant. Never export a refresh token, a cloud-provider
    // credential, the whole Keychain, or the user's mutable credential store.
    if (process.platform === "darwin") {
      const lookup = spawnSync("/usr/bin/security", ["find-generic-password", "-a", "cursor-user",
        "-s", "cursor-access-token", "-w"], { timeout: 5000, maxBuffer: 32768, encoding: "utf8",
        env: { HOME: env.HOME, PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore"] });
      if (lookup.status === 0 && lookup.stdout.trim()) return { CURSOR_AUTH_TOKEN: lookup.stdout.trim() };
    }
    const file = process.platform === "darwin" ? path.join(env.HOME, ".cursor", "auth.json")
      : path.join(env.XDG_CONFIG_HOME || path.join(env.HOME, ".config"), "cursor", "auth.json");
    try {
      const data = readProfile(file);
      if (!data.signedOut && typeof data.apiKey === "string" && data.apiKey) return { CURSOR_API_KEY: data.apiKey };
      if (!data.signedOut && typeof data.accessToken === "string" && data.accessToken) return { CURSOR_AUTH_TOKEN: data.accessToken };
    } catch (error) { if (error.code !== "ENOENT") throw new Error("Cannot read Cursor sign-in from its credential file."); }
  }
  throw new Error("Cursor authentication required for private configuration. Supply CURSOR_API_KEY or renew the Cursor sign-in.");
}

// Resolve the standard executable before changing cwd or reading native
// credentials. A checkout's PATH entry must never receive the installed login.
export function installedCursor(repository, searchPath = process.env.PATH) {
  const repo = realpathSync(repository);
  for (const dir of (searchPath ?? "").split(path.delimiter).filter(path.isAbsolute)) {
    const file = path.join(dir, "cursor-agent");
    try { accessSync(file, constants.X_OK); }
    catch (error) { if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) continue; throw error; }
    const binary = realpathSync(file);
    if (binary.startsWith(repo + path.sep)) throw new Error("Refusing a repository-provided Cursor executable.");
    return binary;
  }
  throw new Error("Cannot find installed cursor-agent on PATH.");
}

function exists(file) {
  try { lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export function assertIndependentWorkspace(directory, repository) {
  const repo = realpathSync(repository);
  for (let dir = realpathSync(directory); ; dir = path.dirname(dir)) {
    const discovered = [".git", ".mcp.json", ".cursor/mcp.json", ".cursor/hooks.json", ".cursor/cli.json",
      ".cursor/sandbox.json", ".cursor/permissions.json", ".cursor/plugins", ".cursor/rules", ".cursor/skills"];
    if (dir === repo || discovered.some(file => exists(path.join(dir, file)))) {
      throw new Error("Cursor requires a private evidence workspace outside repositories and ancestor Cursor configurations. Select a clean TMPDIR.");
    }
    if (dir === path.dirname(dir)) return;
  }
}

export function prepareCursorSession(root, workspace, repository, fileAccess = "restricted", env = process.env, useInstalledLogin = true) {
  assertIndependentWorkspace(workspace, repository);
  if (!["restricted", "host"].includes(fileAccess)) throw new Error("Unsupported Cursor file access.");
  const home = path.join(root, "home"), config = path.join(home, ".cursor"), tmp = path.join(root, "tmp");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  mkdirSync(tmp, { mode: 0o700 });
  const host = fileAccess === "host";
  // Even the opt-out borrows only policy. Never register an external MCP
  // configuration, plugin, workspace approval store or hook directory.
  const source = env.CURSOR_CONFIG_DIR || path.join(env.HOME, ".cursor");
  let policy = {};
  if (host) policy = readProfile(path.join(source, "cli-config.json"));
  const mode = host ? policy.approvalMode ?? "allowlist" : "allowlist";
  const sandbox = host ? policy.sandbox?.mode ?? "enabled" : "enabled";
  if (!["enabled", "disabled"].includes(sandbox) || !["allowlist", "unrestricted", "auto-review"].includes(mode)) throw new Error("Invalid Cursor approval or sandbox mode.");
  const credDirs = [".aws", ".ssh", ".config/gcloud", ".kube", ".cursor", ".claude", ".codex", ".config/cursor", ".config/Cursor", "Library/Application Support/Cursor"];
  const credFiles = [".netrc", ".claude.json"];
  const sensitivePaths = [...credDirs, ...credFiles].map(location => path.join(env.HOME, location)).concat([
    env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.CURSOR_DATA_DIR, source,
    ...(env.XDG_CONFIG_HOME ? ["cursor", "Cursor", "gcloud"].map(dir => path.join(env.XDG_CONFIG_HOME, dir)) : [])]).filter(Boolean);
  const repo = realpathSync(repository);
  for (const location of sensitivePaths) {
    const sensitive = exists(location) ? realpathSync(location) : path.resolve(location);
    if (!host && (sensitive === repo || repo.startsWith(sensitive + path.sep) || sensitive.startsWith(repo + path.sep))) {
      throw new Error("Cursor cannot isolate credential files in this checkout. No review was performed.");
    }
  }
  const denied = ["Shell(*)", "Write(**)", "Mcp(*:*)", "Read(**/.env*)", "Read(.env*)", "Read(**/.env*/**)"];
  for (const file of credFiles) denied.push(`Read(~/${file})`, `Read(${path.join(env.HOME, file)})`);
  for (const dir of credDirs) denied.push(`Read(~/${dir}/**)`, `Read(${path.join(env.HOME, dir)}/**)`);
  for (const dir of [...sensitivePaths, config]) {
    denied.push(`Read(${path.resolve(dir)}/**)`);
  }
  if (host && [policy.permissions?.allow ?? [], policy.permissions?.deny ?? []].some(list =>
    !Array.isArray(list) || list.some(rule => typeof rule !== "string"))) throw new Error("Invalid Cursor permission rules.");
  const permissions = host ? { allow: policy.permissions?.allow ?? [], deny: [...(policy.permissions?.deny ?? []), "Mcp(*:*)"] }
    : { allow: [], deny: [...new Set(denied)] };
  const readBoundary = host ? policy.sandbox?.readBoundary ?? "system" : "workspace";
  if (!["workspace", "system"].includes(readBoundary)) throw new Error("Invalid Cursor read boundary.");
  const settings = { version: 1, editor: { vimMode: false }, approvalMode: mode, sandbox: { mode: sandbox,
    readBoundary }, permissions };
  writeFileSync(path.join(config, "cli-config.json"), JSON.stringify(settings), { flag: "wx", mode: 0o600 });
  writeFileSync(path.join(config, "mcp.json"), '{"mcpServers":{}}\n', { flag: "wx", mode: 0o600 });
  const environment = childEnvironment(env, {
    PATH: [path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter), HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    CURSOR_DATA_DIR: config, CURSOR_CONFIG_DIR: config, AGENT_CLI_CREDENTIAL_STORE: "memory",
    ...authentication(env, useInstalledLogin) });
  function verifyPolicy() {
    const actual = readProfile(path.join(config, "cli-config.json"));
    if (actual.approvalMode !== mode || actual.sandbox?.mode !== sandbox || actual.sandbox?.readBoundary !== readBoundary
        || !permissions.deny.every(rule => actual.permissions?.deny?.includes(rule))
        || (!host && actual.permissions?.allow?.length !== 0)) throw new Error("Cursor changed the pinned review policy.");
  }
  return { environment, verifyPolicy, approvalMode: mode, sandboxMode: sandbox, confinement: host ? "unconfined" : "restricted" };
}
