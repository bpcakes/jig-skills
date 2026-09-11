# Evaluation and review-policy contracts: root cause and repair

## 1. Executive outcome

The four review findings have a common design-level contributor: important contracts were implicit or duplicated across boundaries. They do not demonstrate that the overall skill/evaluator architecture needs replacement. The appropriate repair is to give each invariant one owner and test its observable consequences across the boundary.

Accept with residual risk — A1 behavioral audit. Six new checks fail against the preserved pre-fix state and pass against the candidate; four are runtime contract checks and two are structural policy guards. All 10 selected live Codex trials pass. This supports accepting the scoped repairs, not a claim that all skill behavior is correct. No commit, staging, dependency installation, or new comprehensive-review run is part of this repair.

## 2. Scope and evidence

The pre-fix working tree was copied to `/tmp/jig-contract-audit-06s4Lx` before editing. This is the baseline, not the much older repository HEAD (`0f106352c36bde312a0621971c2a894a6f51be3c`). Its temporary Git commit is `8936f0d8d9e560c21e74e7ef7c0ad92fe05a2544`. The candidate evaluator and plugins are preserved under that directory's `final-source` subdirectory. The coding-agent-test-audit skill guided baseline contrasts, protected-file inspection, coverage, and evidence limitations. No independent gold implementation was available.

The task covers read-evidence ordering, source Git identity, the React test-review template/reference contradictions, and the missing SQLx Low category. Existing earlier repairs and historical reports remain intact.

## 3. Behavioral contract

| ID | Invariant | Root cause and repair |
|---|---|---|
| R1 | Equivalent read evidence has the same serialized representation regardless of catalog layout | A set was represented as an array whose order accidentally came from directory traversal. Canonical unique lexical ordering now belongs to the shared extractor, not the exporter. |
| R2 | Source provenance identifies the explicit source repository | One raw Git call inherited repository selectors while fixture calls were isolated. The fixture-specific helper boundary encouraged incomplete application; source, fixtures, and child commands now share Git isolation. |
| R3 | Templates and selectively loaded references implement the same evidence standard | Repeated report templates and imperative checklists drifted away from the entrypoint. One authoritative report contract now owns the template; both entrypoint and detailed rules route to it. |
| R4 | Establishing a defect and rating its impact are separate decisions | A missing Low category left an incomplete decision model: a real minor defect could be inflated or suppressed as a preference. SQLx now explicitly separates defect validity from impact and includes Low. |

R1 is an implementation error exposing an underspecified representation contract. Sorting only inside the exporter would mask the symptom without fixing producers and other consumers. R2 is a missed call site amplified by an incorrectly narrow abstraction boundary, not a broken Git algorithm. R3 is a maintainability/design flaw: instruction text is executable policy, so duplicating it creates multiple behavioral authorities. A neutral heading alone would leave conflicting reference imperatives intact. R4 is principally a rubric omission; the deeper issue is conflating whether a defect exists with how serious it is. None warrants a new framework or wholesale rewrite.

## 4. Diff and evaluator integrity

Changes are limited to `evals/run.mjs`, integration tests and the deterministic CLI fixture, a new contract-test module, two additional live cases, React test-review instructions and a new report reference, SQLx severity guidance, and documentation/evidence. Existing live case definitions, response schemas, grading schema, scope allowances, CI gates, and historical reports were not weakened or rewritten.

The final protected comparison records four modified evaluator files, one added test file, and one new live report, with 19 protected files unchanged and none deleted. Saved read inventories still must match independently recomputed canonical arrays exactly; genuine membership changes remain errors. Historical reports require their original hashed evaluator and source, as before.

## 5. Replay matrix

| Same check against both states | Pre-fix | Candidate | What it establishes |
|---|---|---|---|
| Read-set permutation, duplicate-input, and event-order property | Fail | Pass | Stable, unique, disjoint encoding; not tied to a particular skill name |
| Assembled runner/export with cross-plugin exact reads | Fail: reads mismatch | Pass | Actual flat-bundle/source-catalog boundary works |
| Assembled runner/export with catalog glob | Fail: uncertainReads mismatch | Pass | Ambiguous read sets use the same contract |
| Source commit with foreign `GIT_DIR` and `GIT_WORK_TREE` | Fail: foreign commit recorded | Pass | Explicit source repository owns provenance |
| React template-routing and neutral-format guard | Fail | Pass | Structural policy ownership, not model behavior |
| SQLx two-stage severity guard | Fail | Pass | Complete written rubric, not model behavior |
| Existing 77 tests | Pass | Pass | Regression protection; these did not reproduce the findings |

The candidate's cross-layout tests additionally erase recorded reads and require export rejection. No failed baseline check was changed to pass by weakening an oracle. Live instruction outcomes are current-behavior evidence, not a measured old-versus-new improvement rate.

## 6. Coverage and reach

Existing tests alone and the expanded suite both reach every changed executable runner line; runner line coverage remains 99.19%. This is an instructive distinction: the old suite executed the sorting and Git paths but did not assert catalog permutation or repository-selection invariance. The new checks supply discrimination, not merely extra reach. Runner branch coverage is 89.80% with existing tests and 89.84% with all 83; exporter coverage is 90.51% lines / 90.77% branches in the expanded run. Uncovered runner/exporter lines are CLI dispatch/help paths, not these repairs. Export/verify is also exercised separately with live artifacts.

Markdown structural checks cannot measure instruction compliance. The live cases evaluate outcomes, while raw command output establishes whether the revised references were actually read.

## 7. Oracle-strength analysis

The ordering property uses multiple catalog permutations, duplicate names, overlapping exact/uncertain evidence, and reversed event order. Integration cases use real `cat`/`head` output from copied multi-plugin skills, not an exporter-shaped hand-authored summary. The foreign repository has a distinct asserted commit, and the source identity is independently read under a clean environment.

The CLI fixture is an explicitly executable deterministic test double; its synthetic grades are not presented as model evidence. Semantic live cases include intentional test IDs with compensating coverage, a real missing confirmation assertion, a valid runtime SQLx query, and minor React/SQLx defects. The added severity criteria remain outside the task workspace and do not appear in the agent prompt. Fixture READMEs specify product contracts and impact boundaries, not the expected finding. These are public regression fixtures, not hidden or independent-family oracles.

## 8. Reliability

All 83 evaluator tests pass on Node 22.23.2 and Node 24.19.0; the latter ran in UTC. Focused candidate checks also passed separately. Tests own fresh temporary directories, isolate ambient Git selectors, and install the CLI double with executable mode. No retries, dependencies, or permanent skips were added. Live trials repeat each selected case twice but cannot establish broad statistical reliability.

The scanner emitted 15 low-confidence leads: thirteen references to content snapshots and two bounded readiness deadlines. These unchanged tests assert mutation-sensitive behavior and process readiness; inspection found no new golden-output laundering or wall-clock result oracle. Scanner counts are not findings.

## 9. Regression breadth

The review-plugin suite passes 135 tests with two existing opt-in provider tests skipped. Both changed skills pass frontmatter validation; `git diff --check` passes. The full evaluator suite increased from 77 to 83 tests without removing any. The live suite increased from 31 to 33 cases by adding severity-sensitive React and SQLx cases.

The [live report](../evals/results/2026-09-11-contracts.json) passes 10/10 planned trials: five cases, each repeated twice. Both valid-query and intentional-test-ID pairs produce no findings; both confirmation trials report Medium; both greeting-gap and wrong-caption-column pairs report Low. Findings and semantic grades were inspected, not accepted from counts alone. Completed command outputs contain the new report contract in every React trial and the revised Low guide in every SQLx trial. Relevant detailed references were also read. All task files, HEADs, and indexes remain unchanged, and every grader workspace was removed. Export and current-source verification pass. The report explicitly omits the other 28 suite cases; it is not a full-suite live pass.

## 10. Findings and disposition

The original ordering finding is Medium / dynamically confirmed (R1); source identity is Low / dynamically confirmed (R2); React policy drift and the SQLx severity omission are Low / directly confirmed in the instructions (R3–R4). Their common validation gap was coverage without the relevant cross-boundary oracle (`CA-OR-02`, `CA-EV-05`), alongside duplicated policy (`CA-MT-01`). Repairs follow the owning contracts above rather than matching the review's particular examples.

Reproduce the original evaluator failures with the commands in the appendix; the two ordering errors are `Evidence mismatch: rust-implicit-simplify-1 reads` and `... uncertainReads`. Source identity records the deliberately unrelated temporary repository's commit instead of the baseline source commit. The template guards expose the missing route and missing Low category. The six checks all pass against the candidate. Static policy findings do not alone establish how often an earlier model would misbehave.

## 11. Residual risk and evidence gaps

Command/read detection remains a bounded proxy, not a complete shell interpreter. Canonical encoding does not fix unrecognized shell syntax or incomplete instruction-read attribution. Local hashes identify content but are not an adversarial authenticity guarantee. Same-family Codex grading, public minimal fixtures, and a small selected run do not prove behavior across all skills or real repositories. Other operating systems and old-versus-new live model comparisons were not tested. The historical reports and preserved source/raw directories must be retained together to reverify them.

## 12. Remediation verification plan

Keep the canonical-set, explicit-repository, and single-template contracts when changing discovery or report logic. New examples must preserve no-findings cases and distinguish minor defects from optional preferences. Before accepting future instruction changes, run affected positive/negative/severity cases and inspect returned reference content as well as final answers and grades. Do not infer a successful regression repair from an unchanged aggregate coverage percentage or a green old suite.

## 13. Appendix

Audit root: `/tmp/jig-contract-audit-06s4Lx`. It contains preserved baseline/candidate sources, `protected-before.json`, `protected-comparison.json`, `scanner.json`, and the baseline/candidate Node and plugin logs. No gold-fix outcome is claimed.

Raw live artifacts: `/tmp/jig-skill-evals-1tMxem`, including task/grader prompts, commands, JSONL outputs, answers, grades, frozen schemas and skill bundles, and before/after snapshots. Retain these directories or archive them with the matching source; the exported report alone is not a self-contained reproduction.

```sh
EVAL_TEST_LIBRARY=/tmp/jig-contract-audit-06s4Lx/evals/run.mjs EVAL_TEST_SOURCE=/tmp/jig-contract-audit-06s4Lx node --test evals/contracts.test.mjs
EVAL_TEST_RUNNER=/tmp/jig-contract-audit-06s4Lx/evals/run.mjs EVAL_TEST_EXPORTER=/tmp/jig-contract-audit-06s4Lx/evals/export.mjs node --test --test-name-pattern='runner evidence round-trips|source commit belongs' evals/integration.test.mjs
node --test --experimental-test-coverage evals/*.test.mjs
TZ=UTC /home/aa/.local/share/mise/installs/node/24.19.0/bin/node --test evals/*.test.mjs
node --test plugins/jig-review/tests/*.test.mjs
node evals/run.mjs --live --case react-test-valid-testid --case react-test-missed-confirmation --case react-test-minor-display-gap --case sqlx-runtime-query-valid --case sqlx-minor-display-defect --repeat 2 --timeout 240 --grade-timeout 240
node evals/export.mjs /tmp/jig-skill-evals-1tMxem evals/results/2026-09-11-contracts.json --partial
node evals/export.mjs --verify evals/results/2026-09-11-contracts.json
git diff --check
```

Baseline suite: `node --test evals/*.test.mjs` from the audit root. Existing-only candidate coverage: exclude `contracts.test.mjs` and select out the three new integration tests with `--test-skip-pattern='runner evidence round-trips|source commit belongs'`; this is an audit comparison, not a CI exclusion. Toolchains: Node 22.23.2 and 24.19.0, Git 2.43.0, authenticated Codex CLI 0.154.0 with its default model and user configuration ignored.
