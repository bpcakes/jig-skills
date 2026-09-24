// Match the standalone adapter's 28-minute budget and leave the worker time
// to receive its result after final fingerprint verification and cleanup.
export const DEFAULT_REVIEW_WORKER_TIMEOUT_MS = 29 * 60 * 1000;

export function reviewAdapterTimeout(workerTimeoutMs = DEFAULT_REVIEW_WORKER_TIMEOUT_MS) {
  const cleanupMargin = Math.min(60000, Math.max(1, Math.floor(workerTimeoutMs / 10)));
  return Math.max(1, workerTimeoutMs - cleanupMargin);
}
