---
name: review-fix-loop
description: Review and fix code through a bounded, persisted repair and validation loop. Use for ordinary review-and-fix requests; review-only and explicitly one-pass requests stay outside the loop.
---

# Review Fix Loop

“Review and fix this” authorizes this bounded loop. “Review this” means review only; “fix this” means repair and validate; “review and fix once” or “do not re-review” means one repair phase. Do not ask for routine approval to begin or continue an authorized round.

If repository capabilities are unsupported, stop and report the precise limitation. Do not proceed with review or repair, fall back to one pass, or bypass preservation checks.

Use the executable [controller](scripts/review-fix-loop.mjs), which owns state, round limits, provider attempts, immutable assignments, validation, patch application, and terminal decisions. Read [the controller interface](references/controller.md) before running it. Never reconstruct counters in conversation or declare convergence independently of its result.

## Normal invocation

```text
Review and fix this.
```

Inspect the request and repository, then pin a task contract with acceptance criteria, non-goals, compatibility constraints, permitted behavior changes, and concrete validation commands. Use `plan-validation` to discover CI and project evidence; inspect that evidence before selecting commands. An omitted requirement is a review defect even if no changed line is wrong. Empty diffs are supported when the contract defines unfinished work.

Initialize the controller, then use `run` to execute until a terminal state or a native assignment boundary. For native review assignments, delegate each to a fresh isolated reviewer with only its assignment and repository copy. These are independent review tasks; do not pass prior findings, verdicts, or repair narratives. Native Codex is the default capability. Selected external providers may be supplied as structured command adapters; preserve explicit model, effort, profile, and access settings. Run triage and repair assignments yourself or through a configured adapter. Return their structured results with `submit` and continue the same run. `advance` is also available for a single transition. A waiting command is already accounted for: poll the same run, never launch a replacement yourself.

Return results matching each assignment's `resultSchema`. Review reports are evidence to verify. For each persisted finding, establish whether it is actionable, rejected, fixed, or blocked and cite the source, reproduction, or validation that supports the decision. Preserve finding IDs across recurrences; use stable causal keys when reporting findings. Severity orders repairs; all actionable severities are included by default.

For repair assignments, establish the failure mechanism and repair the contract or boundary responsible for preventing it. That layer must own the guarantee and have the information to enforce it without taking on inappropriate responsibilities; it need not be the deepest or most shared layer. Expand scope when evidence shows the cause crosses boundaries. Include necessary callers, tests, and generated source outputs, respecting exclusions and supported behavior. Verify the original failure, relevant neighboring cases, and any claimed structural correction. Reassess the diagnosis using new evidence when attempts fail or findings recur. A mitigation leaves its residual cause actionable or blocked. Use the existing evidence and edit-reason fields for concise source-backed explanations; filling these fields is not proof of correctness.

The controller applies the candidate with a recoverable journal, then runs the repository's normal checks in the existing checkout and development environment. Failed candidates remain visible and recorded; there is no automatic rollback. Do not directly edit source inputs or Git indices in the checkout or assignment copies. Diagnostic commands may write ignored build/cache outputs in assignment copies; put other scratch files outside them. Only controller validation supplies required validation evidence.

## Repair modes

`--fix-mode balanced` is the default. All modes require a causal repair at the responsible layer; the mode controls investigation breadth, independently of reviewer selection, severity, and round limits. Every review, triage, and repair assignment carries the selected mode and the complete policy pinned at initialization.

- **Balanced:** inspect the mechanism, relevant callers, and neighboring paths; expand investigation and repair scope when evidence warrants it. Stop at the demonstrated mechanism and its affected users.
- **Minimal:** focus on the reported mechanism and the dependencies needed to correct it. Necessary structural repairs remain in scope; defer broader recurrence searches and unrelated cleanup. Scope limits do not make a known residual cause resolved.
- **Comprehensive:** actively investigate related entry points and contributing design weaknesses or recurrence risks. Compare local and structural repairs when the evidence warrants it; implement the justified correction and affected callers now, with prevention coverage. A sound design can still warrant a local fix.

Map explicit plain-language requests for minimal changes or comprehensive diagnosis to their mode when no flag was supplied; otherwise use balanced. State the effective mode. Diff size is a cost, not the objective. Similar-looking code and speculative future needs do not justify redesign. A demonstrated local mistake does not require an architecture exercise.

## Strict example

Strict requires configured JSON bridges for external providers; none is bundled. Initialize with the user's bridge configuration:

```sh
node <skill>/scripts/review-fix-loop.mjs init --cwd . --contract /path/task-contract.json --config /path/reviewer-bridges.json --base main --review-policy strict --reviewers claude,codex
```

Defaults are `--fix-mode balanced`, `--scope auto`, `--max-rounds 3`, `--review-policy balanced`, and `--min-severity low`. `--base` implies branch scope including local work. Balanced review uses two isolated discovery reviewers, one fresh review after repair, then a second independent terminal review. It can use the same available provider in separate isolated sessions. Strict requires two different providers and fails honestly when that evidence is unavailable. Each review slot or triage/repair assignment allows at most `--max-provider-attempts 3` attempts; uncertain executions are never replayed. `--max-rounds` permits 1–10 rounds, including failed repair and recovery rounds, but not transport retries of the same assignment. Supporting repairs consume ordinary rounds. There is no separate closure protocol.

Use `node scripts/loop-options.mjs` to normalize supplied controls; reviewer and exclusion controls come from the sibling comprehensive-review parser. `--wait` has been removed. An explicit higher `--min-severity` is a scope limit and can produce only `THRESHOLD_MET`, never `CONVERGED` or “clean”.

Required validation cannot be waived by triage or severity filtering. Missing prerequisites are blockers, not permission to install dependencies or retry unchanged failing checks. Reuse the existing toolchain and dependencies; isolated validation is an explicit option for projects that already support it.

## Authority boundary

An authorized review-and-fix request permits necessary repository-local edits, tests, formatting, required generated outputs, safe local validation, and bounded re-review. Routine implementation choices, necessary structural repairs, and another permitted round need no conversational confirmation.

Ask only for a material public-behavior choice that repository evidence cannot resolve, or new authority for secret access, paid external systems, unapproved dependency installation, destructive data operations, commits, pushes, releases, or deployments. Reuse authorization already present in the session. Bundle unresolved contract choices into one question, record the answer once, and continue independent safe work. Host tool approvals and sandbox restrictions still apply.

## Outcome

Report the controller outcome, repair mode, satisfied or unresolved requirements, fixed and outstanding findings, changed files, validation commands/results, whether the index needs re-staging, and any blocker or incomplete evidence. Distinguish mitigations and residual causes from resolved findings. Link the run directory. Keep exact inventories, snapshots, fingerprints, attempts, and transcripts in `run.json`, `events.jsonl`, and their referenced artifacts.

`CONVERGED` requires acceptance evidence for every criterion, successful required validation of the final files, no actionable finding, two complete terminal reports, and a matching final fingerprint. Other outcomes are `THRESHOLD_MET`, `ROUND_LIMIT`, `BLOCKED`, `VALIDATION_FAILED`, `REVIEW_INCOMPLETE`, and `SCOPE_CHANGED`. A test suite proves lifecycle properties, not the correctness of arbitrary model diagnoses or repairs.
