# Evaluation integrity and React rubric follow-up

Historical record of the preceding repair. The subsequent [edge-case follow-up](evaluation-harness-edge-cases-audit.md) records further command, invocation, cancellation, timeout, and Rust test-review repairs. Counts and source-verification claims below describe this earlier frozen run.

## 1. Executive outcome

Accept with residual risk — A1 behavioral audit. The six findings from the latest comprehensive review are addressed. Baseline contrasts establish the harness repairs; live positive and negative cases exercise the React instruction changes. This is evidence for these repairs, not a complete or adversarial skill benchmark.

## 2. Scope and evidence

The pre-repair working tree's evaluator and plugins were copied to `/tmp/jig-eval-integrity-BF1sT2` before edits. Repository HEAD remained `0f106352c36bde312a0621971c2a894a6f51be3c`; the baseline is that preserved working tree, not HEAD's older content. No dependencies were installed or repository commits made. Validation used Linux, Node 22.23.2 and 24.19.0, real Git, and Codex CLI 0.154.0. No independent gold implementation was available. The coding-agent-test-audit skill guided baseline preservation, negative controls, and explicit evidence limits.

## 3. Behavioral contract

| Requirement | Required behavior | Evidence |
|---|---|---|
| R1: Complete experiments | Record every intended trial before execution; never label interrupted repetitions complete | Exporter baseline contrasts and pre-cancellation manifest assertions |
| R2: React test evidence | Query choices and smoke tests need surviving regressions and counterevidence before findings | Aligned reference/example plus two live cases |
| R3: React performance evidence | Cheap patterns are not rated defects without consequences | Aligned entrypoint/reference plus two live cases |
| R4: Workflow trace | Detect actual launches without rejecting searches for names | Command-position checks, positive/negative controls, CLI integration replay |
| R5: Frozen inputs | Deny temporary evidence writes; detect changed skills/schemas and stop later trials | Real sandbox probe and agent/grader tamper tests |
| R6: Cancellation | Stop active provider groups and subsequent trials; clean grader workspace; retain failure | SIGINT task and SIGTERM grader tests with real child processes |

## 4. Diff and evaluator integrity

Format 3 adds planned trials and lifecycle state; older reports cannot be relabeled with provenance they never recorded. The runner replaces summaries atomically, checks frozen inputs at execution boundaries, restricts ambient temporary writes, and handles cancellation. The exporter checks the plan and terminal state, preserving omissions in partial reports. Workflow cases now use command-position detection instead of broad token matching. Existing task prompts, grading criteria, and scope allowances were not weakened; four new React cases were added. Two React entrypoints and their relevant references/examples were aligned.

The protected `evals/**` comparison records six modified files and three additions (two test files and the new report), with no deletions. Schemas and historical reports remain unchanged. No CI policy, dependencies, skips, or retries were added. The CLI stub remains explicitly test-only.

## 5. Replay matrix

| Check group | Preserved baseline | Candidate | Interpretation |
|---|---|---|---|
| Repetition/completion/plan checks | 3 failures | Pass | Old exporter accepted incomplete or invalid inventories |
| Search, tamper, sandbox argv integration | 7 failures, 1 pass | Pass | Three harmless searches were rejected, three mutations accepted, temporary-write exclusions absent; the sed search already passed |
| SIGINT/SIGTERM cancellation | 2 failures | Pass | Both baseline provider processes remained alive after runner exit |
| React positive/negative behavior | Not run | 4 live passes | Current behavior evidence, not a before/after model improvement rate |

Exporter replay uses `EVAL_TEST_FORMAT=2` only to encode the fixture in the old exporter's supported format; trial plans, assertions, and behavior under test are unchanged. Baseline orphan processes were killed by test teardown using their recorded process-group IDs. No unrelated processes or historical artifact directories were swept.

## 6. Coverage and reach

The final 50-test Node 22 coverage run passed. `run.mjs` reported 98.80% line and 88.41% branch coverage; `export.mjs` reported 89.76% and 87.30%. Tests reach cancellation, pre-execution manifests, incomplete export, task/grader tampering, and halt-before-next-trial behavior. Coverage measures execution, not oracle quality; existing-only versus added-test coverage was not separated. Deep wrapper recursion and some CLI help/error branches remain untested.

## 7. Oracle strength

The test double deliberately bypasses sandbox enforcement to corrupt frozen inputs, checking the independent integrity guard. Two repetitions are planned, and tests require only the first to execute after tampering. Harmless search controls oppose real executable launches. Cancellation checks actual provider and descendant liveness, not just exit codes or mocks. The real Codex probe allowed a workspace write and denied a sibling temporary evidence write with `EROFS`.

The static test scanner emitted 14 low-confidence leads: 12 concern snapshot mechanics with explicit tamper/mutation assertions, and two concern bounded readiness deadlines. These were inspected and not promoted to defects. No golden outputs were regenerated to make failing checks pass.

## 8. Reliability

All 50 tests passed on both Node 22 and Node 24, with the latter run in UTC. Earlier 49-test runs also passed before the final grader-tamper case was added. Tests use owned temporary directories and observable readiness markers rather than a fixed startup sleep. Timeouts are failure bounds, not expected output. The existing one-second grader-timeout fixture may still be sensitive to exceptionally slow CI startup. Live model generation and authentication remain external dependencies.

## 9. Regression breadth

The review-plugin suite passed 135 tests with two opt-in provider tests skipped. Both changed skill entrypoints passed frontmatter validation, and `git diff --check` passed.

The [format-3 live report](../evals/results/2026-09-11-integrity-react.json) passed all six planned trials: scoped Rust simplification, preview-only review-loop selection, and positive/negative pairs for React test quality and performance. Codex accepted the intentional test ID and cheap provider, identified a confirmation callback left untested, and identified quadratic filtering at the stated 10,000-user workload. Every invocation, scope, finding-count, trace, and outcome check passed; commands and grader explanations were inspected. All grader workspaces were removed. The report verified against current source and raw artifacts.

This completed selected experiment covers six of 29 suite cases and explicitly lists the 23 omitted cases. It is not a full-suite pass or a repeated-trial reliability estimate.

## 10. Findings and disposition

All six requested findings are repaired. The prior format-2 smoke report also verified with its preserved original evaluator/source. Historical records were not rewritten. A first attempt to use this CLI's standalone sandbox command failed because that command requires a named permission profile; the subsequent real `codex exec` probe tested the actual runner flags successfully. No failed behavioral evaluation was dropped or rerun to select a pass.

## 11. Residual risks

Command detection is a bounded shell proxy, not complete analysis of aliases, substitutions, variables, or arbitrary interpreter programs. Write restrictions do not hide criteria from broader read access; the public regression suite and same-account processes are not an adversarial evaluator. Hash checks are not an authenticity guarantee against an external privileged actor. SIGKILL, machine shutdown, and descendants deliberately escaping the process group remain outside cancellation guarantees. Other operating systems and a full 29-case live run were not exercised.

## 12. Remediation verification

```sh
node --test --experimental-test-coverage evals/*.test.mjs
TZ=UTC node --test evals/*.test.mjs
node --test plugins/jig-review/tests/*.test.mjs
node evals/export.mjs --verify evals/results/2026-09-11-integrity-react.json
git diff --check
```

Use Node 24 for the second command to repeat the recorded compatibility check. Re-verification requires the matching source and raw artifact directory. Temporary evidence is local and must be retained or separately archived; these records are not independently reproducible from the checked-in JSON alone.

## 13. Retained evidence

Audit directory: `/tmp/jig-eval-integrity-BF1sT2`, including the baseline, protected hashes, requirement traceability, baseline exporter/integration/cancellation logs, final Node 22 coverage and Node 24 UTC logs, plugin results, scanner leads, and sandbox-probe notes. Live artifacts: `/tmp/jig-skill-evals-fOQRWF`; the checked-in report records hashes, trial inventory, final answers, grades, and commands. Source instructions and the evaluator were unchanged throughout that frozen live run.
