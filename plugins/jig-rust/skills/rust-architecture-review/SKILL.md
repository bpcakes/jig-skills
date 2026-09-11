---
name: rust-architecture-review
description: Review Rust module boundaries, dependencies, ownership, and public APIs for structural consequences.
---

# Rust Architecture Review

Review structural consequences in the requested Rust diff, files, or snippet: modules, crates, dependencies, ownership, traits, and public APIs. When a review has no specified target, inspect current staged and unstaged changes. Follow neighbors only to validate a boundary affected by that scope.

Automatic discovery does not start a review whenever code changes. Use this skill to serve the user's task. Review-only requests produce findings and proposals; implement refactors only when the user requests changes.

## Evidence standard

A smell is an investigation signal, not a finding. Establish the intended boundary, concrete usage, consequence, and strongest counterevidence. Counts, nesting, naming, library choices, and missing comments cannot establish defects or severity. A coherent large module or trait may be cheaper to maintain than a split.

Use actual source, manifests, re-exports, and available metadata. Do not invent graph edges, counts, external consumers, or compilation results. Distinguish missing evidence from a confirmed problem.

## Investigate relevant boundaries

- **Cohesion and nesting:** Mixed handlers and database code, deep paths, or pass-through modules may warrant inspection. Confirm independent change responsibilities, caller confusion, or duplicated policy. Small vertical slices, facade re-exports, generated protocol hierarchies, and deliberate API organization are counterevidence. Do not flag depth or item counts alone.
- **Dependencies:** Trace cycles or apparent layer skips against the project's actual dependency contract. Show the cycle or import and resulting coupling, initialization risk, or blocked independent change. Mutual references within a cohesive Rust module graph are not inherently defective. If useful, count distinct importing/imported modules within the inspected scope and disclose incomplete counts.
- **Visibility:** Resolve effective visibility through private modules and re-exports. No local callers does not prove a public library API is unused. Show an exposed implementation detail violating the intended contract or allowing invariant escape. `#[doc(hidden)]` does not make a reachable item private; assess compatibility under the project's policy.
- **Traits and dispatch:** Many methods or trait implementations are signals to examine cohesion, not thresholds. Visitor traits, extension APIs, foreign-trait newtypes, and `dyn Trait` can be deliberate. Recommend a split or dispatch change only with caller, runtime, compile-time, or maintenance evidence. Verify dyn compatibility before proposing trait objects.
- **Types and state:** Nested generics, primitive IDs, repeated types, or several `Option` fields invite examination. Report concrete accidental mixing, inconsistent definitions, invalid state transitions, or repeated caller compensation. Independent optional fields, runtime state validation, and clear local types are counterevidence. A type alias, newtype, or typestate design is a possible fix, not a universal requirement.
- **Conversions and errors:** Distinguish lossless `From`, fallible `TryFrom`, contextual constructors, and boundary translation. Different conversion styles can express different semantics. Error types need not exist at every module boundary. Consolidate only when overlapping contracts or lost recovery/diagnostic information impose a concrete cost.
- **Compatibility:** Suggest sealing or `#[non_exhaustive]` only when consistent with the intended extension and evolution policy. These changes can break existing callers; disclose migration needs rather than claiming every structural improvement is behavior-preserving.

## Output

Report each supported finding with severity, location, intended boundary, source/caller evidence, consequence, counterevidence considered, and the smallest incremental remedy. Severity follows impact and reachability; cycles, visibility, or trait size do not receive automatic critical ratings.

Separate optional design alternatives from defects. No supported findings is a valid result. State missing inputs and verification limits. Read-only build or test checks may support a proposal, but cannot prove an unapplied refactor compiles. Do not edit code merely to verify a review recommendation.
