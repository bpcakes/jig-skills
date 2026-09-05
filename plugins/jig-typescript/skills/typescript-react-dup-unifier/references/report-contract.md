# TypeScript/React Dup Unifier Report Contract

Use this structure for the user-facing result. Omit empty sections only when they are genuinely inapplicable.

# TypeScript/React Dup Unifier Report

## Scope

- Repository or scoped path.
- Mode: `scan`, `plan`, or `apply`.
- Files and abstraction categories reviewed.
- Exclusions, threshold changes, and validation constraints.

## Executive Verdict

State:

- The number of material candidate clusters.
- The number classified as `unify-now`, `shared-core`, `standardize-contract`, `intentional-duplicate`, and `false-positive`.
- The single highest-value consolidation.
- The main architectural risk revealed by the scan.

Do not equate candidate count with technical-debt severity.

## Priority Table

| ID | Decision | Confidence | Score | Abstractions | Expected payoff | Primary risk |
|---|---|---|---:|---|---|---|

Order by expected reduction in duplicated change cost, not scanner score alone.

## Candidate Details

### DU-XXX — Concise name

**Decision:** `unify-now | shared-core | standardize-contract | intentional-duplicate | false-positive`  
**Confidence:** `high | medium | low`  
**Decision score:** `N/20 after deductions`  
**Scanner signal:** Include score and relationship only as supporting evidence.

**Source anchors**

- `path/to/a.tsx:start-end` — abstraction and role.
- `path/to/b.tsx:start-end` — abstraction and role.
- Representative call sites, tests, exports, or stories.

**Shared invariant**

One precise sentence describing the behavior that is genuinely common.

**Concrete divergence**

Cover relevant differences in domain purpose, props or types, state ownership, hook lifecycle, effects, cache behavior, accessibility, client/server boundary, dependencies, errors, and change cadence.

**Usage evidence**

State consumer count, package ownership, public exposure, and whether consumers change together.

**Recommended seam**

Name the shared unit, canonical owner, retained wrappers, typed variation surface, and what must remain separate.

**Why not a broader abstraction**

State the strongest rejected design and why it would create coupling, invalid states, lifecycle hazards, or illegible call sites.

**Migration**

1. Characterization tests.
2. Shared unit creation.
3. Consumer migration order.
4. Compatibility handling.
5. Deletion of obsolete code.

**Validation**

List exact targeted tests, type checks, lint, builds, stories, visual checks, or accessibility checks.

**Strongest counterargument**

State the best evidence for keeping the abstractions separate.

## Intentional Duplicates

Record pairs that should remain separate and the boundary that justifies duplication. This section prevents repeated future attempts to merge them.

## Cross-Cutting Findings

Include patterns such as:

- Missing design-system primitive.
- Repeated query lifecycle logic.
- Fragmented schema ownership.
- Package-boundary violations.
- Boolean-variant proliferation.
- Repeated accessibility defects.
- Duplicated tests caused by missing test builders.

## Applied Changes

Include only in `apply` mode:

- Changed files.
- Added canonical abstractions.
- Retained compatibility adapters.
- Removed implementations and exports.
- Any intentional follow-up left out of scope.

## Validation Results

For each command, report the exact command and outcome. Distinguish passed, failed, and not run. Never imply that validation ran when it did not.

## Residual Risk

State unresolved semantic questions, weak test coverage, public API concerns, or candidates deferred because evidence was insufficient.
