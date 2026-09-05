# Rust Dup Unifier Report Contract

Use Markdown by default. Keep the report evidence-dense rather than long.

## Header

```markdown
# Rust Dup Unifier Report

- Repository: `<path or repository name>`
- Scope: `<requested paths>`
- Mode: `scan-only | plan | implementation`
- Coverage: `<files/crates reviewed, exclusions, and material gaps>`
- Candidate generator: `<command and threshold, if used>`
```

## Executive Summary

State:

- Number of validated clusters by disposition.
- Highest-priority consolidation.
- Most important reason not to merge an attractive false positive.
- Any material coverage or build-validation limitation.

## Cluster Entry

```markdown
## DU-001 — `<cluster title>`

- Disposition: `unify | shared_core | keep_separate | needs_evidence`
- Confidence: `high | medium | low`
- Drift risk: `high | medium | low`
- Payoff: `high | medium | low`
- Migration risk: `high | medium | low`

### Abstractions

- `<TypeOrTrait>` — `path/to/file.rs:line`
- `<OtherTypeOrTrait>` — `path/to/file.rs:line`

### Shared responsibility

One precise sentence describing the concept or mechanism they both own.

### Common invariant

The narrow rule that can safely be centralized.

### Divergences

| Dimension | A | B | Interpretation |
|---|---|---|---|
| Field/variant/signature | ... | ... | accidental, policy, compatibility, unknown |
| Behavior | ... | ... | ... |
| Callers | ... | ... | ... |
| Attributes/bounds | ... | ... | ... |

### Semantic blockers

List only blockers grounded in source: public API, serialization, ownership, coherence, feature gates, ABI, unsafe contract, performance, or missing evidence.

### Recommendation

Describe the target shape. Prefer a narrow shared core over a union type full of optional state.

### Smallest safe sequence

1. Test or characterize the shared invariant.
2. Extract or select the canonical implementation.
3. Migrate one caller group.
4. Preserve or stage public compatibility.
5. Remove obsolete adapters and duplicate tests only after behavior is covered.

### Validation

- `<repository-specific command>`
- `<feature or crate-specific command>`
```

## Rejected Candidates

Include high-scoring or obvious pairs that should remain separate so future scans do not repeatedly propose them.

```markdown
## Rejected candidates

- `<A> ↔ <B>` — `keep_separate`: concise source-backed reason.
```

## Coverage

End with:

- Rust files and crates reviewed.
- Excluded generated, vendored, test, example, or build-output paths.
- Candidate classes inspected manually beyond the scanner.
- Commands actually run and their results.
- Unresolved questions that could change a disposition.

Do not report a similarity score as proof of shared semantics. Scores may be included only as discovery context.
