#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { json, readJSON } from "./run-store.mjs";
import { commandEnvironment, resultEnvelope } from "./job-runtime.mjs";

// This process anchors the command's group until its result has been saved.
// The claiming worker publishes its identity before granting start over IPC.
const directory = process.argv[2];
const request = readJSON(path.join(directory, "request.json"));
const argv = request.command;
let child, timer, killing, cancelTimer, drainTimer, stopReason, stopOutcome, output = "", stderr = "", settled = false;
let started = false, spawned = false, exitFacts;
const maxBytes = 2 * 1024 * 1024;
let stdoutBytes = 0, logBytes = 0;
const logLimit = 8 * 1024 * 1024;
let log = null;
function signal(name) {
  // The live anchor prevents this process group ID from being recycled.
  process.kill(-process.pid, name);
}
function finish(result) {
  if (settled) return;
  settled = true; clearTimeout(timer); clearTimeout(killing); clearTimeout(drainTimer); clearInterval(cancelTimer);
  result = { ...result, ...exitFacts, execution: !spawned ? "not_started"
    : exitFacts && !stopReason && result.execution !== "uncertain" ? "completed" : "uncertain" };
  try {
    if (log !== null) {
      try { closeSync(log); }
      catch (error) {
        result = { ...result, outcome: "infrastructure_failed", error: `Validation log close failed: ${error.message}`,
          execution: spawned ? "uncertain" : "not_started", infrastructure: !spawned };
      }
      result = { ...result, stdout: output, stdoutBytes, logTruncated: stdoutBytes > logBytes, log: path.join(directory, "stdout.log") };
    }
    json(path.join(directory, "stderr.json"), { stderr });
    json(path.join(directory, "result.json"), result);
  } finally { signal("SIGKILL"); }
}
function stop(reason, outcome = "cancelled") {
  if (stopReason || settled) return;
  stopReason = reason; stopOutcome = outcome;
  signal("SIGTERM");
  killing = setTimeout(() => finish({ outcome, error: reason }), 500);
}
for (const name of ["SIGINT", "SIGTERM"]) process.on(name, () => stop(`Worker interrupted by ${name}`));
process.on("disconnect", () => {
  if (!started) finish({ outcome: "cancelled", error: "Worker lost before command start" });
  else stop("Worker lost; command outcome may be uncertain", "failed");
});
if (!process.connected) finish({ outcome: "cancelled", error: "Worker lost before command start" });
process.once("message", message => {
if (message !== "start") return;
started = true;
if (existsSync(path.join(directory, "cancel"))) { finish({ outcome: "cancelled", error: "Controller cancelled this assignment before execution" }); return; }
try {
  // Log creation is startup work: a failure here conclusively precedes the
  // command and can use the controller's existing bounded infrastructure retry.
  if (request.role === "validate") log = openSync(path.join(directory, "stdout.log"), "wx", 0o600);
  const environment = commandEnvironment(request);
  const missing = (request.requiredEnvironment ?? []).filter(name => !environment[name]);
  if (missing.length) throw new Error(`Required worker environment missing: ${missing.join(", ")}`);
  child = spawn(argv[0], argv.slice(1), { cwd: request.cwd,
    env: environment,
    stdio: [request.role === "validate" ? "ignore" : "pipe", "pipe", "pipe"] });
  spawned = Boolean(child.pid);
  child.stdin?.on("error", () => {});
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    if (stopReason) return;
    if (request.role === "validate") {
      const bytes = Buffer.from(chunk); stdoutBytes += bytes.length;
      const retained = bytes.subarray(0, Math.max(0, logLimit - logBytes));
      try {
        let offset = 0;
        while (offset < retained.length) {
          const written = writeSync(log, retained.subarray(offset));
          if (written === 0) throw new Error("Write made no progress");
          offset += written; logBytes += written;
        }
      }
      catch (error) { stop(`Validation log unavailable: ${error.message}`, "infrastructure_failed"); }
      output = (output + chunk).slice(-16384);
    } else { output += chunk; if (Buffer.byteLength(output) > maxBytes) stop("Output limit exceeded", "failed"); }
  });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16384); });
  child.once("error", error => finish({ outcome: "infrastructure_failed", error: error.message, infrastructure: !spawned }));
  child.once("exit", (exitCode, signal) => { exitFacts = { exitCode, signal }; drainTimer = setTimeout(() => stop("Command streams did not close", "failed"), 1000); });
  child.once("close", (code, sig) => {
    if (stopReason) finish({ outcome: stopOutcome, error: stopReason, exitCode: code, signal: sig });
    else if (request.role === "validate") finish({ outcome: code === 0 && !sig ? "succeeded" : "failed", exitCode: code, signal: sig,
      error: sig ? `Command terminated by ${sig}` : undefined });
    else if (code !== 0) finish({ error: `Provider exited ${code ?? sig}` });
    else {
      try {
        const result = resultEnvelope(JSON.parse(output));
        if (["exitCode", "signal"].some(key => Object.hasOwn(result, key))) throw new Error("Reserved transport fields exitCode and signal cannot be supplied by providers.");
        if (Object.hasOwn(result, "execution") && (!result.error || !["completed", "uncertain"].includes(result.execution))) throw new Error("Reserved transport field execution is supported only on error results as completed or uncertain.");
        finish(result);
      } catch (error) { finish({ error: `Malformed JSON report: ${error.message}`, stdout: output }); }
    }
  });
  child.stdin?.end(JSON.stringify(request.assignment));
  timer = setTimeout(() => stop("Command timed out", "timed_out"), request.timeoutMs ?? 300000);
  cancelTimer = setInterval(() => { if (existsSync(path.join(directory, "cancel"))) stop("Controller cancelled this assignment"); }, 100);
} catch (error) { finish({ outcome: "infrastructure_failed", error: error.message, infrastructure: !spawned }); }
});
