export const DEFAULT_FIX_MODE = "balanced";
export const FIX_MODES = Object.freeze(["minimal", "balanced", "comprehensive"]);

const shared = "A sound repair has a demonstrated failure mechanism and violated contract or invariant supported by source evidence, a reproduction, or a targeted experiment. Established causes are distinguished from hypotheses, with competing explanations investigated when relevant. The responsible layer owns the guarantee, has the information to enforce it, and covers affected paths without inappropriate responsibilities; it need not be the deepest or most shared layer. The correction addresses that mechanism, including necessary callers and tests, while preserving supported behavior and respecting the task contract and exclusions. A coherent correction that reduces special cases is preferred; diff size is a cost, not the objective. Existing patterns are evidence, not proof of sound design. Validation covers the original failure, relevant neighboring cases, preserved behavior, and whether affected paths use the repaired boundary. Expected results come from the contract rather than the patch's assumptions. Failed attempts or recurring findings require new evidence distinguishing implementation errors from an incorrect diagnosis before another workaround is justified. A mitigation leaves its residual cause actionable or blocked; passing tests alone does not establish resolution. Explanations are proportional to uncertainty and risk; an established local defect does not require an architecture exercise.";

const modes = Object.freeze({
  minimal: "Investigation focuses on the reported mechanism and the dependencies needed to establish and correct it. Necessary structural repairs and caller changes remain in scope. Unrelated refactoring and broader recurrence searches are deferred; a scope limit cannot turn a known residual cause into a resolved finding.",
  balanced: "Investigation covers relevant callers and neighboring paths. Expansion across boundaries or to other users of the same invariant requires evidence. Scope ends at the demonstrated mechanism and its affected users; similar-looking code or speculative future needs alone do not justify redesign.",
  comprehensive: "Investigation includes related entry points, sibling paths, contracts, representations, and ownership for contributing weaknesses and recurrence risks, bounded by the invariant and its users. Evidence of a structural deficiency calls for comparison of a local correction with repairing the responsible boundary. The justified correction includes necessary callers and prevention coverage across affected paths. A local fix remains appropriate when the design is sound; unrelated cleanup and speculative redesign remain out of scope.",
});

// Freeze this text in the run so resumed and external assignments receive the
// same policy. The policy guides judgment; its presence is not repair evidence.
export function repairPolicy(mode) {
  if (!FIX_MODES.includes(mode)) throw new Error("--fix-mode must be minimal, balanced, or comprehensive.");
  return `${shared}\n\n${mode} mode: ${modes[mode]}`;
}
