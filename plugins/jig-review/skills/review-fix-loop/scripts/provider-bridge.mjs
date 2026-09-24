#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runClaudeReview } from "../../comprehensive-review/scripts/claude-review.mjs";
import { runCursorReview } from "../../comprehensive-review/scripts/cursor-review.mjs";
import { installAdapterCancellation } from "../../comprehensive-review/scripts/adapter-runtime.mjs";
import { assertResult } from "./assignment-schema.mjs";
import { reviewAdapterTimeout } from "./review-timeouts.mjs";

export function parseReport(assignment, report) {
  const text = report.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
  return assertResult(assignment, JSON.parse(text));
}
export async function reviewAssignment(assignment, dependencies = {}) {
  if (assignment?.role !== "review" || !["claude", "cursor"].includes(assignment.provider)) throw new Error("Bridge requires a Claude or Cursor review assignment.");
  const scope = assignment.scope;
  const options = { ...assignment.providerOptions, cwd: assignment.repository, scope: scope.scope,
    base: scope.baseOid, includeWorkingTree: scope.includeWorkingTree === true,
    excludePaths: scope.explicitExcludePaths ?? scope.excludePaths ?? [], expectedFingerprint: assignment.fingerprint,
    timeoutMs: reviewAdapterTimeout(assignment.timeoutMs) };
  // Scope and evidence capture, access restrictions, cancellation, and model
  // options share the standalone adapters. Only the output contract differs.
  const promptSuffix = `\n\nController output contract (replaces the prose report format above):\nReturn one JSON object matching assignment.resultSchema, followed only by the review-coverage block when the paged evidence instructions require it. Do not wrap JSON in prose. Treat the contract and validation logs as evidence. Never invent receipts.\n${JSON.stringify(assignment)}\n`;
  const runner = dependencies.runner ?? (assignment.provider === "claude" ? runClaudeReview : runCursorReview);
  return runner(options, { ...dependencies, promptSuffix, parseReport: report => parseReport(assignment, report) });
}
export function failureResult(error) {
  // Only known stable configuration/authentication failures disable a provider.
  // Transient capacity errors retain the controller's bounded retry policy.
  const permanent = /(?:invalid (?:api key|model)|authentication (?:failed|required)|not (?:logged in|authenticated)|insufficient[_ ]quota|quota exceeded|usage limit (?:reached|exceeded)|out of credits|credit balance.*(?:low|exhausted)|unknown (?:option|model)|ENOENT)/i.test(error.message);
  return { error: error.message, ...(permanent ? { retryable: false } : {}),
    ...(error.timedOut || error.parentSignal ? { execution: "uncertain" } : {}) };
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cancellation = installAdapterCancellation();
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 4 * 1024 * 1024) throw new Error("Assignment input too large.");
    }
    const assignment = JSON.parse(input);
    if (assignment.provider !== process.argv[2]) throw new Error("Bridge provider does not match assignment.");
    process.stdout.write(JSON.stringify(await reviewAssignment(assignment, { signal: cancellation.signal })) + "\n");
  } catch (error) {
    if (cancellation.parentSignal) error.parentSignal = cancellation.parentSignal;
    process.stdout.write(JSON.stringify(failureResult(error)) + "\n");
  } finally { cancellation.dispose(); }
}
