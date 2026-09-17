// Deterministic OS observation at a real completed-job consumption boundary.
// No production hooks: the group appears present, but its anchor has exited.
import fs from "node:fs";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const pid = Number(process.env.JIG_TEST_CLEANUP_PID);
const read = fs.readFileSync, list = fs.readdirSync, exec = cp.execFileSync, rename = fs.renameSync;
let observations = 0;
fs.readdirSync = function(name, ...rest) { return name === "/proc" ? [String(pid)] : list(name, ...rest); };
fs.readFileSync = function(name, ...rest) {
  if (name === `/proc/${pid}/stat`) {
    if (++observations % 2) return `${pid} (exiting) D 1 ${pid} ${Array(25).fill("0").join(" ")}`;
    throw Object.assign(new Error("Anchor exited"), { code: "ENOENT" });
  }
  return read(name, ...rest);
};
cp.execFileSync = function(command, args, ...rest) {
  if (command === "python3" && args.at(-1) === String(pid)) {
    if (args.includes("group")) return "true";
    if (args.includes("identity")) return "null";
  }
  return exec(command, args, ...rest);
};
fs.renameSync = function(source, destination) {
  rename(source, destination);
  if (process.env.JIG_TEST_CLEANUP_INTERRUPT && destination.endsWith("/run.json")
      && Object.keys(JSON.parse(read(destination)).cleanupWaits ?? {}).length) process.kill(process.pid, "SIGKILL");
};
syncBuiltinESMExports();
