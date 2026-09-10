---
name: review-fix-loop
description: Run bounded cycles of independent comprehensive review, evidence-based triage, minimal or comprehensive fixes, tests, and fresh re-review over working-tree changes. Use when the user explicitly asks to review and fix iteratively until qualifying defects are cleared or a round limit is reached. Do not use for review-only requests or branch-only diffs.
---

# Review Fix Loop

Turn working-tree review findings into validated fixes through a bounded convergence loop. Invoking this skill authorizes edits inside the reviewed repository, but not commits, pushes, releases, deployments, or unrelated cleanup.

## Controls

Accept these loop controls:

- `--fix-mode <minimal|comprehensive>` selects repair depth. Default: `minimal`.
- `--min-severity <critical|high|medium|low>` sets the lowest severity eligible for fixes. Default: `medium`.
- `--max-rounds <1|2|3>` caps repair rounds started. Default: `3`. See the runtime for successful and aborted rounds.
- `--scope working-tree` is the only supported scope and is the default.
- `--wait` is a compatibility no-op.

Accept and forward every reviewer and exclusion control supported by the sibling [comprehensive-review skill](../comprehensive-review/SKILL.md), including `--reviewers`, `--all-reviewers`, provider model/effort/profile controls, `--cursor-speed`, and repeatable `--exclude-path` values.

Run `node scripts/loop-options.mjs` from this skill directory with the supplied controls, then use its JSON exactly. It rejects invalid loop values, branch scope, `--base`, and reviewer configurations rejected by comprehensive review.

Translate an explicit plain-language request for minimal patches or diagnosis and long-term fixes into the corresponding `--fix-mode` when no flag was supplied. Otherwise keep the default. Selecting comprehensive reviewers does not select comprehensive repairs. State the effective mode before starting.

## Fix Modes

- **Minimal:** apply the smallest coherent correction that resolves each verified defect, with focused validation. Necessary internal restructuring and caller changes are allowed. Avoid optional refactoring and broader prevention work; flag deeper deficiencies outside the correction. The fact that a fix is structural or spans files is not a reason to stop.
- **Comprehensive:** diagnose contributing design weaknesses and inspect related paths, then implement the smallest coherent repair that fully addresses the demonstrated cause. Correct deficient abstractions and affected callers now when the evidence warrants it. Read [references/comprehensive-fixes.md](references/comprehensive-fixes.md) for diagnosis and prevention requirements.

Severity controls eligibility and urgency, not repair shape. A critical defect can have a local fix; a medium defect can justify a shared-boundary correction. Comprehensive mode can also select a local fix when the evidence supports it.

## Scope Boundary

Operate only on working-tree changes. Before doing anything else, inspect Git status and preserve every pre-existing staged, unstaged, untracked, and submodule change. Preserve the index unless staging is separately authorized. Repairs and convergence concern final working files; report repaired paths that still need re-staging. Do not use destructive Git commands or revert unrelated work.

Branch scope is intentionally unsupported. After a repair, the existing branch reviewer cannot include both committed branch changes and uncommitted fixes in one verified scope. Stop with that explanation when the request supplies `--base`, `--scope branch`, or `--scope auto`; do not silently review only the repair delta. A clean tree with no working-tree changes is not a loop target.

Excluded paths are outside both review and repair scope. Never edit them as part of this workflow, including through validation output.

Repairs may touch previously unchanged files when needed for a verified finding's correction or validation, including shared implementations, callers, and tests. Record that causal connection and include all resulting changes in the next full working-tree review. This does not authorize a general repository redesign.

## Workflow

Read [references/loop-runtime.md](references/loop-runtime.md) before starting. It defines finding states, research and input requirements, round accounting, validation, and ordered stop decisions. For review execution, also read the comprehensive review's [parallel runtime](../comprehensive-review/references/parallel-review-runtime.md).

1. Normalize controls and capture the original repository status.
2. Run an independent comprehensive-review pass over the current working tree using the runtime's review rules.
3. Triage the report, reconcile the finding ledger, and resolve material questions. Apply the runtime's stop decisions before beginning any edits.
4. Repair verified eligible findings according to `fixMode` and validate them. Follow the runtime's abort rules if the round cannot complete.
5. After successful validation, obtain a fresh review of the entire updated working-tree scope, then return to triage. The final permitted repair round still gets this review. If the repair removed every included change, apply the runtime's verified-empty-scope exception instead.

## Outcome

Use the runtime's completion criteria and [handoff format](references/loop-runtime.md#handoff). Report one outcome: `converged`, `round limit reached`, `validation failed`, `review incomplete`, `scope changed`, or `blocked`. Review silence alone does not establish completion.
