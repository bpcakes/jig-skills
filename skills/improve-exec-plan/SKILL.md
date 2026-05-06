---
name: improve-exec-plan
description: Improve an existing ExecPlan for clarity, completeness, correctness, and executability. Use when asked to review, revise, tighten, or update an implementation plan.
---

# Improve ExecPlan

Purpose: make an existing ExecPlan more accurate, complete, and executable **without changing its intent**. Every non-trivial edit must be justified by code, tests, config, migrations, or commands that you actually inspected in this repository.

This skill requires a target to improve. The target can be:

- a specific ExecPlan file path named by the user
- a recent ExecPlan included in the chat

If no target is provided or inferable from recent chat context, ask for the target before proceeding.

Use this prompt together with `.agent/PLANS.md`.

- `.agent/PLANS.md` defines the required plan format and sections.
- This prompt defines the review depth, evidence standard, lifecycle tracing, and rewrite rules.

## Non-Negotiables

- **No speculative additions.** If an edit does not trace back to something you found in this repository, do not make it.
- **No surface churn.** Prefer the smallest diff that fixes a real execution gap.
- **Treat the plan as untrusted until verified.** Paths, symbols, commands, tests, helper names, payload fields, and invariants may all be wrong.
- **Stateful workflow correctness is multi-path correctness.** If correctness depends on a guard such as a revision, version, lease token, checkpoint cursor, expected status, run ID, account ID, or organization ID, verify that **every** path that mutates or reconciles the same state preserves that guard, not just the main `execute(...)` path.
- **Preserve intent.** Do not change the plan's goal, expand scope, or add unrelated milestones.
- **Preserve history.** Keep existing `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` content unless a factual correction is required. Do not uncheck completed work.
- **Do not claim full coverage without search evidence.** Import traversal alone is not enough for stateful flows.

## Required Workflow

### 1) Load the standards and target

Read `.agent/PLANS.md` first, then read the target plan.

- If the target is a file, rewrite the plan in place at the same file path.
- If the target is a recent ExecPlan in chat, produce the improved full plan in the response unless the user provides a file path to write it.

Capture:

- the plan's stated goal
- required sections and formatting constraints from `.agent/PLANS.md`
- all paths, symbols, commands, tests, tables, payloads, job names, stage names, error codes, and invariants named in the plan

### 2) Build an evidence checklist before editing

Create an internal checklist of every concrete thing the plan asserts, including:

- file paths
- functions, methods, traits, structs, enums, modules
- SQL helpers, repositories, migrations, tables, columns
- job types, queue names, payload structs, checkpoint types
- state/stage names and transition helpers
- tests, fixtures, harnesses, test utilities
- build, run, lint, and verification commands

Assume every item may be inaccurate until confirmed.

### 3) Deep-read every referenced file and symbol

Read each file the plan mentions. Locate each named symbol. Verify:

- the file exists at that path
- the symbol exists with that name
- the signature, types, return value, payload fields, and behavior match the plan
- the file's actual module/crate/package boundaries match the plan
- the referenced tests, fixtures, harnesses, and commands actually exist

Flag anything that does not match reality:

- missing or renamed files
- moved modules or different crate/package ownership
- different function signatures or return types
- different payload fields or serialization behavior
- commands the repository does not actually use
- tests or fixtures that do not exist

Do not stop at the obvious primary function. If the plan references a state transition, workflow stage, table update, or queue payload, continue into helpers, wrappers, callers, and reconciler code that touch the same state.

### 4) Search for adjacent and alternate paths

For every referenced feature or state transition, search the repository using multiple anchors. When relevant, search by:

- symbol name
- payload struct name
- job/queue type
- stage/status enum or string
- SQL table name
- key column names
- transition helper name
- error code or log string
- test name or fixture name

Do not rely only on imports. For stateful flows, alternate paths are often found through:

- queue registration
- worker/reaper/reconciler wiring
- direct SQL updates
- admin commands
- backfills
- repair scripts
- retry wrappers
- timeout handlers
- dead-letter or terminal-failure hooks
- reopen/regenerate/replay entrypoints

To claim lifecycle coverage is complete, you must search using at least **two independent anchors** for the same state or workflow, such as:

- payload type + table name
- transition helper + status enum
- queue name + error code
- checkpoint type + reconciler name

### 5) Trace lifecycle and invariants end-to-end

For every durable job, workflow stage, queue payload, checkpoint, or persisted state the plan touches, identify:

- the invariant-bearing fields
- where each field is created
- where it is defaulted
- where it is incremented or rotated
- where it is serialized and deserialized
- where it is validated or compared
- where it is ignored, dropped, or reconstructed
- every code path that can mutate, reconcile, supersede, or clean up the same state

Inspect the full lifecycle that exists in this repository, including when applicable:

- create / enqueue / insert
- main execution path
- in-band success handling
- in-band failure handling
- retry and resume-from-checkpoint
- timeout / lease expiry / worker recovery
- terminal failure / dead-letter reconciliation
- reopen / replay / regenerate / supersession
- admin repair / cleanup / backfill
- delete / archive / finalization paths

Look specifically for asymmetries and boundary failures:

- the main path carries a guard field but an auxiliary path drops it
- one helper is revision-aware/version-aware but another helper mutating the same state is unconditional
- a narrow recovery payload omits fields needed for stale-work protection
- one caller uses the guarded transition helper while another bypasses it
- direct SQL or repository helpers update the same row without the same predicates
- tests cover success or direct failure but omit stale, superseded, retried, resumed, or reconciled variants

If the plan assumes an invariant that does **not** exist in code, do not invent it. Correct the plan to match reality and flag the missing invariant as a risk only if it is relevant to the plan's stated intent.

### 6) Verify commands and test paths against reality

Only include commands you verified from this repository's actual tooling, such as:

- existing README or contributor docs
- package scripts
- Makefiles / task runners
- CI workflows
- language-native test/build files already in use

For each command you keep or add:

- include the correct working directory when needed
- use the actual command shape the repository uses
- state the expected success signal when practical

Do not invent generic commands when the repo uses wrappers or custom scripts.
If an exact verification command cannot be established from the repo, say so explicitly and flag the gap instead of guessing.

### 7) Audit the plan

Evaluate the plan against these criteria:

| Criterion | Question |
|---|---|
| Accuracy | Do the referenced paths, symbols, signatures, payloads, and behaviors match the code? |
| Completeness | Are all relevant files, helpers, tests, and dependent paths covered? |
| Lifecycle coverage | Does the plan cover the create/execute/retry/reconcile/reopen/cleanup paths that matter here? |
| Invariant preservation | Does the plan explicitly preserve guard fields across every mutating path? |
| Self-containment | Could a novice implement the change end-to-end from this plan alone? |
| Feasibility | Can the steps be executed in order without hidden dependencies? |
| Testability | Does each milestone have concrete verification, including stale or alternate-path regressions where relevant? |
| Safety | Is the rollout idempotent, retryable, and backward compatible for persisted payloads, checkpoints, schemas, and state? |

Prioritize correctness over elegance. A shorter plan that names the real files and real invariants is better than a broader but partly fictional one.

## Rewrite Rules

Rewrite the plan **in place at the same file path** when the target is a file.

Apply only code-grounded improvements:

- fix wrong paths, symbols, helper names, signatures, payload fields, module locations, and commands
- add missing files, functions, tests, fixtures, commands, or milestones only when the code proves they matter
- add missing lifecycle coverage when the plan only described the main path
- name invariant-bearing fields and where they must be propagated, compared, or validated
- add compatibility notes when persisted jobs, payloads, checkpoints, or schemas can outlive a deploy
- split milestones that are too large, hide cross-path dependencies, or mix schema and behavior changes unsafely
- replace vague acceptance criteria with observable behavior
- define undefined jargon
- add idempotence, retry, recovery, rollback, or deploy-order notes where the code makes them necessary
- reference existing repository patterns and utilities instead of inventing new ones

Do **not**:

- rewrite strong sections just to create a diff
- add boilerplate not tied to this codebase
- replace specific implementation detail with generic architecture advice
- remove completed milestones
- broaden the plan beyond its original purpose

If you find no substantive code-grounded improvements, leave the plan body alone aside from the required revision note at the bottom.

## Evidence Standard For Changes

Every substantive change you make to the plan must be defensible by pointing to specific repository evidence.

For each non-trivial correction or addition, you should be able to answer:

- which file(s) or symbol(s) proved this change was needed?
- what exactly in the code contradicted the old plan or justified the new detail?
- which alternate path, invariant, test gap, or command reality did this fix?

If you cannot answer those questions from code you actually read, do not make the edit.

## Usefulness Score

Score the usefulness of **this review pass**, not the absolute quality of the finished plan.

| Score | Meaning |
|---|---|
| 9-10/10 | The pass fixed multiple concrete execution blockers or major missing lifecycle/invariant coverage; implementation likely would have shipped a stale-state, retry, or reconciliation bug without these changes. |
| 7-8/10 | The pass added several substantive, code-grounded corrections that materially improve executability or cross-path correctness. |
| 4-6/10 | The pass made real but moderate improvements; the plan is clearer, safer, or more complete, but not fundamentally different. |
| 1-3/10 | The pass found little to improve beyond minor wording, sequencing, or already-obvious clarifications. |

A low score is the correct outcome when the plan was already strong or the repository did not reveal meaningful new gaps.

## Revision Note In The Plan

Append a revision note at the bottom of the plan describing:

- what changed
- why it changed
- which kinds of code-grounded issues were corrected

Do **not** record the usefulness score inside the plan.

## Report Back To The User

Report in this format:

- **Fixed:** inaccuracies corrected, including wrong paths, signatures, payloads, helper assumptions, or command references
- **Added:** missing files, tests, milestones, commands, lifecycle paths, compatibility notes, or invariant propagation steps
- **Strengthened:** vague sections made concrete, especially acceptance criteria, rollback/deploy notes, and alternate-path verification
- **Flagged:** risks, open questions, or repository realities that still deserve attention
- **Final line:** `Usefulness score: X/10 - <specific reason>`

The justification must be specific. Name what was missing or what would have broken.

## Anti-Patterns

- **Surface-level rewording:** editing prose without reading code
- **Single-path correctness:** validating only the main execution or happy path
- **Payload asymmetry blindness:** missing that retry/recovery/reconcile payloads dropped required guard fields
- **Helper asymmetry blindness:** noticing one guarded helper but missing another unguarded mutator
- **Search laziness:** relying only on imports or one symbol search and claiming full coverage
- **Invented commands:** adding build/test commands not supported by this repository
- **Speculative additions:** adding milestones or safeguards not rooted in code
- **Intent drift:** changing the plan's goal instead of making it more executable
- **Progress erasure:** removing completed work or flattening historical sections
- **Diff theater:** making many textual edits without increasing factual accuracy or implementation safety
