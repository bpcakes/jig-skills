# Review-Fix Loop Runtime

Use after `loop-options.mjs` has returned the normalized loop and reviewer configuration. Keep that configuration stable across rounds unless the user changes it.

## Scope Resolution

Resolve the scope once before the first review, using comprehensive review's default-branch detection and ref validation. An explicit `--base` selects branch scope. Otherwise `auto` selects working-tree scope when local changes exist, or branch scope when the checkout is clean. A branch base must resolve to a commit; stop on an invalid or unavailable base. Never reconsider `auto` after repairs change the checkout.

For working-tree scope, use `--scope working-tree` for every fingerprint and reviewer. For branch scope, resolve and pin the base OID, then use `--scope branch --base <base-oid> --include-working-tree` for every fingerprint, adapter, and native reviewer assignment, including the initial pass. The first fingerprint pins `headOid`, `baseOid`, and `mergeBaseOid`; require these to stay unchanged throughout the loop. A moving base ref has no effect once its OID is pinned. A changed pinned commit is `scope changed`, even between passes. Branch mode includes pre-existing local changes and requires no clean checkout.

Use the selected scope's trusted exclusions: pinned `HEAD` policy for working-tree scope, pinned base policy for branch scope. Keep explicit exclusions unchanged across passes. Branch evidence includes the committed diff and the subsequent local deltas; the review target is their cumulative effect in final working files. Require each reviewer to verify that findings survive all supplied changes. The committed branch and preserved index may still contain superseded defects until the repairs are staged and committed separately.

## State and Finding Ledger

Track original Git status and index entries, round and review counts, edits, validation results, and each pass's reviewer, exclusion, evidence, and fingerprint status. Give findings stable IDs; group related findings by evidenced causal mechanism without losing their individual severity or source attribution. Revising a diagnosis or merging reports must not reset repair-attempt history.

Record verification independently of repair status:

| Field | Values and meaning |
|---|---|
| `verification` | `verified`: evidence establishes the original defect; `rejected`: evidence contradicts it or it is not an actionable defect; `unresolved`: a material factual or intent question prevents a verdict. |
| `repair` | `pending`: repair or validation remains; `fixed`: the selected mode's correction is complete and validated; `mitigated`: a temporary measure leaves required repair work; `blocked`: a concrete dependency prevents repair; `not-applicable`: rejected or below-threshold finding. |

Keep evidence, severity, attempted changes, and any dependency with these fields. For example, a proven bug requiring an unavailable compatibility decision is `verified` + `blocked`; uncertainty about whether the behavior is a bug is `unresolved` + `blocked`. Fixing a defect does not erase its original verification. Only new evidence can change that verdict.

Severity order is `critical > high > medium > low`; `minSeverity` is inclusive. Below-threshold findings are outside independent repair scope, not automatically rejected. Record material residual risk. A shared repair may also resolve a related lower-severity manifestation; record the relationship.

An outstanding finding is a verified eligible defect whose repair is not `fixed`, or an unresolved claim that could meet the threshold and needs a material answer. Reconcile every fresh report against the ledger: omission by later reviewers never marks an entry fixed or rejected. Reopen a supposedly fixed entry when current evidence shows it still fails.

Repairs and convergence concern the final working files. Preserve the index unless the user separately authorized staging. A fresh report may repeat a defect in the committed branch or preserved staged version: verify it against the working files, retain the original defect as `verified`, and keep `fixed` only if the working-file correction is validated. Track repairs absent from the index or `HEAD` separately as requiring staging or committing; never imply that either committed or staged code has been repaired.

## Triage and Research

Inspect cited code, contracts, relevant callers, and tests. Prefer a failing regression test or deterministic reproduction; accept static proof when the failing path is unambiguous and execution adds no useful evidence. Reject contradicted claims, intended behavior, style preferences, and unsupported hypothetical failures. Low probability alone does not invalidate a supported failure: assess likelihood and impact separately from confidence in the evidence.

Before each repair round, resolve questions that could change verification, diagnosis, repair, or validation. Start with repository evidence and focused experiments. For external APIs or unstable behavior, use primary documentation for the relevant version. Briefly retain answers and sources; reuse them until new evidence invalidates them. There is no requirement to browse when no external question remains.

Triage is read-only in the reviewed repository, including tests and their output. Run reproductions through read-only commands or in a temporary copy outside it, with caches and output redirected there. Do not add a regression test to the reviewed tree before verification and the stop decisions. Once a verified eligible repair can start, count the round before its first repository mutation, including adding a test. Reproduction work outside the repository does not consume a repair round.

When a material answer requires unavailable user intent, access, or authority, record the dependency and stop as `blocked`. Flag the precise question, evidence already gathered, and recommended choice. Do not guess a product or external compatibility contract. Routine implementation choices and necessary structural changes within the authorized scope do not require confirmation.

### Repair Recurrence

Apply this analysis when a later repair reintroduces a fixed defect or weakens or removes a mitigation's recorded, validated benefit in the working files. A mitigation's underlying defect remaining unresolved does not establish a regression. A validated repair or alternative protection may replace the temporary mechanism; removing that mechanism alone does not prove loss of protection.

Reopen a `fixed` finding as `pending`. A `mitigated` finding is already outstanding: change it to `pending` if all validated benefit is lost, or retain `mitigated` and record the reduced protection and residual risk if some benefit remains. Preserve the original verification, ID, repair-attempt history, and dependencies; apply existing blocking rules when needed. Record the repair that caused the regression and the supporting evidence, retaining uncertainty when attribution is not yet established. If fixing A introduces B and fixing B brings A back, retain both findings and their interaction. Merge causal groups only when evidence supports a shared mechanism, using the attempt accounting below.

Before another repair of the interacting findings, diagnose why the changes conflicted and explain how the proposed correction will satisfy the required behaviors together. Validate that correction, affected earlier fixes, and retained or replacement mitigation benefits against the same final working state. Update repair statuses from that evidence; restoring a temporary mitigation leaves its finding outstanding until the selected repair is complete.

Recurrence triggers diagnosis, not an automatic stop: a safe joint correction may proceed under the selected mode when the existing stop decisions permit it. Reopening or regrouping findings grants no extra rounds or within-round corrections. If no safe repair is available, report the concrete dependency or constraint under the existing stop rules.

## Review Passes

Follow comprehensive review and its parallel runtime, with these loop rules:

- use the pinned scope and normalized reviewer configuration and exclusions, including `--include-working-tree` for branch scope;
- create fresh, context-free reviewer children for every pass;
- provide only current code, scope, and the normal review assignment, never earlier findings, repairs, or desired outcomes;
- preserve source attribution and keep intermediate reports internal; and
- remain read-only while reviewers run.

Within a pass, pre- and post-review fingerprints must match. Between passes, changes must be attributable to recorded loop edits or validation output under the rules below. Before each round's first edit, confirm the repository still matches the reviewed state. Reconcile actual changes with the recorded operations before accepting a new baseline; a fresh capture alone does not explain a change. After edits, validation, and any permitted artifact cleanup, capture the next pass's baseline. Equal partial captures remain limited coverage and never establish a verified fingerprint; retain their issues as comprehensive review requires.

Preserve comprehensive review's timeouts, partial-provider handling, evidence limitations, and cleanup rules. Never repeat an unaccounted external invocation or lower the requested reviewer set to manufacture completion. A partial pass can supply verified repair candidates, but cannot prove convergence.

## Repair Rounds and Validation

The initial review consumes no repair round. Increment the round counter when beginning edits for at least one verified eligible finding, even if the round later aborts.

Count one repair attempt per causal group targeted by edits in that round, including a mitigation or the permitted focused correction. Record the distinct round numbers for each group; several edits targeting it in one round count once. Touching shared code or incidentally breaking another group does not itself count as an attempt on that other group. When evidence justifies merging groups, use the union of their targeted round numbers: a round targeting both counts once, and attempts in different rounds all remain counted. Retain this history across reports and diagnostic label changes.

Prioritize severity while respecting dependencies. Use the selected mode's repair policy, preserving supported public behavior except for the verified defect. Record each repair's rationale, affected paths, and validation. Comprehensive mode additionally records causal evidence and prevention as specified in [comprehensive-fixes.md](comprehensive-fixes.md).

Run the narrowest meaningful validation first, then broader relevant checks. Use existing repository tools. Tests must independently exercise the behavior: do not weaken assertions, bless incorrect outputs, or over-mock the changed boundary. Add or strengthen tests only when they materially prove the correction or invariant.

After later edits, rerun regression checks for earlier fixes and validated mitigation benefits whose behavior could be affected. If the evidence was static proof, recheck that proof against the current files. Reconcile failures with the original ledger entries even when the latest reviewers omit them, and apply the recurrence rules when a repair caused them.

Before running a check, identify its output paths and preserve their existing state. Prefer output outside the repository. Record necessary in-scope generated changes as part of the round and include retained changes in the next baseline and full review. Clean up only artifacts created by this run whose current contents are still attributable to it; do not delete pre-existing files or overwrite concurrent work. Unexplained changes still trigger `scope changed`. Validation must not write excluded paths: configure a safe output location or use a temporary copy. If a required check cannot run safely that way, stop as `validation failed` and name the unavailable check and constraint.

If validation exposes a defect introduced by the repair, first reconcile the affected finding and causal group's targeted-round history. Treat the current round as targeting that group if the proposed correction would edit it, then apply the immediate repeated-failure guard below. If the correction would target the group in a third distinct round, stop as `blocked` before editing. Otherwise allow one focused correction and rerun the relevant checks within the same round. If required validation still fails, cannot run, or the repair cannot be made safe, abort as `validation failed`. Record attempted changes and failing or unavailable checks; do not reset the round counter or keep patching to evade its bound.

A successful repair round ends with successful validation and a fresh full-scope review, including after the last allowed repair round, unless the verified scope became empty as defined below. An aborted round ends immediately under the stop rules below; it does not require another review. Distinguish the last reviewed state from any later unreviewed edits in the handoff.

### Repair Produces an Empty Scope

Comprehensive review does not launch reviewers for an empty diff. After a successful repair, use its scope-fingerprint helper with the same pinned scope, branch inclusion flag, and exclusions to capture and recheck the final state. Both captures must be complete, equal, and report `hasChanges: false`; a net diff against `HEAD` or the merge base alone is insufficient because committed, staged, and unstaged changes can cancel each other. In branch mode, any included committed diff keeps the scope nonempty even when local repairs reverse it completely; obtain the final review of both deltas. Require unchanged pinned commits and index, fully accounted-for edits, successful required validation, no outstanding ledger entry, and a preceding nonempty pass with all requested reviewers and complete evidence. Comprehensive repairs must also satisfy their causal-repair and prevention requirements.

When these conditions hold, report `converged` because the repair removed the entire included change. Record terminal review as skipped for verified empty scope and retain the actual completed-pass count; do not claim a fresh review ran. Immediate stop guards still take precedence. If evidence or reviewer coverage is missing, report `review incomplete`; if a ledger dependency remains, report `blocked`. This exception never starts a loop on an initially empty scope.

## Ordered Stop Decisions

Apply these immediate guards whenever the condition arises, before further edits or a new review:

1. Unexplained repository changes or mismatched fingerprints: `scope changed`. If capture cannot supply a baseline or recheck, stop as `review incomplete`; do not report an unobserved change as fact.
2. A repair or focused correction would target the same causal mechanism in a third distinct round: `blocked`. Reconcile recurrence and merged-group history before deciding; do not make the disallowed edit.
3. Failed or unavailable required validation after the bounded correction above: `validation failed`.
4. A material question needs unavailable user input, access, or authority: `blocked`.

Otherwise, after each review and evidence-based ledger reconciliation, evaluate these decisions in order. Do not start another repair until all preceding stop conditions have been checked.

1. **Converged:** no outstanding finding remains, all requested reviewers completed, evidence coverage is complete, and the fingerprint is verified unchanged for the current state. In comprehensive mode, `fixed` requires completion and validation of the selected causal repair and prevention; a mitigation remains outstanding.
2. **Repeated failure:** the same causal mechanism remains or recurs after two repair attempts: `blocked`. Describe the failed or undone approaches and name the two-attempt limit as the stopping constraint.
3. **Round cap:** `maxRounds` rounds have started and work remains: `round limit reached`, or `review incomplete` if the latest pass lacks requested reviewers or complete evidence.
4. **No repair candidate:** after available research, no outstanding finding has both a verified defect and a safe repair within scope: `blocked`, or `review incomplete` if incomplete review coverage prevents establishing completion. Identify the actual dependency or coverage gap.
5. **Continue:** at least one verified eligible finding has a safe repair, and rounds remain. Begin the next repair round.

The immediate guards take precedence over these post-review outcomes. Always disclose additional blockers or incomplete coverage even when another condition determines the outcome. A fresh successful review after the final allowed repair may converge; the round cap is not itself failure.

## Handoff

Lead with the outcome and remaining qualifying findings. Include:

- effective mode and scope, pinned branch base/HEAD/merge-base OIDs when applicable, repair rounds started (including aborted rounds), and review passes completed;
- a concise ledger showing verification separately from repair status, with supporting evidence and dependencies;
- files changed and reproducible validation commands and results;
- terminal reviewer, evidence, and fingerprint status, identifying any unreviewed edits or the verified-empty-scope exception;
- repaired paths whose index entries differ from their final working files, including staged additions or deletions; state that these paths need staging or re-staging and that convergence applies to working files;
- for branch scope, the exact counts and returned entries for `workingTreePathsDifferingFromIndex`, `workingTreePathsAbsentFromIndex`, and `dirtySubmodulePaths` from the final matching fingerprint, including pre-existing local changes. If a `Truncated` field is true, label the entries as capped; if `pathInventoryComplete` is false, label staging guidance incomplete and disclose the responsible truncation and fingerprint issues. Retain the separate repaired-path list, apply comprehensive review's re-stage/add/innermost-submodule-first guidance, and state that local changes remain outside the committed branch until separately recorded;
- material below-threshold findings; and
- in comprehensive mode, causal diagnosis, repair rationale, prevention evidence, and any temporary mitigation or required remaining work.

Leave changes in the working tree and preserve pre-existing work. Do not paste intermediate reviewer reports or claim that unvalidated attempts are fixes.
