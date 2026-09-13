# Review Fix Loop

[Back to the skill catalog](../README.md#jig-review)

`jig-review:review-fix-loop` runs independent comprehensive reviews, validates actionable findings, applies minimal or comprehensive fixes, runs tests, and starts fresh reviews until the selected working-tree or branch changes converge or a bounded repair limit is reached.

Unlike `comprehensive-review`, this skill changes files. It never commits, pushes, releases, or deploys unless those actions are requested separately.

## Usage

Run the skill from a repository with working-tree changes:

```text
$jig-review:review-fix-loop
```

To review and fix a branch against `main`, including any existing local changes:

```text
$jig-review:review-fix-loop --base main
```

The defaults use Claude and Codex, apply minimal fixes to verified findings of medium severity or higher, and allow at most four ordinary repair rounds plus one bounded batch for remaining supporting work. Select all providers and Cursor fast mode with:

```text
$jig-review:review-fix-loop --all-reviewers --cursor-effort xhigh --cursor-speed fast --exclude-path .agents/
```

Available loop controls:

| Control | Default | Meaning |
|---|---|---|
| `--fix-mode minimal\|comprehensive` | `minimal` | Selects minimal corrections or diagnosis and durable causal repairs. |
| `--min-severity critical\|high\|medium\|low` | `medium` | Lowest finding severity eligible for repair. |
| `--max-rounds 1\|2\|3\|4\|5` | `4` | Maximum ordinary repair rounds started, including aborted rounds. Supporting closure has a separate bounded allowance. |
| `--scope working-tree\|branch\|auto` | `working-tree` | Selects local changes, branch plus local changes, or automatic selection once at startup. |
| `--base <ref>` | detected for branch scope | Selects branch scope against a base; conflicts with explicit working-tree scope. |

Do not add comprehensive review's `--include-working-tree` flag. Branch loops already enable that mode on every pass; use `--base` or `--scope branch` alone. The loop reports a targeted error if the redundant flag is supplied.

All reviewer, model, effort, profile, speed, and exclusion controls from [comprehensive review](comprehensive-review.md) are supported. `--wait` remains a compatibility no-op. A following `--flag` is never accepted as a missing value. To exclude a literal path beginning with `--`, use a repository-root prefix, for example `--exclude-path /--fix-mode`.

## Fix Modes

Choose repair depth independently of reviewer selection and severity:

```text
$jig-review:review-fix-loop --fix-mode minimal
$jig-review:review-fix-loop --fix-mode comprehensive
```

| Mode | Repair policy |
|---|---|
| `minimal` | The smallest coherent correction and focused validation, including necessary internal restructuring or caller changes. Flag deeper deficiencies outside that correction. |
| `comprehensive` | Investigate contributing design weaknesses and related paths, implement the smallest coherent repair that fully addresses the demonstrated cause, and validate prevention. A local fix remains appropriate when the evidence supports it. |

An explicit plain-language request for minimal patches or root-cause diagnosis and long-term fixes selects the corresponding mode when no flag is supplied. Choosing comprehensive reviewers alone does not change the repair mode. The loop announces its effective mode.

Before each repair round, resolve open questions that could change the diagnosis, repair, or validation. Use repository evidence first and primary sources for external behavior; reuse valid research from earlier rounds. Stop and flag questions that require unavailable product intent, compatibility requirements, access, or authority. Routine implementation choices and necessary structural changes within scope do not require another confirmation.

Comprehensive mode follows [the diagnosis and repair guidance](../plugins/jig-review/skills/review-fix-loop/references/comprehensive-fixes.md). It distinguishes the triggering omission from a weakness that makes similar mistakes likely, compares local and shared-boundary repairs where relevant, and implements the selected durable repair. Relevant callers and tests may require edits outside the original diff; every added path must support a verified finding's repair, respect exclusions, and appear in the next review. Unrelated redesign remains outside scope.

A small, non-exhaustive taxonomy helps describe causes: local omission, shared implementation defect, structural deficiency, or undetermined. These labels guide investigation, not automatic action. Severity sets eligibility and urgency; it does not measure architectural depth or authorize larger changes. For example, a critical comparison typo may need one line, while a medium finding may reveal duplicated validation that belongs in a shared boundary.

This separation follows Google's distinction between incident triggers and systemic causes in its [postmortem analysis](https://sre.google/workbook/postmortem-analysis/). The repair policy uses conceptual cohesion rather than line count, consistent with its [small-change guidance](https://google.github.io/eng-practices/review/developer/small-cls.html). The two modes and diagnostic labels are this skill's design choices.

## Round Semantics

The initial review is not counted as a repair round. An ordinary round is consumed when edits begin, including a test for a substantive correction. Batch compatible repairs and their known supporting obligations in the same round. Successful ordinary rounds normally finish with validation and a fresh comprehensive review of the entire selected scope, including the last allowed round. Aborted rounds still count, but stop without requiring another review. Four successful ordinary rounds normally perform five comprehensive passes; closure verification is counted separately.

Each ordinary round counts once toward every causal group it targets for substantive repair or mitigation. Supporting-only edits do not add attempts to a linked behavioral defect. Incidentally breaking another group does not count as an attempt to repair it. Merging groups combines their substantive targeted-round histories, counting a shared round once.

Before a third or later substantive attempt, the loop must reassess the earlier approaches, identify concrete new evidence explaining their failure or interaction, and describe a materially revised repair and validation. A newly isolated supported path or demonstrated conflicting invariant can justify another attempt within the remaining ordinary budget; optimistic wording or renaming cannot. Reassess again before each later distinct attempt. A group without a safe revised approach remains blocked, while independent safe findings may still be repaired. This also applies to behavioral corrections during validation, and never grants extra rounds or resets history.

Budget exhaustion alone does not make a repair blocked. Reassessment determines whether new evidence supports a safe repair; the ordinary round cap separately determines whether it can proceed.

## Supporting Closure

The ledger separates substantive defects, supporting documentation/validation obligations, and optional suggestions. A missing regression for behavior already established as correct is supporting work; a test exposing incorrect behavior is substantive. Equivalent existing coverage can discharge a test request without another test. Severity remains separate: a lone low-severity finding does not block a medium-threshold loop, while checks necessary to prove an eligible repair remain required.

After a complete comprehensive review leaves only verified, safely repairable supporting obligations, the loop uses one closure batch, even at the ordinary round cap. It can correct stale explanations, add discriminating regressions, strengthen assertions, or finish required generated documentation or changelog entries against established contracts. Classify actual effects rather than extensions: executable skill Markdown, public types, schema changes, unverified snapshots, and weakened test helpers cannot automatically use closure.

Closure permits one edit batch and one further supporting correction batch shared across validation and focused review. There are at most two focused verification passes, using the same selected reviewers and current full-scope evidence and fingerprints. They verify the complete cumulative closure patch, each requirement, and collateral effects. Optional new suggestions do not restart discovery; unmet material obligations remain outstanding. Closure does not use or reset ordinary substantive attempt counters. User limits on total edits, reviews, or time still apply.

If closure reveals a substantive defect, it stops supporting edits and returns to ordinary triage with a fresh full review when ordinary rounds remain. At the cap it reports the real defect and `round limit reached`; it cannot change production behavior under a supporting label. New supporting obligations caused by a later ordinary substantive repair can use remaining ordinary rounds with full reviews, without adding substantive attempts or replenishing closure. Record their origin and retain the old obligation IDs; this cannot retry exhausted closure work. Such new work at the ordinary cap yields `round limit reached`. Exhausted closure work is `closure incomplete`; failed required validation is `validation failed`; incomplete reviewer evidence is `review incomplete`. See the [closure protocol](../plugins/jig-review/skills/review-fix-loop/references/closure.md) for capture, adapter commands, evidence, and exact stop rules.

If a validated repair removes every included change, there is no diff left to review. The loop may converge with the final review explicitly skipped only after complete, matching captures establish an empty scope, the preceding review had full coverage, all edits are accounted for, and no finding remains outstanding. A net diff against `HEAD` or the merge base is insufficient: committed, staged, and unstaged changes can cancel each other. The runtime defines the full [empty-scope conditions](../plugins/jig-review/skills/review-fix-loop/references/loop-runtime.md#repair-produces-an-empty-scope).

Ordinary reviewers receive fresh contexts and never see earlier findings or desired outcomes. Closure reviewers receive neutral requirements and the cumulative supporting patch, with no previous reports or repair narratives. Within every pass, full-scope fingerprints must remain unchanged. Changes between passes are accepted only when attributable to recorded loop edits.

Convergence requires no eligible substantive defect, supporting obligation, or material question outstanding, successful required validation, complete reviewer evidence, and a verified final fingerprint. Besides the verified-empty-scope exception, a complete comprehensive baseline followed by complete focused verification of every closure change can establish convergence. The final report distinguishes those passes and fingerprints instead of claiming a comprehensive review of the final files. Unresolved findings stay in the ledger even when later reviewers omit them; a comprehensive-mode mitigation remains outstanding until the selected repair and proportional prevention are complete. See the runtime's [ordered stop decisions](../plugins/jig-review/skills/review-fix-loop/references/loop-runtime.md#ordered-stop-decisions).

If fixing A introduces B and fixing B reintroduces A, the loop reopens A with its original identity and attempt history and records the interaction. Before another repair, it must explain how the correction preserves both required behaviors. Both findings and affected earlier fixes must pass validation. Recurrence alone does not force a stop or grant extra rounds: reassessment, the ordinary cap, and validation rules still apply. A late request for additional evidence does not reopen an already validated behavioral fix unless it contradicts that fix or invalidates its proof. See [repair recurrence](../plugins/jig-review/skills/review-fix-loop/references/loop-runtime.md#repair-recurrence).

The same interaction analysis applies when a later repair weakens a mitigation's validated benefit. The finding is already outstanding: total loss of benefit makes it `pending`, while partial protection remains `mitigated` with updated residual risk, subject to existing blocking rules. An unresolved underlying defect alone is not a new regression, and a validated repair may replace the workaround. Checks establish the required behavior and protection, allowing the temporary mechanism to change. This policy draws on [Google SRE's distinction between mitigation and prevention](https://www.usenix.org/system/files/login/articles/login_spring17_09_lunney.pdf) and [Google's guidance on testing behavior](https://testing.googleblog.com/2013/08/testing-on-toilet-test-behavior-not.html).

## Review Scopes

Working-tree scope includes staged, unstaged, untracked, and initialized submodule changes. Branch scope includes the committed diff from the merge base through `HEAD` and all those local changes together, including repairs from every round. It works with clean or dirty checkouts. Every reviewer checks the cumulative effect in final working files, so a later round still sees branch defects in files untouched by the latest repair.

`--base <ref>` selects branch scope. `--scope branch` without a base detects the default branch using comprehensive review's rules. `--scope auto` chooses working-tree scope when local changes exist and branch scope otherwise. Selection happens once; the loop does not change scopes after a repair. An invalid base stops the loop. Branch mode requires an existing `HEAD` commit.

The base, `HEAD`, and merge-base commits remain pinned throughout the loop. Branch exclusions come from `.reviewignore` at that base, plus explicit exclusions. Moving the original base ref does not change the review; changing a pinned commit ends the loop as `scope changed`. Branch passes always include local changes, using the adapters' combined branch mode. The committed diff and its local reversal remain reviewable even if their net effect matches the merge base.

The loop preserves the index unless staging was separately authorized. Convergence describes repaired working files. The final report lists repaired paths whose staged versions still differ and need staging or re-staging. For branch scope it additionally reports exact counts and bounded lists of tracked paths differing from the index, untracked paths absent from it, and dirty submodules from the final matching fingerprint, including pre-existing local changes. If a list is capped or capture issues prevent enumeration, the report identifies the staging guidance as incomplete. Nested paths must be added or re-staged in their owning repository, working from innermost submodules outward. Repairs and other local changes remain uncommitted, so the staged version or committed branch may still contain defects reviewers treated as superseded in the final working files.

## Triage and Validation

The loop checks cited code and callers and prefers a failing test or deterministic reproduction. A rare but supported failure remains a repair candidate according to its severity. Style preferences, intended behavior, and unsupported hypothetical failures are rejected. Below-threshold findings are outside repair scope without being declared false.

Triage leaves the reviewed repository unchanged: reproductions run read-only or in an external temporary copy. Regression tests enter the tree only after verification and the decision to start a counted ordinary round or the recorded closure batch. Validation output should go outside the repository; necessary retained generated changes are recorded and included in the next review. Cleanup is limited to artifacts created by the run. Checks must not write excluded paths; an unavailable safe execution method for a required check yields `validation failed`.

The ledger separates verification (`verified`, `rejected`, or `unresolved`) from repair status (`pending`, `fixed`, `mitigated`, `blocked`, or `not-applicable`). For example, a proven defect can remain `verified` while its repair is `blocked` on a compatibility decision. A passing repair retains the original verification and records `fixed` separately.

After a repair, the skill runs focused tests and broader relevant checks. Each ordinary round permits up to two mechanical correction passes for repair-caused build, formatting, or test-wiring mistakes, plus one behavioral correction subject to reassessment. Mechanical corrections must preserve semantics, assertions, and test discovery; their allowance never resets within the round. Closure instead shares its single correction allowance across all supporting corrections. Evidence of transient infrastructure failure permits one accounted rerun per required command, retaining the initial failure; flaky assertions do not justify retrying until green. Unresolved required validation still prevents convergence.

The final report includes the outcome, effective mode, finding kinds, verification and repair statuses, supporting links, substantive attempt histories and reassessments, files changed, validation evidence, reviewer coverage, closure usage, any unreviewed edits, residual below-threshold findings, and blockers. Comprehensive reports also explain the causal diagnosis, repair choice, prevention, and required remaining work. Preserve histories and closure usage when handing work back; resuming the same loop never silently replenishes its allowances.
