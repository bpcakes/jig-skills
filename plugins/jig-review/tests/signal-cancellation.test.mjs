import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CANCELLATION_SIGNALS } from "../skills/panel-review/scripts/signal-cancellation.mjs";

const moduleUrl = new URL("../skills/panel-review/scripts/signal-cancellation.mjs", import.meta.url).href;
const bridge = fileURLToPath(new URL("../skills/review-fix-loop/scripts/provider-bridge.mjs", import.meta.url));

// A process that installs the handlers, reports each abort, and then waits on
// work that never observes it.
function probe(t, settleMs) {
  const script = [
    `import { installSignalCancellation } from ${JSON.stringify(moduleUrl)};`,
    `const cancellation = installSignalCancellation({ subject: "probe", settleMs: ${settleMs} });`,
    'cancellation.signal.addEventListener("abort", () => console.log(JSON.stringify({',
    "  message: cancellation.signal.reason.message,",
    "  cancelled: cancellation.signal.reason.cancelled,",
    "  parentSignal: cancellation.parentSignal,",
    "})));",
    'console.log("ready");',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return { child, line: async () => (await lines.next()).value };
}

test("interrupt, terminate and hang-up are the signals that cancel", () => {
  assert.deepEqual([...CANCELLATION_SIGNALS], ["SIGINT", "SIGTERM", "SIGHUP"]);
});

for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  test(`${name} becomes a cancellation that names it instead of ending the process`, async (t) => {
    const { child, line } = probe(t, 60_000);
    assert.equal(await line(), "ready");
    child.kill(name);
    assert.deepEqual(JSON.parse(await line()), { message: `probe received ${name}`, cancelled: true, parentSignal: name });
    assert.equal(child.exitCode ?? child.signalCode, null, "the caller ends the process once its work has stopped");
  });
}

test("a repeated signal is ignored while work is stopping, and ends a process that is stuck", async (t) => {
  const settleMs = 2_000;
  const { child, line } = probe(t, settleMs);
  assert.equal(await line(), "ready");
  child.kill("SIGTERM");
  assert.equal(JSON.parse(await line()).parentSignal, "SIGTERM");
  const abortedAt = Date.now();

  child.kill("SIGINT");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(child.exitCode ?? child.signalCode, null, "a second Ctrl-C does not cut the work short");

  // This process never stops its work. Once that is evident, a signal ends it.
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, abortedAt + settleMs + 100 - Date.now())));
  const exit = once(child, "exit");
  child.kill("SIGINT");
  const unresponsive = setTimeout(() => child.kill("SIGKILL"), 5_000);
  const ended = await exit;
  clearTimeout(unresponsive);
  assert.deepEqual(ended, [null, "SIGINT"]);
});

test("the loop's provider bridge stops waiting for its assignment at the first signal", async (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "jig-bridge-signal-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const child = spawn(process.execPath, [bridge, "claude"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, TMPDIR: temporary } });
  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  // More than a pipe holds: once it is all written the bridge is reading, so
  // its handlers are installed. The assignment itself never arrives.
  child.stdin.on("error", () => {});
  await new Promise((resolve, reject) => child.stdin.write(" ".repeat(1024 * 1024), (error) => (error ? reject(error) : resolve())));

  const exit = once(child, "exit");
  child.kill("SIGINT");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  const [code, signal] = await exit;
  clearTimeout(timer);

  assert.deepEqual([code, signal], [0, null], "the bridge reports the interruption as a result");
  assert.deepEqual(JSON.parse(output), { error: "adapter received SIGINT", execution: "uncertain" });
});

test("the loop's provider bridge reads an assignment that arrives split inside a character", async (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "jig-bridge-input-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  // The provider name is the one part of an assignment the bridge compares with
  // something outside it, so it shows whether the text arrived intact.
  const provider = "✔";
  const child = spawn(process.execPath, [bridge, provider], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, TMPDIR: temporary } });
  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stdin.on("error", () => {});
  const bytes = Buffer.from(`${" ".repeat(1024 * 1024)}${JSON.stringify({ provider })}`);
  const split = bytes.indexOf(Buffer.from(provider)) + 1;
  const write = (part) => new Promise((resolve, reject) => child.stdin.write(part, (error) => (error ? reject(error) : resolve())));
  // More than a pipe holds, so the bridge is reading by the time this is
  // written; the pause lets it take what is left, which ends mid-character.
  await write(bytes.subarray(0, split));
  await new Promise((resolve) => setTimeout(resolve, 250));
  await write(bytes.subarray(split));
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const [code, signal] = await once(child, "exit");
  clearTimeout(timer);

  assert.deepEqual([code, signal], [0, null]);
  // A provider that matched; with a damaged name the bridge reports a mismatch.
  assert.deepEqual(JSON.parse(output), { error: "Bridge requires a Claude, Codex, or Cursor review or adjudication assignment." });
});
