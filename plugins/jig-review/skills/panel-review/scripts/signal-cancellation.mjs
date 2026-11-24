// Signal handling shared by the command-line entry points. Each of them runs
// child process groups that outlive this process unless it stops them, so a
// signal becomes an abort the running work observes, and the entry point
// re-raises the signal once that work has stopped.

// Closing a terminal sends SIGHUP, which would otherwise end the process with
// its child groups still running.
const CANCELLATION_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);
// Stopping a process group takes about a second: a 500 ms grace, SIGKILL, and a
// 500 ms stdio drain. Well past that, the process is stuck rather than busy.
const SIGNAL_SETTLE_MS = 5 * 1000;

// The handlers stay installed until dispose(): a repeated signal, such as a
// second Ctrl-C, must not end the process while it is still stopping its child
// groups and removing evidence. If that has not finished settleMs after the
// first signal, something is waiting on work that ignores the cancellation, and
// the next signal ends the process as it would without these handlers.
function installSignalCancellation({ subject = "process", settleMs = SIGNAL_SETTLE_MS } = {}) {
  const controller = new AbortController();
  let parentSignal = null;
  let signalledAt = 0;
  const handlers = new Map();
  const dispose = () => {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  };
  for (const signal of CANCELLATION_SIGNALS) {
    const handler = () => {
      if (parentSignal) {
        if (Date.now() - signalledAt < settleMs) return;
        dispose();
        process.kill(process.pid, signal);
        return;
      }
      parentSignal = signal;
      signalledAt = Date.now();
      controller.abort(Object.assign(
        new Error(`${subject} received ${signal}`),
        { cancelled: true, parentSignal: signal },
      ));
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return {
    signal: controller.signal,
    get parentSignal() {
      return parentSignal;
    },
    dispose,
  };
}

export { CANCELLATION_SIGNALS, installSignalCancellation };
