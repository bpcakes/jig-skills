# Review workflow improvements

## Outcome and scope

Implement the six improvements identified in the September 24 local-thread audit: recover validation-only acceptance uncertainty without rediscovery; provide external reviewer bridges and honor explicit provider selection; preflight validation in its worker environment; reconcile declared generated evidence; run discovery reviews concurrently; improve causal repair guidance and regression coverage. Preserve checkout identity, independent review contexts, frozen reports, bounded attempts, and uncertain-execution recovery.

No automatic dependency installation, secret discovery, broad environment inheritance, or migration of active historical runs. Existing runs retain their original controller. New durable state uses a new schema version. No authenticated live-provider benchmark is implied by offline tests.

## Evidence and design

- `triageResult` only permits `needs-validation` with source drift; `validate` can leave discovery acceptance unresolved. Add a distinct validation-pending disposition and an explicit post-validation triage boundary, without automatically accepting coverage claims.
- `review` selects providers from two slots; explicit three-provider requests can omit a provider. Pin provider-specific slots for explicit selections and provide bundled structured bridges using existing CLI argument/access helpers.
- `commandEnvironment` is the validation authority. Add pinned prerequisite commands and required environment names, executed before discovery with the same worker machinery. Include repository contract files in validation discovery.
- `repairResult` rejects excluded-path mutations. Permit only declared append-only evidence outputs through that boundary and route their effects through existing source/validation reconciliation; never exempt policy files, source overwrites, deletions, or index changes.
- `run.pending` serializes reviews. Add a bounded queue of prepared review assignments sharing the original source snapshot. Expose all native requests together; launch external jobs before waiting. Preserve cleanup obligations on interruption and do not begin repair until the wave settles.
- `repair-policy.mjs` already emphasizes causal repair. Add concrete dependency/consumer probes and distinguish required coverage gaps from optional assertions.

## Execution graph

### T-01 — Acceptance evidence recovers in the same run
- Changes: controller, result schema, acceptance regression tests.
- Depends on: none
- Verify: a no-repair discovery with missing receipts validates and reconciles; unresolved coverage and failed checks still block.
- Recovery: immutable old reports remain; new state version prevents accidental old-run migration.
- Done when: the incident converges without replacement discovery or source edits.

### T-02 — Requested external reviewers execute reliably
- Changes: bundled bridge, provider scheduling, native submission prevalidation, adapter fixtures.
- Depends on: T-01
- Verify: explicit three-provider coverage; provider options/access retained; malformed results are correctable; deterministic failure is retained.
- Recovery: preserve failed-provider evidence and honest incomplete coverage; never replay uncertain execution.
- Done when: no custom per-task bridge is required and selected coverage is explicit.

### T-03 — Validation and evidence outputs have executable contracts
- Changes: task contract, discovery, worker preflight, output reconciliation, tests.
- Depends on: T-01
- Verify: missing worker environment fails before review; prerequisite commands use the same environment; declared appended receipts survive while policy/source/index mutation stops.
- Recovery: retain source changes and failed checks; no blanket path exemptions.
- Done when: prerequisite and receipt incidents are covered by positive and negative tests.

### T-04 — Discovery reviews run concurrently with a mutation barrier
- Changes: review queue, durable storage, status/submit/run interfaces, cleanup, lifecycle tests.
- Depends on: T-02, T-03
- Verify: both jobs start before either completes; out-of-order native submissions, restart, drift, interruption and failed jobs preserve evidence and cleanup.
- Recovery: source drift stops the concurrent wave safely; historical runs use their original controller.
- Done when: native and external discovery overlap without weakening preservation or quorum.

### T-05 — Instructions and delivery match the executable behavior
- Changes: skill entry points, references, public docs, repair policy, package version.
- Depends on: T-01, T-02, T-03, T-04
- Verify: complete review test suite, skill validation, local documentation links, diff checks, focused inspection and subprocess fault injection at concurrency and evidence boundaries.
- Recovery: leave installation and existing active runs untouched until release is requested.
- Done when: all six audit improvements have implementation and appropriate regression evidence, with remaining platform/live-provider limits stated.

## Risks and verification

The material risks are premature acceptance, discarded sibling jobs, secret leakage, and treating source changes as harmless evidence. Tests must exercise actual controller transitions and subprocesses, including negative controls. Provider stubs establish protocol and scheduling, not live model quality. Parallel discovery may contend for host resources; expose a serial setting and make no unmeasured speedup claim.


## Implementation record

The implementation is prepared as jig-review 0.13.0, with run schema 15. Prior run schemas are not resumed by the new controller; settled records through schema 14 retain explicit release support.

| Audit improvement | Implementation | Regression evidence |
| --- | --- | --- |
| Acceptance awaiting receipts | `awaiting-validation` runs outstanding checks, then returns to triage; resolutions bind original reports to current receipts | Discovery uncertainty converges with zero repairs and two original reviews; failed checks and unresolved coverage still block |
| Provider reliability | Bundled Claude/Cursor bridges, selected-provider slots, coverage status, permanent-failure retention, native submission prevalidation | Local CLI subprocesses preserve fingerprints and options; malformed native submissions are correctable; missing selected providers cannot converge |
| Validation prerequisites | Pinned prerequisite argv and required variable names use the validation worker before discovery; discovery includes repository contracts | Missing worker variables stop required checks; explicit inheritance passes; failed prerequisites start no reviewers; optional failures remain visible |
| Generated evidence | Exact declared JSONL outputs permit only complete appended objects; claims remain separate from controller receipts | Appended records survive direct repair; overwrites, deletion, mode changes, policy files, and undeclared excluded outputs stop |
| Concurrent discovery | Durable bounded sibling queue, out-of-order submission/consumption, result-received status, shared mutation barrier | Both subprocesses start together; reviewer three can start while reviewer one waits; preparation interruption preserves IDs; drift settles all external siblings |
| Causal repair quality | Shared review/repair guidance calls for real dependency/consumer inspection or a small probe; required gaps are distinguished from optional assertions | Paired evaluation fixtures both pass a mock, but the real consumer probe rejects only the broken implementation |

The serial process-ownership and source-reconciliation fixtures explicitly select `reviewConcurrency: 1`; concurrent behavior has its own subprocess and interruption tests. This preserves the intended serial reconciliation contract while checking the new wave barrier separately.

No live model quality or measured production speedup is claimed. Local provider substitutes exercise CLI transport and lifecycle, and the new model-evaluation cases have deterministic fixture oracles but have not been run against live models. These changes are in the working checkout; publishing and refreshing installed homes remain release steps.

## Initial verification result

- Broad command: `node --test --test-concurrency=8 plugins/jig-review/tests/*.test.mjs` — 696 tests reported: 690 passed, four failed, two opt-in live-provider checks skipped. The four failures were assertions loaded before their expectation updates: a concurrent review stopping on source drift, early rejection of ambiguous native repair JSON, preserving both issued reviewer IDs after worker loss, and explicitly serial source reconciliation.
- All four corrected cases passed focused reruns: seven direct-checkout checks, four submission checks, and two worker-loss/serial-drift checks. The full broad command was not repeated after these test-only edits; there are no remaining known failures.
- All 26 new workflow regressions pass, including real local subprocess bridges, interrupted preparation, sibling cancellation, out-of-order results, prerequisites, and evidence-output boundaries.
- The additional regression reproducing initial acceptance rejection before receipts passes with no repair, no replacement discovery, and one validation execution.
- All 32 serial source-reconciliation tests and 19 evaluation fixture/schema/command checks pass. The paired dependency cases' deterministic oracles pass; live model evaluations remain unrun.
- Both skill entry points pass `quick_validate.py`; changed Markdown links resolve; `git diff --check` passes.

T-01 through T-05 are implemented and verified within these limits. No source changes were made in a temporary checkout, and the implementation has not been committed, pushed, or installed into local Codex homes.

## Review corrections

Independent review found two controller interactions missed by the initial fixtures: serial source reconciliation could leave `awaiting-validation` running checks repeatedly, and prerequisite preflight could make a default per-round baseline commit discard the discovery quorum later. Successful validation now requests triage for outstanding acceptance dispositions even without current reports; prerequisite baseline commits no longer request replacement discovery. Fresh review after an actual repair commit remains required.

Bundled external review workers now default to 29 minutes, giving their adapter 28 minutes plus settlement time. Explicit worker timeouts remain binding, with a bounded internal margin. Source-reconciliation documentation now states the concurrent-wave exception next to the serial behavior.

`review-repair-regressions.test.mjs` exercises empty-report reconciliation, default per-round prerequisites with satisfied and uncertain acceptance, real local Claude/Cursor bridge subprocesses over committed ranges, and a slow provider settling before its worker deadline. The repair run validates the full plugin and evaluation suites before obtaining fresh terminal reviews. Its durable run records contain the final execution results; the counts above describe the initial implementation only.
