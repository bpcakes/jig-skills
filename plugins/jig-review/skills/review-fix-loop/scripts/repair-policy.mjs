export const DEFAULT_FIX_MODE = "balanced";
export const FIX_MODES = Object.freeze(["minimal", "balanced", "comprehensive"]);

const shared = "Establish the demonstrated failure mechanism and the violated contract or invariant using source evidence, a reproduction, or a targeted experiment. Distinguish established causes from hypotheses; investigate competing explanations before choosing a repair. Identify the layer that owns the guarantee, has the information to enforce it, and can cover affected paths without taking on inappropriate responsibilities. The right layer need not be the deepest or most shared one. Repair the mechanism there, including necessary caller changes and tests, while preserving supported behavior and respecting the task contract and exclusions. Prefer a coherent correction that reduces special cases; diff size is a cost, not the objective. Existing patterns are evidence, not proof of sound design. Validate the original failure, relevant neighboring cases, preserved behavior, and whether affected paths actually use any repaired boundary. Derive expected results from the contract rather than copying the patch's assumptions into tests. When an attempt fails or a finding recurs, distinguish an implementation error from an incorrect diagnosis and use new evidence to revise the approach before adding another workaround. A mitigation leaves its residual cause actionable or blocked; do not report it fixed merely because tests pass. Keep explanations proportional to uncertainty and risk; no architecture exercise is required for an established local defect.";

const modes = Object.freeze({
  minimal: "Keep investigation focused on the reported mechanism and the dependencies needed to establish and correct it. Necessary structural repairs and caller changes remain in scope. Defer unrelated refactoring and broader recurrence searches; a scope limit cannot turn a known residual cause into a resolved finding.",
  balanced: "Expand investigation and repair scope when evidence shows that the cause crosses boundaries or affects other users of the same invariant. Inspect the relevant callers and neighboring paths. Stop expansion when the demonstrated mechanism and its affected users are addressed; similar-looking code or speculative future needs alone do not justify redesign.",
  comprehensive: "Actively investigate related entry points, sibling paths, contracts, representations, and ownership for contributing weaknesses and recurrence risks, bounded by the invariant and its users. When evidence supports a structural deficiency, compare a local correction with repairing the responsible boundary and implement the justified durable correction with necessary callers now. Verify prevention across the affected paths. A local fix remains appropriate when the design is sound; avoid unrelated cleanup and speculative redesign.",
});

// Freeze this text in the run so resumed and external assignments receive the
// same policy. The policy guides judgment; its presence is not repair evidence.
export function repairPolicy(mode) {
  if (!FIX_MODES.includes(mode)) throw new Error("--fix-mode must be minimal, balanced, or comprehensive.");
  return `${shared}\n\n${mode} mode: ${modes[mode]}`;
}
