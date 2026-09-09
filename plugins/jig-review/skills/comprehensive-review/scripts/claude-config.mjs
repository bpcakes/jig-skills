import os from "node:os";
import path from "node:path";

function normalizeClaudeConfigDir(value, flag = "--claude-config-dir") {
  if (value == null) return null;

  let configDir = String(value).trim();
  if (!configDir) throw new Error(`${flag} must not be blank.`);
  if (configDir.includes("\0") || configDir.includes("\n") || configDir.includes("\r")) {
    throw new Error(`${flag} must be a single filesystem path.`);
  }
  if (configDir === "~") configDir = os.homedir();
  else if (configDir.startsWith("~/")) {
    configDir = path.join(os.homedir(), configDir.slice(2));
  } else if (configDir.startsWith("~")) {
    throw new Error(`${flag} supports only ~ or ~/ home-directory expansion.`);
  }
  if (!path.isAbsolute(configDir)) {
    throw new Error(`${flag} must be an absolute path or start with ~/.`);
  }
  return path.normalize(configDir);
}

export { normalizeClaudeConfigDir };
