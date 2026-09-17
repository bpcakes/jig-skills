// Faults in real worker/supervisor I/O, without hooks in production code.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const open = fs.openSync, write = fs.writeSync, close = fs.closeSync;
const fault = process.env.JIG_TEST_LOG_FAULT;
let logFd;
fs.openSync = function(file, ...args) {
  if (!String(file).endsWith("/stdout.log")) return open(file, ...args);
  if (fault === "open") {
    const counter = process.env.JIG_TEST_LOG_FAILURES;
    const count = counter && fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
    if (count < Number(process.env.JIG_TEST_LOG_FAILURE_LIMIT ?? 1)) {
      if (counter) fs.writeFileSync(counter, String(count + 1));
      throw Object.assign(new Error("EACCES: injected validation log open failure"), { code: "EACCES" });
    }
  }
  logFd = open(file, ...args); return logFd;
};
fs.writeSync = function(fd, buffer, ...args) {
  if (fd === logFd && Buffer.isBuffer(buffer)) {
    if (fault === "short") return write(fd, buffer.subarray(0, Math.max(1, Math.floor(buffer.length / 2))));
    if (fault === "zero") return 0;
    if (fault === "write") throw Object.assign(new Error("ENOSPC: injected validation log write failure"), { code: "ENOSPC" });
  }
  return write(fd, buffer, ...args);
};
fs.closeSync = function(fd) {
  const result = close(fd);
  if (fd === logFd) {
    logFd = undefined;
    if (fault === "close") throw Object.assign(new Error("EIO: injected validation log close failure"), { code: "EIO" });
  }
  return result;
};
syncBuiltinESMExports();
