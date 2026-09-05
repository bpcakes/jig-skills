# Unification Decision Rubric

Score a candidate only after reading definitions, usages, tests, and package ownership. Scanner similarity is supporting evidence; it is not one of the decision dimensions below.

## Positive Dimensions

Score each from 0 to 4.

### Shared invariant

- 0: Different purpose or invariant.
- 1: Similar output shape, different meaning.
- 2: Some shared behavior, but important rules differ.
- 3: Same core invariant with bounded variation.
- 4: Same invariant and observable contract.

### Shared change trigger

- 0: Changes originate from unrelated teams or requirements.
- 1: Rarely change together.
- 2: Some correlated maintenance.
- 3: Usually change for the same reason.
- 4: Every meaningful change should apply to both.

### Regularity of variation

- 0: Divergence is open-ended or feature-specific.
- 1: Many unrelated switches or callbacks would be required.
- 2: A few variations exist but the seam is uncertain.
- 3: Variation is small, explicit, and typed.
- 4: Difference is data or one closed variant.

### Leverage

- 0: Tiny stable duplication with negligible maintenance cost.
- 1: Two low-change copies.
- 2: Moderate repeated logic or three consumers.
- 3: High-change behavior or several consumers.
- 4: Repeated defects, broad fan-out, or a clear platform primitive.

### Validation safety

- 0: Behavior is poorly understood and cannot be characterized safely.
- 1: Sparse tests and high regression risk.
- 2: Partial tests or observable behavior can be added.
- 3: Strong targeted tests and clear validation commands.
- 4: Excellent characterization, type coverage, and reversible migration.

Positive subtotal: 0–20.

## Risk Deductions

Deduct the stated points when applicable.

- Different domain ownership or release cadence: −3.
- Shared location would violate dependency direction or create a cycle: −5.
- Material hook/effect/cache/cancellation divergence: −5.
- Material accessibility or state-ownership divergence: −4.
- Server/client boundary mismatch: −4.
- Public API or multi-package migration risk: −2.
- More than three independent behavioral flags: −4.
- Generic callback or `options` bag required to express the difference: −3.
- Same shape but distinct regulated, authorization, identity, or money semantics: −5.
- Call sites become less legible: −2.

## Decision Thresholds

- 16 or more: `unify-now`, unless a hard stop applies.
- 11–15: `shared-core` is usually the maximum safe move.
- 7–10: `standardize-contract` or retain separate wrappers.
- 3–6: `intentional-duplicate` is usually cheaper and clearer.
- 2 or less: `false-positive` unless other evidence is compelling.

A hard stop in `SKILL.md` overrides the numeric score.

## Required Written Rationale

For every candidate not marked `false-positive`, record:

- Positive subtotal and each dimension score.
- Risk deductions.
- Final score.
- The shared invariant in one sentence.
- The strongest counterargument against the decision.
- The smallest stable seam.
- The canonical owner and why it is the correct owner.

Do not inflate scores to justify a preferred refactor. When evidence is missing, score the dimension lower and state the gap.
