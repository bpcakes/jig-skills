# Provenance, read evidence, and secret-sink follow-up

## 1. Executive outcome

Accept with residual risk — A1 behavioral audit. All five findings from the latest comprehensive review are addressed. Twelve targeted checks fail against the preserved pre-fix evaluator and pass against the candidate; two additional controls already passed. Four live Codex trials exercise the corrected security instructions. This is scoped repair evidence, not proof of full skill-suite correctness.

## 2. Scope and evidence

Baseline evaluator and plugins: `/tmp/jig-eval-provenance-uOQbCr`, copied before changes. Repository HEAD remains `0f106352c36bde312a0621971c2a894a6f51be3c`; the baseline is the preserved working tree, not HEAD's older content. The coding-agent-test-audit skill guided preservation, baseline contrasts, negative controls, and evidence limits. No independent gold implementation was available. No dependencies were installed and no files were staged or committed.

Changes affect [run.mjs](../evals/run.mjs), [export.mjs](../evals/export.mjs), their tests/CLI fixture, and the Rust security [entrypoint](../plugins/jig-rust/skills/rust-security-boundary-review/SKILL.md) and [secret-handling reference](../plugins/jig-rust/skills/rust-security-boundary-review/references/secrets-and-authorization.md).

## 3. Behavioral contract

| ID | Required behavior | Evidence |
|---|---|---|
| R1 | Unselected, unread references may evolve without invalidating partial runs | Partial export/verification and entrypoint control |
| R2 | Recompute exact/uncertain reads before deciding provenance requirements | Changed-reference and erased/missing-evidence tests |
| R3 | Successful numbered instruction reads count as invocation | Real `nl`, `cat -n`, and `grep -n` output |
| R4 | Lookup/help/version checks are not workflow launches | Availability controls paired with actual subsequent launches |
| R5 | Secret derives alone are not confirmed disclosure | Sink/no-sink Codex cases, each repeated twice |

## 4. Diff and evaluator integrity

The exporter uses recorded trial targets plus independently recomputed exact and uncertain reads from non-error trials. It requires both saved read arrays to match that recomputation. Every frozen bundle and current discovery entrypoint still has to match. Error records remain failures and do not claim a verified read inventory.

The runner normalizes common numeric line prefixes and distinguishes `command -v`/`-V` lookups and plain Claude/Cursor help/version queries from execution. It still detects later launches and flag-like text used as prompt data. Secret-handling instructions now consistently require a reachable unauthorized disclosure path and classify derive-only concerns as optional hardening.

The protected `evals/**` comparison records seven modified files and one new result record, with no deletions. Existing fixtures' summary arrays were made explicit to match their traces; no outcome criteria, scope allowances, schemas, historical reports, CI policy, skips, or dependencies were weakened. The 31 live case definitions are unchanged.

## 5. Replay matrix

| Check group | Baseline | Candidate | Classification |
|---|---|---|---|
| Partial export with unrelated reference change | 1 failure | Pass | Bug-discriminating |
| Uncertain non-target reference and erased/missing read evidence | 5 failures | Pass | Bug-discriminating |
| Exact non-target reference and frozen-reference controls | 2 passes | Pass | Regression-only, not reproduced defects |
| Numbered read integration | 3 failures | Pass | Bug-discriminating |
| Availability-check integration | 3 failures | Pass | Bug-discriminating |
| Security instructions | Static contradiction confirmed; old skill not live-replayed | 4 live passes | Current behavior, not an improvement-rate estimate |

Exact commands and full outputs are retained in `baseline-export.json`, `baseline-integration.json`, and the candidate logs under the audit root. Harness test collection increased from the preceding verified 61 tests to 77; none was removed.

## 6. Coverage and reach

The final Node 22 run reports runner coverage of 99.19% lines / 89.45% branches and exporter coverage of 90.51% / 90.48%. Tests reach the changed normalization, lookup, read-comparison, evaluated-set, and conditional hash-check paths through both helpers and assembled entrypoints. Current-source, frozen-source, exact-read, uncertain-read, and missing-evidence rejection paths are exercised. Uncovered lines are CLI dispatch/help branches; real export/verify separately exercises exporter dispatch. Existing-only versus added-test coverage was not separated. Coverage measures reach, not correctness.

## 7. Oracle strength

The tests distinguish mutable unrelated references from immutable evaluated references, entrypoints, and frozen evidence. Deliberately erasing recorded reads must fail even when the final verdict is otherwise correct. Numbered output comes from actual system tools, not a hand-copied positive answer alone. Wrong skill names and failed reads remain negative controls. Lookup followed by a real launch still fails, and help-like prompt text does not exempt execution. These are behavioral assertions; no snapshot was regenerated to match a failed candidate.

## 8. Reliability

All 77 tests pass on Node 22.23.2 and Node 24.19.0, with the latter run in UTC. Tests use fresh owned temporary directories and the explicit deterministic CLI double; they do not consume model usage. The scanner emitted 15 low-confidence leads: thirteen snapshot references and two bounded readiness deadlines. Inspection found mutation-sensitive assertions and readiness semantics, not weakened golden outputs or elapsed-time output expectations. No retries or new skips were introduced.

## 9. Regression breadth

The review-plugin suite passes 135 tests, with two existing opt-in provider tests skipped. Rust security frontmatter validation and `git diff --check` pass.

The [live report](../evals/results/2026-09-11-provenance-security.json) passes all four planned trials. In both no-sink trials, Codex reports no confirmed disclosure; in both log-sink trials it traces the bearer token through derived Debug into the unauthorized vendor log and rejects the later sensitive-header flag as protection for that earlier event. Every trial read the revised secret-handling reference. Answers, grades, and reference-read traces were inspected; no task files changed and all grader workspaces were removed. Export and verification pass against the retained raw artifacts and matching source. This covers two of 31 cases, with the other 29 explicitly omitted.

## 10. Findings and disposition

All five requested low-severity findings are resolved. R1–R4 are dynamically confirmed by baseline contrasts; R5's conflicting instructions were directly observed and its replacement behavior was checked through Codex. The relevant testing risks are wrong-target validation (`CA-EV-02`) and false or insufficient read-evidence decisions (`CA-OR-02`). No new unresolved finding was established. The prior edge-case report still verifies using its preserved original evaluator/source; historical results were not rewritten.

## 11. Residual risk and evidence gaps

Command and read detection remain bounded proxies, not complete shell interpreters. Direct reference-only reads, arbitrary output transformations, aliases, and unknown wrappers are not exhaustively attributed. Plain help/version queries are supported; arbitrary mixed-option invocations are not guaranteed. Public fixtures, same-family model grading, and local hashes are not an adversarial authenticity or confidentiality boundary. Four selected trials are not a full-suite or broad reliability estimate. Other operating systems and new live provider-adapter checks were not exercised.

## 12. Verification commands

```sh
node --test --experimental-test-coverage evals/*.test.mjs
TZ=UTC node --test evals/*.test.mjs
node --test plugins/jig-review/tests/*.test.mjs
node evals/export.mjs --verify evals/results/2026-09-11-provenance-security.json
git diff --check
```

Run from the repository root; the second command used Node 24. The live command was `node evals/run.mjs --live --case security-debug-without-sink --case security-debug-log-sink --repeat 2 --timeout 240 --grade-timeout 240`, using authenticated Codex CLI 0.154.0 and its default model with user configuration ignored.

## 13. Retained evidence

Audit root: `/tmp/jig-eval-provenance-uOQbCr`, containing baseline sources, `final-source`, protected manifests/comparison, traceability CSV, scanner leads, baseline failures, and final Node/plugin command logs. Raw live run: `/tmp/jig-skill-evals-oGSozf`. Reports retain coverage, hashes, configuration, answers, grades, and commands; raw artifacts additionally retain prompts and detailed traces. These temporary directories must be retained or archived separately to reverify. Source changes correctly require the matching original evaluator; checked-in reports alone are not self-contained model reproductions.
