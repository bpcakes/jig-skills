# Validation, Severity, And Confidence

## Minimum Evidence For A Finding

A confirmed finding needs all of the following:

- an identifiable exported or architectural boundary;
- a specific hidden implementation detail;
- at least one concrete consumer dependency;
- a plausible implementation change that preserves promised semantics;
- unrelated consumer edits caused by that change;
- a reason the concern belongs inside another owner, or a reason the boundary should be removed;
- counterevidence considered and rejected.

Prefer two independent consumers. A single consumer can support a finding when the contract is public, the coupling is direct, and the change test is unambiguous.

Do not report declarations, naming, file size, generic complexity, `Context`, `className`, `ref`, controlled props, render props, or third-party imports by themselves.

## Severity

### High

Use when one or more of these hold:

- the leak crosses a public package, design-system, platform, or widely shared feature boundary;
- many consumers repeat workarounds or orchestration;
- the leak permits invalid state, data corruption, authorization mistakes, accessibility regressions, severe performance failures, or persistent user-visible defects;
- replacing or upgrading the hidden implementation requires a broad migration;
- the boundary changes frequently and repeatedly causes unrelated consumer churn.

### Medium

Use when:

- the leak crosses a feature/shared-component boundary with multiple consumers;
- repeated consumer logic creates a credible defect or maintenance risk;
- a library or representation swap would require several unrelated edits;
- ownership is wrong but the current blast radius is contained.

### Low

Use when:

- the leak is localized to one or two consumers;
- the change amplification is real but modest;
- the boundary is early in its life and correction is cheap;
- tests or stories, rather than product code, are the main source of coupling.

Do not inflate severity merely because an API is unpleasant. Architecture severity is driven by blast radius, correctness risk, change frequency, and migration cost.

## Confidence

### High Confidence

- definition and consumer evidence are direct;
- at least two consumers or a clearly public contract demonstrate the same hidden dependency;
- the substitution test is concrete;
- counterevidence was checked in code or documentation.

### Medium Confidence

- one real consumer demonstrates the leak;
- the boundary promise and ownership are clear;
- the change test is strong, but breadth or intent is less certain.

Do not publish low-confidence items as findings. Put them in a watchlist only when the user explicitly requests speculative leads.

## Change-Amplification Test

Use this compact record during validation:

| Question | Required answer |
|---|---|
| Promise | What stable behavior does the boundary claim? |
| Hidden choice | What implementation choice should be replaceable? |
| Consumer knowledge | What does the caller know or reproduce? |
| Preserving change | What internal change preserves the promise? |
| Unrelated edits | Which callers change solely because of the hidden choice? |
| Correct owner | Where should this knowledge live, or should the boundary disappear? |

A finding fails when the preserving change is implausible, the consumer edits reflect changed semantics, or the consumer intentionally owns the concern.

## Remediation Quality

A good correction:

- makes ownership explicit;
- narrows the contract rather than wrapping the same leak;
- preserves necessary capabilities;
- reduces the number of consumers that know the implementation;
- has a credible migration path;
- adds contract-level tests;
- does not create a generic framework for hypothetical future cases.

Prefer, in order:

1. delete or inline a fake abstraction;
2. move a stable policy to its natural owner;
3. translate the boundary to domain types and semantic events;
4. split primitive and product-level contracts;
5. introduce a dedicated adapter when a real external boundary exists.
