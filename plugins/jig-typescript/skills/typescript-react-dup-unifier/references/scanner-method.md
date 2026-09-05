# Scanner Method And Limits

## What The Scanner Extracts

The scanner parses `.ts` and `.tsx` files with the TypeScript compiler API and identifies named abstraction units including:

- Function declarations and function-valued variables.
- React components, including common `memo` and `forwardRef` wrappers.
- Hooks identified by the `useX` convention.
- Class methods and React class components.
- Reducer, store, slice, and state-machine declarations.
- Schema-like declarations.
- Configuration or registry objects with abstraction-like names.
- Interfaces and type aliases unless `--no-types` is set.

It excludes declaration files, common build directories, generated-looking files, tests, and stories by default.

## Similarity Signals

Each abstraction receives several fingerprints:

- Normalized AST shape shingles.
- Syntax-kind histogram.
- Relative size and control-flow profile.
- Call and hook names.
- JSX tags and attributes.
- Parameter/prop and member keys.
- Type references and imported dependencies.
- Literal and template-default signals.
- React `use client` boundary.
- Semantic name terms.

The aggregate score is family-specific. Components and hooks give more weight to React behavior signals; types and schemas give more weight to member shape.

## Candidate Generation

Small abstraction families are compared directly. Large families use rare structural shingles and semantic name anchors to reduce pair count before full scoring. Exact structural matches are always added to the candidate set.

This is a recall-oriented heuristic, not a formal clone detector. A threshold around `0.68` is intended for review. Lowering below `0.62` usually produces disproportionately more incidental similarity.

## Relationship Labels

- `exact-clone`: Source is identical after whitespace normalization.
- `renamed-clone`: Structural shape is identical and behavior signals substantially overlap.
- `near-duplicate`: High aggregate similarity.
- `shared-shell-divergent-core`: Strong structural overlap with weaker behavioral overlap.
- `parallel-abstraction`: Meaningful shape overlap with visible divergence.
- `possible-pattern`: Lower-confidence candidate that still passes the configured threshold.

These labels describe scanner evidence only. They are not refactoring decisions.

## Known Limits

- No full TypeScript program or symbol graph is constructed.
- Re-exports and dynamic imports are not resolved into a complete usage graph.
- Alias names can obscure shared external APIs.
- Runtime configuration and environment-dependent behavior are invisible.
- Git history and ownership are not analyzed by the script.
- Compact one-line abstractions may be filtered by `--min-lines` unless adjusted.
- Generated code detection is heuristic.
- Pairwise similarity can connect a cluster transitively even when its endpoints should not share one abstraction.

The agent workflow compensates by reading definitions, callers, tests, package boundaries, and React lifecycle semantics before classifying a candidate.
