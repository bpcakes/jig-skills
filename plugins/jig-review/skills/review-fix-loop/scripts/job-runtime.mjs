import { accessSync, constants, closeSync, existsSync, fsyncSync, linkSync, openSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { json, readJSON } from "./run-store.mjs";
import { identity, ownedAlive, killOwned } from "./process-ownership.mjs";
import { gitEnvironment } from "../../comprehensive-review/scripts/git-environment.mjs";

// The same cwd/PATH rules are used for capability checks and actual spawn.
export function executableCommand(request, inherited = process.env) {
  const executable = request.command?.[0];
  if (!executable) return false;
  const environment = commandEnvironment(request, inherited);
  const candidates = executable.includes("/") ? [path.resolve(request.cwd, executable)]
    : (environment.PATH ?? "/usr/bin:/bin").split(path.delimiter).map(directory => path.resolve(request.cwd, directory, executable));
  return candidates.some(file => { try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } });
}

// Publish a fully written claim with exclusive creation. Cancellation and
// worker startup compete for the same claim, so an unstarted job can settle
// without ever launching a provider (including after controller interruption).
export function claimJob(directory, owner) {
  const temporary = path.join(directory, `claim-${randomUUID()}`);
  json(temporary, owner);
  try {
    linkSync(temporary, path.join(directory, "claimed"));
    const fd = openSync(directory, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return true;
  }
  catch (error) { if (error.code === "EEXIST") return false; throw error; }
  finally { unlinkSync(temporary); }
}
export function cancelJob(directory, reason) {
  if (existsSync(path.join(directory, "result.json"))) return;
  json(path.join(directory, "cancel"), { reason });
  settleUnstarted(directory, { outcome: "cancelled", execution: "not_started", error: reason });
}
export const DEFAULT_STARTUP_TIMEOUT_MS = 5000;
export function failWorkerStart(directory, error) {
  return settleUnstarted(directory, {
    outcome: "infrastructure_failed", execution: "not_started", infrastructure: true, error,
  });
}
function settleUnstarted(directory, settlement) {
  // The exclusive claim is the decision, including all facts needed after a
  // crash. The result is only its projection; no result precedes claim ownership.
  if (!claimJob(directory, { settlement })) return false;
  recoverSettlement(directory);
  return true;
}
export function recoverSettlement(directory) {
  const result = path.join(directory, "result.json"), claim = path.join(directory, "claimed");
  if (existsSync(result) || !existsSync(claim)) return;
  let owner;
  try { owner = readJSON(claim); } catch { return; }
  let settlement = owner.settlement;
  // Older version-4 marker claims also conclusively excluded worker execution.
  if (!settlement && owner.failedBeforeStart === true) settlement = { outcome: "infrastructure_failed", execution: "not_started", infrastructure: true, error: "Recovered pre-start failure." };
  if (!settlement && owner.cancelled === true) settlement = { outcome: "cancelled", execution: "not_started", error: "Recovered pre-start cancellation." };
  if (!settlement) return;
  if (owner.pid || settlement.execution !== "not_started" || !["cancelled", "infrastructure_failed"].includes(settlement.outcome) || typeof settlement.error !== "string") throw new Error("Invalid pre-start settlement claim.");
  json(result, settlement);
}
export function launchJob(directory, worker, maxStarts, startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS) {
  recoverSettlement(directory);
  if (existsSync(path.join(directory, "claimed")) || existsSync(path.join(directory, "result.json"))) return;
  const file = path.join(directory, "launch.json");
  const launches = existsSync(file) ? readJSON(file) : [];
  const last = launches.at(-1);
  const fail = () => {
    if (failWorkerStart(directory, "Worker could not claim its assignment within the bounded startup deadline/attempts.") && last?.owner) killOwned(last.owner);
  };
  // Account before spawning. Even interruption before saving the PID cannot
  // reset this budget. Exclusive claims prevent duplicate provider execution.
  if (last) {
    const deadlineAt = last.deadlineAt ?? last.started + DEFAULT_STARTUP_TIMEOUT_MS;
    if (Date.now() >= deadlineAt) { fail(); return; }
    try { if (!last.owner?.token || ownedAlive(last.owner, { deadlineAt })) return; }
    catch { fail(); return; }
  }
  if (launches.length >= maxStarts) { fail(); return; }
  const started = Date.now(), attempt = { started, deadlineAt: started + startupTimeoutMs }; launches.push(attempt); json(file, launches);
  const child = spawn(process.execPath, [worker, directory, String(attempt.deadlineAt)], { detached: true, stdio: "ignore" });
  child.once("error", error => {
    failWorkerStart(directory, error.message);
  });
  if (child.pid) {
    try { attempt.owner = { pid: child.pid, token: identity(child.pid, { deadlineAt: attempt.deadlineAt })?.token }; }
    catch (error) { failWorkerStart(directory, `Worker startup identity failed: ${error.message}`); }
  }
  json(file, launches); child.unref();
}
export function commandSucceeded(result) {
  return Boolean(result && result.outcome === "succeeded" && result.exitCode === 0 && !result.error && !result.signal);
}
export function resultEnvelope(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Result must be a non-null JSON object.");
  if (Object.hasOwn(result, "error") && (typeof result.error !== "string" || !result.error.trim())) throw new Error("Result error must be a nonempty string.");
  return result;
}

const localEnvironment = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "JAVA_HOME", "GOPATH", "GOENV", "GOCACHE", "GOMODCACHE",
  "CARGO_HOME", "CARGO_TARGET_DIR", "RUSTUP_HOME", "RUSTC", "RUSTFLAGS", "NVM_DIR", "VIRTUAL_ENV", "PYENV_ROOT", "UV_CACHE_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
const providerEnvironment = { claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR"],
  codex: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME"], cursor: ["CURSOR_API_KEY"] };
export function commandEnvironment(request, inherited = process.env) {
  const names = new Set([...localEnvironment, ...(request.environmentFrom ?? []),
    ...(request.role === "review" ? providerEnvironment[request.assignment.provider] ?? [] : [])]);
  return gitEnvironment({ ...Object.fromEntries([...names].filter(name => inherited[name] !== undefined).map(name => [name, inherited[name]])),
    ...request.environment, CI: "1" });
}
