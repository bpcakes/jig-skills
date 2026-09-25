# GPT-6 Astra skill audit

Audited 2026-09-12 against repository commit `9c47b5e36bb641721abeb7343bed82d72350cdb2`.

The catalog has a sound foundation: short descriptions, explicit task boundaries, source-based findings, and several good examples of selective reference loading. The highest-value changes are to remove contradictory instructions, define completion for delegated implementation, and establish an explicit Astra evaluation baseline. A wholesale rewrite or adding an Astra persona to every skill is not justified.

This is an instruction and workflow audit. All 40 `SKILL.md` entrypoints across seven plugins were read, together with selected supporting references, report contracts, generated prompts, installation logic, and evaluation code/results. Recommendations below are repository-specific judgments informed by official OpenAI guidance; predicted model effects have not been measured. Skill implementations were not changed and no live model evaluations were launched.

## Official guidance and its application

Sources were searched and fetched on 2026-09-12, including the Markdown bodies when the web reader could not render them.

| Official source | Guidance relevant to this repository |
|---|---|
| [Using GPT-6 Astra](https://developers.openai.com/api/docs/guides/latest-model) | Audit conflicting skill instructions; make user intent and prior authorization explicit; define completion; tune delegation, output style, and verification effort. Astra can otherwise pause unnecessarily or over-verify. |
| [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra) | Keep descriptions concise and specific. Use small entrypoints that route to relevant resources. Reconsider elaborate recipes, blanket document prerequisites, and older permission rules. Consider other models that consume the same skills. |
| [Build skills](https://learn.chatgpt.com/docs/build-skills) | Discovery initially uses names and descriptions; descriptions can be shortened when the catalog exceeds its budget. Put the use case first. `agents/openai.yaml` is optional and can control implicit invocation. |
| [Testing Agent Skills Systematically with Evals](https://developers.openai.com/blog/eval-skills) | Measure task outcomes, invocation, traces, style, and efficiency. Include positive and negative prompts, deterministic checks, and qualitative grading. Track unnecessary commands and token usage. |
| [GPT-6 Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra) | The documented API model ID is `gpt-6-astra`; API reasoning efforts are `low`, `medium`, `high`, `xhigh`, and `max`. |

For a direct API migration, the model guide also requires Responses for tool calling, excludes `none`/`minimal` effort and sampling parameters such as `temperature`, and documents cache and EU residency constraints. This repository currently invokes Codex and other CLIs rather than constructing OpenAI API requests. Those API changes therefore belong in the host or a future API adapter, not in every skill. Do not infer data residency from the operator's timezone. [Migration guidance](https://developers.openai.com/api/docs/guides/latest-model)

## Inventory and existing strengths

- 40 entrypoints contain 5,427 lines and approximately 50,125 whitespace-delimited words. This is the full catalog, not the context loaded for one task.
- Descriptions are already only 88–127 characters each, 4,405 characters combined. Keep that improvement; names, paths, and other installed skills also consume discovery context.
- The behavioral suite has 33 cases whose declared targets cover 14 skills. The remaining 26 have no dedicated case in `evals/cases.json`; this does not mean their scanners lack tests.
- Rust error handling, architecture, and test quality have particularly clear evidence and no-finding contracts. React Effects and SQLx already route by concern. The React test report reference is a useful model for concise, consequence-based reports.
- The review runtime already specifies independent children, parallel launch, bounded waits, immutable reports, scope fingerprints, and honest partial coverage. Keep these correctness mechanisms.
- Privacy skills usually load standards references conditionally and distinguish observed leakage from incomplete negative evidence. Preserve those distinctions and redaction requirements.

Inventory is based on [skill entrypoints](../plugins), [cases](../evals/cases.json), [evaluation documentation](skill-evaluations.md), and the [review runtime](../plugins/jig-review/skills/comprehensive-review/references/parallel-review-runtime.md#spawn-every-selected-child).

## Prioritized findings

Priorities describe recommended work order: P1 affects task completion, review conclusions, or claims of Astra readiness; P2 improves execution reliability and efficiency; P3 is optional cleanup. Confidence is in the instruction/code observation, not a measured prediction of Astra behavior.

### A1 — P1: Resolve contradictory mode and scope instructions

High confidence. Several entrypoints establish a reasonable default and later give an absolute instruction that conflicts with a request already authorized by the user:

- [Comprehensive review, line 10](../plugins/jig-review/skills/comprehensive-review/SKILL.md#L10) allows fixes only after a separately requested follow-up. A user who initially asks for review and fixes has already authorized both phases. The children should remain read-only, but the parent should be able to continue into the requested repair phase after reports are frozen. This also needs an explicit composition rule when called by the repair loop.
- [Ruby Fowler, line 21](../plugins/jig-ruby/skills/fowler-ruby-rails-refactoring/SKILL.md#L21) says to add characterization tests when coverage is weak, before the read-only mode at lines 30–37 prohibits edits. Separate recommending those tests in assessment mode from adding them during authorized implementation.
- [Swift simplify, line 14](../plugins/jig-swift/skills/swift-simplify/SKILL.md#L14) accepts the requested target, but lines 71 and 77 restrict work to recently modified/uncommitted code. A named unchanged Swift file is a valid target. Make the uncommitted diff a fallback consistently.
- [TypeScript abstraction review, line 36](../plugins/jig-typescript/skills/typescript-react-abstraction-police/SKILL.md#L36) groups applicable repository guidance and ordinary repository prose together as evidence that cannot override the skill. Distinguish host-loaded instructions from comments and documents being examined as task data.

Recommended change: use explicit modes and concrete boundaries, preserve authorization from earlier turns, and state that skill defaults yield to the user's requested task subject to host instructions. When a skill rule actually blocks continuation, report its exact source and reason. Do not turn these changes into a blanket permission to edit during reviews or start paid reviewer loops.

Acceptance: initial requests for review-and-fix continue through both authorized phases; review-only requests make no edits; a named unchanged file is processed; a preview-only request stays a preview.

### A2 — P1: Make detailed checklists obey the evidence standard

High confidence. Adding a good evidence paragraph at the top has not removed conflicting rules farther down:

- [React state/data flow, lines 161–168](../plugins/jig-typescript/skills/react-state-data-flow-review/SKILL.md#L161) assigns severity to unnecessary derived state, scattered setters, and even organization issues without a clear bug. The opening requires a concrete consequence.
- [React component API, lines 82–88](../plugins/jig-typescript/skills/react-hooks-component-api-review/SKILL.md#L82) labels callback syntax and naming categories by severity without consistently requiring a demonstrated consumer failure.
- [TypeScript duplication, line 121](../plugins/jig-typescript/skills/typescript-react-dup-unifier/SKILL.md#L121) rejects a design for more than three independent boolean variants. Its [decision rubric](../plugins/jig-typescript/skills/typescript-react-dup-unifier/references/unification-decision-rubric.md) says counts do not establish defects. Replace the numeric rejection with conflicting combinations, lifecycle differences, or caller cost.
- [Transaction consistency, line 223](../plugins/jig-rust/skills/sql-transaction-consistency-review/SKILL.md#L223) rates speculative future-danger clarity issues as Low despite its consequence-based opening.
- [Network payload audit, line 121](../plugins/jig-privacy-audit/skills/network-payload-zero-knowledge-test/SKILL.md#L121) places expected low-sensitivity control values in Low severity. Expected controls should be positive evidence. [Audit common, lines 14 and 36](../plugins/jig-privacy-audit/skills/audit-common/SKILL.md#L14) and several child severity tables also disagree about whether documentation gaps alone are findings.

Recommended change: revise the actual checklist, severity table, template, and relevant examples together. Every defect needs an affected contract, source evidence, consequence, counterevidence, and impact-based severity. Separate hardening, design preferences, and missing evidence. Preserve a clean-result path.

Acceptance: pair each corrected rule with a benign counterexample and a real defect. Independent boolean options and expected control sentinels must not become findings; a demonstrated small defect must still receive an appropriate low severity.

### A3 — P1: Make Cursor delegation complete the requested plan

High confidence. The [generated Cursor prompt, line 137](../plugins/jig-exec-plans/skills/cursor-implement-exec-plan/scripts/run_cursor_execplan.py#L137) permits implementing only the next incomplete milestone, reserving full completion for a sufficiently small plan. The [parent workflow, lines 47–59](../plugins/jig-exec-plans/skills/cursor-implement-exec-plan/SKILL.md#L47) launches once, summarizes remaining work, and prohibits correcting stale plan updates without another user request.

For a request to implement a whole ExecPlan, those instructions make partial completion an acceptable endpoint. The child is Composer, so this is a cross-agent workflow issue affecting an Astra orchestrator, not evidence of an Astra coding defect.

Recommended change: pass the user's requested terminal condition to the child. A whole-plan request should continue through applicable milestones and validation, resuming the same authorized workflow when needed; a milestone-only request should stop at that milestone. Completion requires checked acceptance criteria and accurate plan progress. Resolve routine ambiguity from repository evidence; reserve a blocker for a material unresolved decision or unavailable capability. Keep the chosen provider and force/trust controls explicit.

Acceptance: a two-milestone fixture finishes both milestones when the task requests the whole plan, but only the named milestone when constrained. A child exiting successfully with outstanding required work cannot be reported as task completion.

### A4 — P1: Establish an identifiable Astra baseline and broader behavioral coverage

High confidence. The checked-in result records identify model selection as `CLI default (--ignore-user-config)`, including [the latest contracts record](../evals/results/2026-09-11-contracts.json). They do not establish which model was effectively used. The [runner](../evals/run.mjs#L294) accepts a model but has no explicit reasoning-effort control; the same options configure both agent and judge. It records traces and hashes well, but does not summarize token use, latency, clarification pauses, repeated checks, or reference-reading cost.

The harness disables multi-agent features and web access. Its three loop cases test restraint/preview, not an executed repair loop. A forced response schema also cannot establish ordinary Markdown presentation quality. [Documented evaluation limits](skill-evaluations.md#what-the-cases-establish)

Recommended change:

1. Run before/after trials with explicit `gpt-6-astra`, the same reasoning effort, the same fixtures, and frozen skill versions. Record requested and reported model/effort when available; disclose unresolved defaults.
2. Add separate agent and grader configuration. Hold the grader fixed during comparisons and manually adjudicate disputed results; another judge invocation alone does not establish independent model-family evidence.
3. Extend coverage first for A1–A3, supplied-artifact privacy work, missing `PLANS.md`, clean named files, and absent optional tooling. Add dedicated positive/negative cases for the other untested skills incrementally.
4. Add an opt-in orchestration lane for real delegation, partial child results, cancellation, steering, and repair-loop completion. Test installed plugin and direct-copy layouts as well as the flattened fixture catalog.
5. Add unconstrained-output trials and report token use, elapsed time, repeated commands, skill/reference reads, unnecessary clarification, and actual task completion. Optimize these only after preserving correctness.

Acceptance: retain every planned trial and failure, compare equivalent workloads, and report per-skill results. A smaller prompt or a passing scanner test is not sufficient evidence that a skill is optimized for Astra.

### A5 — P2: Replace blanket preparation with conditional routes

High confidence on context cost; benefit requires evaluation. Large entrypoints often require additional overlapping references:

- [Fowler Rust](../plugins/jig-rust/skills/fowler-rust-refactoring/SKILL.md#L22) routes an ordinary assessment through principles, smell catalog, refactoring catalog, and report template. Together with its entrypoint this is roughly 9,600 words before repository evidence.
- [Improve ExecPlan](../plugins/jig-exec-plans/skills/improve-exec-plan/SKILL.md#L36) requires `.agent/PLANS.md` first with no absent-file fallback, then extensive file and lifecycle procedures. [Write ExecPlan](https://github.com/bpcakes/jig-skills/blob/9c47b5e36bb641721abeb7343bed82d72350cdb2/plugins/jig-exec-plans/skills/write-exec-plan/SKILL.md#L12) also demands full standards reading and source rereading; its own skeleton later treats a checked-in standards file as conditional.
- React performance/test quality and both abstraction-police skills repeat procedures that also appear in references. Stateful lifecycle instructions are valuable for durable workflows, but need not dominate a simple plan correction.
- Both duplication skills mandate scanning even where two named definitions may supply the entire comparison; TypeScript's scanner also depends on an available TypeScript installation.

Recommended change: keep objective, scope, evidence standard, routing, completion, and output contract in the entrypoint. Move long taxonomies and platform branches into selectively loaded references. Define a missing-`PLANS.md` fallback based on the existing plan and a bundled skeleton. Allow direct semantic comparison for named candidates and source-only fallback when optional scanners are unavailable. Preserve completeness within the requested audit scope.

Acceptance: a small targeted case loads only applicable resources and completes with missing optional tooling. Complex lifecycle cases must retain alternate-path coverage. Use measured read volume; do not impose an arbitrary line limit or remove useful domain-specific counterexamples.

### A6 — P2: Calibrate verification to risk and stop after sufficient evidence

High confidence. [Fowler Rust, lines 47–62 and 224–233](../plugins/jig-rust/skills/fowler-rust-refactoring/SKILL.md#L47) supplies workspace-wide baseline commands and requires a full project suite at completion. [Fowler Ruby, lines 19–21 and 164–176](../plugins/jig-ruby/skills/fowler-ruby-rails-refactoring/SKILL.md#L19) requires baseline tests before even proposing a change and tests after every step. These can multiply checks for a small assessment or mechanical edit.

Recommended change: distinguish static assessment from executed validation; reuse an unchanged known baseline; run the narrowest meaningful check and required project checks. Broaden only for affected shared contracts, concurrency, persistence, unsafe code, or new failures. Add characterization tests during implementation when existing tests cannot prove preservation. A review may recommend an unapplied change without pretending to have compiled it.

Also resolve [source-reorganization rules](../plugins/jig-rust/skills/rust-source-reorg/references/rust-source-reorg-rules.md#L56): removing unused imports and demanding identical warnings are conflicting completion requirements. Preserve order-sensitive constructs and project formatter constraints explicitly.

Acceptance: a harmless local edit does not cause repeated unchanged full-suite runs or new tests mirroring the edit; substantive behavior and concurrency repairs still receive meaningful regression checks.

### A7 — P2: Separate privacy artifact analysis, capture, and retest modes

High confidence on ambiguous routing. [Intake, line 8](../plugins/jig-privacy-audit/skills/audit-intake-and-evidence-map/SKILL.md#L8) says to use it before narrow audits even when the user already supplied scope and evidence. [Network audit, lines 32–44](../plugins/jig-privacy-audit/skills/network-payload-zero-knowledge-test/SKILL.md#L32) starts with sentinel generation and traffic capture. Client and telemetry audits similarly include runtime exercises in the main workflow. [Retest management, lines 134–145](../plugins/jig-privacy-audit/skills/vulnerability-disclosure-and-retest-manager/SKILL.md#L134) directs rerunning original and adjacent skills.

Recommended change: route by the requested deliverable. Supplied HAR plus its sentinel manifest should go directly to analysis. Static-source audits should finish with supported findings and runtime gaps. New capture, retesting, register updates, and disclosure drafts should have separate branches. Reuse an established scope; invoke intake when scope actually needs work. Preserve real access, disclosure, synthetic-data, and redaction boundaries, while avoiding a new approval checklist for already authorized local analysis.

Acceptance: analyzing supplied artifacts neither generates replacement sentinels nor requires fresh account activity; a report-only request does not start retests or send disclosure messages; authorized capture still exercises the required flows.

### A8 — P2: Make required resources survive installation

High confidence; one failure reproduced locally. Installing just `network-payload-zero-knowledge-test` into a fresh temporary destination succeeds but omits `audit-common`, which its line 10 requires. The [installer's dependency logic](../scripts/install.sh#L118) only handles `review-fix-loop` → `comprehensive-review`. This affects individual installation of all 11 user-facing privacy skills that reference the shared support skill. Installing the complete privacy plugin does provide the sibling directory.

Other portability traps:

- [Rust async scanner example, line 41](../plugins/jig-rust/skills/rust-async-concurrency-review/SKILL.md#L41) assumes `plugins/jig-rust/...` exists inside the target repository.
- [TypeScript abstraction scanner example, line 59](../plugins/jig-typescript/skills/typescript-react-abstraction-police/SKILL.md#L59) uses `node scripts/scan.mjs` without resolving that script relative to the loaded skill.
- Privacy helper instructions refer to this checkout's plugin directory rather than consistently resolving the installed skill directory.

Recommended change: make the installer include and validate `audit-common` for individual privacy installs, or bundle the necessary support resource inside each independently installable package. Resolve scanner paths from the loaded entrypoint and target paths from the user's workspace. Keep optional-tool failure separate from unavailable required instructions.

Acceptance: each documented single-skill install contains its required resources, and documented helpers run from an unrelated target repository, including paths containing spaces. Preserve existing dependency copies unless replacement is authorized.

### A9 — P2: Make presentation proportional to the result

High confidence. [Rust source reorganization, line 30](../plugins/jig-rust/skills/rust-source-reorg/SKILL.md#L30) requires the entire edited file in the response. [Improve ExecPlan, lines 214 and 228–259](../plugins/jig-exec-plans/skills/improve-exec-plan/SKILL.md#L214) requires a revision note even for no substantive improvement and a self-assigned usefulness score. Several React skills require large verdict/checklist sections, and the performance template includes three top-issue placeholders.

Recommended change: default to findings or changed-file links, material validation, and relevant limitations. Omit empty sections and quota-like placeholders. Use full templates and machine-readable schemas when they are the requested artifact or a downstream contract. Return full rewritten source when the user asks for it or when the input is a snippet. Remove the obligatory no-op revision and usefulness score; report a clean assessment without manufacturing changes.

Keep review provenance, exact required inventories, evidence IDs, and privacy redaction. Those fields carry real meaning; compress their presentation without deleting them.

Acceptance: a clean small review is brief, a repository edit does not echo hundreds of unchanged lines, and structured audit consumers still receive all required fields.

### A10 — P3: Document Astra host configuration without hardcoding the catalog

High confidence. Comprehensive review already inherits the host model and effort and supports an explicit override. Local parser validation accepted `--reviewers codex --codex-model gpt-6-astra --codex-effort high`; that verifies argument handling, not provider availability or a successful model run.

Recommended change: document an Astra override example and test effective propagation in the orchestration lane. Keep Claude and Cursor roles intact. The parser's `ultra` effort is a host-facing option; public Astra API documentation lists efforts only through `max`. Describe and validate each host's supported mapping rather than deleting `ultra` solely from API documentation or promising it works everywhere.

Keep the existing explicit reviewer launch policy. Do not add unconditional delegation to small single-scope skills. Async tool calling and mid-turn steering are host capabilities; prompt text alone cannot enable them. For long workflows, specify how a changed user constraint updates remaining work and invalidates in-flight results where necessary.

`agents/openai.yaml` is optional. Do not add 37 metadata files just for symmetry. Consider disabling implicit invocation for the internal `audit-common` support entry only if discovery trials show accidental standalone selection. Keep the loop's natural-language trigger for explicitly requested iterative work.

## Coverage of every skill

“Cases” counts dedicated targets in the current behavioral suite, not scanner/unit tests or proof of Astra compatibility. A retain recommendation means no substantial entrypoint rewrite is justified by this audit; A4 evaluation work still applies.

### Jig Rust

| Skill | Cases | Recommended action |
|---|---:|---|
| [fowler-rust-refactoring](../plugins/jig-rust/skills/fowler-rust-refactoring/SKILL.md) | 0 | P2: A5/A6. Route catalogs conditionally; replace routine workspace-wide baselines with risk-based checks. Preserve Rust compatibility and counterexample rules. |
| [rust-abstraction-police](../plugins/jig-rust/skills/rust-abstraction-police/SKILL.md) | 2 | P2: A5/A9. Shorten the router and repeated report instructions; retain the five-part confirmation rule and source-first inspection. |
| [rust-architecture-review](../plugins/jig-rust/skills/rust-architecture-review/SKILL.md) | 1 | Retain the concise contract. A4: add defect and benign architecture cases; its current case concerns read-only behavior. |
| [rust-async-concurrency-review](../plugins/jig-rust/skills/rust-async-concurrency-review/SKILL.md) | 2 | P2: A8. Fix installed scanner path resolution. Retain selective lifecycle references and “None required” for unnecessary tests. |
| [rust-dup-unifier](../plugins/jig-rust/skills/rust-dup-unifier/SKILL.md) | 0 | P2: A5/A6. Allow named-pair/manual comparison without mandatory scanner execution; make added tests conditional on coverage gaps. Preserve semantic and migration checks. |
| [rust-error-handling-review](../plugins/jig-rust/skills/rust-error-handling-review/SKILL.md) | 4 | Retain. Strong model for conditional references, impact-based findings, and optional improvements. Establish explicit Astra results through A4. |
| [rust-security-boundary-review](../plugins/jig-rust/skills/rust-security-boundary-review/SKILL.md) | 2 | Retain source-to-sink requirements and conditional references. P2 A9: permit compact output while retaining meaningful coverage limitations. |
| [rust-simplify](../plugins/jig-rust/skills/rust-simplify/SKILL.md) | 3 | P3: remove the expert-persona preamble and redundant generic Rust advice; preserve MSRV, ownership, target scope, and relevant existing checks. |
| [rust-source-reorg](../plugins/jig-rust/skills/rust-source-reorg/SKILL.md) | 0 | P2: A6/A9. Resolve warning-preservation conflict, avoid speculative TODO additions, protect order-sensitive constructs, and link edited files instead of always echoing them. |
| [rust-test-quality-review](../plugins/jig-rust/skills/rust-test-quality-review/SKILL.md) | 3 | Retain. Strong surviving-regression oracle and explicit resistance to unnecessary coverage demands. |
| [sql-transaction-consistency-review](../plugins/jig-rust/skills/sql-transaction-consistency-review/SKILL.md) | 0 | P1: A2. Remove speculative Low findings. P2 A5: route detailed checks by the invariant and database flow; preserve interleaving analysis. |
| [sqlx-query-safety-review](../plugins/jig-rust/skills/sqlx-query-safety-review/SKILL.md) | 2 | Retain stack routing and evidence standard. A4: include driver fallback and named-file cases. |

### Jig TypeScript

| Skill | Cases | Recommended action |
|---|---:|---|
| [typescript-simplify](../plugins/jig-typescript/skills/typescript-simplify/SKILL.md) | 2 | P3: remove persona/repetition; align “recently modified” process wording with named files/snippets. Keep project-convention and behavior preservation rules. |
| [typescript-type-system-review](../plugins/jig-typescript/skills/typescript-type-system-review/SKILL.md) | 2 | P2: A2/A9. Convert residual “flag” style/duplication rules into consequence-based investigation prompts; make examples and health summaries conditional. |
| [typescript-react-abstraction-police](../plugins/jig-typescript/skills/typescript-react-abstraction-police/SKILL.md) | 0 | P1: A1 instruction precedence. P2: A5/A8 resource routing and scanner path. Preserve real consumer evidence and transparent-adapter counterexamples. |
| [typescript-react-dup-unifier](../plugins/jig-typescript/skills/typescript-react-dup-unifier/SKILL.md) | 0 | P1: A2 numeric rejection conflict. P2: A5 manual fallback and scoped preparation. Preserve lifecycle, accessibility, and package ownership checks. |
| [react-hooks-effects-review](../plugins/jig-typescript/skills/react-hooks-effects-review/SKILL.md) | 2 | Retain conditional reference/test guidance. P2 A9: omit irrelevant lifecycle/checklist sections in small reviews. |
| [react-state-data-flow-review](../plugins/jig-typescript/skills/react-state-data-flow-review/SKILL.md) | 0 | P1: A2 evidence/severity consistency. P2: A5/A9 split lengthy state categories and simplify clean reports. |
| [react-render-performance-review](../plugins/jig-typescript/skills/react-render-performance-review/SKILL.md) | 2 | P2: A5/A9 route large examples by bottleneck, remove top-three placeholders, and keep measurement/inference explicit. |
| [react-test-quality-review](../plugins/jig-typescript/skills/react-test-quality-review/SKILL.md) | 3 | Retain the authoritative report contract. P2 A5: read the large rule file and sample only when needed; select relevant UI states. |
| [react-hooks-component-api-review](../plugins/jig-typescript/skills/react-hooks-component-api-review/SKILL.md) | 0 | P1: A2 consumer-impact severity. P2: A5/A9 route the detailed checklist by contract and remove mandatory cleanup/rewrite sections. |

### Jig ExecPlans, Review, Ruby, and Swift

| Skill | Cases | Recommended action |
|---|---:|---|
| [write-exec-plan](https://github.com/bpcakes/jig-skills/blob/9c47b5e36bb641721abeb7343bed82d72350cdb2/plugins/jig-exec-plans/skills/write-exec-plan/SKILL.md) | 0 | P2: A5/A6. Specify missing-standards fallback; separate template and durable-state guidance; scale verification and explanation to the actual plan. |
| [improve-exec-plan](../plugins/jig-exec-plans/skills/improve-exec-plan/SKILL.md) | 0 | P2: A5/A9. Find an inferable local target, handle absent `.agent/PLANS.md`, route lifecycle depth, and remove mandatory no-op revision/score. |
| [cursor-implement-exec-plan](../plugins/jig-exec-plans/skills/cursor-implement-exec-plan/SKILL.md) | 0 | P1: A3. Align child and parent completion with whole-plan versus milestone requests. Preserve explicit provider and unattended-execution settings. |
| [comprehensive-review](../plugins/jig-review/skills/comprehensive-review/SKILL.md) | 0 | P1: A1 review-phase composition. P2: A4/A5 test orchestration and route branch/provider details. P3: A10 document explicit Astra configuration. |
| [review-fix-loop](../plugins/jig-review/skills/review-fix-loop/SKILL.md) | 3 | P1: A4 executed-loop coverage and A1 composition. P2: retain bounded rounds and ledger semantics; report exact blocking rules, reuse valid evidence, and test steering. |
| [fowler-ruby-rails-refactoring](../plugins/jig-ruby/skills/fowler-ruby-rails-refactoring/SKILL.md) | 0 | P1: A1 read-only/test-writing conflict. P2: A5/A6 conditionally load Rails guidance and remove redundant baseline/full-suite requirements. |
| [swift-simplify](../plugins/jig-swift/skills/swift-simplify/SKILL.md) | 0 | P1: A1 named-target consistency. P3: remove generic persona/advice while retaining actor isolation, cancellation, availability, and UI contracts. |

### Jig Privacy Audit

All 11 user-facing privacy skills need A8's single-install dependency handling and A4's dedicated behavioral coverage.

| Skill | Cases | Recommended action |
|---|---:|---|
| [audit-common](../plugins/jig-privacy-audit/skills/audit-common/SKILL.md) | 0 | P1: A2 reconcile evidence and severity for missing documentation/hardening. P3: A10 assess support-only discovery. Retain redaction and limited-negative-evidence rules. |
| [audit-intake-and-evidence-map](../plugins/jig-privacy-audit/skills/audit-intake-and-evidence-map/SKILL.md) | 0 | P2: A7 reuse established scope; intake only for missing scope/evidence planning. Keep unknown inputs as limitations and questions. |
| [privacy-claims-field-classifier](../plugins/jig-privacy-audit/skills/privacy-claims-field-classifier/SKILL.md) | 0 | P2: A2/A5/A7 separate evidence gaps from leakage, route static versus runtime evidence, and move long classification examples out of the entrypoint. |
| [threat-model-and-dataflow-builder](../plugins/jig-privacy-audit/skills/threat-model-and-dataflow-builder/SKILL.md) | 0 | P2: A5/A9 condition taxonomy depth on the system, avoid duplicate support reads, and use structured schema only for that deliverable. Keep its missing-input continuation. |
| [network-payload-zero-knowledge-test](../plugins/jig-privacy-audit/skills/network-payload-zero-knowledge-test/SKILL.md) | 0 | P1: A2 expected-control severity. P2: A7/A8 analyze supplied captures/manifests directly; resolve installed helpers and use unique run directories. |
| [client-encryption-boundary-audit](../plugins/jig-privacy-audit/skills/client-encryption-boundary-audit/SKILL.md) | 0 | P2: A2/A7 select static or capture mode; keep missing tests as evidence gaps absent a demonstrated consequence; limit cross-skill work to the requested flow. |
| [crypto-architecture-review](../plugins/jig-privacy-audit/skills/crypto-architecture-review/SKILL.md) | 0 | P2: A5/A7 select key/recovery/sharing branches; clarify that specialist-review recommendations do not block other supported static findings. Preserve limits on cryptographic conclusions. |
| [crypto-implementation-static-review](../plugins/jig-privacy-audit/skills/crypto-implementation-static-review/SKILL.md) | 0 | P2: A5/A8 route language-specific checks, resolve the installed scanner, and keep static findings separate from runtime follow-up. |
| [server-decryptability-and-plaintext-path-audit](../plugins/jig-privacy-audit/skills/server-decryptability-and-plaintext-path-audit/SKILL.md) | 0 | P2: A5/A7 separate source analysis, supplied server artifacts, and authorized live sentinel queries; load only relevant store/worker branches. |
| [metadata-leakage-inventory](../plugins/jig-privacy-audit/skills/metadata-leakage-inventory/SKILL.md) | 0 | P2: A2/A5 missing evidence is not leakage; route lengthy categories and minimization examples while retaining field-level evidence and inference paths. |
| [telemetry-crash-logs-support-leakage-audit](../plugins/jig-privacy-audit/skills/telemetry-crash-logs-support-leakage-audit/SKILL.md) | 0 | P2: A5/A7 route static logs, existing captures, new flow exercises, and support workflows separately. Keep before-collection redaction analysis. |
| [vulnerability-disclosure-and-retest-manager](../plugins/jig-privacy-audit/skills/vulnerability-disclosure-and-retest-manager/SKILL.md) | 0 | P2: A5/A7 split register normalization, retest execution, and disclosure drafting; no automatic adjacent reruns for a summary request. Preserve evidence-based status transitions. |

## Recommended implementation order and validation

1. Correct A1–A3 contradictions and completion behavior, with focused regression cases for each. Preserve the existing short descriptions and evidence protections.
2. Repair A8's install/resource failures. Verify single-skill dependency closure and helper commands in temporary install/target directories.
3. Add A4's explicit model/effort recording and the missing high-value cases. Capture an Astra baseline before compressing prompts.
4. Refactor the heaviest affected entrypoints under A5–A9 one workflow at a time. Compare unchanged and revised skills using the same model, effort, inputs, and judge. Retain improvements only when behavioral quality holds and execution cost or completion improves.
5. Update user docs and affected plugin versions for release; validate both plugin installation and direct copies. Add an Astra configuration example under A10 without replacing other providers.

The current runner already supports an initial named-model smoke run:

```sh
node evals/run.mjs --live --model gpt-6-astra --case rust-implicit-simplify --repeat 3
```

This command consumes authenticated Codex usage and uses the same model for semantic grading. It does not select reasoning effort or test multi-agent behavior. Add those controls before treating comparisons as controlled optimization evidence. Do not raise every workflow to maximum effort by default.

Useful acceptance scenarios include: previously authorized fixes; explicit preview; unchanged named files; missing optional standards/scanners; known benign code; real defects with small and large impact; supplied HAR plus manifest; whole-plan delegation; partial reviewer failure; user steering during a long task; and a clean result with concise output. Measure redundant reads/tests and tokens alongside completed outcomes. Keep held-out examples and inspect surprising grades manually.

## Checks performed and limits

- Read all 40 entrypoints; inspected relevant runtime references, report contracts, launcher prompt, optional metadata, installer, and evaluation implementation/results. This does not certify every scanner or every domain-specific security claim.
- Counted descriptions, entrypoint sizes, and declared case targets directly from the repository.
- Reproduced the missing `audit-common` dependency using a fresh temporary single-skill install. The diagnostic copy is `/tmp/jig-astra-audit.7jHXd3`; no user installation was replaced.
- Confirmed that the review option parser accepts the explicit Astra/high combination. No provider request or child-agent run was made.
- Did not run live evaluations, external reviewers, or the unrelated runtime test suites. Existing result records were inspected, not rerun or independently reverified.
- Only this audit document was added. The recommendations remain proposed changes, and Astra efficiency or quality gains remain unmeasured.
