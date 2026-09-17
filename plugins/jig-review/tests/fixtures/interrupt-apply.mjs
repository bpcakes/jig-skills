// Fault injection at an actual file replacement, without production hooks.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
let triggered = false;
for (const name of ["renameSync", "linkSync"]) {
  const original = fs[name];
  fs[name] = function(source, destination) {
    original(source, destination);
    if (process.env.JIG_TEST_TERMINAL_INTERRUPT && destination.endsWith("/run.json") && JSON.parse(fs.readFileSync(destination)).phase === "SCOPE_CHANGED") process.kill(process.pid, "SIGKILL");
    if (process.env.JIG_TEST_ASSIGNMENT_INTERRUPT && destination.endsWith("/run.json") && JSON.parse(fs.readFileSync(destination)).pending?.command) process.kill(process.pid, "SIGKILL");
    if (!triggered && (destination === process.env.JIG_TEST_APPLY_TARGET || source === process.env.JIG_TEST_BACKUP_SOURCE)) {
      triggered = true;
      if (process.env.JIG_TEST_USER_EDIT) fs.writeFileSync(process.env.JIG_TEST_USER_EDIT, "module.exports = 999; // concurrent user work\n");
      else process.kill(process.pid, "SIGKILL");
    }
  };
}
syncBuiltinESMExports();
