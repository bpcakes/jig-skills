import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let macBoot;

export function identity(pid, { deadlineAt = Date.now() + 5000 } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const remaining = () => {
    const ms = deadlineAt - Date.now();
    if (ms <= 0) throw new Error("Process identity deadline exceeded.");
    return Math.min(ms, 2147483647);
  };
  remaining();
  if (process.platform === "darwin") {
    macBoot ??= execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: remaining(), killSignal: "SIGKILL" }).trim();
    const value = JSON.parse(execFileSync("python3", ["-I", fileURLToPath(new URL("./macos-runtime.py", import.meta.url)), "identity", String(pid)],
      { encoding: "utf8", timeout: remaining(), killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] }));
    remaining();
    return value && { ...value, token: `${macBoot}:${value.token}` };
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return { token: `${boot}:${fields[19]}`, running: fields[0] !== "Z" };
  } catch { return null; }
}
export function ownedAlive(owner, options) {
  const current = owner && identity(owner.pid, options);
  return Boolean(current?.running && current.token === owner.token);
}
export function killOwned(owner) {
  if (!ownedAlive(owner)) return;
  try { process.kill(-owner.pid, "SIGKILL"); } catch { try { process.kill(owner.pid, "SIGKILL"); } catch {} }
}

// Presence is not ownership. Never signal a group with a lost anchor identity.
export function groupRunning(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) return false;
  if (process.platform === "darwin") return JSON.parse(execFileSync("python3", ["-I",
    fileURLToPath(new URL("./macos-runtime.py", import.meta.url)), "group", String(owner.pid)],
    { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }));
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).some(pid => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return Number(fields[2]) === owner.pid && !["Z", "X"].includes(fields[0]);
    } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return false; throw error; }
  });
}
