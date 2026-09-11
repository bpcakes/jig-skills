# Evaluation harness portability follow-up

Historical format-2 repair pass. The subsequent [integrity follow-up](evaluation-harness-integrity-audit.md) records trial inventories, cancellation handling, sandbox changes, and React rubric repairs. The report below requires its original evaluator/source copy at `/tmp/jig-eval-integrity-BF1sT2`; the current exporter intentionally rejects it rather than adding unrecorded provenance.

## 1. Executive outcome

Accept with residual risk — A1 behavioral audit. All seven findings from the second comprehensive review are addressed. The coding-agent-test-audit skill guided baseline preservation, negative controls, and evidence checks. This is scoped repair evidence, not certification of every skill or shell trace.

## 2. Scope and evidence

The baseline is the working tree before these seven repairs, preserved with its evaluator and plugins at `/tmp/jig-harness-portability-aVtEcP`. HEAD remained `0f106352c36bde312a0621971c2a894a6f51be3c`; no commit or dependency installation was made. Validation used Linux, Node 22.23.2, real Git, and Codex CLI 0.154.0. No independent gold implementation or held-out test set was available.

## 3. Behavioral contract

| Requirement | Repair | Discriminating evidence |
|---|---|---|
| R1: Physical paths | Canonicalize artifact, task, and grader roots | Symlinked TMPDIR with absolute reads and edits |
| R2: Quoted launches | Recognize quoted Claude, Cursor, and Codex commands | Forbidden trace paired with a passing outcome grade |
| R3: Git defaults | Pin ignore and attributes files to the null device, including in the Codex child | Hostile XDG defaults with real Git |
| R4: Schema provenance | Freeze both schemas, record hashes, verify source and frozen copies | Four tamper cases and frozen CLI argv |
| R5: Bundle stability | Exclude named generated artifacts only from skill bundles | Cache ignored, authored untracked reference retained, task cache mutation observed |
| R6: UTF-8 | Decode streams across chunk boundaries; count bytes for limits | Every split boundary in multibyte text and byte-limit control |
| R7: Cleanup | Remove only the newly allocated grader workspace in finally | Success, process failure, timeout, and live-run cleanup |

## 4. Evaluator integrity

The user authorized these repairs. No semantic criteria, prompts, finding counts, or allowed changes were relaxed. Only three existing cases' forbidden-command patterns changed. No tests were deleted, skipped, or made retry-dependent. A protected `evals/**` inventory recorded six modified files and one new test file before the new live report was added. Schemas and historical reports stayed byte-identical. Existing skill edits from previous work were preserved; no skill instructions changed in this pass.

## 5. Replay matrix

The current CLI integration tests against the preserved pre-fix runner produced 7 passes and 9 expected failures. Failures covered physical paths, three quoted launches, XDG Git defaults, three cleanup outcomes, and frozen-schema arguments. The quoted Codex launch already failed closed before repair and remains a positive control, not a new fix claim.

Five selected current exporter tests all failed against the pre-fix exporter: four schema mutations were accepted, and generated caches invalidated otherwise unchanged source. All pass against the repaired exporter. UTF-8 has a separate primitive replay: the old Buffer-to-string accumulation produces replacement characters for a split crab emoji; the new collector preserves it. This last replay is not an assembled CLI test. Its initial source-marker check used the wrong local variable name and was corrected before the reproduction ran; no production expectation changed.

## 6. Coverage and reach

All 36 harness tests passed, including the coverage run. Node reported `run.mjs` line/branch coverage of 98.76%/88.67% and `export.mjs` 88.60%/86.27%. Coverage demonstrates execution reach, not correctness. Existing-only versus added-test coverage was not separately measured. The local tests combine real filesystem/Git operations, a labeled CLI test double, and direct helper checks. They do not prove every operating-system or subprocess edge case.

## 7. Oracle strength

Tests pair passing semantic grades with forbidden commands, verify tracked fixture files and unspecified Git attributes, reject tampered schema bytes, and inspect the actual grader CLI directory after termination. Bundle filtering has an opposing control: the same generated file must remain visible to task-mutation snapshots. The scanner emitted 12 low-confidence snapshot leads; inspection found explicit mutation and tamper assertions, not regenerated acceptance snapshots. None established another defect.

## 8. Reliability

The 36-test suite passed repeatedly, including a fresh UTC process and the instrumented coverage run. Temporary configuration and symlinks are test-owned; test cleanup includes child temporary roots. Authentication and model generation remain external, nondeterministic dependencies. No retries were used to select a passing live result.

## 9. Regression breadth

The review-plugin suite passed 135 tests with two opt-in provider tests skipped. `git diff --check` passed. Skill frontmatter was not revalidated in this pass because no instructions changed; earlier validation remains historical evidence.

The [format-2 live smoke report](../evals/results/2026-09-11-portability-smoke.json) passed 2/2 targeted cases: implicit Rust simplification and an explicitly selected review-loop preview. All invocation, scope, findings, trace, and outcome checks passed. Commands and grades were inspected: the former changed only `src/lib.rs` inside the fixture; the latter only read instructions. Both grader directories were absent afterward. This is a partial run with 23 omitted cases, not a new 25/25 claim.

## 10. Findings and disposition

All seven reviewed findings are repaired with regression evidence. No additional confirmed defect remains from this scoped verification. The format-2 report was exported and verified against the current evaluator, suite, schemas, skill bundle, and raw artifacts. Both historical format-1 reports also verified using their preserved original evaluator and matching sources; they were not migrated or relabeled.

## 11. Residual risks

Command patterns and instruction-read detection are proxies, not a shell interpreter. Task snapshots do not monitor every external temporary file or reverted shell write. The live simplification command used a temporary compiler output outside the fixture, illustrating that boundary. Bundle exclusions reserve specific generated names; they do not identify every possible cache. Cleanup after an uncatchable parent kill is not guaranteed, and historical leaked directories were not swept. Other platforms, Node 24, a full current live suite, and an authorized multi-reviewer loop were not run. Grading uses another Codex pass, not an independent model family.

## 12. Remediation verification

```sh
node --test evals/*.test.mjs
node --test --experimental-test-coverage evals/*.test.mjs
node --test plugins/jig-review/tests/*.test.mjs
node evals/export.mjs --verify evals/results/2026-09-11-portability-smoke.json
git diff --check
```

For a fresh paid smoke run: `node evals/run.mjs --live --case rust-implicit-simplify --case loop-explicit-preview --timeout 240`. Export selected runs with `--partial`; retain any failures and raw artifacts.

## 13. Retained evidence

Audit directory: `/tmp/jig-harness-portability-aVtEcP`, with baseline runner/exporter, baseline replay logs, coverage start/completion logs, UTC and plugin results, scanner leads, protected-file comparison, UTF-8 primitive replay, and requirement traceability. Live artifacts: `/tmp/jig-skill-evals-XRpuT7`. The checked-in report records all hashes and the raw location required for re-verification. Temporary evidence directories must remain available to replay these checks.
