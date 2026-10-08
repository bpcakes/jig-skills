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

The narrow rule that can safely be centralized, or why no common invariant has been established.

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

For `unify` or `shared_core`, describe the target shape. For `keep_separate`, state the preserved boundary. For `needs_evidence`, state the unresolved question and evidence needed.

### Smallest safe sequence

For `unify` or `shared_core` only: list the actual dependency-ordered edits and compatibility steps for this cluster. Omit this section for other dispositions; do not copy a generic migration sequence.

### Validation

For actionable recommendations, give repository-specific validation commands and distinguish proposed commands from those actually run. Other dispositions need evidence anchors, not speculative implementation checks.
```

## Rejected Candidates

Use this short list for obvious false positives rejected during cheap screening. Reserve full `keep_separate` entries for clusters that received deep semantic validation; do not list the same cluster twice. This is a record for the reader, not persistent scanner suppression.

```markdown
## Rejected candidates

- `<A> ↔ <B>` — `keep_separate`: concise source-backed reason.
```

## Coverage

End with:

- Rust files and crates reviewed; clusters screened versus deeply validated.
- Per-stream eligible/emitted/truncated pairs and lowest emitted scores.
- `blocked_groups`, potential/considered/unselected/prefiltered pairs, omitted exact matches, and parse errors.
- Note that connected discovery groups may include transitive matches and edges omitted by output caps.
- Excluded generated, vendored, test, example, or build-output paths.
- Candidate classes inspected manually beyond the scanner.
- Commands actually run and their results.
- Unresolved questions that could change a disposition.

Do not report a similarity score as proof of shared semantics. Scores may be included only as discovery context.
