import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
for (const name of ["linkSync", "renameSync"]) {
  const original = fs[name];
  fs[name] = function(source, destination) {
    original(source, destination);
    if (process.env.JIG_TEST_SETTLEMENT_POINT === "claim" && destination.endsWith("/claimed")) process.kill(process.pid, "SIGKILL");
    if (process.env.JIG_TEST_SETTLEMENT_POINT === "assignment" && destination.endsWith("/run.json")) {
      const pending = JSON.parse(fs.readFileSync(destination)).pending;
      if (pending?.command && !pending.preparing) process.kill(process.pid, "SIGKILL");
    }
  };
}
syncBuiltinESMExports();
