---
name: review-fix-loop
description: Run bounded review/fix/test cycles when the user explicitly requests iterative review and repair; not a one-pass review or fix.
---

# Review Fix Loop

Turn review findings into validated working-file fixes through a bounded convergence loop. Execute the loop only when the user explicitly invokes this skill or asks for iterative review and repair (for example, "review and fix until qualifying defects are cleared"). Automatic discovery, previously loaded instructions, a code change, or a one-pass "review and fix" request does not authorize the loop or repeated external reviews. For those tasks, follow the requested review or repair scope without starting this workflow.

An authorized loop permits edits inside the reviewed repository, but not commits, pushes, releases, deployments, or unrelated cleanup.

## Controls

Accept these loop controls:

- `--fix-mode <minimal|comprehensive>` selects repair depth. Default: `minimal`.
- `--min-severity <critical|high|medium|low>` sets the lowest severity eligible for fixes. Default: `medium`.
- `--max-rounds <1|2|3>` caps repair rounds started. Default: `3`. See the runtime for successful and aborted rounds.
- `--scope <working-tree|branch|auto>` selects the review scope. Default: `working-tree`. Resolve `auto` once before the initial review.
- `--base <ref>` selects branch scope against that base. It cannot be combined with `--scope working-tree`. Without a base, branch scope uses the detected default branch.
- `--wait` is a compatibility no-op.

Do not pass comprehensive review's `--include-working-tree` flag to this loop. Branch scope already enables that inclusion mode on every pass; select it with `--base` or `--scope branch` alone. The option parser reports this distinction explicitly.

Accept and forward every reviewer and exclusion control supported by the sibling [comprehensive-review skill](../comprehensive-review/SKILL.md), including `--reviewers`, `--all-reviewers`, provider model/effort/profile controls, `--cursor-speed`, and repeatable `--exclude-path` values.

Run `node scripts/loop-options.mjs` from this skill directory with the supplied controls, then use its JSON for scope resolution and reviewer configuration. It rejects invalid loop values, conflicting scope controls, and reviewer configurations rejected by comprehensive review.

Translate an explicit plain-language request for minimal patches or diagnosis and long-term fixes into the corresponding `--fix-mode` when no flag was supplied. Otherwise keep the default. Selecting comprehensive reviewers does not select comprehensive repairs. State the effective mode before starting.

## Fix Modes

- **Minimal:** apply the smallest coherent correction that resolves each verified defect, with focused validation. Necessary internal restructuring and caller changes are allowed. Avoid optional refactoring and broader prevention work; flag deeper deficiencies outside the correction. The fact that a fix is structural or spans files is not a reason to stop.
- **Comprehensive:** diagnose contributing design weaknesses and inspect related paths, then implement the smallest coherent repair that fully addresses the demonstrated cause. Correct deficient abstractions and affected callers now when the evidence warrants it. Read [references/comprehensive-fixes.md](references/comprehensive-fixes.md) for diagnosis and prevention requirements.

Severity controls eligibility and urgency, not repair shape. A critical defect can have a local fix; a medium defect can justify a shared-boundary correction. Comprehensive mode can also select a local fix when the evidence supports it.

## Scope Boundary

Before doing anything else, inspect Git status and preserve every pre-existing staged, unstaged, untracked, and submodule change. Preserve the index unless staging is separately authorized. Repairs and convergence concern final working files; report repaired paths that still need staging or re-staging. For branch scope, also report the exact counts and returned entries for `workingTreePathsDifferingFromIndex`, `workingTreePathsAbsentFromIndex`, and `dirtySubmodulePaths` from the final matching fingerprint, including pre-existing local changes, with comprehensive review's re-stage, add, and innermost-submodule-first guidance. If a `Truncated` field is true, label the entries as capped; if `pathInventoryComplete` is false, label the staging list incomplete and disclose the responsible truncation and fingerprint issues. Do not use destructive Git commands or revert unrelated work.

Working-tree scope reviews local changes. Branch scope reviews the committed diff from the pinned merge base to the pinned `HEAD`, together with all staged, unstaged, untracked, and initialized submodule changes, including those present before the loop starts. It supports clean and dirty checkouts. Every branch pass uses comprehensive review's `--include-working-tree` mode with the same pinned base; never switch to reviewing only the repair delta. A scope with no included changes is not a loop target.

Excluded paths are outside both review and repair scope. Never edit them as part of this workflow, including through validation output.

Repairs may touch previously unchanged files when needed for a verified finding's correction or validation, including shared implementations, callers, and tests. Record that causal connection and include all resulting changes in the next full-scope review. This does not authorize a general repository redesign.

## Workflow

Read [references/loop-runtime.md](references/loop-runtime.md) before starting. It defines finding states, research and input requirements, round accounting, validation, and ordered stop decisions. For review execution, also read the comprehensive review's [parallel runtime](../comprehensive-review/references/parallel-review-runtime.md).

1. Normalize controls, capture the original repository status, and resolve and pin the scope as specified in the runtime.
2. Run an independent comprehensive-review pass over the selected scope using the runtime's review rules.
3. Triage the report, reconcile the finding ledger including repair recurrences, and resolve material questions. Apply the runtime's stop decisions before beginning any edits.
4. Repair verified eligible findings according to `fixMode` and validate them. Follow the runtime's abort rules if the round cannot complete.
5. After successful validation, obtain a fresh review of the entire selected scope including all repairs, then return to triage. The final permitted repair round still gets this review. If the repair removed every included change, apply the runtime's verified-empty-scope exception instead.

## Outcome

Use the runtime's completion criteria and [handoff format](references/loop-runtime.md#handoff). Report one outcome: `converged`, `round limit reached`, `validation failed`, `review incomplete`, `scope changed`, or `blocked`. Review silence alone does not establish completion.
