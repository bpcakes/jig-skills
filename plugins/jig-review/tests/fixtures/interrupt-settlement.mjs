import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
for (const name of ["linkSync", "renameSync"]) {
  const original = fs[name];
  fs[name] = function(source, destination) {
    original(source, destination);
    if (process.env.JIG_TEST_SETTLEMENT_POINT === "claim" && destination.endsWith("/claimed")) process.kill(process.pid, "SIGKILL");
    if (process.env.JIG_TEST_SETTLEMENT_POINT === "validation-command" && destination.endsWith("/run.json")
        && JSON.parse(fs.readFileSync(destination)).events.at(-1)?.event === "validation-command") process.kill(process.pid, "SIGKILL");
    if (process.env.JIG_TEST_SETTLEMENT_POINT === "terminal" && destination.endsWith("/run.json")) {
      const run = JSON.parse(fs.readFileSync(destination));
      if (run.retainedCheckout && !run.retainedCheckout.observation) process.kill(process.pid, "SIGKILL");
    }
    if (["assignment", "prepared"].includes(process.env.JIG_TEST_SETTLEMENT_POINT) && destination.endsWith("/run.json")) {
      const pending = JSON.parse(fs.readFileSync(destination)).pending;
      if (process.env.JIG_TEST_SETTLEMENT_POINT === "prepared" ? pending?.preparing : pending?.command && !pending.preparing) process.kill(process.pid, "SIGKILL");
    }
  };
}
syncBuiltinESMExports();
