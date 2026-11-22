import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { runCursorReview } from "../skills/panel-review/scripts/cursor-review.mjs";
import { captureFingerprint } from "../skills/panel-review/scripts/scope-fingerprint.mjs";
import { parseArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";
import { runUntilBoundary, status, submit } from "../skills/review-fix-loop/scripts/review-fix-loop.mjs";
import { fixtureCursorKey } from "./fixtures/provider-evidence.mjs";
import { createWorkingTreeRun } from "./fixtures/working-tree-loop.mjs";

const model = "fixture-model";
const refusal = "I could not open the assignment. Please paste the diff so I can review it.";
const finding = "- [high] [sum.js:1] The addition function subtracts its second argument.";
const contract = {
  goal: "Check addition", acceptanceCriteria: [{ id: "sum", description: "Adds two numbers" }],
  nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: [],
  requiredValidation: [{ id: "unit", argv: [process.execPath, "-e", "require('node:assert/strict').equal(require('./sum.js')(3, 2), 5)"] }],
};

function temporaryEnvironment(t, name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function fixture(t, scenario) {
  // A developer's per-user TMPDIR can already contain a Cursor project configuration.
  const directory = mkdtempSync("/tmp/jig-review-coverage-");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  temporaryEnvironment(t, "TMPDIR", directory);
  const repo = path.join(directory, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "sum.js"), "module.exports = (a, b) => a + b;\n");
  git("add", "sum.js");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
  writeFileSync(path.join(repo, "sum.js"), "module.exports = (a, b) => a - b;\n");

  const cursorBin = path.join(directory, "fixture-cursor.mjs");
  const marker = path.join(directory, "submitted");
  writeFileSync(cursorBin, `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readEvidence, sendReport, withCoverage } from ${JSON.stringify(import.meta.resolve("./fixtures/provider-evidence.mjs"))};
const args = process.argv.slice(2);
const value = key => args[args.indexOf(key) + 1];
const roots = args.flatMap((arg, i) => ["--workspace", "--add-dir"].includes(arg) ? [args[i + 1]] : []);
const directory = roots.find(root => existsSync(path.join(root, "review-prompt.md")));
const scenario = ${JSON.stringify(scenario)};
let result = ${JSON.stringify(refusal)};
if (scenario === "partial") {
  const manifest = existsSync(path.join(directory, "manifest.json"));
  const { text, reviewed } = manifest ? readEvidence(directory)
    : { text: readFileSync(path.join(directory, "review-prompt.md"), "utf8") };
  if (!text.includes("a - b")) throw new Error("Fixture did not receive the changed line");
  result = ${JSON.stringify(finding)};
  if (manifest) result = withCoverage(result, reviewed);
} else if (scenario === "refusal-with-receipts" && existsSync(path.join(directory, "manifest.json"))) {
  result = withCoverage(result, readEvidence(directory).reviewed);
} else if (scenario === "unattested") {
  const prompt = readFileSync(path.join(directory, "review-prompt.md"), "utf8");
  const assignment = JSON.parse(prompt.split("\\n").findLast(line => line.startsWith('{"') && line.includes('"resultSchema"')));
  result = JSON.stringify({ assignmentId: assignment.id, fingerprint: assignment.fingerprint,
    complete: true, findings: [], acceptance: [{ criterionId: "sum", status: "satisfied",
      evidence: "The sum function adds its arguments.", validationIds: ["unit"] }] });
}
writeFileSync(${JSON.stringify(marker)}, "submitted");
if (value("--output-format") === "stream-json") {
  sendReport("cursor", result);
} else {
  console.log(result);
}
`, { mode: 0o700 });
  fixtureCursorKey(t);
  return { repo, cursorBin, marker };
}

async function panel({ repo, cursorBin }) {
  const { fingerprint } = await captureFingerprint({ cwd: repo, scope: "working-tree" });
  return runCursorReview({
    cwd: repo, scope: "working-tree", model, expectedFingerprint: fingerprint,
    timeoutMs: 10_000, metaFile: path.join(path.dirname(repo), "cursor-meta.json"),
  }, { cursorBin });
}

for (const scenario of ["refusal", "refusal-with-receipts"]) {
  test(`Cursor panel rejects exit-zero ${scenario}`, async t => {
    const f = fixture(t, scenario);
    await assert.rejects(panel(f), /no review|coverage|receipts?|attest|review report/i);
    assert.ok(existsSync(f.marker), "the fixture returned its refusal");
  });
}

test("panel preserves a supported finding and reports an omitted item on a small diff", async t => {
  const f = fixture(t, "partial");
  writeFileSync(path.join(f.repo, "small.bin"), Buffer.from([0, 1]));
  const report = await panel(f);
  assert.ok(report.includes(finding));
  assert.match(report, /Evidence coverage: limited/i);
  assert.match(report, /omitted untracked item|small\.bin/i);
});

for (const scenario of ["refusal", "unattested"]) {
  test(`strict review ends incomplete when Cursor returns ${scenario} output alongside a valid peer`, async t => {
    const f = fixture(t, scenario);
    temporaryEnvironment(t, "JIG_CURSOR_BIN", f.cursorBin);
    const run = await createWorkingTreeRun({
      cwd: f.repo, contract,
      options: parseArgs(["--review-policy", "strict", "--reviewers", "codex,cursor",
        "--codex-runtime", "native", "--cursor-model", model, "--max-provider-attempts", "1"]),
      config: { reviewConcurrency: 1, environmentFrom: { review: ["JIG_CURSOR_BIN"] } },
    });
    t.after(() => rmSync(path.dirname(run.workspaceRoot), { recursive: true, force: true }));
    const peer = (await runUntilBoundary(run.directory)).pending.assignment;
    assert.equal(peer.provider, "codex");
    await submit(run.directory, peer.id, { assignmentId: peer.id, fingerprint: peer.fingerprint,
      complete: true, findings: [], acceptance: [{ criterionId: "sum", status: "unsatisfied",
        evidence: "sum(3, 2) now evaluates to 1.", validationIds: ["unit"] }] });
    const terminal = await runUntilBoundary(run.directory);
    assert.ok(existsSync(f.marker), `fixture did not submit a result: ${terminal.outcome?.reason}`);
    assert.equal(terminal.phase, "REVIEW_INCOMPLETE");
    assert.match(terminal.outcome.reason, scenario === "unattested" ? /receipts?|coverage/i : /receipts?|coverage|not JSON/i);
    assert.deepEqual(status(terminal).providerCoverage.completed, ["codex"]);
  });
}
