#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { json, readJSON } from "./run-store.mjs";
import { identity } from "./process-ownership.mjs";
import { claimJob, DEFAULT_STARTUP_TIMEOUT_MS, failWorkerStart } from "./job-runtime.mjs";

const directory = process.argv[2];
if (existsSync(path.join(directory, "claimed"))) process.exit(0);
const launches = path.join(directory, "launch.json");
const last = existsSync(launches) ? readJSON(launches).at(-1) : null;
const deadlineAt = Number(process.argv[3] ?? last?.deadlineAt ?? (last ? last.started + DEFAULT_STARTUP_TIMEOUT_MS : Date.now() + DEFAULT_STARTUP_TIMEOUT_MS));
try {
  if (!Number.isSafeInteger(deadlineAt)) throw new Error("Invalid worker startup deadline.");
  const owner = { pid: process.pid, token: identity(process.pid, { deadlineAt })?.token, protocol: 2 };
  if (!owner.token || Date.now() >= deadlineAt) throw new Error("Worker startup deadline exceeded before claim.");
  if (!claimJob(directory, owner)) process.exit(0);
} catch (error) { failWorkerStart(directory, error.message); process.exit(0); }
const result = path.join(directory, "result.json");
if (Date.now() >= deadlineAt) {
  json(result, { outcome: "infrastructure_failed", execution: "not_started", infrastructure: true, error: "Worker startup deadline exceeded while persisting claim." });
  process.exit(0);
}
if (existsSync(path.join(directory, "cancel"))) {
  json(result, { outcome: "cancelled", execution: "not_started", error: "Controller cancelled this assignment before execution" });
  process.exit(0);
}
json(path.join(directory, "owner.json"), { pid: process.pid, started: Date.now() });
const child = spawn(process.execPath, [fileURLToPath(new URL("./command-runner.mjs", import.meta.url)), directory],
  { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
child.once("error", error => {
  if (!existsSync(result)) json(result, { outcome: "infrastructure_failed", execution: "not_started", infrastructure: true, error: error.message });
});
child.once("spawn", () => {
  const owner = { pid: child.pid, token: identity(child.pid)?.token };
  if (!owner.token) { child.disconnect(); return; }
  json(path.join(directory, "child.json"), owner);
  child.send("start", error => { if (error && child.connected) child.disconnect(); });
});
child.once("close", () => {
  if (!existsSync(result)) json(result, { outcome: "failed", execution: "uncertain", error: "Command supervisor exited before persisting its result; execution will not be replayed." });
});
