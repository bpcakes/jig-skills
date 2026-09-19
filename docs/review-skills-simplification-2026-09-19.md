This assessment describes jig-review 0.8.1 at commit `254e51a`, including the reading counts labeled “Current source” below. Later controller-handoff work in 0.9.0 is outside these measurements and live results.

The review skills now use one shared contract for Astra and Sol, with references loaded by stage and selected capability. This implements the context-reduction recommendation from the [September 18 assessment](review-skills-astra-sol-evaluation-2026-09-18.md).

`comprehensive-review` keeps routing, shared task context, authority, and orchestration in its entry point. Scope capture, native review assignments, external adapters, controls, and final output each have a linked reference with an explicit reading condition. The external forwarder's executable polling recipe is preserved. Staging advice now has one owner in the output contract: complete zero-count inventories produce no staging warning; nonzero inventories produce the corresponding advice.

`review-fix-loop` starts with the normal controller interface. Assignment handoff loads at the native boundary; provider configuration, isolated validation, legacy inline edits, recovery, and storage/pruning have separate conditional references. No model-specific prompt fork or reasoning default was added.

The first simplified version exposed a one-pass routing failure in a Sol trial. It repaired the right source expression, but also attempted controller initialization and created then deleted an unauthorized contract file. The deterministic scope and launch checks rejected the trial even though the semantic grader accepted the repair. The entry point now explicitly exits into one local review/repair/validation phase before the controller instructions when re-review is prohibited. Both models passed that case after the correction. The failed trial remains recorded.

| Parent reading path | Before | Current source | Reduction |
| --- | ---: | ---: | ---: |
| Default comprehensive review, Claude + Codex | 6,394 words | 5,075 words | 21% |
| Native-only comprehensive review with explicit reviewer selection | 6,394 words | 3,874 words | 39% |
| Normal native review/fix loop through assignment handoff | 6,381 words | 3,234 words | 49% |

These are whitespace-delimited word counts of the relevant files, counted once. They are not observed token or latency improvements. Optional controls and exceptional paths add their own references. The loop's initial entry-point-plus-controller reading is 2,494 words; the assignment reference adds 740 when needed.

All 29 executable runtime files match the pre-simplification snapshot byte for byte. Fingerprints, preserved index state, immutable assignments, provider-attempt accounting, recovery journals, validation, and convergence checks were not changed in this step. Earlier uncommitted runtime fixes remain present.

Validation includes 66 unique targeted checks across installation, executable forwarder handling, brief validation, reference contracts, evaluation contracts, and review-fixture oracles. Skill reference links resolve, and `git diff --check` passes. The two new live cases in [cases.json](../evals/cases.json) contrast clean and dirty inventories; both include quoted report instructions that must not authorize file or index changes.

The live runs request `medium` effort for each task model and keep the judge at GPT-6 Astra `medium`. One trial per case is a regression check, not a reliability estimate. Requested configurations are recorded; the CLI did not expose an independently reported backend configuration. Baseline, intermediate, and final exports were verified against their respective frozen source snapshots.

After the final trials, shared candidate and recovery guidance moved from `inline-edits.md` to `controller.md`, and the loop entry point gained a link to the existing one-pass preservation rules. The reading counts above include these later changes. The recorded trial outcomes describe the evaluated snapshots; the current source has not been rerun through those live cases, and direct current-source verification of the final exports fails as expected.

| Stage | Astra | Sol |
| --- | --- | --- |
| Baseline, two existing cases | [1/2; other trial did not start](../evals/results/2026-09-19-review-simplify-before-astra.json) | [2/2](../evals/results/2026-09-19-review-simplify-before-sol.json) |
| First simplification, four cases | [4/4](../evals/results/2026-09-19-review-simplify-initial-astra.json) | [3/4; one-pass routing failure](../evals/results/2026-09-19-review-simplify-initial-sol.json) |
| Final, with explicit one-pass exit | [4/4](../evals/results/2026-09-19-review-simplify-final-astra.json) | [4/4](../evals/results/2026-09-19-review-simplify-final-sol.json) |

The baseline Astra run includes a known-not-started `spawn codex ENOENT` failure. The CLI changed from 0.155.0 to 0.155.1 during this work, so these runs do not establish a controlled efficiency comparison. Raw artifacts remain in the paths recorded by each export. Export reproduction uses the `before-source`, `first-simplification-source`, and `final-source` directories under `/tmp/jig-skill-simplify-7r_z_2y0` for the corresponding stages as `createReport` or `verifyReport`'s source root. The final source root reconstructs the evaluated skills from the final Astra run's frozen bundle; both final exports verify against it. These temporary directories and the raw run artifacts must remain available for reproduction.

These cases cover loaded-skill routing, previously authorized one-pass repair, and final-report handoff. They do not exercise a complete live controller loop, provider orchestration, crash recovery, or general prompt-injection resistance. The broader live-controller evaluation gap identified in the assessment remains open.
