// Opt-in authenticated smoke checks: JIG_REVIEW_LIVE=claude,cursor,codex node --test
// plugins/jig-review/tests/review-evidence-live.test.mjs
// These contact the selected providers and consume a small amount of usage.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReviewEvidence } from "../skills/comprehensive-review/scripts/review-evidence.mjs";
import { buildClaudeArgs, parseClaudeResult } from "../skills/comprehensive-review/scripts/claude-review.mjs";
import { buildCodexArgs, parseCodexResult, shimVariables, writeShim } from "../skills/comprehensive-review/scripts/codex-review.mjs";
import { buildCursorArgs, parseCursorResult } from "../skills/comprehensive-review/scripts/cursor-review.mjs";
import { childEnvironment } from "../skills/comprehensive-review/scripts/provider-launch.mjs";
import { buildReviewPrompt, runCommand } from "../skills/comprehensive-review/scripts/review-context.mjs";

const selected = new Set((process.env.JIG_REVIEW_LIVE ?? "").split(","));

// Codex runs the production path: the generated shim swaps in a private home
// holding only a link to the current CODEX_HOME's auth.json, and the read-only
// ephemeral session must still reach the external evidence pages.
test("live codex reads external evidence through the private-home shim with the production flags", {
  skip: !selected.has("codex"), timeout: 190_000,
}, async (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "jig-live-evidence-repo-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", repo]);
  const evidence = new ReviewEvidence();
  t.after(evidence.cleanup);
  const secret = randomBytes(16).toString("hex");
  evidence.add("Working tree staged diff", `diff --git a/removed.txt b/removed.txt\n--- a/removed.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-${secret}\n`);
  evidence.add("Working tree unstaged diff", "diff --git a/code.js b/code.js\n--- a/code.js\n+++ b/code.js\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n");
  evidence.required = true;
  const scope = { repoRoot: repo, label: "fixture changes" };
  const context = evidence.finish(scope, { text: "", limitations: [], incomplete: false });
  const prompt = `${buildReviewPrompt(scope, context, { tooling: "codex" })}\nThis is an evidence-access smoke check. In your report also reproduce the removed line from removed.txt exactly. It exists only in the evidence pages, not in the working tree.\n`;
  const { shim, privateHome } = writeShim(evidence.directory);
  const lastMessagePath = path.join(evidence.directory, "codex-last-message.txt");
  const args = buildCodexArgs({ model: null, effort: null }, scope, lastMessagePath);
  await runCommand("/bin/sh", [shim, ...args], {
    cwd: repo, input: prompt, timeoutMs: 180_000, maxBuffer: 4 * 1024 * 1024, overflow: "truncate",
    env: childEnvironment(process.env, shimVariables(process.env.JIG_CODEX_BIN ?? "codex", privateHome)),
  });
  const parsed = parseCodexResult(lastMessagePath);
  assert.ok(parsed.includes(secret), "reviewer must retrieve the deleted line from external evidence");
  const report = evidence.annotateReport(parsed, context);
  assert.match(report, /Evidence coverage: reviewer-attested; 2\/2/);
});
for (const provider of ["claude", "cursor"]) {
  test(`live ${provider} reads external evidence using the production read-only flags`, {
    skip: !selected.has(provider), timeout: 190_000,
  }, async (t) => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "jig-live-evidence-repo-"));
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    const evidence = new ReviewEvidence();
    t.after(evidence.cleanup);
    const secret = randomBytes(16).toString("hex");
    evidence.add("Working tree staged diff", `diff --git a/removed.txt b/removed.txt\n--- a/removed.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-${secret}\n`);
    evidence.add("Working tree unstaged diff", "diff --git a/code.js b/code.js\n--- a/code.js\n+++ b/code.js\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n");
    evidence.required = true;
    const scope = { repoRoot: repo, label: "fixture changes" };
    const context = evidence.finish(scope, { text: "", limitations: [], incomplete: false });
    const prompt = `${buildReviewPrompt(scope, context)}\nThis is an evidence-access smoke check. In your report also reproduce the removed line from removed.txt exactly. It exists only in the evidence pages, not in the working tree.\n`;
    const promptPath = path.join(evidence.directory, "review-prompt.md");
    writeFileSync(promptPath, prompt, { mode: 0o600 });
    const args = provider === "claude"
      ? buildClaudeArgs({ model: "opus", fileAccess: "restricted" }, evidence.directory)
      : buildCursorArgs({ effort: "high" }, scope, evidence.directory, promptPath);
    const result = await runCommand(provider === "claude" ? "claude" : "cursor-agent", args, {
      cwd: repo, input: provider === "claude" ? prompt : undefined,
      timeoutMs: 180_000, maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = provider === "claude" ? parseClaudeResult(result.stdout) : parseCursorResult(result.stdout);
    assert.ok(parsed.includes(secret), "reviewer must retrieve the deleted line from external evidence");
    const report = evidence.annotateReport(parsed, context);
    assert.match(report, /Evidence coverage: reviewer-attested; 2\/2/);
  });
}
