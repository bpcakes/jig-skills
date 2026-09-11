---
name: rust-error-handling-review
description: Review Rust error propagation, diagnostics, panic paths, and recovery within the requested scope.
---

# Rust Error Handling Review

Review error paths in the user's requested diff, files, or snippet. If a review is requested without a target, use current staged and unstaged changes. Follow relevant callers to the final handler; an empty diff is not permission for a repository-wide audit.

Skill discovery does not authorize execution. Apply this review when it serves the user's task; code changing or the skill remaining in context does not start another review. Report findings without editing unless fixes are part of the user's request.

## Evidence standard

Treat syntax, counts, missing comments, and library choices as investigation signals. For each candidate, identify the failure input, propagation path, affected contract, and concrete consequence. Check counterevidence in callers, error sources, validation, tests, library configuration, and established recovery behavior. Missing evidence is a limitation, not proof of a defect.

In particular, four or more `#[from]` variants do not establish overuse. Trace what each conversion preserves and what callers need. Distinct variants with useful messages and source chains may be exactly right. Report context loss only when a relevant operation or recovery distinction is actually lost, regardless of variant count.

## Workflow

1. Locate changed producers, conversions, handlers, and relevant tests.
2. Trace errors from origin to caller, user response, diagnostic sink, or task supervisor.
3. Investigate only the relevant families below:
   - For discards, defaults, context, and error type design, read [propagation and design](references/propagation-and-design.md).
   - For panics, retries, timeouts, cleanup, and task outcomes, read [recovery and resilience](references/recovery-and-resilience.md).
4. Validate the consequence and strongest alternative explanation before reporting. Use existing checks when useful; do not change dependencies or error strategy for a review.
5. Recommend the smallest correction consistent with existing APIs and behavior.

## Output

For each supported finding, give severity, location, error flow, failure condition, consequence, counterevidence considered, and a concrete fix. Group occurrences with the same cause. Assign severity from impact and reachability: data loss or an unavailable critical service can be critical; local diagnostic ambiguity is usually lower. No pattern receives a fixed severity.

Keep optional improvements separate from defects. Say when no supported findings remain, and state what could not be checked. Do not require a quota of findings, extra context on every `?`, replacement of `anyhow` with `thiserror`, or new logging that could expose credentials.
