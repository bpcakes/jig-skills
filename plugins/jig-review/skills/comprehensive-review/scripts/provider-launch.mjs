// Shared launch resolution for external reviewer CLIs. A Jig launcher selects the
// provider home (account) immediately before the CLI starts; without one the
// adapters spawn the provider executable directly. The same resolution serves
// capability preflight, so the controller checks the executable that will run.
import { spawnSync } from "node:child_process";

const LAUNCHER_KINDS = new Set(["none", "auto"]);
const LAUNCHER_COMMANDS = Object.freeze({ claude: "claude", codex: "codex" });
const DEFAULT_LAUNCHER_BIN = "jig";

// Session markers that a Claude Code or Codex parent sets for its own child
// processes. A reviewer is an independent CLI session: inheriting these would
// attach it to the parent's messaging socket, session identity, effort, or
// sandbox state. Provider configuration such as CLAUDE_CONFIG_DIR, CODEX_HOME,
// and credential variables is deliberately retained.
const PARENT_SESSION_VARIABLES = Object.freeze([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
]);

function normalizeLauncher(value, flag = "--launcher") {
  if (value == null) return "none";
  const launcher = String(value).trim();
  if (!launcher) throw new Error(`${flag} must not be blank.`);
  if (LAUNCHER_KINDS.has(launcher)) return launcher;
  if (launcher.startsWith("home:")) {
    const home = launcher.slice("home:".length);
    if (!home.trim()) throw new Error(`${flag} home:<name> requires a Jig home name or path.`);
    if (/[\0\r\n]/.test(home)) throw new Error(`${flag} home must be a single name or path.`);
    if (home.startsWith("-")) throw new Error(`${flag} home must not begin with -.`);
    return `home:${home}`;
  }
  throw new Error(`Unsupported ${flag} value "${launcher}". Use none, auto, or home:<name>.`);
}

function assertLauncherProvider(provider) {
  if (!Object.hasOwn(LAUNCHER_COMMANDS, provider)) {
    throw new Error(`Jig launchers support Claude and Codex, not ${provider}.`);
  }
}

function launcherBinary(inherited = process.env, override = null) {
  const binary = override ?? inherited.JIG_LAUNCHER_BIN ?? DEFAULT_LAUNCHER_BIN;
  if (typeof binary !== "string" || !binary.trim()) throw new Error("JIG_LAUNCHER_BIN must not be blank.");
  return binary;
}

// Help is local and does not inspect accounts or start a provider. Check each
// provider separately: older Jig releases can support only one launch command.
function supportsAutoLauncher(provider, { inherited = process.env, cwd = process.cwd(), timeoutMs = 1000 } = {}) {
  assertLauncherProvider(provider);
  try {
    const result = spawnSync(launcherBinary(inherited), [provider, "launch", "--help"], {
      cwd, env: childEnvironment(inherited), encoding: "utf8", timeout: timeoutMs,
      killSignal: "SIGKILL", maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    const help = result.stdout ?? "";
    return !result.error && result.status === 0
      && new RegExp(`Usage:\\s+\\S+\\s+${provider}\\s+launch\\b`, "i").test(help)
      && /^\s*--auto(?:\s|$)/m.test(help);
  } catch { return false; }
}

// The executable that a launch will actually start, for preflight checks.
function launchExecutable(provider, launcher, executable, inherited = process.env, override = null) {
  if (normalizeLauncher(launcher) === "none") return executable;
  assertLauncherProvider(provider);
  return launcherBinary(inherited, override);
}

// Every executable a bundled launch needs: the launcher when one is selected,
// plus the provider itself for Codex, whose adapter renders the prompt with the
// provider executable directly before Jig starts the review.
function preflightExecutables(provider, launcher, executable, inherited = process.env, override = null) {
  if (normalizeLauncher(launcher) === "none") return [executable];
  assertLauncherProvider(provider);
  const launcherBin = launcherBinary(inherited, override);
  return provider === "codex" ? [launcherBin, executable] : [launcherBin];
}

function resolveProviderLaunch({ provider, launcher, executable, args, inherited = process.env, jigBin = null }) {
  const normalized = normalizeLauncher(launcher);
  if (normalized === "none") return { command: executable, args: [...args], launcher: normalized };
  assertLauncherProvider(provider);
  const selection = normalized === "auto" ? ["--auto"] : [normalized.slice("home:".length)];
  return {
    command: launcherBinary(inherited, jigBin),
    args: [LAUNCHER_COMMANDS[provider], "launch", ...selection, "--", ...args],
    launcher: normalized,
  };
}

// Environment for an independent provider process: the parent's session markers
// removed, explicit overrides applied (null removes a variable).
function childEnvironment(inherited = process.env, overrides = {}) {
  const environment = { ...inherited };
  for (const name of PARENT_SESSION_VARIABLES) delete environment[name];
  for (const [name, value] of Object.entries(overrides)) {
    if (value == null) delete environment[name];
    else environment[name] = value;
  }
  return environment;
}

export {
  PARENT_SESSION_VARIABLES,
  childEnvironment,
  launchExecutable,
  launcherBinary,
  normalizeLauncher,
  preflightExecutables,
  resolveProviderLaunch,
  supportsAutoLauncher,
};
