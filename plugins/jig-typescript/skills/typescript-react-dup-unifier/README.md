# TypeScript/React Dup Unifier Skill

A TypeScript/React-specific skill for finding abstractions that are structurally similar but have drifted in naming, dependencies, lifecycle behavior, props, JSX, types, or defaults.

It is deliberately not a “make everything DRY” workflow. The skill separates five outcomes:

- unify now;
- extract a shared core and keep thin wrappers;
- standardize only the contract;
- retain an intentional duplicate;
- reject a scanner false positive.

## Package Contents

- `SKILL.md` — the agent workflow and guardrails.
- `scripts/typescript-react-dup-unifier.mjs` — local TypeScript AST candidate scanner.
- `scripts/test-typescript-react-dup-unifier.mjs` — black-box scanner tests.
- `references/react-duplication-taxonomy.md` — React/TypeScript review dimensions.
- `references/unification-decision-rubric.md` — evidence-based merge rubric.
- `references/report-contract.md` — required reporting structure.
- `references/scanner-method.md` — scanner mechanics and limitations.
- `examples/typescript-react-dup-unifier.config.json` — example scanner configuration.

## Standalone Scanner

The scanner has no bundled runtime dependencies. It loads an existing `typescript` package from the target repository or from an already-installed global location. It never installs packages.

```bash
node scripts/typescript-react-dup-unifier.mjs /path/to/repo \
  --json /tmp/typescript-react-dup-unifier.json \
  --markdown /tmp/typescript-react-dup-unifier.md
```

Useful variants:

```bash
# Narrow a scan to one package or feature
node scripts/typescript-react-dup-unifier.mjs packages/design-system

# Include tests and stories
node scripts/typescript-react-dup-unifier.mjs . --include-tests --include-stories

# Lower recall threshold once for a noisier exploratory pass
node scripts/typescript-react-dup-unifier.mjs . --min-score 0.62

# CI-style signal; exits with status 2 when a candidate reaches 0.90
node scripts/typescript-react-dup-unifier.mjs . --fail-above 0.90 \
  --json typescript-react-dup-unifier.json
```

## Test

```bash
node scripts/test-typescript-react-dup-unifier.mjs
```

or:

```bash
npm test
```

## Installation

This skill is bundled with the `jig-typescript` plugin in `jig-skills`. Install the plugin using the [repository instructions](../../../../README.md#install-with-codex), then invoke `$jig-typescript:typescript-react-dup-unifier`.

Run the scanner and test commands above from this skill directory. Keep the relative paths intact because `SKILL.md` invokes the bundled scanner and references the review guides.

## Limits

The scanner does not prove semantic equivalence. It does not build a complete type-aware call graph, inspect runtime behavior, or decide ownership. Its output is intentionally a ranked review queue. The skill requires source, usage, test, lifecycle, accessibility, and package-boundary review before recommending consolidation.
