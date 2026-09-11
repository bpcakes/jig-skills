# Evaluation harness repair audit

Historical first repair pass. The subsequent [portability audit](evaluation-harness-portability-audit.md) records seven additional repairs and format-2 evidence. Counts and reports below describe the earlier evaluator, not the current harness.

## 1. Executive outcome

**Accept with residual risk — A1 behavioral audit.** The six review findings are repaired. Five harness failure modes have fail-before/pass-after evidence. This supports the scoped repair, not universal skill correctness or release certification. Model results remain a small regression set, and execution traces are not an adversarial sandbox.

## 2. Scope and evidence

Repository: `/home/aa/Documents/jig-skills`, branch `master`, HEAD `0f106352c36bde312a0621971c2a894a6f51be3c`. The baseline for this follow-up is the pre-repair working tree, not HEAD's older skill content. Its evaluator and plugins were copied before editing to `/tmp/jig-eval-repair-audit-gyuqye/baseline-evals` and `baseline-plugins`. The initial evaluator hash was `5c58c5edb204b52ca68325d0f5a99303e2d29ad7390e0aece95f6b774955de48`.

Validation used Linux, Node `v22.23.2`, real Git, and authenticated `codex-cli 0.154.0` with its default model and user configuration ignored. No gold implementation or held-out test set was available. No dependencies were installed or commits made.

## 3. Behavioral contract

| Requirement | Required behavior | Evidence |
|---|---|---|
| R1: Scope | Reject every recorded out-of-scope write, even if restored | Restored-write and restored-move integration cases |
| R2: Provenance | Disable symlinked personal skills; require the fixture skill path | Symlink replay, foreign-read integration, live argv |
| R3: Authorization | Discovery/loading does not start a repair loop | Two one-pass live cases and explicit preview |
| R4: Evidence | Consequences and counterevidence determine findings | Async, security, and React positive/negative pairs |
| R5: Optional scores | Reports may omit numeric scores | Template and rubric inspection |
| R6: Git isolation | Personal signing, hooks, and templates cannot affect fixtures | Real-Git integration with hostile temporary configuration |
| R7: Record integrity | Recompute verdicts and preserve failures and coverage limits | Exporter tests and both report verifications |

## 4. Diff and evaluator integrity

The user authorized changes to the harness, tests, fixtures, skill instructions, and supporting documentation. Existing semantic criteria were not relaxed. Nine live cases were added. One new preview prompt was subsequently clarified after a false-negative invocation result; its expected read, scope, and outcome checks remained unchanged. The original failed run is preserved.

Protected-file snapshots and comparisons are retained in the audit directory. The default hash-guard patterns missed `.mjs` evaluator files, so an explicit `evals/**` inventory and direct evaluator hashes were also captured. No tests were removed, skipped, focused, or made retry-dependent. The deterministic CLI stub is labeled test-only and is not model evidence.

## 5. Replay matrix

| Check | Pre-repair harness | Repaired harness | Interpretation |
|---|---|---|---|
| Correct scoped edit | Pass | Pass | Positive control, not bug-fix proof |
| Unrelated edit and restoration | Fails test: accepts edit | Pass | Discriminates R1 |
| Move outside scope and restoration | Fails test: accepts move | Pass | Discriminates R1 |
| Same-name personal skill read | Fails test: accepts read | Pass | Discriminates R2 |
| Ambient Git configuration | Fails fixture commit | Pass | Discriminates R6 |
| Symlink inventory | Fails assertion | Pass | Discriminates R2 |

The same five integration tests ran against the preserved baseline and candidate. Symlink replay used the unchanged baseline enumeration function, exposed with an audit-only export. The baseline's four original unit tests also passed, demonstrating their coverage gap. Export and forbidden-workflow tests cover new functionality without a pre-existing equivalent.

## 6. Coverage and reach

CLI-boundary tests exercise the assembled runner, real fixture snapshots and Git, and verdict composition. Unit cases cover absolute/relative paths, malformed write paths, move destinations, symlink aliases/cycles, wrong-location reads, missing grades, and changed HEAD/index state. Coverage output is in `final-16-tests.json` under the audit directory. It is reach evidence, not a correctness score; existing-only versus added-test coverage was not separately measured. Timeout/output-limit and some CLI help branches lack local regression coverage.

## 7. Oracle strength

The tests challenge correct final files paired with forbidden intermediate effects, correct answers paired with the wrong instruction source, and passing semantic grades paired with forbidden workflow commands. Those cases cannot pass merely because a final answer looks right. Export tests reject changed evidence, stale source, missing cases, and forged pass summaries; partial exports list omitted cases explicitly.

The test-smell scanner emitted seven snapshot-related leads. Inspection found hash/snapshot mechanics being tested, with explicit changed-path and tamper-rejection assertions, not regenerated acceptance snapshots. These were not promoted to findings.

## 8. Reliability

The local suite passed repeatedly in fresh processes, including UTC and Europe/Prague settings during the repair. The final suite contains 16 passing tests with no skips. Git perturbations use temporary configuration, hooks, and templates without changing personal configuration. Authentication and model generation remain external, nondeterministic dependencies.

## 9. Regression breadth

The review-plugin suite passed 135 tests with two opt-in provider tests skipped. All 40 skill frontmatters validated. Local link checks and `git diff --check` passed. Node 24, other platforms, and an authorized multi-reviewer repair loop were not exercised in this follow-up.

The [full live run](../evals/results/2026-09-11-review-fixes-full.json) passed 24/25 cases. Its preview request said "before executing anything," and Codex correctly ran no commands, conflicting with the required command-based invocation evidence. The clarified instruction-reading preview passed [1/1 on rerun](../evals/results/2026-09-11-review-fixes-preview.json). No clean 25/25 single run or before/after model improvement rate is claimed.

## 10. Findings and disposition

All six reviewed findings are repaired. R1, R2, and R6 have dynamic baseline contrasts; R3 and R4 have live behavior checks; R5 has direct template/rubric consistency evidence. No unresolved defect was established in this scoped verification. The preview fixture conflict was diagnosed and corrected rather than weakening the invocation check or omitting its failed result.

## 11. Residual risks

Recorded writes and final snapshots cannot detect every reverted shell mutation or unrelated external action. Invocation checks are a conservative command/path proxy, not a shell interpreter. A separate grading pass is not an independent model family. The live cases are public regression examples, not a held-out benchmark. The score-template change has no live rendering case, and positive loop execution is covered by existing runtime tests rather than a new paid reviewer loop.

One Markdown hard-break whitespace change in the non-evaluated duplication report reference occurred during the frozen full run. Export validation checks every discovery entrypoint and every file in evaluated or observed-read skills; unused references in other skills may differ, with their original frozen hashes retained.

## 12. Remediation verification

From the repository root:

```sh
node --test evals/*.test.mjs
node --test plugins/jig-review/tests/*.test.mjs
git diff --check
```

Both historical reports require the original format-1 evaluator. A retained evaluator and preview-suite copy is `/tmp/jig-harness-portability-aVtEcP/evals`; import its `export.mjs` and call `verifyReport(reportPath, sourceRoot)` with that directory's parent for the preview. The full-run report instead requires the pre-clarification source root `/tmp/jig-eval-repair-audit-gyuqye/full-run-source`. The current format-2 exporter rejects these records because their schemas were not recorded. A future complete current-suite run can use `node evals/run.mjs --live`.

## 13. Appendix: retained evidence

- Audit directory: `/tmp/jig-eval-repair-audit-gyuqye`, including baseline/candidate command logs, coverage, protected hashes, scanner leads, and requirement traceability.
- Baseline replay: `EVAL_TEST_RUNNER=/tmp/jig-eval-repair-audit-gyuqye/baseline/evals/run.mjs node --test evals/integration.test.mjs`; the retained log predates the separately added forbidden-workflow test.
- Full run: `node evals/run.mjs --live --timeout 240`, artifacts `/tmp/jig-skill-evals-0d0zEI`.
- Corrected preview: `node evals/run.mjs --live --case loop-explicit-preview --timeout 240`, artifacts `/tmp/jig-skill-evals-4aVuDS`.
- Each exported report contains its harness, suite, exporter, frozen skill, source-summary, and per-trial artifact hashes. Raw directories must remain available for re-verification.
