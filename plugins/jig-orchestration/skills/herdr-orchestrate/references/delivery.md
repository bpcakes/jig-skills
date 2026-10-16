# Delivery and PR gates

Read before review, delegated merge, or acceptance. Each checkout has one source writer. Settle the prior writer and descendants at implementation/review/acceptance handoffs. Required review uses the installed matching `review-fix-loop` and `panel-review` pair; read that skill and its controller reference. Do not reimplement convergence in orchestration state.

## Final review

Retain the original task base for provenance. Separately record the integrated target OID used as the fixed base of each final review run. After a clean, settled implementation handoff, new final runs explicitly use `--commit-mode per-round` and `--base <integrated-target-OID>`. Verify the returned base; do not rely on branch auto-detection. Review the entire PR diff from that fixed base, including all task changes and conflict-resolution effects. Repairs append commits without narrowing the range or changing the run's base.

The driver publishes resulting commits; the controller does not push. At merge, require the controller's converged `commitRange.tip`, clean checkout HEAD, and live GitHub PR head to agree. Reports and required validation must bind to that range/fingerprint. Keep unrelated tracker edits outside the task checkout.

Preserve an adopted run's mode. In `none` mode, map certified full source/tree to the published commit and establish applicability of Git-aware validation; tree equality alone is insufficient. If the installed controller cannot establish that binding, settle normally and review/validate the published candidate in an explicit successor. Do not relabel old evidence or silently alter a saved run.

Follow the exact returned controller path/run ID and recorded successor links. A nearby newer `run.json`, successful sibling PR, or Herdr `done` badge is no substitute. Missing/mismatched evidence is unknown.

## Moving target and history

Fetch observations while workers run, but integrate source only at a safe writer boundary. Do not repeatedly merge the target into an active review to improve a status indicator. Independent worktrees can integrate/review concurrently; coordinate concrete target conflicts and required merge queues, not a new global integration queue.

If material target movement requires integration after review starts, settle the old run normally. A permitted successor reviews the complete current PR diff from the new integrated target, retaining original provenance, prior scopes/results, cumulative expenditure, and unresolved findings. An explicit immutable-base contract forbids this change until the user changes that contract.

The task driver reconciles cross-run findings by ID and artifact reference. Each carried actionable finding needs a demonstrated fix, sourced rejection, or unresolved blocker against the candidate. Absence from newer reports does not resolve it. Reconcile after new reports and before merge; do not seed independent reviewers with old verdicts or repair narratives. Acceptance decisions must have an actual source, not an invented product exception.

## Merge gate

The designated executor must inspect fresh evidence for all of these:

1. Current authority and no applicable pause, cancellation, or task hold. The PR is open in the intended repository against the intended target.
2. Exact candidate/head binding above, full controller convergence, required validation, and dispositions for carried findings. Missing, partial, timed-out, stale, or threshold-limited reviews are not clean reviews.
3. Required GitHub checks succeed for the candidate/integration context. Explain conditional skips against real CI policy; neither a check count nor similar local/CI names establishes coverage.
4. All actionable feedback from paginated review threads, review bodies, and issue comments has a demonstrated fix or sourced rejection, including outdated/resolved threads. UI resolution alone does not resolve a defect.
5. Current target integration satisfies repository policy. Reintegrate/revalidate when movement makes evidence inapplicable.

Persist a delegated action's executor, task/PR, expected head/target, authority revision, evidence references, and hold conditions through the helper. Recheck live gates immediately before the external operation. With the installed GitHub CLI, `gh pr merge <pr> --repo <owner/repo> --match-head-commit <head>` supplies a head guard; also choose the repository's authorized merge strategy/queue behavior. Never use admin bypass to escape a gate.

A head guard does not atomically pin the target. Use repository up-to-date checks or its required merge queue; where unavailable, disclose the remaining target-update race. Do not alter repository protections. A queued or auto-merge acknowledgement is not a completed merge: verify the final external result before advancing.

For uncertain delivery, inspect the actual PR and action record before retrying. Record the receipt once and notify dependent owners. Driver delegation changes the executor, not the gates; no second full coordinator review is needed. If the helper or current authority is unavailable, pause the irreversible transition while independent authorized checks continue.

An externally merged PR without required evidence remains an assurance gap. Review its relevant pinned source, deliver any required repair through a gated PR, and disclose the original gap; do not retroactively label it converged.

## Acceptance

One task can require several PRs. A small independently testable prerequisite may be extracted within scope while the parent work remains incomplete; review that change and its eventual integration independently. Maintain every outstanding criterion.

For deployed acceptance, verify actual deployed revision/configuration, the required signed-in journey, and cleanup under deployment authority. Identify concrete product prerequisites separately from harness setup. A whole epic is not a prerequisite when only one verified account or deployed fix is needed. Preserve the acceptance contract when choosing alternate setup.

Use [resource ownership](recovery.md#shared-staging) for staging grants/handoffs. At a handoff choose an eligible journey by configured priority; a blocked preferred journey does not reserve staging against ready work. Identify natural waits early and release exclusive resources only when the contract permits. Merged-but-unaccepted tasks retain ownership and unfinished-task accounting.
