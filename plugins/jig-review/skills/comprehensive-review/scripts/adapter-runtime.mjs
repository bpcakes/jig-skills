import { captureFingerprint } from "./scope-fingerprint.mjs";

const MAX_FINAL_FINGERPRINT_RESERVE_MS = 5 * 60 * 1000;
const MAX_FINGERPRINT_TIMEOUT_MS = 5 * 60 * 1000;

function adapterTimeoutError(message = "adapter exceeded its overall deadline") {
  return Object.assign(new Error(message), { timedOut: true });
}

function assertSupportedAdapterPlatform() {
  if (process.platform === "win32") {
    throw new Error(
      "Native Windows is not supported because descendant process termination cannot be guaranteed; run the adapter in WSL.",
    );
  }
}

function remainingAdapterTime(deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw adapterTimeoutError();
  return remaining;
}

function providerTimeout(deadlineAt, totalTimeoutMs) {
  const reserve = Math.min(
    MAX_FINAL_FINGERPRINT_RESERVE_MS,
    Math.max(100, Math.floor(totalTimeoutMs * 0.2)),
  );
  const remaining = remainingAdapterTime(deadlineAt) - reserve;
  if (remaining <= 0) {
    throw adapterTimeoutError("adapter deadline left no time for the provider and final scope verification");
  }
  return remaining;
}

function installAdapterCancellation() {
  const controller = new AbortController();
  let parentSignal = null;
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (parentSignal) return;
      parentSignal = signal;
      controller.abort(Object.assign(
        new Error(`adapter received ${signal}`),
        { cancelled: true, parentSignal: signal },
      ));
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return {
    signal: controller.signal,
    get parentSignal() {
      return parentSignal;
    },
    dispose() {
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
    },
  };
}

async function verifyScopeFingerprint(
  options,
  expectedFingerprint,
  deadlineAt,
  signal = null,
) {
  const result = await captureFingerprint({
    cwd: options.cwd,
    scope: options.scope,
    base: options.base,
    timeoutMs: Math.min(
      MAX_FINGERPRINT_TIMEOUT_MS,
      remainingAdapterTime(deadlineAt),
    ),
    signal,
  });
  if (expectedFingerprint && result.fingerprint !== expectedFingerprint) {
    throw Object.assign(
      new Error(
        `review scope fingerprint changed: expected ${expectedFingerprint}, got ${result.fingerprint}`,
      ),
      { scopeChanged: true },
    );
  }
  return result;
}

export {
  adapterTimeoutError,
  assertSupportedAdapterPlatform,
  installAdapterCancellation,
  providerTimeout,
  remainingAdapterTime,
  verifyScopeFingerprint,
};
