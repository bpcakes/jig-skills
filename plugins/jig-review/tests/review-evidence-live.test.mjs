// Opt-in authenticated smoke checks: JIG_REVIEW_LIVE=claude,cursor node --test
// plugins/jig-review/tests/review-evidence-live.test.mjs
// These contact the selected providers and consume a small amount of usage.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReviewEvidence } from "../skills/comprehensive-review/scripts/review-evidence.mjs";
import { buildClaudeArgs, parseClaudeResult } from "../skills/comprehensive-review/scripts/claude-review.mjs";
import { buildCursorArgs, parseCursorResult } from "../skills/comprehensive-review/scripts/cursor-review.mjs";
import { buildReviewPrompt, runCommand } from "../skills/comprehensive-review/scripts/review-context.mjs";

const selected = new Set((process.env.JIG_REVIEW_LIVE ?? "").split(","));
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
