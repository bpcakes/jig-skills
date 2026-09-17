import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const mkdir = fs.mkdirSync, rename = fs.renameSync;
fs.mkdirSync = function(directory, ...args) {
  const result = mkdir.call(this, directory, ...args);
  if (process.env.JIG_TEST_SCRATCH_FAULT && /\/overlays\/scratch-[^/]+$/.test(String(directory))) process.kill(process.pid, "SIGKILL");
  if (process.env.JIG_TEST_COPY_FAULT && /\/overlays\/[^/]+$/.test(String(directory))) {
    if (process.env.JIG_TEST_COPY_FAULT === "kill") process.kill(process.pid, "SIGKILL");
    throw new Error("Injected copy preparation failure");
  }
  return result;
};
fs.renameSync = function(source, target) {
  if (process.env.JIG_TEST_ANCHOR_FAULT && String(target).endsWith("/child.json")) process.kill(process.pid, "SIGKILL");
  return rename.call(this, source, target);
};
syncBuiltinESMExports();
