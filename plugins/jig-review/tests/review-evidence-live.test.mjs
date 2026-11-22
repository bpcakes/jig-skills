// Opt-in authenticated smoke checks: JIG_REVIEW_LIVE=claude,cursor,codex node --test
// plugins/jig-review/tests/review-evidence-live.test.mjs
// These contact the selected providers and consume a small amount of usage.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runClaudeReview } from "../skills/panel-review/scripts/claude-review.mjs";
import { runCodexReview } from "../skills/panel-review/scripts/codex-review.mjs";
import { runCursorReview } from "../skills/panel-review/scripts/cursor-review.mjs";
import { captureFingerprint } from "../skills/panel-review/scripts/scope-fingerprint.mjs";

const selected = new Set((process.env.JIG_REVIEW_LIVE ?? "").split(","));

for (const [provider, run] of Object.entries({ claude: runClaudeReview, codex: runCodexReview, cursor: runCursorReview })) {
  test(`live ${provider} reads external evidence using production permissions and returns valid receipts`, {
    skip: !selected.has(provider), timeout: 190_000,
  }, async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "jig-live-evidence-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const repo = path.join(directory, "repo");
    mkdirSync(repo);
    const git = (...args) => execFileSync("git", args, { cwd: repo });
    git("init", "-q");
    const secret = randomBytes(16).toString("hex");
    writeFileSync(path.join(repo, "removed.txt"), `${secret}\n`);
    writeFileSync(path.join(repo, "code.js"), "const value = 1;\n");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline");
    git("rm", "-q", "removed.txt");
    writeFileSync(path.join(repo, "code.js"), "const value = 2;\n");
    const pinned = await captureFingerprint({ cwd: repo, scope: "working-tree" });
    const options = { cwd: repo, scope: "working-tree", expectedFingerprint: pinned.fingerprint, timeoutMs: 180_000, launcher: "none" };
    if (provider === "claude") options.model = "opus";
    if (provider === "cursor") options.metaFile = path.join(directory, "fixture-metadata.json");
    const report = await run(options, {
      promptSuffix: "\nInclude the deleted line from removed.txt in your report. Retrieve it from the evidence pages. Keep the requested coverage footer last.\n",
    });
    assert.ok(report.includes(secret), "reviewer must retrieve the deleted line");
    assert.match(report, /Evidence coverage: reviewer-attested; ([1-9]\d*)\/\1 /);
  });
}
