import fs from "node:fs";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const mode = process.env.JIG_TEST_OBSERVATION_FAULT;
const readDirectory = fs.readdirSync, execute = cp.execFileSync, rename = fs.renameSync, now = Date.now;
let probes = 0;
if (mode?.startsWith("identity") && process.platform !== "darwin") {
  // Expire the real identity function's shared deadline, not a mocked result.
  Date.now = () => new Error().stack.includes("/process-ownership.mjs:") ? now() + (probes++ % 2 ? 6000 : 0) : now();
}
cp.execFileSync = function(command, args, ...rest) {
  if (process.platform === "darwin" && command === "python3" &&
      (mode?.startsWith("identity") && args.includes("identity") || mode === "group" && args.includes("group"))) {
    throw Object.assign(new Error("Injected process inspection timeout"), { code: "ETIMEDOUT" });
  }
  return execute(command, args, ...rest);
};
fs.readdirSync = function(directory, ...rest) {
  if (mode === "group" && String(directory) === "/proc" || mode?.startsWith("resources") && String(directory).endsWith("/resources")) {
    throw Object.assign(new Error("Injected inspection failure"), { code: "EACCES" });
  }
  return readDirectory(directory, ...rest);
};
fs.renameSync = function(source, destination) {
  rename(source, destination);
  if (mode?.endsWith("-interrupt") && String(destination).endsWith("/run.json")) {
    const run = JSON.parse(fs.readFileSync(destination));
    if (mode === "identity-interrupt" && run.outcome || mode === "resources-interrupt" && run.events.at(-1)?.event === "cleanup-blocked") process.kill(process.pid, "SIGKILL");
  }
};
syncBuiltinESMExports();
