export const SEVERITY_RANK = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });

const text = { type: "string", minLength: 1 };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const array = (items, extra = {}) => ({ type: "array", items, ...extra });
const choice = values => values.length ? { type: "string", enum: values } : false;

// An assignment carries its complete wire contract. Reviewers need no prior
// conversation or controller source to learn names, enum values, or envelopes.
export function resultSchema(assignment) {
  const envelope = { assignmentId: { const: assignment.id }, fingerprint: { const: assignment.fingerprint } };
  let success;
  if (assignment.role === "review") {
    success = object({ ...envelope, complete: { const: true },
      findings: array(object({ key: text, path: text, severity: choice(Object.keys(SEVERITY_RANK)), title: text, evidence: text }), { maxItems: 128 }),
      acceptance: array(object({ criterionId: choice(assignment.contract.acceptanceCriteria.map(c => c.id)),
        status: choice(["satisfied", "unsatisfied", "uncertain"]), evidence: text,
        validationIds: array(choice(assignment.contract.requiredValidation.filter(c => !c.optional).map(c => c.id)), { minItems: 1, uniqueItems: true }) }),
      { minItems: assignment.contract.acceptanceCriteria.length, maxItems: assignment.contract.acceptanceCriteria.length }) });
  } else if (assignment.role === "triage") {
    success = { oneOf: [object({ ...envelope,
      ...(assignment.validationAssessment ? { validationImpact: array(object({
        assignmentId: choice(assignment.validationAssessment.checks.map(c => c.assignmentId)),
        status: choice(["unaffected", "rerun"]), evidence: text,
      }), { minItems: assignment.validationAssessment.checks.length, maxItems: assignment.validationAssessment.checks.length }) } : {}),
      decisions: array(object({ id: choice(assignment.findings.map(f => f.id)), status: choice(["actionable", "rejected", "fixed", "blocked", ...(assignment.sourceChanges ? ["needs-validation"] : [])]), evidence: text }),
        { minItems: assignment.findings.length, maxItems: assignment.findings.length }) }),
    object({ ...envelope, question: object({ text, recommended: text, evidence: text }) })] };
  } else if (assignment.role === "repair") {
    const attribution = { path: text, reason: text, findingIds: array(choice(assignment.findings.map(f => f.id)), { minItems: 1, uniqueItems: true }) };
    const mode = { type: "string", enum: ["0644", "0755"] };
    success = { oneOf: [object({ ...envelope, workspaceEdits: array(object({ ...attribution, mode }, Object.keys(attribution)), { minItems: 1, maxItems: 128 }) }),
      object({ ...envelope, edits: array({ oneOf: [
      object({ ...attribution, content: { type: "string" }, mode }, [...Object.keys(attribution), "content"]),
      object({ ...attribution, delete: { const: true } }),
      object({ ...attribution, mode }),
    ] }, { minItems: 1, maxItems: 128 }) })] };
  } else throw new Error(`No result schema for assignment role: ${assignment.role}`);
  return { $schema: "https://json-schema.org/draft/2020-12/schema", oneOf: [success,
    object({ error: text, execution: { type: "string", enum: ["completed", "uncertain"] } }, ["error"])] };
}

// Execute precisely the small schema vocabulary generated above. Fail closed
// if that vocabulary grows: a new keyword must acquire runtime semantics too.
const keywords = new Set(["$schema", "type", "const", "enum", "oneOf", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "uniqueItems", "minLength"]);
function matches(schema, value) {
  if (typeof schema === "boolean") return schema;
  for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new Error(`Unsupported result schema keyword: ${key}`);
  if (schema.oneOf && schema.oneOf.filter(branch => matches(branch, value)).length !== 1) return false;
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "string" && (typeof value !== "string" || [...value].length < (schema.minLength ?? 0))) return false;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (schema.required.some(key => !Object.hasOwn(value, key))) return false;
    if (Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) return false;
    if (Object.entries(value).some(([key, item]) => !matches(schema.properties[key], item))) return false;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return false;
    if (value.some(item => !matches(schema.items, item))) return false;
  }
  return true;
}
export function assertResult(assignment, result) {
  if (!matches(resultSchema(assignment), result)) throw new Error(`Malformed ${assignment.role} result: does not match the assignment result schema.`);
  return result;
}
