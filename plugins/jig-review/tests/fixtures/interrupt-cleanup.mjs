// Kill after an actual deletion, before its cleanup receipt can be saved.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.rmSync;
fs.rmSync = function(target, ...args) {
  const existed = fs.existsSync(target);
  original(target, ...args);
  if (existed && target === process.env.JIG_TEST_CLEANUP_TARGET) process.kill(process.pid, "SIGKILL");
};
syncBuiltinESMExports();
