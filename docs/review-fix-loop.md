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

The defaults use Claude and Codex, apply minimal fixes to verified findings of medium severity or higher, and allow at most three repair rounds. Select all providers and Cursor fast mode with:

```text
$jig-review:review-fix-loop --all-reviewers --cursor-effort xhigh --cursor-speed fast --exclude-path .agents/
```

Available loop controls:

| Control | Default | Meaning |
|---|---|---|
| `--fix-mode minimal\|comprehensive` | `minimal` | Selects minimal corrections or diagnosis and durable causal repairs. |
| `--min-severity critical\|high\|medium\|low` | `medium` | Lowest finding severity eligible for repair. |
| `--max-rounds 1\|2\|3` | `3` | Maximum repair rounds started, including aborted rounds. |
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

The initial review is not counted as a repair round. A round is consumed when edits begin, including adding a regression test for a verified finding. Successful rounds normally finish with validation and a fresh comprehensive review of the entire selected scope, including all repairs and the last allowed repair round. Aborted rounds still count, but stop without requiring another review. Consequently, three successful repair rounds normally perform four review passes; a validation failure can end the loop earlier.

Each round counts once toward every causal group it targets for repair or mitigation. Incidentally breaking another group does not count as an attempt to repair that group. Merging groups combines their targeted round histories, counting any shared round once. A mechanism still outstanding after two attempts stops under the repeated-failure limit.

That limit also applies during validation. If a later repair reopens a mechanism already targeted in two earlier rounds, the loop stops before using its focused correction as a third attempt.

If a validated repair removes every included change, there is no diff left to review. The loop may converge with the final review explicitly skipped only after complete, matching captures establish an empty scope, the preceding review had full coverage, all edits are accounted for, and no finding remains outstanding. A net diff against `HEAD` or the merge base is insufficient: committed, staged, and unstaged changes can cancel each other. The runtime defines the full [empty-scope conditions](../plugins/jig-review/skills/review-fix-loop/references/loop-runtime.md#repair-produces-an-empty-scope).

Reviewers receive fresh contexts and never see earlier findings or desired outcomes. Within each review pass, scope fingerprints must remain unchanged. Changes between passes are accepted only when they are attributable to recorded loop edits.

Except for that verified empty scope, convergence requires no eligible defect or material question outstanding, all requested reviewers completed for the current state, complete evidence coverage, and a verified fingerprint. Unresolved findings stay in the ledger even if later reviewers omit them. In comprehensive mode, a temporary mitigation remains outstanding until the selected causal repair and its validation are complete. See the runtime's [ordered stop decisions](../plugins/jig-review/skills/review-fix-loop/references/loop-runtime.md#ordered-stop-decisions) for precedence and partial-review handling.

If fixing A introduces B and fixing B reintroduces A, the loop reopens A with its original identity and attempt history and records the interaction. Before another repair, it must explain how the correction will preserve both required behaviors. The repaired state must pass validation for both findings and affected earlier fixes. Recurrence alone does not force a stop or grant extra attempts: the existing repeated-failure, round-cap, and validation rules still apply. See [repair recurrence](../plugins/jig-review/skills/review-fix-loop/references/loop-runtime.md#repair-recurrence).

The same interaction analysis applies when a later repair weakens a mitigation's validated benefit. The finding is already outstanding: total loss of benefit makes it `pending`, while partial protection remains `mitigated` with updated residual risk, subject to existing blocking rules. An unresolved underlying defect alone is not a new regression, and a validated repair may replace the workaround. Checks establish the required behavior and protection, allowing the temporary mechanism to change. This policy draws on [Google SRE's distinction between mitigation and prevention](https://www.usenix.org/system/files/login/articles/login_spring17_09_lunney.pdf) and [Google's guidance on testing behavior](https://testing.googleblog.com/2013/08/testing-on-toilet-test-behavior-not.html).

## Review Scopes

Working-tree scope includes staged, unstaged, untracked, and initialized submodule changes. Branch scope includes the committed diff from the merge base through `HEAD` and all those local changes together, including repairs from every round. It works with clean or dirty checkouts. Every reviewer checks the cumulative effect in final working files, so a later round still sees branch defects in files untouched by the latest repair.

`--base <ref>` selects branch scope. `--scope branch` without a base detects the default branch using comprehensive review's rules. `--scope auto` chooses working-tree scope when local changes exist and branch scope otherwise. Selection happens once; the loop does not change scopes after a repair. An invalid base stops the loop. Branch mode requires an existing `HEAD` commit.

The base, `HEAD`, and merge-base commits remain pinned throughout the loop. Branch exclusions come from `.reviewignore` at that base, plus explicit exclusions. Moving the original base ref does not change the review; changing a pinned commit ends the loop as `scope changed`. Branch passes always include local changes, using the adapters' combined branch mode. The committed diff and its local reversal remain reviewable even if their net effect matches the merge base.

The loop preserves the index unless staging was separately authorized. Convergence describes repaired working files. The final report lists repaired paths whose staged versions still differ and need staging or re-staging. For branch scope it additionally reports exact counts and bounded lists of tracked paths differing from the index, untracked paths absent from it, and dirty submodules from the final matching fingerprint, including pre-existing local changes. If a list is capped or capture issues prevent enumeration, the report identifies the staging guidance as incomplete. Nested paths must be added or re-staged in their owning repository, working from innermost submodules outward. Repairs and other local changes remain uncommitted, so the staged version or committed branch may still contain defects reviewers treated as superseded in the final working files.

## Triage and Validation

The loop checks cited code and callers and prefers a failing test or deterministic reproduction. A rare but supported failure remains a repair candidate according to its severity. Style preferences, intended behavior, and unsupported hypothetical failures are rejected. Below-threshold findings are outside repair scope without being declared false.

Triage leaves the reviewed repository unchanged: reproductions run read-only or in an external temporary copy. Regression tests enter the reviewed tree only after verification and the decision to start a counted repair round. Validation output should go outside the repository; necessary retained generated changes are recorded and included in the next review. Cleanup is limited to artifacts created by the run. Checks must not write excluded paths; if a required check cannot run safely with redirected output or in a temporary copy, the loop reports `validation failed` with that constraint.

The ledger separates verification (`verified`, `rejected`, or `unresolved`) from repair status (`pending`, `fixed`, `mitigated`, `blocked`, or `not-applicable`). For example, a proven defect can remain `verified` while its repair is `blocked` on a compatibility decision. A passing repair retains the original verification and records `fixed` separately.

After a repair, the skill runs focused tests and broader relevant checks. A repair-induced validation failure permits one focused correction in the same round. Remaining failure or unavailable required validation aborts the round. Immediate scope, validation, and required-input guards take precedence; after a review, convergence, repeated failures, and round limits are evaluated before allowing more edits.

The final report includes the outcome, effective mode, verification and repair statuses, files changed, validation evidence, terminal reviewer coverage, any unreviewed edits, residual below-threshold findings, and blockers. Comprehensive reports also explain the causal diagnosis, repair choice, prevention, and required remaining work.
