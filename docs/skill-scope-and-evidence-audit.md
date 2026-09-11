# Skill scope, evidence, and context audit

Investigated on 2026-09-11 against baseline commit `0f106352c36bde312a0621971c2a894a6f51be3c`. The working tree was clean before this task. All three reported problems were confirmed in the instructions; related problems extended beyond the two simplification skills and the conversion-count rule.

## Scope expansion

The baseline Rust and TypeScript simplification entrypoints explicitly instructed immediate refinement without an explicit request. Rust error-handling, architecture, and test-quality reviews also instructed themselves to run immediately when code changed. SQLx, Rust async, and React hook reviews used code markers as execution triggers. Swift simplification defaulted to all uncommitted code, and plan writing included instructions to implement prototypes and commit.

The revised instructions preserve automatic discovery and existing invocation-policy metadata. Execution follows the user's task and named target. A loaded skill or a changed file does not start another workflow. Review-only tasks produce findings; editing requires that changes be part of the task. Related callers can be inspected to validate a finding without expanding the edit target. An empty diff is not permission to audit the repository.

These boundaries are present in the focused Rust and TypeScript entrypoints, Swift simplification, plan writing, and the shared privacy-audit rules. Adjacent-skill recommendations remain routing advice. Existing bounded implementation and review-fix workflows retain their authorized behavior.

## Heuristics promoted to defects

The audit found several classes of unsupported mandates:

| Baseline instruction | Revised decision standard |
|---|---|
| Flag four or more `#[from]` variants | Trace information preserved and needed by handlers; report actual lost context or recovery distinctions at any count. |
| Flag discards without comments | Check the operation's contract, optionality, caller behavior, and diagnostics. A comment is neither necessary nor sufficient proof of correctness. |
| Mandate error libraries, explicit source attributes, or per-variant matching | Check actual source-chain behavior and consumer needs; accept intentional opaque errors, inferred sources, transparent wrappers, and external consumers. |
| Flag depth, generic nesting, trait size, or repeated setup counts | Establish caller burden, inconsistent change, invalid state, or other concrete maintenance/correctness consequences. |
| Assign critical severity to missing regression tests | Identify a meaningful regression existing coverage would miss; severity follows the affected behavior. |
| Treat `is_ok()`, float equality, or test placement as defects | Evaluate the asserted contract, independent oracle, coverage elsewhere, and determinism. |
| Flag runtime SQLx queries or unchecked macros by default | Inspect schema, binding, types, cardinality, and compensating validation; macro adoption alone is optional. |
| Mandate retries, timeouts, task spans, or a runtime choice locally | Inspect parent policies, supervisors, idempotency, finite workloads, and actual operational consequences. |
| Use a numeric unification threshold as the decision | Use scores only as optional ranking aids; justify shared invariants, ownership, caller costs, and counterarguments directly. |

The error, architecture, and Rust test review entrypoints were rewritten to make these distinctions explicit. SQLx, async, TypeScript type review, React testing/performance, transaction retries, and privacy support received targeted corrections. Existing security and integrity requirements remain: a demonstrated missing authorization check, unsafe data flow, or violated transaction invariant still warrants a finding. Missing context is reported as a limitation, not assigned a defect severity.

## Context efficiency

The current catalog has 39 task skills plus one support entrypoint. Measuring all 40 gives a different baseline from the earlier 39-entry sample. Counts below are Unicode characters, not UTF-8 bytes or model tokens; frontmatter description values exclude YAML quoting.

| Measure | Before | After initial pass |
|---|---:|---:|
| Discovery descriptions, all 40 | 11,006 | 4,402 |
| Rust security entrypoint | 23,906 | 6,848 |
| SQLx entrypoint | 20,655 | 6,417 |
| Rust async entrypoint | 18,842 | 8,647 |
| React hooks/effects entrypoint | 18,086 | 8,090 |
| Rust test review entrypoint | 17,780 | 5,108 |

Descriptions are about 60% shorter. The two entrypoints previously above 20,000 characters are about 71% and 69% smaller. All entrypoints together fell from 447,672 to 367,278 characters; the largest remaining entrypoint is 16,399 characters. Security, SQLx, async, and React lifecycle procedures now live in references selected by the relevant boundary or operation. Error review separately routes propagation/design and recovery/resilience. Detailed review procedures remain available without loading every branch of the checklist.

These sizes are efficiency measurements, not validation thresholds. Names and installation paths also consume discovery space, and the catalog is not guaranteed to fit every host's budget. OpenAI's [current skill guidance](https://learn.chatgpt.com/docs/build-skills) explains that discovery descriptions can be shortened while selected entrypoints are still loaded in full; this motivates both concise discovery and selective references.

## Behavioral validation

The [evaluation harness](skill-evaluations.md) runs actual Codex tasks in isolated workspaces, checks skill reads and mutations, and uses a separate Codex pass for semantic grading. It records raw JSONL traces and identifies the skill content by hash. This follows the invocation, outcome, and trace approach in OpenAI's [skill evaluation guidance](https://developers.openai.com/blog/eval-skills).

Cases cover explicit and implicit invocation, negative discovery, already-loaded skills asked to explain code, scoped simplification, real error and type-boundary defects, correct counterexamples, and abstraction promises. Expectations stay outside the tested workspace. The abstraction cases adapt the distinction already captured in the Rust skill's handwritten examples: an invariant escape warrants a finding; an intentionally transparent representation does not.

Local validation includes all 40 skill frontmatters, the harness's trace/grader/mutation checks, direct-installation tests, local reference checks, and `git diff --check`. Live results and their limits are recorded with the evaluation evidence; they do not imply coverage of every skill or every real-world repository. No before/after model benchmark was used to estimate an improvement rate: the original instruction defects are confirmed by source, and live cases test the revised behavior.

### Initial recorded results (before review follow-up)

The [initial evidence matrix](../evals/results/2026-09-11.json) contains **16 passing cases across eight skills**. It uses a completed 16-case frozen-bundle run, superseding six scope cases with strengthened dirty-worktree trials and the SQLx case with a trial after the initial severity correction. Each selected skill's content hash was checked against that revision. Subsequent review found blind spots in its harness (symlink isolation and reverted implementation writes); retain these results as historical evidence, not validation of the repaired harness.

- Explicit and implicit skill reads were observed in completed tool events.
- Explanation and negative-discovery cases made no file, HEAD, or index changes, including when both target and unrelated files were already dirty.
- Rust and TypeScript simplification changed only the requested file and preserved the specified behavior.
- Codex reported lost I/O origin, discarded required writes, unvalidated TypeScript input, and mutable access that bypasses a validated header invariant.
- Codex accepted four informative error conversions, optional parsing, a proven TypeScript assertion, a valid runtime SQLx query, a complete unit-result assertion, and an intentionally transparent ID representation.
- All four local harness tests and all 14 direct-installation tests passed. All 40 skills passed frontmatter validation.

The evidence file includes final answers, independent grading explanations, skill reads, reference commands, hashes, and local raw-artifact locations. The CLI was `codex-cli 0.154.0`, using its default model with user configuration ignored; no explicit model was pinned. Raw traces and frozen bundles remain in the recorded temporary directories, while the outcome matrix is saved in the repository as a reviewable artifact.

### Review follow-up

The six follow-up findings were addressed: all recorded writes are checked against scope; personal skill symlinks and resolved targets are disabled; reads must identify the fixture skill; fixture Git is isolated; review-loop execution requires user authorization; and residual async/security/React mandates and mandatory score fields were corrected. Discovery remains enabled. See the [repair evidence audit](evaluation-harness-repair-audit.md) for before/after checks and limits.

The repaired harness ran **25 cases across 12 skills**, with **24 passing**. The preview case correctly performed no actions, but its wording prohibited executing anything while its oracle required a command-based skill read. That invocation failure is retained in the [full-run report](../evals/results/2026-09-11-review-fixes-full.json). The fixture was clarified to allow instruction reading without workflow execution; the unchanged invocation and scope checks then passed in a [1/1 targeted rerun](../evals/results/2026-09-11-review-fixes-preview.json). These are separate reports, not a claim of a clean 25/25 single run. The other 24 case definitions and the harness did not change between runs.

The new async, security, and React pairs accepted finite/no-sink/correct-dependency cases and reported lost required writes, credential logging, and stale room connections. Loaded and implicitly discovered loop cases performed only the requested one-pass repair. The corrected explicit preview read instructions without starting reviewers or changing files.

All **16 local harness tests** passed, including CLI-boundary regression tests and evidence-export checks. The broader review-plugin suite passed **135 tests**, with **two opt-in live tests skipped**. All 40 skill frontmatters and `git diff --check` passed. Both new reports were generated and verified by the checked-in exporter, with the historical full run checked against its preserved matching source.

### Portability and provenance follow-up

The next review's seven harness findings are addressed in the [portability audit](evaluation-harness-portability-audit.md): physical temporary paths, quoted workflow launches, implicit Git defaults, frozen schema provenance, generated bundle artifacts, UTF-8 streaming, and grader cleanup. All 36 current harness tests pass; baseline replays distinguish the repaired failures from positive controls. A new [2/2 targeted Codex smoke run](../evals/results/2026-09-11-portability-smoke.json) uses format-2 evidence and explicitly lists its 23 omitted cases. Earlier reports remain historical and require their original evaluator; no full current-suite pass is claimed.

### Trial integrity and React rubric follow-up

The subsequent six findings are addressed in the [integrity audit](evaluation-harness-integrity-audit.md): planned-trial completeness, React test and performance rubric contradictions, harmless-search false positives, temporary evidence writes, and signal cancellation. Format 3 records the experiment before execution and distinguishes incomplete trials from complete selected runs. All 50 harness tests pass on Node 22 and 24. The [six-case live report](../evals/results/2026-09-11-integrity-react.json) passes the four new React positive/negative cases plus scoped simplification and preview restraint; 23 of the now 29 suite cases were not rerun. Historical reports retain their original evaluator requirements.
