---
name: typescript-react-dup-unifier
description: "Scan TypeScript/React repositories for exact and near-duplicate abstractions—components, hooks, functions, methods, state logic, schemas, configs, interfaces, and types—then decide whether to unify, extract a shared core, standardize a contract, or keep them intentionally separate. Use for duplicate-abstraction audits, DRY/refactor reviews, design-system consolidation, and requests to merge similar implementations. Do not use for non-TypeScript repositories, generated code, or blind textual clone counting."
---

# TypeScript/React Dup Unifier

Find parallel abstractions whose implementations are similar enough to create duplicated change cost but divergent enough that a blind merge would be dangerous. Reduce duplication without creating a configurable, cross-domain “god abstraction.”

Resolve the directory containing this `SKILL.md` as `<skill_dir>`.

## Inputs And Modes

Resolve these inputs from the request and repository:

- Target repository or scoped path. Default to the current working directory.
- Mode: `scan`, `plan`, or `apply`. Infer it from the user’s request; default to `scan` when the request does not authorize edits.
- Optional threshold, exclusions, or focus such as components, hooks, forms, data access, state, schemas, or types.
- Applicable repository instructions, package boundaries, and validation commands.

Do not install packages or access the network. The bundled scanner uses the repository’s existing `typescript` dependency when available and otherwise an already-installed global TypeScript package.

## Operating Principles

- Similar syntax is evidence, not a unification decision.
- Unify only when the abstractions protect the same invariant, have compatible lifecycle semantics, and change for substantially the same reasons.
- Prefer a shared pure core with thin domain wrappers over a single component or hook controlled by flags and callbacks.
- Preserve dependency direction and package ownership. Shared code must not import feature-specific code.
- Keep distinct domain language when the concepts are distinct, even when their fields or JSX happen to match.
- In `scan` or `plan` mode, keep product source read-only.
- Treat generated code, snapshots, vendored code, and framework output as out of scope unless the user explicitly includes them.

## Workflow

### 1. Map The Repository Before Scoring Duplicates

Identify:

- Workspace and package boundaries, package ownership, and public entry points.
- TypeScript configs, path aliases, project references, and React framework conventions.
- Design-system layers, feature folders, data-access clients, state libraries, form libraries, schema libraries, and test conventions.
- React client/server boundaries, including `use client`, server components, route handlers, and framework-specific rendering boundaries.
- Generated directories and intentionally mirrored platform implementations.

Do not assume the most generic-looking location is the correct owner. Ownership follows the narrowest stable shared domain.

### 2. Generate Structural Candidates

Run the bundled scanner once at the default threshold:

```bash
node "<skill_dir>/scripts/typescript-react-dup-unifier.mjs" "<target>" \
  --json "<work_dir>/typescript-react-dup-unifier.json" \
  --markdown "<work_dir>/typescript-react-dup-unifier.md"
```

Useful options:

```text
--min-score 0.68       Default candidate threshold
--min-tokens 32        Ignore trivial abstractions
--max-results 100      Bound review volume
--include-tests        Include test helpers and fixtures
--include-stories      Include Storybook stories
--no-types             Skip interfaces and type aliases
--exclude <glob>       Add a repository-relative exclusion
```

If the default scan produces no candidates but repository evidence strongly suggests parallel abstractions, run one additional pass at `--min-score 0.62`. Do not repeatedly lower the threshold until noise appears.

The scanner is a candidate generator. Its score combines normalized AST shape, behavioral signals, control flow, size, and React-specific features. Never present the score as proof that two abstractions should be merged.

### 3. Review Source And Usage, Not Just Definitions

For every material candidate or cluster:

1. Read both definitions completely.
2. Find all imports, call sites, JSX usages, re-exports, tests, stories, and public package consumers.
3. Compare domain purpose and the invariant each abstraction protects.
4. Compare change triggers and expected future evolution.
5. Inspect the React-specific divergence listed in `references/react-duplication-taxonomy.md`.
6. Identify the nearest valid shared owner and verify that moving code there preserves dependency direction.
7. Record the strongest counterargument against unification.

A candidate with no usage evidence is incomplete. A candidate spanning packages with different owners requires a stronger case than one inside a single feature.

### 4. Classify Each Candidate

Assign exactly one decision:

- `unify-now`: One abstraction can own the behavior with a small, stable variation surface.
- `shared-core`: Extract pure behavior or a headless primitive while retaining thin domain-specific wrappers.
- `standardize-contract`: Align naming, types, or interfaces now, but defer implementation sharing because lifecycle or ownership remains distinct.
- `intentional-duplicate`: Keep separate and document the semantic or architectural boundary.
- `false-positive`: Similarity is incidental or too shallow to matter.

Use `references/unification-decision-rubric.md`. Do not recommend `unify-now` unless the evidence score reaches its threshold and no hard stop applies.

### 5. Design The Smallest Stable Unification Seam

For `unify-now` or `shared-core`, specify:

- Canonical owner and public name.
- Shared invariant and exact behavior that moves.
- Variations that remain at call sites or in thin wrappers.
- Type strategy, favoring discriminated unions or explicit variants over independent booleans.
- Migration order and compatibility strategy.
- Characterization tests needed before extraction.
- Validation commands and rollback boundary.

Prefer these patterns in order when they fit:

1. Shared pure function with feature wrappers.
2. Headless hook or state machine with presentational wrappers.
3. Design-system primitive with explicit, closed variants.
4. Declarative configuration when differences are data rather than behavior.
5. Shared contract or type only, with separate implementations.

Reject an abstraction that requires broad `options` bags, arbitrary lifecycle callbacks, conditional hooks, feature imports in shared code, or more than three independent boolean variants.

### 6. Apply Changes Only When Authorized

In `apply` mode:

1. Add or strengthen characterization tests before moving behavior when regression risk is material.
2. Create the canonical shared unit at the narrowest valid owner.
3. Migrate one consumer at a time.
4. Preserve public compatibility with temporary adapters only when the migration spans multiple packages or external consumers.
5. Remove obsolete implementations, exports, and tests after all consumers move.
6. Run the repository’s targeted tests, TypeScript checks, lint, and relevant build commands.
7. Inspect the final diff for API inflation, dependency inversion, conditional-hook hazards, accessibility regressions, and server/client boundary changes.

Do not broaden the refactor into unrelated cleanup.

## Hard Stops

Do not unify when any of these is true unless the design changes to remove the conflict:

- Hook order, effect cleanup, cancellation, caching, invalidation, retry, optimistic-update, or error semantics differ materially.
- One component is controlled and the other is uncontrolled, or state ownership differs materially.
- Accessibility role, focus management, keyboard behavior, or user-facing semantics differ.
- One implementation is server-safe and the other requires a client boundary.
- The proposed shared layer would depend on a feature layer or create a package cycle.
- The abstractions represent different domain concepts with different owners or regulatory/security requirements.
- The variation surface is open-ended rather than a small, stable set.
- Call sites become less legible than the duplicated implementations.
- Tests cannot establish behavior well enough to migrate safely.

## Required Output

Follow `references/report-contract.md`.

The report must distinguish high-confidence unifications from shared-core candidates, contract-only alignments, and intentional duplicates. Every material recommendation must include source locations, usage evidence, the shared invariant, concrete divergence, canonical ownership, migration shape, validation, and the strongest reason not to merge.

In `apply` mode, also report changed files, compatibility adapters, removed abstractions, and executed validation commands with their outcomes.

## Final Checks

Before completion, verify that:

- Every recommendation is supported by source and usage evidence, not only scanner output.
- The proposed owner is narrower than or equal to the shared domain; it is not a generic dumping ground.
- React lifecycle, accessibility, state ownership, and client/server semantics were compared explicitly.
- The type surface excludes invalid combinations rather than hiding them behind optional fields.
- The plan removes more duplicated change cost than coupling it introduces.
- Intentional duplicates and false positives are recorded so the same pair is not repeatedly “rediscovered.”
- Validation is scoped, reproducible, and honest about anything not run.
