# Skill behavior evaluations

The opt-in [Codex harness](../evals/run.mjs) tests invocation, task outcomes, and execution traces. It complements skill validation and candidate-scanner tests: a scanner hit does not prove a finding, and valid frontmatter does not prove that a skill follows the user's scope.

The approach follows OpenAI's [skill evaluation guidance](https://developers.openai.com/blog/eval-skills). See the [scope and context audit](skill-scope-and-evidence-audit.md) for the changes that prompted these cases and the recorded results.

## Run

Use Node 22 or newer and an authenticated Codex CLI. The runner was exercised with Codex CLI 0.154.0. It requires support for `exec --json`, `--output-schema`, `--ephemeral`, `--ignore-user-config`, and `--ignore-rules`; unsupported options fail the run rather than falling back to broader permissions.

List cases without invoking Codex:

```sh
node evals/run.mjs
```

Run the suite, a selected case, or repeated trials:

```sh
node evals/run.mjs --live
node evals/run.mjs --live --case error-four-from-valid
node evals/run.mjs --live --case rust-implicit-simplify --repeat 3
```

Live runs consume Codex usage. Each case invokes Codex for the task and again for semantic grading. `--model MODEL` and `--effort EFFORT` select the task model and reasoning effort. `--judge-model MODEL` and `--judge-effort EFFORT` independently configure the grader; omitted judge settings inherit their task counterparts for compatibility. Omitted task settings use CLI defaults with user configuration ignored. Pin both roles when comparing changes, hold the judge fixed, and inspect disputed grades manually.

For an explicit Astra regression run:

```sh
node evals/run.mjs --live --model gpt-6-astra --effort medium \
  --judge-model gpt-6-astra --judge-effort medium \
  --case astra-swift-named-clean --case astra-component-independent-options
```

`medium` is an example, not a catalog-wide optimal setting. The harness passes effort through the Codex CLI [`model_reasoning_effort` configuration key](https://developers.openai.com/codex/config-reference), so it accepts only the documented `minimal`, `low`, `medium`, `high`, and `xhigh` values. It rejects `none`, `max`, and `ultra`; Max and Ultra exposed by some Codex product surfaces are not values of this configuration key, and Ultra adds delegation rather than only changing single-agent reasoning. Explicitly selected Astra also rejects `minimal`. The harness never substitutes another model on failure.

`--timeout SECONDS` defaults to 180; `--grade-timeout SECONDS` independently overrides the grading deadline and otherwise inherits `--timeout`. Both are recorded in the manifest. Use `--output NEW_DIRECTORY` for a persistent artifact destination; the directory must not exist. The default is a fresh temporary directory whose path is printed at startup. Artifacts and task workspaces are retained for inspection. Temporary roots are resolved to physical paths before invoking Codex. Grader workspaces are removed after success, process failure, timeout, or handled cancellation. SIGINT/SIGTERM terminate the active provider process group and stop subsequent trials; interrupted results remain failed. Queued signals from synchronous Git setup are handled before launching a provider or another trial. An uncatchable kill or machine shutdown can still prevent cleanup.

## What the cases establish

The [92-case suite](../evals/cases.json) covers skill discovery, review findings, repair decisions, and scope preservation. It includes counterexamples for Rust, React, SQL, privacy, and planning skills. The two one-pass review/fix cases explicitly prohibit re-review, matching the current routing contract. The paired `review-merge-clean-inventory` and `review-merge-dirty-inventory` cases exercise final reporting: conditional staging advice, preserved zero/nonzero inventory counts, and a quoted report instruction that must not authorize edits. They start at a completed review handoff and do not establish full reviewer orchestration or loop convergence. Twelve `selection-*` cases cover natural-language design assessments, nearby general tasks, generic plan implementation without Cursor selection, requested plan artifacts, privacy intake, and privacy summary/retest/source-review boundaries. An [earlier selected live run](../evals/results/2026-09-18-selection-routing.json) passed all 12 in isolated fixtures. A [later run](../evals/results/2026-09-18-selection-routing-split-string.json) passed 11/12: the Rust boundary assessment introduced a hypothetical future representation that its criterion excludes. Both reports retain their original harness hashes; neither verifies subsequent parser changes or installed-plugin discovery behavior.

The 21 frozen-history loop cases are marked `runtime: "markdown-loop-v1"` and excluded from current evaluation selection. Explicit selection is rejected with a pointer to the original evaluator/skill revision. The default suite therefore runs 71 current cases; exports list historical cases separately, never as missing or successful current coverage. Keep these fixtures as historical reproductions, not evidence of controller correctness. Historical live results remain tied to their recorded skill versions.

Run the current deterministic controller lifecycle checks with:

```sh
node --test plugins/jig-review/tests/review-fix-controller.test.mjs
```

This suite executes real state transitions, subprocess stubs, repairs in isolated copies, validation, application, and terminal reviews. It also exercises failure, preservation, and resume paths. See the [review-fix verification guide](../plugins/jig-review/tests/review-fix-behavior.md) for its evidence limits and live evaluation requirements. No live provider or natural-language routing result is implied by these deterministic tests.

Each case starts in a separate Git repository with fixture files and a copy of the skill catalog. Scope cases contain uncommitted edits in both the requested target and an unrelated file, so they exercise change-triggered behavior rather than relying on an empty diff. Cases may also identify fixture paths to stage before the task; the stale comprehensive-review repair case uses this to require preservation of an already-staged correction. `initialDiff` includes both staged and unstaged changes relative to `HEAD`. A frozen bundle and content hashes identify the skill versions used throughout a run. The `exclude-generated-v1` bundle policy excludes `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, and `.DS_Store` path components, but retains authored untracked files. This filter does not apply to task-mutation or case-artifact snapshots. Both response schemas are separately frozen, hashed, and passed to Codex from the artifact directory. The tested checkout contains no harness criteria or grading results. Bundled skills may still contain their own documented examples; the suite is a regression set, not a held-out benchmark.

The task agent gets workspace-write permission so an unwanted edit is observable. Network use, dependency installation, and external services are excluded from the fixture task. Personal skills found in the standard user locations are disabled under both symlink aliases and resolved paths, with cycle detection. User configuration, MCP servers, web search, memories, and multi-agent features are disabled. Git operations use one isolation boundary for source provenance, fixture setup, and the Codex child: ambient Git configuration and environment overrides are ignored, signing and hooks are disabled, fixture initialization uses an empty template, and harness Git commands have a timeout. Global ignore and attributes files are explicitly disabled, including implicit XDG defaults. An inherited `GIT_DIR` cannot redirect the recorded source commit to another repository. Authentication remains with the existing Codex account. These controls reduce environment variation; they are not an adversarial security sandbox.

Except for the explicitly granted handoff-fixture paths described below, task commands cannot write to ambient `$TMPDIR` or `/tmp` outside their workspace: both Codex temporary-write exclusions are enabled. The frozen skill bundle and schemas are checked before and after each trial, after task execution, and at completion; a mismatch fails and stops the run. This protects writes, not confidentiality: the CLI still permits broader reads, so keeping criteria outside the workspace is not a hidden-test security boundary. These public cases and same-account processes are not an adversarial benchmark.

Checks combine several independent observations:

- **Invocation:** a successful command must name the fixture's exact skill path and return its frontmatter. Quoted and escaped paths with spaces and common line-number prefixes from `nl -ba`, `cat -n`, or `grep -n` are supported. Same-name personal skill reads, mentions in the final answer, and failed reads do not count as positive proof. Relative paths in commands that change directories require absolute-path evidence for positive attribution. Successful reads with matching frontmatter but ambiguous paths (including globs) are recorded in `uncertainReads`; they produce `invocation: null` and cannot pass a negative-discovery case. This is inconclusive evidence, not proof of a particular read. Loaded-skill cases test execution restraint, not discovery. `expectInvoke: null` permits either reading or not reading a skill: discovery itself is not execution authorization.
- **Scope:** before/after content and permission snapshots detect added, removed, or modified files. HEAD and index fingerprints detect commits or staging. Every completed file-change path is checked against the allowlist, including reverted writes and move endpoints, in both review and implementation cases.
- **Findings:** case-specific counts catch missed defects and false positives. Counts alone cannot pass a case.
- **Outcome:** a separate Codex pass receives the original task, committed fixture baseline (`gitBase`), user diff (`initialDiff`), task-start and final files (`before`/`after`, including permitted new artifacts), answer, completed commands, recorded file changes, and private semantic criteria. The distinction matters for review-only tasks: unchanged task-start/final files do not mean the user supplied an empty Git diff. Every criterion needs a passing result and concrete evidence. Missing, duplicate, failed, or empty-evidence grades fail closed.
- **Trace:** JSONL records tool calls and outputs, including completed reference reads. Cases with `forbidWorkflowLaunches` inspect executable positions and quoted shell-wrapper commands, distinguishing launches from searches for reviewer names. Codex global options and their operands do not hide `review`, `exec`, or its `e` alias. `command -v`/`-V` lookups and plain Claude/Cursor help or version queries are not launches; a later launch in the same command still fails. The bounded loop cases use `forbidReviewerLaunches` to reject those same external reviewer invocations while allowing local option and fingerprint helpers. `forbiddenScriptLaunches` rejects named launchers in executable or interpreter script positions while allowing file reads and searches; optional `forbiddenCommandPatterns` remain available for literal restrictions. Failed or incomplete turns cannot pass. Timeouts and process failures are recorded as failures, not skipped cases.

Each case retains prompts, argv, raw JSONL, stderr, final answers, snapshots, and grades. Output streams preserve UTF-8 characters across chunk boundaries and enforce byte limits (32 MiB stdout, 8 MiB stderr). Before execution, `summary.json` format 4 records every planned case/iteration, a `running` state, the CLI version, source commit, requested task/judge configuration, bundle policy, and schema/bundle/suite/harness hashes. Each recorded trial explicitly marks the agent and judge phases `not-started`, `attempted`, or `completed`; atomic summary replacements add verdicts and terminal run state (`completed`, `interrupted`, or `failed`). Review raw commands and grader explanations when a result is surprising. Workflow detection is a bounded proxy, not a complete shell parser: aliases, variable-built commands, substitutions, and arbitrary interpreter programs are not exhaustively analyzed. The runner also cannot recognize every reverted shell mutation, skill read, or unrelated action in a trace.

## Export and verify evidence

New runs record separate requested task/judge model and effort, per-process elapsed time, exact exit status, and a stop reason of `timeout`, `cancelled`, `output-limit`, or `null`. `timedOut` is true only for the timeout reason. A successful JSONL trace must contain exactly one `turn.completed` event; duplicate terminal events are ambiguous and rejected rather than treated as additive usage. Successful traces also summarize input/cached/output tokens, exact repeated commands, and successful commands whose text mentions `SKILL.md` or `/references/`, including those commands' whole output byte counts. Those mention metrics deliberately do not claim that a file was read: listings count, compound-command output is not apportioned, and templates or scripts without either path token are outside the proxy. Missing usage is `null`, not zero. Repeated checks may be legitimate; none of these metrics is an optimization score. `reported: null` means the CLI did not independently expose effective provider model/effort: requested flags and a successful response are not a resolved-model attestation. Raw artifacts retain failed attempts as well as successful ones. Export requires prompt, command, execution, JSONL, stderr, and response artifacts for completed phases; attempted phases with an execution record require all except the optional response, while spawn failures without an execution record permit only prompt and command. Additive execution fields require a future format version.

The exporter verifies configuration against saved CLI arguments and metrics against raw traces. Unconstrained Markdown style, automatic clarification classification, installed-plugin discovery, live multi-reviewer loops, and steering still require separate trials; the default harness deliberately disables those capabilities.

Export one run against the current source. By default it must cover the complete suite. The exporter refuses missing cases, mismatched harness or suite versions, stale discovery entrypoints, stale evaluated/read skills, duplicate trials, and verdicts that disagree with the raw evidence. It preserves failed trials rather than selecting only passes. Full current-skill checks cover recorded trial targets and recomputed exact or uncertain reads from non-error trials, not every target mentioned anywhere in the suite. Both saved read arrays must match recomputation. References in unselected, unread skills may differ; every frozen bundle and every current discovery entrypoint must still match. Error records remain failed and do not assert a verified read inventory.

```sh
node evals/export.mjs /path/to/run /path/to/new-report.json
node evals/export.mjs --verify /path/to/new-report.json
node evals/export.mjs /path/to/selected-case-run /path/to/new-partial-report.json --partial
```

Full export requires all planned trials and a completed run, as well as every suite case. Partial export requires the explicit `--partial` flag and lists omitted cases, omitted planned trials, and run state; interrupted repetitions cannot masquerade as a complete run. Partial exports may preserve an experiment with no finished trials. Keep separate reports when correcting a fixture and rerunning only that case, including the original failed trial.

Verification recomputes scope, invocation, counts, trace restrictions, and grading checks, and compares hashes of all case artifacts plus both frozen and current schemas. Keep the raw run directory and matching source revision to reverify; a changed suite correctly rejects verification against that newer source. Format-1 through format-3 historical reports require their original evaluator and matching source. Format 4 adds mandatory requested-configuration and per-phase lifecycle provenance rather than inventing it for older records. The exported JSON is a portable outcome record, but its hashes are not proof of authenticity against a malicious evaluator. No manual multi-run aggregation is needed for new result records.

## Comprehensive-review judgment cases

Eight `review-*` cases exercise the native reviewer assignment with the same shared guidance used by external adapters: omitted versus satisfied requirements, a symptom-only correction versus the responsible shared layer, caller misuse versus a valid shared contract, and weakened versus equivalent test coverage. Expected conclusions stay in grader-only criteria. Fixture contracts describe the product without naming the suspected defect.

These are component evaluations of review judgment, not evidence that the parent orchestrator or live multi-provider execution works. The task is explicitly a native child assignment, so it must not spawn reviewers or route to repairs. Local `review-judgment-fixtures.test.mjs` checks concrete behavior and surviving mutants; it does not prove that an agent finds the issue. Adapter tests separately verify that the shared brief reaches provider prompts.

Run affected live cases explicitly when desired, then inspect findings, recommendations, false positives, and traces:

```sh
node evals/run.mjs --live --case review-intent-omitted --case review-intent-complete \
  --case review-layer-symptom --case review-layer-owner \
  --case review-caller-misuse --case review-caller-valid \
  --case review-coverage-weakened --case review-coverage-equivalent
```

## Maintain

Add cases with a realistic user request and minimal source artifacts. `files` defines what the task agent sees; optional `baseFiles` overrides the committed revision before those files are written, producing a dirty worktree. The runner saves the exact case definition and initial diff outside that worktree. Keep expected consequences in `criteria`, outside `files` and the task prompt. A fixture README may describe the actual product contract, but should not reveal the suspected defect or desired review answer. Pair defect cases with plausible correct cases, and include an adjacent task that should not trigger the skill.

Frozen-history fixtures must also represent the stated retained changes in Git: commit the established contract and pre-repair source/tests, then supply the retained state. An undone source repair can legitimately leave only its new regression changed; do not invent a source delta for a round trip or substitute a placeholder README diff. The local convergence-fixture tests check those diffs and replay failure causes. The epic oracle rejects own-only, descendant-only, and accept-everything mutants. These are fixture checks, not evidence that a live agent's final patch passed independent post-repair checks; inspect that patch separately.

Do not weaken an oracle to turn a failed run green. Determine whether the task, expectation, harness, or skill is wrong using the raw evidence; retain the original failed result when rerunning. For meaningful instruction changes, run the affected cases and inspect both findings and traces. Repeated trials improve confidence because model selection and generation are not deterministic.

The local harness checks run without authentication and are included in CI:

```sh
node --test evals/*.test.mjs
```

They check trace completeness, invocation location and uncertainty, symlink/cycle handling, grading omissions, recorded and net mutations, Git isolation, streaming output, cancellation during setup and provider execution, independent grader deadlines, frozen inputs, and complete trial export. CLI-boundary integration tests use an explicitly labeled deterministic test double; those results are harness tests, not model evidence. See the [initial repair audit](evaluation-harness-repair-audit.md), [portability follow-up](evaluation-harness-portability-audit.md), [integrity follow-up](evaluation-harness-integrity-audit.md), and [edge-case follow-up](evaluation-harness-edge-cases-audit.md) for baseline contrasts. Live Codex evaluations remain necessary. A passing small suite is evidence about those cases under the recorded configuration, not proof that all skills behave correctly in all repositories.

Read inventories are canonically encoded sets: unique names in lexical order, with exact reads taking precedence over uncertain reads. The shared extractor owns this encoding, so a flat runtime catalog and plugin-grouped source catalog produce identical evidence. Export still compares saved and recomputed arrays strictly; it does not discard membership changes to make a run verify. Integration tests exercise real runner-to-export round trips across those layouts, including ambiguous catalog globs.

The [provenance and read-evidence follow-up](evaluation-provenance-audit.md) records the partial-export, read-attribution, availability-check, and secret-sink rubric repairs. The [contract root-cause audit](evaluation-contracts-audit.md) explains the subsequent ordering, Git repository identity, report-template, and severity fixes and their behavioral evidence.

The `review-followup-address` and `loop-followup-address` cases start with a real scope-bound completed-review handoff and the follow-up “Ok please address.” They allow controller initialization, triage, repair, and validation, then stop at the first pending post-repair reviewer assignment. They prohibit external reviewer launches and do not establish live terminal-review quality or convergence. For these cases only, the task gets two additional writable locations: its owned handoff/scratch directory (also `TMPDIR`) and `.git/jig` for controller state. Neither contains grading criteria or the frozen evaluation bundle. Empty metadata mount points are prepared for Codex sandbox setup. In these fixtures the bundled skill catalog remains readable and covered by evaluator snapshots, but Git ignores it so it is not copied into controller assignments or scanned as application source. Trace scope checks permit writes beneath the two owned roots while still rejecting unrelated source edits, path escapes, staging, and commits. The source checkout, HEAD, and index retain the usual scope checks. Deterministic handoff tests separately enforce assignment ordering and fresh terminal quorum.

The September 19 handoff live attempts did **not** pass. The [Astra export](../evals/results/2026-09-19-review-handoff-astra-incomplete.json) records one completed failure at controller initialization (`spawnSync git ETIMEDOUT`) and one cancelled task; the [Sol export](../evals/results/2026-09-19-review-handoff-sol-incomplete.json) records a cancelled task, with its second planned case never started. No controller run was allocated in these retained trials. Earlier fixture attempts failed during sandbox setup; empty metadata mount points corrected that setup error. Excluding the bundled catalog from Git inputs did not remove the later Git timeout. Remaining attempts were stopped, with provider processes settled, rather than counted as successful or retried indefinitely. These exports preserve unsuccessful evidence against the recorded source and do not establish live routing reliability. The deterministic controller tests establish the handoff ordering and preservation behavior independently.
