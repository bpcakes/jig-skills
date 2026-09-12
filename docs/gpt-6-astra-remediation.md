# Astra priority fixes and remaining audit work

Implementation follow-up to the [2026-09-12 audit](gpt-6-astra-skill-audit.md), against the original skill versions at `9c47b5e36bb641721abeb7343bed82d72350cdb2`. The original audit remains a historical record; its line numbers refer to that revision.

This pass corrects the highest-priority instruction conflicts, delegated completion, and installation failure. It also implements explicit Astra evaluation controls and selected context/output reductions. It does not claim that every skill is fully optimized or that passing fixtures establish a general efficiency gain.

## Changes delivered

| Audit item | Change |
|---|---|
| A1 — mode, scope, authorization | Comprehensive review now separates the frozen read-only phase from previously authorized parent repairs and loop-owned repairs. Ruby assessment recommends tests without writing them. Swift consistently honors named unchanged files. TypeScript abstraction review respects the host instruction hierarchy. |
| A2 — evidence and severity | Replaced pattern-based severity in React state/API and transaction review; removed numeric rejection of independent boolean variants; corrected the detailed callback rules. Privacy severity tables now separate actual low-impact violations from missing documentation/tests, weak evidence, benign controls, and protected/gated paths. |
| A3 — delegated completion | Cursor receives whole-plan completion by default, or an explicit `--milestone` boundary. The parent inspects acceptance and resulting files, continues incomplete implementation in the same workspace, preserves live handles, and performs remaining validation/bookkeeping directly. Exit status and task completion are separate. No provider substitution or broader force permission was added. |
| A4 — identifiable evaluations | Added independent task/judge model and effort flags; strict missing-value checks; requested configuration and unknown effective-configuration recording; elapsed time, token usage, repeated-command and skill-resource-mention proxies; export verification against argv and raw traces. Added 13 behavioral cases, bringing the suite from 33 cases/14 targets to 46 cases/23 targets at the time of the recorded runs. |
| A5/A6 — selected preparation and verification | Fowler Rust references are conditional and assessment no longer requires a workspace-wide test baseline. Ruby can assess without a test suite and reuse an unchanged baseline. TypeScript duplication supports direct named-pair comparison without optional tooling. Plan skills handle absent standards. |
| A7 — supplied network evidence | Network analysis reuses a supplied capture and its manifest without generating new sentinels or starting fresh account activity. New capture is a separate mode. |
| A8 — install/resource portability | Standalone privacy installs include `audit-common` for Codex and Claude. Dependency conflicts fail before writes for explicit selections; all-skills installation skips affected dependents while preserving existing copies. Automatic dependencies remain protected from `--force`. Rust/TypeScript scanner and privacy helper examples resolve from installed skill directories. |
| A9 — selected output reductions | Removed compulsory no-op plan revisions and usefulness scores. Rust source reorganization links edited files rather than always echoing them, avoids speculative TODOs, and reconciles warning-preservation rules. Fowler Rust permits compact assessments. |
| A10 — configuration documentation | Added explicit Astra evaluation and comprehensive-review examples without changing host defaults, Claude/Cursor roles, or invocation metadata. |

The skill-creator guidance informed the preservation of user scope, conditional reference loading, and independent forward tests. The plugin update/reinstall flow was not used: this task changes repository sources, not the operator's installed plugins or marketplace configuration.

## Validation and evidence

Local checks:

- Evaluation harness: 100 tests passed, including separate agent/judge argument propagation, exact execution-provenance validation, failed-phase provenance, staged-index preservation, unknown usage, tamper detection, cancellation, and exports.
- Review runtime: 158 tests passed; two real-provider tests skipped by their existing opt-in gate. The focused installer suite now has 37 passing checks, including force-replacement and conflict-isolation coverage for shared privacy dependencies.
- Cursor launcher: eight tests passed for provider/path preservation, milestone and force propagation, unavailable models, failure status, and continuation from an actual worktree with a relative plan path. These are launcher boundary tests, not live Composer evidence.
- All 23 changed skill entrypoints and all seven plugin manifests passed the supplied validators.
- Documentation links, source diffs, and final changed-file scope are checked separately from model grades.

### Behavioral runs

The comparison and corrected-case runs use Codex CLI 0.154.0 with requested task and judge model `gpt-6-astra`, effort `medium`, and a 240-second per-phase deadline. The judge is a separate invocation of the same model family, not an independent model-family review. The CLI trace does not expose a resolved model/effort attestation; records explicitly use `reported: null`.

The first updated-skill run is preserved in [the initial result record](../evals/results/2026-09-12-astra-priorities-initial.json): 11 of 13 trials passed all gates. Both failures were test-definition errors: the plan-repair and already-authorized-repair cases required zero findings even when the answer accurately summarized the defect it had fixed. Both trials passed invocation, scope, trace, and semantic checks. The corrected cases allow at most that one actual defect and explicitly forbid invented issues. Both were rerun; the original failed results are not relabeled as passes.

The [corrected-case rerun](../evals/results/2026-09-12-astra-priorities-corrected.json) passed both trials under the corrected oracles; its raw evidence is `/tmp/jig-skill-evals-dzUVE6`. That temporary run no longer contains a matching `source/` snapshot, and the available retained sources have a different suite hash, so this record cannot now be independently reverified. It remains historical evidence rather than being reconstructed against mismatched source. The [provenance sidecar](../evals/results/2026-09-12-astra-provenance.json) records this limitation and binds all four comparison reports by SHA-256 without claiming that their machine-local raw artifacts are durable. The one-case Swift pilot also passed with a 180-second deadline and is retained at `/tmp/jig-skill-evals-1Gi3Ts`; it is not pooled into the comparison.

The [original-skill comparison](../evals/results/2026-09-12-astra-original-initial.json) used the original checked-in plugins in detached worktree `/tmp/jig-astra-baseline.D9tBSf/checkout`, with the exact same updated harness, cases, schemas, model, effort, and judge configuration. It passed 10/13 strict gates and 12/13 semantic outcomes. It had the same two findings-count oracle failures, and `astra-plan-repair-no-standard` also failed invocation because its combined skill/standards/plan read exited nonzero. It additionally had a real no-op-plan failure: it added an unnecessary revision note and returned a usefulness score after finding no substantive gap. The updated skill left that plan unchanged and passed the same test. The original versions passed the other semantic checks; this experiment does not demonstrate a behavior improvement for every edited rule.

Observed task-agent measurements for those complete, matched 13-trial batches (including every failed trial):

| Measurement | Original skills | Updated skills |
|---|---:|---:|
| Semantic outcomes passed | 12/13 | 13/13 |
| Total input tokens | 1,008,718 | 962,092 |
| Input tokens minus cached input | 252,622 | 274,348 |
| Output tokens | 7,459 | 7,301 |
| Completed commands | 51 | 54 |
| Cumulative task-agent elapsed time | 377.577 s | 391.813 s |

These are separate, single-trial batches, not a randomized or statistically powered benchmark. Cache conditions differed; the measurements exclude grader time/usage. Results are mixed: less total input/output did not translate into lower uncached input, fewer commands, or lower total elapsed time. **No general efficiency gain is established.** Raw records retain per-case and judge metrics for investigation.

The [corrected-oracle original-skill rerun](../evals/results/2026-09-12-astra-original-corrected.json) passed 1/2 strict verdicts and both semantic outcomes. `astra-plan-repair-no-standard` failed the invocation gate: its combined `cat SKILL.md .agent/PLANS.md plan.md` returned skill text but exited 1 because the standards file was absent. The conservative invocation detector requires a successful command and rejected that read; this is not proof the skill went unread. That failure is retained rather than converted into a pass or treated as a demonstrated code defect. Its raw evidence is `/tmp/jig-skill-evals-GQDDij`; the matching source remains in the detached baseline worktree. These separate reports are not pooled into a manufactured full-suite pass rate.

Raw updated-run evidence and its matching evaluator/skill snapshot are retained at `/tmp/jig-skill-evals-Cs2ZS4`. To reverify the historical initial record after later source edits:

```sh
node /tmp/jig-skill-evals-Cs2ZS4/source/evals/export.mjs --verify \
  evals/results/2026-09-12-astra-priorities-initial.json
node /tmp/jig-skill-evals-KJaThx/source/evals/export.mjs --verify \
  evals/results/2026-09-12-astra-original-initial.json
```

These are machine-local temporary directories, not durable archives. Their `source/` trees contain the matching evaluator snapshot used by the commands above; preserve or archive the complete run directories if long-term reverification is required. The checked-in result JSON alone is not a reproducible provider run.

This repository intentionally keeps portable JSON reports and the compact provenance sidecar rather than silently copying raw run directories into version control. Future evidence that needs durable replay should use `--output` on persistent private storage or an explicit external artifact archive instead of the default temporary directory, then record the archive URI and SHA-256 digest in a new provenance record.

All checked-in result records in this section use the format-3 evaluator and hash the skill state at their run time. They predate the later final review fixes to comprehensive-review repair safety, evaluator failure provenance, Cursor worktree continuation, ExecPlan milestone selection, and Rust review instructions. They therefore document the earlier experiment, not validation of the final unstaged text.

### Independent Cursor-parent forward tests

An isolated fixture supplies two real source edits and acceptance commands, with a deterministic local Cursor replacement that performs one milestone per call and deliberately leaves bookkeeping incomplete. No actual Cursor/Composer provider is called. Independent agents receive only the user task, skill, workspace, and executable location; they do not inspect the test double.

The whole-plan parent completed both milestones rather than stopping after the first successful exit. The milestone-limited parent left Search unchanged in its final result. The first pass exposed unnecessary implementation calls for documentation-only work; the milestone test double then changed Search despite the narrowed prompt, and the parent restored that attributable edit. The skill was corrected to reconcile verified records directly. The repeated trials then completed with two calls for the whole plan and one for Labels alone, with no Search edit in the limited trial. The root agent independently checked the resulting source, call log, acceptance commands, and clean Search diff. Fixture commands and resulting files are retained at `/tmp/jig-astra-forward.GFi1Rh`.

These checks establish parent behavior under simulated partial child results. Live Composer completion, isolation, authentication, and provider-specific steering are not established by them.

## Remaining concerns from the original audit

| Audit item | Unaddressed or partial work |
|---|---|
| A1/A2 | The identified P1 instruction conflicts have been edited, but realistic composed review-and-fix runs and wider evidence/severity counterexamples remain valuable. The loaded repair fixture does not execute the initial independent reviewers. TypeScript type-system review's residual style-oriented flags still need cleanup. This pass is not a certification of every domain-specific checklist or scanner. |
| A3 | Run the full workflow with authenticated Composer, including isolated worktrees, unavailable capabilities, cancellation, and mid-run user changes. The deterministic fixture cannot establish provider behavior. |
| A4 | Seventeen skills still have no dedicated case. Run the full suite and held-out/repeated trials, add installed-plugin discovery and an opt-in real orchestration lane, assess ordinary Markdown output without a forced schema, and inspect clarification/approval behavior. Failed batched reads can produce conservative invocation false negatives even when skill text was returned. Exact command repeats and output-byte metrics are proxies, not proof of wasted work. No automatic effort tuning or catalog-wide performance claim is justified. |
| A5 | Physically split remaining long entrypoints/catalogs and repeated React/abstraction guidance where measured context savings justify it. Rust duplication still mandates scanner-driven preparation. Fowler Ruby and several privacy workflows still have substantial mandatory references/procedures. Keep lifecycle coverage for genuinely stateful plans. |
| A6 | Continue risk-based verification cleanup in remaining Ruby/Rust duplication procedures and supporting examples. Validate source-reorganization behavior on order-sensitive macros, attributes, cfg, and formatter configurations before claiming broad mechanical safety. |
| A7 | Intake reuse and separate static/capture/retest/register/disclosure branches are still needed across the other privacy skills. Only supplied-network-artifact routing was corrected here. Preserve actual access, redaction, and external disclosure boundaries. |
| A8 | The reproduced dependency failure and cited helper paths are fixed. Live installed-plugin discovery across hosts and broader scanner correctness remain outside the installation tests; they are not known remaining instances of the original missing-dependency bug. |
| A9 | Several React report templates, including top-issue placeholders and large checklist sections, still need proportional-output cleanup. Preserve downstream schemas, provenance, and required evidence inventories. |
| A10 / optional cleanup | Verify host-specific effort mappings and effective native-child propagation. Test steering/cancellation in a real host. Generic persona/advice cleanup in the Rust, TypeScript, and Swift simplifiers remains optional. No metadata files were added merely for symmetry; the internal support skill remains discoverable under its existing policy. |

Plugin release/version bumps, publishing, and reinstalling the operator's plugins were not performed. Temporary evaluation workspaces and the detached baseline worktree are retained for reproducibility; no existing user installation was overwritten.
