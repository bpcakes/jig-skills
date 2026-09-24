import assert from "node:assert/strict";
import test from "node:test";
import { assertResult, resultSchema, SEVERITY_RANK } from "../skills/review-fix-loop/scripts/assignment-schema.mjs";
import { validateContract } from "../skills/review-fix-loop/scripts/task-contract.mjs";

const base = { id: "assignment-1", fingerprint: "pinned", contract: {
  acceptanceCriteria: [{ id: "behavior" }, { id: "compatibility" }],
  requiredValidation: [{ id: "unit" }, { id: "optional", optional: true }],
}, findings: [{ id: "f-1" }] };

test("review wire schema carries the exact envelope, severity vocabulary and required evidence IDs", () => {
  for (const id of [undefined, null, true, 123]) assert.throws(() => validateContract({
    goal: "Contract", nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: [],
    acceptanceCriteria: [{ id, description: "Required behavior" }], requiredValidation: [{ id: "unit", argv: ["true"] }],
  }), /Invalid or duplicate acceptanceCriteria ID/);
  const schema = resultSchema({ ...base, role: "review" }).oneOf[0];
  assert.deepEqual(schema.required, ["assignmentId", "fingerprint", "complete", "findings", "acceptance"]);
  assert.equal(schema.properties.assignmentId.const, base.id);
  assert.equal(schema.properties.fingerprint.const, base.fingerprint);
  assert.deepEqual(schema.properties.findings.items.properties.severity.enum, Object.keys(SEVERITY_RANK));
  const acceptance = schema.properties.acceptance;
  assert.equal(acceptance.minItems, 2); assert.equal(acceptance.maxItems, 2);
  assert.deepEqual(acceptance.items.properties.criterionId.enum, ["behavior", "compatibility"]);
  assert.deepEqual(acceptance.items.properties.validationIds.items.enum, ["unit"]);
});

test("triage schema binds decisions to the complete ledger and supports one structured question", () => {
  const [decisions, question] = resultSchema({ ...base, role: "triage" }).oneOf[0].oneOf;
  assert.deepEqual(decisions.properties.decisions.items.properties.id.enum, ["f-1"]);
  assert.deepEqual(decisions.properties.decisions.items.properties.status.enum, ["actionable", "rejected", "fixed", "blocked", "awaiting-validation"]);
  assert.equal(decisions.properties.decisions.minItems, 1);
  assert.equal(decisions.properties.decisions.maxItems, 1);
  assert.deepEqual(question.properties.question.required, ["text", "recommended", "evidence"]);
  const empty = resultSchema({ ...base, role: "triage", findings: [] }).oneOf[0].oneOf[0].properties.decisions;
  assert.equal(empty.maxItems, 0);
  assert.equal(empty.items.properties.id, false);
});

test("repair schema distinguishes replacement and deletion and requires causal attribution", () => {
  const edits = resultSchema({ ...base, role: "repair" }).oneOf[0].oneOf[1].properties.edits;
  assert.equal(edits.minItems, 1); assert.equal(edits.maxItems, 128);
  const [replace, remove] = edits.items.oneOf;
  assert.deepEqual(replace.required, ["path", "reason", "findingIds", "content"]);
  assert.deepEqual(remove.required, ["path", "reason", "findingIds", "delete"]);
  assert.equal(remove.properties.delete.const, true);
  assert.deepEqual(replace.properties.findingIds.items.enum, ["f-1"]);
  assert.equal(replace.properties.content.minLength, undefined, "An empty replacement file is permitted");
});

test("workspace repairs carry attribution without replacement contents or mixed result formats", () => {
  const assignment = { ...base, role: "repair" }, envelope = { assignmentId: base.id, fingerprint: base.fingerprint };
  const attribution = { path: "value.txt", reason: "Correct the demonstrated defect", findingIds: ["f-1"] };
  assert.doesNotThrow(() => assertResult(assignment, { ...envelope, workspaceEdits: [attribution] }));
  for (const mode of ["0644", "0755"]) assert.doesNotThrow(() => assertResult(assignment, { ...envelope, workspaceEdits: [{ ...attribution, mode }] }));
  for (const fields of [{ workspaceEdits: [] }, { workspaceEdits: [attribution], edits: [{ ...attribution, content: "" }] },
    ...[{ content: "" }, { delete: true }, ...[null, 493, "755", "04755", "0777"].map(mode => ({ mode })), { findingIds: ["unknown"] }, { reason: "" }]
      .map(extra => ({ workspaceEdits: [{ ...attribution, ...extra }] }))]) {
    assert.throws(() => assertResult(assignment, { ...envelope, ...fields }), /Malformed repair/);
  }
});

test("runtime executes the published repair variants, including empty replacements and malformed alternatives", () => {
  const assignment = { ...base, role: "repair" }, envelope = { assignmentId: base.id, fingerprint: base.fingerprint };
  const attribution = { path: "value.txt", reason: "Correct the demonstrated defect", findingIds: ["f-1"] };
  for (const variant of [{ content: "" }, { content: "replacement" }, { delete: true }]) {
    const result = { ...envelope, edits: [{ ...attribution, ...variant }] };
    assert.equal(assertResult(assignment, result), result);
  }
  for (const variant of [{}, { content: "replacement", delete: true }, { content: "", delete: false }, { delete: false },
    { content: null }, { content: "valid", unexpected: true }, { content: "valid", findingIds: ["f-1", "f-1"] },
    { content: "valid", findingIds: ["unknown"] }]) {
    assert.throws(() => assertResult(assignment, { ...envelope, edits: [{ ...attribution, ...variant }] }), /Malformed repair result/);
  }
});

test("runtime validates complete review and exclusive triage results before interpretation", () => {
  const envelope = { assignmentId: base.id, fingerprint: base.fingerprint };
  const review = { ...envelope, complete: true, findings: [], acceptance: base.contract.acceptanceCriteria.map(c => ({
    criterionId: c.id, status: "satisfied", evidence: "Checked behavior", validationIds: ["unit"],
  })) };
  assert.doesNotThrow(() => assertResult({ ...base, role: "review" }, review));
  for (const bad of [{ ...review, complete: false }, { ...review, unexpected: true }, { ...review, acceptance: [] },
    { ...review, findings: [{ key: "f", path: "a", title: "Defect", evidence: "Evidence", severity: "P1" }] }]) {
    assert.throws(() => assertResult({ ...base, role: "review" }, bad), /Malformed review result/);
  }
  const triage = { ...envelope, decisions: [{ id: "f-1", status: "actionable", evidence: "Verified" }] };
  const question = { text: "Which behavior?", recommended: "Keep compatibility", evidence: "Conflicting APIs" };
  assert.doesNotThrow(() => assertResult({ ...base, role: "triage" }, triage));
  assert.doesNotThrow(() => assertResult({ ...base, role: "triage" }, { ...envelope, question }));
  assert.throws(() => assertResult({ ...base, role: "triage" }, { ...triage, question }), /Malformed triage result/);
});

test("repair modes allow explicit regular permissions and reject unsafe or ambiguous variants", () => {
  const assignment = { ...base, role: "repair" }, envelope = { assignmentId: base.id, fingerprint: base.fingerprint };
  const attribution = { path: "tool.sh", reason: "Allow direct execution", findingIds: ["f-1"] };
  for (const mode of ["0644", "0755"]) for (const variant of [{ mode }, { mode, content: "#!/bin/sh\nexit 0\n" }]) {
    assert.doesNotThrow(() => assertResult(assignment, { ...envelope, edits: [{ ...attribution, ...variant }] }));
  }
  for (const mode of [null, 493, "755", "100755", "04755", "0777", "bad"]) {
    assert.throws(() => assertResult(assignment, { ...envelope, edits: [{ ...attribution, content: "", mode }] }), /Malformed repair/);
  }
  assert.throws(() => assertResult(assignment, { ...envelope, edits: [{ ...attribution, delete: true, mode: "0755" }] }), /Malformed repair/);
});
