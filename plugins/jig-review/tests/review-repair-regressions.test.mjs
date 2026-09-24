import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { advance, createRun, runUntilBoundary, status, submit, TERMINAL } from "../skills/review-fix-loop/scripts/review-fix-loop.mjs";
import { parseArgs } from "../skills/review-fix-loop/scripts/loop-options.mjs";
import { reviewAdapterTimeout } from "../skills/review-fix-loop/scripts/review-timeouts.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "jig-review-repairs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(path.join(root, "value.cjs"), "module.exports=0;\n");
  writeFileSync(path.join(root, "notes.txt"), "initial\n");
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(path.join(root, "value.cjs"), "module.exports=2;\n");
  const contract = { goal: "Export 2", nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: [],
    acceptanceCriteria: [{ id: "value", description: "Export 2" }], requiredValidation: [{ id: "unit", argv: [process.execPath, "-e",
      "require('node:assert/strict').equal(require('./value.cjs'),2);require('node:fs').appendFileSync('.git/check-calls','run\\n')"] }] };
  const start = async (config = {}, args = [], overrides = {}) => {
    const run = await createRun({ cwd: root, contract: { ...contract, ...overrides }, config, options: parseArgs(args) });
    t.after(() => rmSync(path.dirname(run.workspaceRoot), { recursive: true, force: true }));
    return run;
  };
  return { root, base, git, start, executions: () => readFileSync(path.join(root, ".git/check-calls"), "utf8").trim().split("\n").length };
}
const vote = (a, acceptance = "satisfied") => ({ assignmentId: a.id, fingerprint: a.fingerprint, complete: true, findings: [],
  acceptance: [{ criterionId: "value", status: acceptance, evidence: "Inspect export and the required real assertion", validationIds: ["unit"] }] });
const triage = (a, disposition) => ({ assignmentId: a.id, fingerprint: a.fingerprint,
  decisions: a.findings.map(f => ({ id: f.id, status: disposition, evidence: "The export satisfies the criterion; assess the pinned unit receipt" })) });

for (const disposition of ["awaiting-validation", "needs-validation"]) test(`serial reconciliation progresses after ${disposition} with empty reports`, async t => {
  const f = fixture(t);
  let run = await runUntilBoundary((await f.start({ reviewConcurrency: 1 }, ["--commit-mode", "none"])).directory);
  await submit(run.directory, run.pending.id, vote(run.pending.assignment, "uncertain"));
  writeFileSync(path.join(f.root, "notes.txt"), "unrelated concurrent note\n");
  run = await runUntilBoundary(run.directory);
  assert.equal(run.pending.role, "triage"); assert.equal(run.reports.length, 0);
  assert.deepEqual(run.pending.assignment.sourceChanges.paths, ["notes.txt"]);
  await submit(run.directory, run.pending.id, triage(run.pending.assignment, disposition));
  // Bound the probe: a broken controller must fail instead of hanging the suite.
  for (let n = 0; n < 250; n++) {
    run = await advance(run.directory);
    if (run.pending || TERMINAL.has(run.phase) || run.validation.length > 1) break;
    if (run.validationCycle?.job) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(f.executions(), 1);
  assert.equal(run.pending?.role, disposition === "awaiting-validation" ? "triage" : "review");
  if (disposition === "awaiting-validation") {
    assert.equal(Object.values(run.ledger)[0].status, "awaiting-validation", "checks alone must not accept the requirement");
    assert.equal(run.pending.assignment.validation.at(-1).outcome, "succeeded");
    await submit(run.directory, run.pending.id, triage(run.pending.assignment, "fixed"));
    run = await runUntilBoundary(run.directory);
    assert.equal(run.pending.role, "review"); assert.equal(f.executions(), 1);
  }
});

for (const acceptance of ["satisfied", "uncertain"]) test(`default per-round prerequisites preserve discovery with ${acceptance} acceptance`, async t => {
  const f = fixture(t), reviewIds = [];
  let run = await f.start({}, [], { prerequisites: [{ id: "preflight", argv: [process.execPath, "-e", "process.exit(0)"] }] });
  for (let n = 0; n < 20; n++) {
    run = await runUntilBoundary(run.directory);
    if (TERMINAL.has(run.phase)) break;
    for (const item of status(run).assignments.filter(item => item.native && !item.resultReceived)) {
      const a = JSON.parse(readFileSync(item.request)).assignment;
      if (a.role === "review") {
        reviewIds.push(a.id);
        assert.equal(a.commitRange.base, f.base); assert.equal(a.scope.checkoutClean, true);
        await submit(run.directory, a.id, vote(a, acceptance));
      } else {
        assert.equal(a.role, "triage");
        await submit(run.directory, a.id, triage(a, a.validation.some(v => v.checkId === "unit" && v.outcome === "succeeded") ? "fixed" : "awaiting-validation"));
      }
    }
  }
  assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome));
  assert.equal(run.options.commitMode, "per-round"); assert.equal(run.round, 0);
  assert.equal(reviewIds.length, 2); assert.equal(run.attempts.length, 2);
  assert.deepEqual(run.reports.map(r => r.assignmentId).sort(), reviewIds.sort());
  assert.equal(f.executions(), 1); assert.deepEqual(run.validation.map(v => v.checkId), ["preflight", "unit"]);
  assert.deepEqual(run.commits.map(c => c.round), [0]); assert.equal(f.git("status", "--porcelain"), "");
});

function fakeCli(t, f, provider, slow = false) {
  const bin = path.join(f.root, ".git/bin"); mkdirSync(bin);
  const cli = path.join(bin, provider === "claude" ? "claude" : "cursor-agent");
  const module = path.join(bin, "fake-cli.mjs");
  writeFileSync(module, `#!${process.execPath}
import fs from 'node:fs';
let prompt='';
if(${JSON.stringify(provider)}==='claude'){for await(const chunk of process.stdin)prompt+=chunk;}
else {prompt=fs.readFileSync(process.argv.at(-1).match(/from (.+)\\. Follow/)[1],'utf8');}
const a=JSON.parse(prompt.trim().split('\\n').at(-1));
fs.writeFileSync(${JSON.stringify(path.join(f.root, ".git/bridge-input.json"))},JSON.stringify(a));
${slow ? "await new Promise(resolve=>setTimeout(resolve,60000));" : ""}
const report=JSON.stringify({assignmentId:a.id,fingerprint:a.fingerprint,complete:true,findings:[],acceptance:[{criterionId:'value',status:'satisfied',evidence:'Export assertion and source inspected',validationIds:['unit']}]});
process.stdout.write(${JSON.stringify(provider)}==='claude'?JSON.stringify({type:'result',result:report,is_error:false}):report);
`);
  chmodSync(module, 0o755); symlinkSync(module, cli);
  const prior = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${prior}`;
  t.after(() => { process.env.PATH = prior; });
}

for (const provider of ["claude", "cursor"]) for (const timeoutMs of [undefined, 20000]) {
  test(`${provider} bundled worker preserves budget (${timeoutMs ?? "default"}) over a committed range`, async t => {
    const f = fixture(t); fakeCli(t, f, provider);
    let run = await f.start({ ...(timeoutMs ? { timeoutMs } : {}), reviewConcurrency: 1 }, ["--reviewers", provider]);
    for (let n = 0; n < 10; n++) {
      run = await runUntilBoundary(run.directory);
      if (TERMINAL.has(run.phase)) break;
      assert.equal(run.pending.role, "triage");
      await submit(run.directory, run.pending.id, triage(run.pending.assignment, "fixed"));
    }
    assert.equal(run.phase, "CONVERGED", JSON.stringify(run.outcome));
    const request = JSON.parse(readFileSync(path.join(run.directory, "assignments", run.attempts[0].id, "request.json")));
    assert.equal(request.timeoutMs, timeoutMs ?? 29 * 60 * 1000);
    assert.equal(request.assignment.timeoutMs, request.timeoutMs);
    const seen = JSON.parse(readFileSync(path.join(f.root, ".git/bridge-input.json")));
    assert.equal(seen.commitRange.base, f.base); assert.equal(seen.commitRange.tip, f.git("rev-parse", "HEAD"));
    assert.equal(seen.scope.scope, "branch"); assert.equal(seen.scope.includeWorkingTree, false);
    assert.equal(f.executions(), 1);
  });
}

test("bundled timeout settles its error before the explicit worker deadline", async t => {
  const f = fixture(t); fakeCli(t, f, "claude", true);
  const run = await runUntilBoundary((await f.start({ timeoutMs: 10000, reviewConcurrency: 1 }, ["--reviewers", "claude"])).directory);
  assert.equal(run.phase, "REVIEW_INCOMPLETE"); assert.equal(run.attempts.length, 1);
  const result = JSON.parse(readFileSync(path.join(run.directory, "assignments", run.attempts[0].id, "result.json")));
  assert.equal(result.execution, "uncertain");
  assert.equal(result.exitCode, 0, "bridge must return its own error before the worker kills it");
  assert.match(result.error, /timed out|deadline/i);
});

test("adapter budget retains the standalone default and leaves explicit settlement margins", () => {
  assert.equal(reviewAdapterTimeout(), 28 * 60 * 1000);
  assert.equal(reviewAdapterTimeout(20000), 18000);
  assert.equal(reviewAdapterTimeout(1), 1);
});
