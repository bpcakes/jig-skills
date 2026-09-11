# Evaluation edge cases and Rust test-only review

Historical record. The later [provenance follow-up](evaluation-provenance-audit.md) covers further repairs; verification below requires the original evaluator and source preserved for this run.

## 1. Executive outcome

Accept with residual risk — A1 behavioral audit. The five requested review findings are addressed, along with a grader-context defect exposed by the new live cases. Targeted baseline contrasts fail before the repairs and pass afterward. The final selected Codex experiment passes four of four trials; this is not a full 31-case live-suite result. No further external review, commit, or staging was performed.

## 2. Scope and evidence

The pre-repair evaluator and plugins were preserved at `/tmp/jig-eval-edge-X8wtT0`. HEAD remained `0f106352c36bde312a0621971c2a894a6f51be3c`; the baseline is the copied working tree, not HEAD's older files. Existing edits and reports were preserved. Linux validation used Node 22.23.2 and 24.19.0, Git 2.43.0, Rust 1.97.1, and authenticated Codex CLI 0.154.0. No dependencies were installed. No independent gold implementation was available. The coding-agent-test-audit skill guided baseline replay, mutation checks, and retention of unfavorable evidence.

Changed behavior is in [the runner](../evals/run.mjs), [the exporter](../evals/export.mjs), and [Rust test-quality instructions](../plugins/jig-rust/skills/rust-test-quality-review/SKILL.md). Regression checks live in `evals/*.test.mjs`; model cases are in [cases.json](../evals/cases.json).

## 3. Behavioral contract

| ID | Required behavior | Evidence |
|---|---|---|
| R1 | Codex global options and `e` must not hide forbidden workflow launches | Three assembled-runner contrasts plus command controls |
| R2 | Review test-only losses; accept replacement coverage | Two live Rust cases and compiled boundary mutations |
| R3 | Preserve quoted paths; ambiguous reads cannot prove negative discovery | Unit, assembled-runner, and exporter checks |
| R4 | Terminal SIGINT during Git setup must stop providers and later trials | Real process-group signal with a readiness marker |
| R5 | A short grader deadline must not shorten the task deadline | Delayed-task fixture and grader cleanup assertions |
| R6 | Graders must distinguish user Git changes from task-agent edits | Committed baseline/diff prompt assertion and live replay |

## 4. Diff and evaluator integrity

The runner now parses Codex option operands, shares a quote-aware tokenizer with invocation detection, records `uncertainReads`, and refuses to pass inconclusive negative invocation checks. The exporter recomputes the same evidence. Event-loop checkpoints deliver queued signals before provider launch, another trial, or completion. `--grade-timeout` independently controls grading. Graders receive `gitBase` and UTF-8 `initialDiff`, separately from task-start/final files.

The Rust skill explicitly checks deleted or weakened tests, ignore/config gates, and discovery changes, requiring a surviving regression and counterevidence. Two fixture cases were added; existing criteria and scope allowances were not weakened. The protected `evals/**` comparison records nine modified files and four additions: one Git-boundary fixture and three result records. No protected files were deleted. Schemas, historical reports, dependencies, CI thresholds, and skip policies were unchanged in this repair.

## 5. Replay matrix

| Check | Preserved baseline | Final candidate | Interpretation |
|---|---|---|---|
| Codex model, directory, and profile/alias launches | 3 failures | Pass | Forbidden launches were accepted |
| Absolute skill path containing spaces | Failure | Pass | Successful invocation was lost |
| Negative discovery with successful glob read | Failure | Pass | Missed attribution incorrectly became a pass |
| Terminal SIGINT during synchronous Git setup | Failure; 2 trial results | Pass; only interrupted first trial | Runner advanced before delivering the signal |
| Export of inconclusive invocation | Failure | Pass | Old exporter could not retain the inconclusive verdict |
| Committed baseline in grader input | Failure; absent | Pass | Grader lacked the reviewed user change |
| Separate grader deadline | Original suite passes | Pass with injected 1.2-second task and 1-second grader deadline | Slow-CI flakiness itself was not reproduced; the shared-budget dependency is removed |

The baseline's original suite passes 50 tests; the final candidate collects and passes 61. Live results are current-behavior evidence, not a measured before/after improvement rate for the skill.

## 6. Coverage and reach

The final Node 22 coverage run reports `run.mjs` at 99.17% line / 89.47% branch and `export.mjs` at 89.84% / 89.83%. Changed paths are reached through assembled runner/exporter tests: option parsing, exact and ambiguous reads, queued cancellation, independent deadlines, and grader Git context. The uncovered runner lines are CLI help/unknown-argument handling; exporter CLI dispatch is exercised separately by real export/verify commands. Some deep wrapper and error branches remain uncovered. Existing-only versus added-test coverage was not separated; aggregate coverage is not an oracle-strength claim.

## 7. Oracle strength

Exact-path variants cover single quotes, double quotes, backslash escapes, and shell wrappers; searches remain negative controls for launch detection. The signal test waits for a Git child to announce the exact blocking phase, signals the terminal process group, and checks both provider absence and the uncreated second trial. The exporter must retain `invocation: null` and reject a forged passing summary.

Compiled Rust mutations independently confirm the fixture consequences. Both `age > 18` and `age >= 17` fail the original boundary tests, survive the weakened/ignored tests, and fail the valid exhaustive replacement test. These checks establish real lost protection rather than relying only on the model's explanation or a test-count rule.

## 8. Reliability

All 61 tests pass on both Node 22 and Node 24, with Node 24 in UTC. Earlier 60-test candidate runs also passed before the grader-context check was added. Fixtures use owned temporary directories and bounded readiness waits. The 1.2-second delay is explicit test-double fault injection; no elapsed-time value is an output oracle. Agent and grader deadlines are 15 and 1 seconds in that timeout test. Exceptionally stalled hosts can still exceed any finite deadline.

The static scanner emitted 14 low-confidence leads: twelve snapshot references and two readiness-deadline checks. Explicit mutation assertions and bounded readiness semantics supplied counterevidence; none was promoted to a defect merely from the scanner match.

## 9. Regression breadth

The review-plugin suite passes 135 tests with two existing opt-in provider tests skipped. Rust skill frontmatter validation and `git diff --check` pass.

The [final live report](../evals/results/2026-09-11-edge-cases.json) records four passing trials: test-only regression review, valid test consolidation, scoped implicit Rust simplification, and negative simplification discovery. Commands, answers, and grader evidence were inspected. Reviews left files unchanged; simplification changed only the requested source in the final snapshot. All grader workspaces were removed. The report verifies against its raw artifacts and matching source. It lists the other 27 suite cases as omitted.

## 10. Findings and disposition

| Finding | Severity / confidence | Disposition |
|---|---|---|
| R1: Workflow option/alias bypass (`CA-EV-04`) | Medium / confirmed | Repaired; three baseline failures |
| R2: Lost test-only review instruction (`CA-EV-09`) | Medium / high static confidence | Explicit coverage restored; positive/negative live behavior established |
| R3: Invocation attribution and false negative pass (`CA-OR-02`) | Low / confirmed | Exact reads preserved; uncertainty fails closed |
| R4: Queued terminal interruption (`CA-RL-03`) | Low / confirmed | Checkpoints stop provider and subsequent trial |
| R5: Coupled timeout fixture (`CA-RL-03`) | Low / high static confidence | Independent deadline; original slow-host flake not reproduced |
| R6: Missing grader Git context (`CA-EV-02`) | Medium / confirmed | Baseline and user diff supplied without changing criteria |

The [initial live report](../evals/results/2026-09-11-edge-cases-initial.json) remains 3/4: Codex correctly found both Rust regressions, but the grader rejected them because its `before`/`after` inputs were identical. A new context test then caught an intermediate Buffer-to-JSON mistake. A prematurely started rerun was deliberately stopped and preserved as [interrupted](../evals/results/2026-09-11-edge-cases-interrupted.json), with three planned trials omitted. The final correction decodes the diff as UTF-8. An earlier exporter test also used the wrong field path; its assertion was corrected to the report's existing `checks.invocation` field. Neither failure was hidden or counted as passing evidence.

## 11. Residual risk and evidence gaps

Workflow/read detection remains a bounded shell proxy, not complete analysis of variables, aliases, substitutions, or arbitrary interpreter programs. Inconclusive attribution is conservative and can require manual inspection. Public fixtures and same-account model grading are not an adversarial benchmark; write isolation does not guarantee confidentiality, and hashes do not authenticate a malicious evaluator. SIGKILL, machine shutdown, and descendants escaping their process group remain outside cancellation guarantees. Full live-suite coverage, other operating systems, and repeated-trial model reliability were not established.

## 12. Remediation verification

```sh
node --test --experimental-test-coverage evals/*.test.mjs
TZ=UTC /home/aa/.local/share/mise/installs/node/24.19.0/bin/node --test evals/*.test.mjs
node --test plugins/jig-review/tests/*.test.mjs
node evals/export.mjs --verify evals/results/2026-09-11-edge-cases.json
git diff --check
```

Run these from the repository root. Use a locally installed Node 24 path on other machines. Matching source and retained raw artifacts are necessary for report verification.

## 13. Retained evidence

Audit root: `/tmp/jig-eval-edge-X8wtT0`. It contains baseline sources, exact command/output JSON for baseline contrasts and final Node runs, protected manifests, traceability CSV, scanner leads, and compiled mutation results. `first-live-source`, `interrupted-source`, and `final-source` preserve the respective evaluator/skill revisions. The previous integrity report also verified using the pre-repair source.

Raw runs: initial `/tmp/jig-skill-evals-cJnhcl`, interrupted `/tmp/jig-skill-evals-TdoRZ6`, final `/tmp/jig-skill-evals-hUtCV7`. The live command selected the four case IDs above with `--timeout 240 --grade-timeout 240`. Reports record coverage, hashes, model configuration, and available commands, answers, and grades; raw runs additionally retain prompts and detailed traces. Temporary evidence must be retained or archived separately; checked-in JSON alone is not an independently reproducible model run.
