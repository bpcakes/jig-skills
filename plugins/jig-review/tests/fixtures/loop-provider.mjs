import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const a = JSON.parse(Buffer.concat(chunks));
assert.ok(a.resultSchema, "Provider assignments must be self-contained wire contracts");
assert.ok(["minimal", "balanced", "comprehensive"].includes(a.fixMode), "External providers must receive the selected repair mode");
const scenario = process.argv[2] ?? "success";
if (process.argv[3]) appendFileSync(process.argv[3], `${a.id}\n`);
for (const role of ["triage", "repair"]) {
  if (scenario.startsWith(`${role}-failure`) && a.role === role) {
    const attempts = readFileSync(process.argv[3], "utf8").trim().split("\n").filter(id => id.endsWith(`-${role}`)).length;
    if (scenario.endsWith("always") || attempts === 1) { process.stdout.write("malformed"); process.exit(0); }
  }
}
if (scenario === "provider-failure" && a.role === "review") { process.stderr.write("unavailable\n"); process.exit(1); }
if (scenario === "malformed" && a.role === "review") { process.stdout.write("invalid report"); process.exit(0); }
if (scenario === "null-report" && a.role === "review") { process.stdout.write("null"); process.exit(0); }
if (scenario === "slow") await new Promise(resolve => setTimeout(resolve, 250));
if (scenario === "very-slow") await new Promise(resolve => setTimeout(resolve, 30000));
const value = readFileSync("value.cjs", "utf8");
const correct = value.includes("= 2");
let result = { assignmentId: a.id, fingerprint: a.fingerprint };
if (a.role === "review") {
  const schema = a.resultSchema.oneOf[0];
  assert.equal(schema.properties.assignmentId.const, a.id);
  assert.equal(schema.properties.fingerprint.const, a.fingerprint);
  const severity = schema.properties.findings.items.properties.severity.enum.at(-1);
  result = { ...result, complete: true,
    findings: scenario === "omitted" || (correct && !["oscillation", "threshold"].includes(scenario)) ? [] : [{ key: "value-contract", path: "value.cjs", severity, title: "Wrong exported value", evidence: `Source exports ${value}` }],
    acceptance: [{ criterionId: "value", status: correct ? "satisfied" : "unsatisfied", evidence: "Inspect value.cjs and run the pinned assertion", validationIds: ["unit"] }] };
  if (scenario === "missing-acceptance") result.acceptance = [];
} else if (a.role === "triage") {
  if (scenario === "ambiguous" && !a.contractAnswers?.length) result.question = { text: "Which value should the public API export?", recommended: "2", evidence: "No repository source establishes the intended new value." };
  else result.decisions = a.findings.map(f => ({ id: f.id, status: scenario === "reject-validation" && f.id.startsWith("validation-") ? "rejected" : scenario === "repair-validation" && f.id.startsWith("validation-") ? "actionable" : correct && !["oscillation", "threshold"].includes(scenario) ? "fixed" : "actionable", evidence: "Compared current source with the contract and recorded validation." }));
} else if (a.role === "repair") {
  const count = a.validation.filter(v => v.exitCode !== 0).length;
  const next = scenario === "oscillation" ? (correct ? 1 : 2) : scenario === "recovery" && count === 0 ? 3 : 2;
  result.edits = [{ path: "value.cjs", content: `module.exports = ${next};\n`, findingIds: a.findings.map(f => f.id), reason: "Restore the required exported value." }];
  if (scenario === "journal") result.edits.push({ path: "support.txt", content: "ready\n", findingIds: a.findings.map(f => f.id), reason: "Supply the required support artifact." });
  if (scenario === "workspace") {
    result.workspaceEdits = result.edits.map(({ content, ...edit }) => { writeFileSync(edit.path, content); return edit; });
    delete result.edits;
  }
  if (scenario === "workspace-error") {
    writeFileSync("value.cjs", `module.exports = ${next};\n`);
    result = { error: "Repair adapter failed after editing" };
  }
}
process.stdout.write(JSON.stringify(result));
