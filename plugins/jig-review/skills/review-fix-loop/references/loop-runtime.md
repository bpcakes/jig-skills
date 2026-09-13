# Review-Fix Loop Runtime

Use after `loop-options.mjs` has returned the normalized loop and reviewer configuration. Keep that configuration stable across rounds unless the user changes it.

## Scope Resolution

Resolve the scope once before the first review, using comprehensive review's default-branch detection and ref validation. An explicit `--base` selects branch scope. Otherwise `auto` selects working-tree scope when local changes exist, or branch scope when the checkout is clean. A branch base must resolve to a commit; stop on an invalid or unavailable base. Never reconsider `auto` after repairs change the checkout.

For working-tree scope, use `--scope working-tree` for every fingerprint and reviewer. For branch scope, resolve and pin the base OID, then use `--scope branch --base <base-oid> --include-working-tree` for every fingerprint, adapter, and native reviewer assignment, including the initial pass. The first fingerprint pins `headOid`, `baseOid`, and `mergeBaseOid`; require these to stay unchanged throughout the loop. A moving base ref has no effect once its OID is pinned. A changed pinned commit is `scope changed`, even between passes. Branch mode includes pre-existing local changes and requires no clean checkout.

Use the selected scope's trusted exclusions: pinned `HEAD` policy for working-tree scope, pinned base policy for branch scope. Keep explicit exclusions unchanged across passes. Branch evidence includes the committed diff and the subsequent local deltas; the review target is their cumulative effect in final working files. Require each reviewer to verify that findings survive all supplied changes. The committed branch and preserved index may still contain superseded defects until the repairs are staged and committed separately.

## State and Finding Ledger

Track original Git status and index entries, ordinary round and comprehensive review counts, closure usage and verification counts, edits, validation results, and each pass's reviewer, exclusion, evidence, and fingerprint status. Keep the last comprehensive-review fingerprint separate from the terminal fingerprint and any closure verification fingerprint. Give findings stable IDs; group related findings by evidenced causal mechanism without losing their individual severity or source attribution. Revising a diagnosis or merging reports must not reset repair-attempt history.

Record verification independently of repair status:

| Field | Values and meaning |
|---|---|
| `verification` | `verified`: evidence establishes the original defect; `rejected`: evidence contradicts it or it is not an actionable defect; `unresolved`: a material factual or intent question prevents a verdict. |
| `repair` | `pending`: repair or validation remains; `fixed`: the selected mode's correction is complete and validated; `mitigated`: a temporary measure leaves required repair work; `blocked`: a concrete dependency prevents repair; `not-applicable`: rejected or below-threshold finding. |

Keep evidence, severity, attempted changes, and any dependency with these fields. For example, a proven bug requiring an unavailable compatibility decision is `verified` + `blocked`; uncertainty about whether the behavior is a bug is `unresolved` + `blocked`. Fixing a defect does not erase its original verification. Only new evidence can change that verdict.

Severity order is `critical > high > medium > low`; `minSeverity` is inclusive. Below-threshold findings are outside independent repair scope, not automatically rejected. Record material residual risk. A shared repair may also resolve a related lower-severity manifestation; record the relationship.

An outstanding finding is a verified eligible defect whose repair is not `fixed`, or an unresolved claim that could meet the threshold and needs a material answer. Reconcile every fresh report against the ledger: omission by later reviewers never marks an entry fixed or rejected. Reopen a supposedly fixed entry when current evidence shows it still fails.

### Substantive Defects and Supporting Obligations

Record a finding's kind independently of severity and verification:

- **Substantive defect:** behavior, an executable instruction, or a public contract needs correction, or the evidence for its correctness has been invalidated. These use ordinary repair rounds and substantive attempt history.
- **Supporting obligation:** a concrete documentation or validation gap can be closed against an established contract without changing substantive behavior. Record its requirement, missing evidence, affected paths, and link to the original finding when applicable. A standalone gap may have its own ID. It remains outstanding when eligible, but supporting edits do not consume a substantive attempt on the linked mechanism.
- **Optional suggestion:** no demonstrated defect or material supporting requirement. Record as non-actionable, without treating it as an unresolved blocker.

Classify by effects, not file extension, diff size, or the reviewer's label. Skill instructions, public types, generated schemas, dependency locks, and build configuration may change substantive behavior. A snapshot update needs independently established expected output; a test-helper change must preserve the strength and reach of existing checks. Uncertainty about whether a correction is supporting must be resolved before using closure.

For an actionable test gap, identify the behavior not proved, a plausible regression the existing tests would miss, and why equivalent coverage is absent. A request for a particular test name or arrangement is insufficient. Additional evidence for an already validated repair does not reopen the substantive finding; reopen it if the new test fails against the contract or the old proof is invalidated. If a test was the only claimed evidence and proves vacuous, correctness must be re-established before closure. Preserve the link and all substantive history when reclassifying.

Severity eligibility remains unchanged for standalone supporting findings: a lone low finding cannot block a medium-threshold loop. Supporting checks necessary to validate an eligible repair are part of that repair regardless of a reviewer's separate severity label. Comprehensive prevention remains proportional to the demonstrated mechanism; optional frameworks, documentation, or additional test permutations are not new completion requirements.

Repairs and convergence concern the final working files. Preserve the index unless the user separately authorized staging. A fresh report may repeat a defect in the committed branch or preserved staged version: verify it against the working files, retain the original defect as `verified`, and keep `fixed` only if the working-file correction is validated. Track repairs absent from the index or `HEAD` separately as requiring staging or committing; never imply that either committed or staged code has been repaired.

## Triage and Research

Inspect cited code, contracts, relevant callers, and tests. Prefer a failing regression test or deterministic reproduction; accept static proof when the failing path is unambiguous and execution adds no useful evidence. Reject contradicted claims, intended behavior, style preferences, and unsupported hypothetical failures. Low probability alone does not invalidate a supported failure: assess likelihood and impact separately from confidence in the evidence.

Before each repair round, resolve questions that could change verification, diagnosis, repair, or validation. Start with repository evidence and focused experiments. For external APIs or unstable behavior, use primary documentation for the relevant version. Briefly retain answers and sources; reuse them until new evidence invalidates them. There is no requirement to browse when no external question remains.

Triage is read-only in the reviewed repository, including tests and their output. Run reproductions through read-only commands or in a temporary copy outside it, with caches and output redirected there. Do not add a regression test to the reviewed tree before verification and the stop decisions. Count an ordinary round before its first repository mutation, including a test intended to prove a substantive correction. For the separate closure batch, record closure usage before its first mutation instead. Reproduction work outside the repository does not consume either allowance.

When a material answer requires unavailable user intent, access, or authority, mark the dependent finding `blocked` and make no dependent edit. Safe independent findings may still be repaired within budget; no overall convergence is possible while the dependency remains. Flag the precise question, evidence already gathered, and recommended choice. Do not guess a product or external compatibility contract. Routine implementation choices and necessary structural changes within the authorized scope do not require confirmation.

### Repair Recurrence

Apply this analysis when a later repair reintroduces a fixed defect or weakens or removes a mitigation's recorded, validated benefit in the working files. A mitigation's underlying defect remaining unresolved does not establish a regression. A validated repair or alternative protection may replace the temporary mechanism; removing that mechanism alone does not prove loss of protection.

Reopen a `fixed` finding as `pending`. A `mitigated` finding is already outstanding: change it to `pending` if all validated benefit is lost, or retain `mitigated` and record the reduced protection and residual risk if some benefit remains. Preserve the original verification, ID, repair-attempt history, and dependencies; apply existing blocking rules when needed. Record the repair that caused the regression and the supporting evidence, retaining uncertainty when attribution is not yet established. If fixing A introduces B and fixing B brings A back, retain both findings and their interaction. Merge causal groups only when evidence supports a shared mechanism, using the attempt accounting below.

Before another repair of the interacting findings, diagnose why the changes conflicted and explain how the proposed correction will satisfy the required behaviors together. Validate that correction, affected earlier fixes, and retained or replacement mitigation benefits against the same final working state. Update repair statuses from that evidence; restoring a temporary mitigation leaves its finding outstanding until the selected repair is complete.

Recurrence triggers diagnosis, not an automatic stop: a safe joint correction may proceed under the selected mode when the existing stop decisions permit it. Reopening or regrouping findings grants no extra rounds or within-round corrections. If no safe repair is available, report the concrete dependency or constraint under the existing stop rules.

## Review Passes

Follow comprehensive review and its parallel runtime, with these loop rules:

- use the pinned scope and normalized reviewer configuration and exclusions, including `--include-working-tree` for branch scope;
- create fresh, context-free reviewer children for every pass;
- provide current code, scope, and the normal discovery assignment for ordinary reviews; closure alone substitutes its neutral requirements and cumulative patch under [closure.md](closure.md), never prior reports, repair narratives, or desired outcomes;
- preserve source attribution and keep intermediate reports internal; and
- remain read-only while reviewers run.

Within a pass, pre- and post-review fingerprints must match. Between passes, changes must be attributable to recorded loop edits or validation output under the rules below. Before each round's first edit, confirm the repository still matches the reviewed state. Reconcile actual changes with the recorded operations before accepting a new baseline; a fresh capture alone does not explain a change. After edits, validation, and any permitted artifact cleanup, capture the next pass's baseline. Equal partial captures remain limited coverage and never establish a verified fingerprint; retain their issues as comprehensive review requires.

Preserve comprehensive review's timeouts, partial-provider handling, evidence limitations, and cleanup rules. Never repeat an unaccounted external invocation or lower the requested reviewer set to manufacture completion. A partial pass can supply verified repair candidates, but cannot prove convergence.

## Repair Rounds and Validation

The initial review consumes no repair round. Increment the round counter when beginning edits for at least one verified eligible finding, even if the round later aborts.

Count one substantive repair attempt per causal group targeted for behavioral or contract correction in that round, including a mitigation or the permitted behavioral correction. Record the distinct round numbers for each group; several edits targeting it in one round count once. Supporting-only edits and mechanical stabilization do not add substantive attempts. Touching shared code or incidentally breaking another group does not itself count as an attempt on that other group. When evidence justifies merging groups, use the union of their substantive targeted-round numbers: a round targeting both counts once, and attempts in different rounds all remain counted. Retain this history across reports and diagnostic label changes.

### Reassessment After Two Attempts

Before targeting a mechanism in a third or later distinct ordinary round, including through a within-round behavioral correction, reassess its complete history. Record the prior failing scenarios and approaches, concrete new evidence explaining why they failed or conflicted, and a correction and validation that address the surviving failure while preserving earlier fixes. New evidence can be a newly isolated supported entry point, an invalidated premise, or a demonstrated interaction between required invariants. A new name, regrouping, smaller patch, optimistic claim, or repetition of the same failed approach is not new evidence.

Assess whether the next attempt has a safe, materially revised repair independently of the remaining ordinary budget. If the causal evidence or safe repair is missing, mark that group `blocked`; continue only with independently safe candidates. Budget exhaustion alone never blocks a group: retain its repair eligibility and apply the round-cap decision before starting a new ordinary round. A permitted correction within an already counted round uses that round's existing allowance. Reassess again before each later distinct attempt, using evidence not already exhausted by the latest failed approach. Merged histories trigger reassessment, not an automatic veto. Reassessment grants no extra rounds or behavioral corrections and does not reset history. Retain history and closure usage in any handoff; resuming work never silently resets either allowance.

Prioritize severity while respecting dependencies. Batch compatible verified repairs and known supporting obligations rather than spending one round per finding. Use the selected mode's repair policy, preserving supported public behavior except for the verified defect. Record each repair's rationale, affected paths, and validation. Comprehensive mode additionally records causal evidence and prevention as specified in [comprehensive-fixes.md](comprehensive-fixes.md).

Run the narrowest meaningful validation first, then broader relevant checks. Use existing repository tools. Tests must independently exercise the behavior: do not weaken assertions, bless incorrect outputs, or over-mock the changed boundary. Add or strengthen tests only when they materially prove the correction or invariant.

After later edits, rerun regression checks for earlier fixes and validated mitigation benefits whose behavior could be affected. If the evidence was static proof, recheck that proof against the current files. Reconcile failures with the original ledger entries even when the latest reviewers omit them, and apply the recurrence rules when a repair caused them.

Before running a check, identify its output paths and preserve their existing state. Prefer output outside the repository. Record necessary in-scope generated changes as part of the round and include retained changes in the next baseline and full review. Clean up only artifacts created by this run whose current contents are still attributable to it; do not delete pre-existing files or overwrite concurrent work. Unexplained changes still trigger `scope changed`. Validation must not write excluded paths: configure a safe output location or use a temporary copy. If a required check cannot run safely that way, stop as `validation failed` and name the unavailable check and constraint.

Within each ordinary round, allow at most two mechanical correction passes for repair-caused build, formatting, or test-wiring mistakes. Batch available diagnostics per pass. They must preserve established semantics, assertion strength, and test discovery; changing expected behavior, suppressing checks, removing side-effectful imports, or redesigning a harness is not mechanical. These passes do not consume the one behavioral correction below, and neither allowance resets after another check or correction. Remaining mechanical failure after both passes is `validation failed`.

If validation exposes a substantive defect introduced by the repair, first reconcile the affected finding and history. Apply the reassessment rule before targeting a group in a third distinct round. If reassessment cannot establish a safe correction, abort as `blocked`, retaining unvalidated edits in the handoff; this is not permission to proceed past failed required validation. Otherwise allow one focused behavioral correction and rerun relevant checks within the same round. A subsequent substantive failure, exhausted mechanical allowance, unavailable required validation, or unsafe repair aborts as `validation failed`. Record attempted changes and failing checks; do not reset counters or keep patching to evade the bounds.

For evidence of a transient infrastructure failure (for example, an unavailable runner before tests execute), allow one accounted rerun per required command in the round or closure batch. Preserve the initial failure and its cause. A flaky assertion is not infrastructure evidence; do not retry until green, skip a required check, or claim unavailable validation passed. A rerun consumes no repair attempt and never starts a duplicate unaccounted process. Closure has its own stricter mutation allowance in [closure.md](closure.md).

A successful repair round ends with successful validation and a fresh full-scope review, including after the last allowed repair round, unless the verified scope became empty as defined below. An aborted round ends immediately under the stop rules below; it does not require another review. Distinguish the last reviewed state from any later unreviewed edits in the handoff.

After a complete review leaves only verified, safely repairable supporting obligations, use the one [closure batch](closure.md) before testing the ordinary round cap. This also applies when no ordinary round has been needed. A partial review cannot authorize the focused-review exception; with ordinary rounds available, supporting candidates may instead be repaired in an ordinary round followed by a full review. Such a round counts against `maxRounds` but adds no substantive attempts. After closure has been consumed, genuinely new supporting obligations caused by a later ordinary substantive repair may likewise use remaining ordinary rounds and full reviews. Record the creating repair and distinct requirement; retain the original closure IDs and usage. This exception cannot retry unresolved closure obligations, rename them, or fund supporting churn unrelated to that later substantive repair.

### Repair Produces an Empty Scope

Comprehensive review does not launch reviewers for an empty diff. After a successful repair, use its scope-fingerprint helper with the same pinned scope, branch inclusion flag, and exclusions to capture and recheck the final state. Both captures must be complete, equal, and report `hasChanges: false`; a net diff against `HEAD` or the merge base alone is insufficient because committed, staged, and unstaged changes can cancel each other. In branch mode, any included committed diff keeps the scope nonempty even when local repairs reverse it completely; obtain the final review of both deltas. Require unchanged pinned commits and index, fully accounted-for edits, successful required validation, no outstanding ledger entry, and a preceding nonempty pass with all requested reviewers and complete evidence. Comprehensive repairs must also satisfy their causal-repair and prevention requirements.

When these conditions hold, report `converged` because the repair removed the entire included change. Record terminal review as skipped for verified empty scope and retain the actual completed-pass count; do not claim a fresh review ran. Immediate stop guards still take precedence. If evidence or reviewer coverage is missing, report `review incomplete`; if a ledger dependency remains, report `blocked`. This exception never starts a loop on an initially empty scope.

## Ordered Stop Decisions

Apply these immediate guards whenever the condition arises, before further edits or a new review:

1. Unexplained repository changes or mismatched fingerprints: `scope changed`. If capture cannot supply a baseline or recheck, stop as `review incomplete`; do not report an unobserved change as fact.
2. Failed or unavailable required validation after the applicable bounded corrections: `validation failed`. A newly established substantive defect exposed during closure instead follows that protocol's explicit transition to ordinary triage or its cap outcome; unrelated failed checks do not get that exception. An unsafe behavioral correction rejected by reassessment aborts as `blocked` before editing.
3. A material question needs unavailable user input, access, or authority: block dependent edits. Stop the whole loop as `blocked` if no independent safe candidate remains or the question prevents any safe validation.

Otherwise, after each review and evidence-based ledger reconciliation, evaluate these decisions in order. Do not start another repair until all preceding stop conditions have been checked.

1. **Converged:** no substantive finding or eligible supporting obligation remains outstanding, all requested reviewers completed, evidence coverage is complete, and the fingerprint is verified unchanged for the current state. The closure protocol explicitly permits a complete comprehensive review followed by complete focused verification of every subsequent change. In comprehensive mode, `fixed` requires the selected causal repair and proportional prevention; a mitigation remains outstanding.
2. **Classify and reassess:** reconcile supporting obligations separately and apply the two-attempt reassessment to proposed further substantive attempts. Preserve blocked groups while identifying independent safe candidates; a blocked group alone does not halt those repairs.
3. **Closure:** only verified, safe supporting obligations remain and the preceding comprehensive review is complete: run the unused closure batch, even at the ordinary cap. If closure has been consumed, retain its limits for the original obligations and follow its protocol for any remaining correction. If that work remains unresolved after its allowance is exhausted, report `closure incomplete`. Genuinely new supporting obligations caused by a later ordinary substantive repair may instead proceed to the ordinary candidate and round-cap decisions below; this grants no new closure allowance or retry of old obligations.
4. **No repair candidate:** no outstanding finding has a verified defect and a safe, in-scope repair supported by research and reassessment, assessed independently of the round budget: `blocked`, or `review incomplete` if incomplete coverage prevents establishing completion. Identify the dependency, failed approach, or coverage gap.
5. **Round cap:** `maxRounds` ordinary rounds have started and an otherwise safe ordinary repair remains: `round limit reached`, or `review incomplete` if the latest pass lacks requested reviewers or complete evidence. Closure cannot hide or fix a substantive defect at the cap.
6. **Continue:** safe candidates exist and ordinary rounds remain. Begin the next ordinary round. All outstanding entries, including blocked groups, remain in the final outcome.

The immediate guards take precedence over these post-review outcomes. Always disclose additional blockers or incomplete coverage even when another condition determines the outcome. A fresh successful review after the final allowed repair may converge; the round cap is not itself failure.

## Handoff

Lead with the outcome and remaining qualifying findings. Include:

- effective mode and scope, pinned branch base/HEAD/merge-base OIDs when applicable, ordinary repair rounds started (including aborted rounds), comprehensive reviews completed, closure usage/correction status, and focused verification passes completed;
- a concise ledger showing kind, verification, repair status, linked supporting obligations, substantive attempt histories, reassessment evidence, and dependencies;
- files changed and reproducible validation commands and results;
- terminal reviewer and evidence status, last comprehensive-review fingerprint, terminal fingerprint, and any closure verification fingerprint, identifying unreviewed edits or the verified-empty-scope exception; never describe focused closure verification as another comprehensive review;
- repaired paths whose index entries differ from their final working files, including staged additions or deletions; state that these paths need staging or re-staging and that convergence applies to working files;
- for branch scope, the exact counts and returned entries for `workingTreePathsDifferingFromIndex`, `workingTreePathsAbsentFromIndex`, and `dirtySubmodulePaths` from the final matching fingerprint, including pre-existing local changes. If a `Truncated` field is true, label the entries as capped; if `pathInventoryComplete` is false, label staging guidance incomplete and disclose the responsible truncation and fingerprint issues. Retain the separate repaired-path list, apply comprehensive review's re-stage/add/innermost-submodule-first guidance, and state that local changes remain outside the committed branch until separately recorded;
- material below-threshold findings; and
- in comprehensive mode, causal diagnosis, repair rationale, prevention evidence, and any temporary mitigation or required remaining work.

Leave changes in the working tree and preserve pre-existing work. Do not paste intermediate reviewer reports or claim that unvalidated attempts are fixes.
