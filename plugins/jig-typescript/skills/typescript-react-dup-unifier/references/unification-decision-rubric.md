# Unification Decision Rubric

Evaluate a candidate after reading definitions, usages, tests, and package ownership. Optional scores help compare candidates; neither totals nor flag counts establish a defect or authorize unification. Scanner similarity is supporting evidence; it is not one of the decision dimensions below.

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

If using scores, these deductions are rough comparison aids. Explain the actual cost and consider counterevidence.

- Different domain ownership or release cadence: −3.
- Shared location would violate dependency direction or create a cycle: −5.
- Material hook/effect/cache/cancellation divergence: −5.
- Material accessibility or state-ownership divergence: −4.
- Server/client boundary mismatch: −4.
- Public API or multi-package migration risk: −2.
- Behavioral flags that create conflicting combinations or repeated caller compensation: up to −4. Count alone is not evidence.
- Generic callback or `options` bag required to express the difference: −3.
- Same shape but distinct regulated, authorization, identity, or money semantics: −5.
- Call sites become less legible: −2.

## Decisions

Choose `unify-now`, `shared-core`, `standardize-contract`, `intentional-duplicate`, or `false-positive` from the demonstrated invariant, ownership, caller costs, and migration risks. No numeric threshold determines the choice. A hard stop in `SKILL.md` still applies; a high score cannot override it.

## Required Written Rationale

For every candidate not marked `false-positive`, record:

- Supporting evidence and material risks; include scores only if used.
- The shared invariant in one sentence.
- The strongest counterargument against the decision.
- The smallest stable seam.
- The canonical owner and why it is the correct owner.

Do not inflate scores to justify a preferred refactor. When evidence is missing, state the gap without treating it as a negative finding.
