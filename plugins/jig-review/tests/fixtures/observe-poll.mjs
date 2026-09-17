import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const read = fs.readFileSync, open = fs.openSync;
const root = process.env.JIG_TEST_SOURCE_ROOT;
const log = process.env.JIG_TEST_IO_LOG;
function observe(file) {
  if (typeof file === "string" && (file.startsWith(`${root}/`) && !file.includes("/.git/") || file.includes("/manifests/"))) {
    fs.appendFileSync(log, `${file}\n`);
  }
}
fs.readFileSync = function(file, ...args) { observe(file); return read.call(this, file, ...args); };
fs.openSync = function(file, ...args) { observe(file); return open.call(this, file, ...args); };
syncBuiltinESMExports();
