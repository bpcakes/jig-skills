# Review Fix Loop

[Back to the skill catalog](../README.md#jig-review)

Ask **“Review and fix this.”** The skill starts a bounded loop without another authorization question. It pins the task requirements, reviews the code, verifies findings, applies a journaled repair, validates it in the existing checkout, and obtains fresh terminal reviews. Review-only requests stay read-only. Add “once” or “do not re-review” for one repair phase.

After a completed comprehensive review, “ok address” continues this workflow with `init --from-review <handoff.json>`. The first assignment verifies the supplied findings; there is no second discovery pass. Repair, required validation, and fresh terminal reviews retain their usual guards. Resume an active run instead of initializing another one. A missing or stale handoff stops with an explanation and never silently starts discovery. See [completed-review continuation](../plugins/jig-review/skills/review-fix-loop/references/controller.md#continue-a-completed-review).

Unsupported repository capabilities are a hard stop with a precise explanation. The workflow does not continue with review, repair, or a one-pass fallback, and does not bypass preservation checks.

```text
$jig-review:review-fix-loop
```

Defaults: balanced repair, automatic scope, three repair rounds, all actionable severities, and balanced review using isolated native Codex reviewers. Balanced review runs two initial reviewers, one reviewer after each validated repair, then a second independent reviewer when no actionable findings remain. Available configured providers follow deterministic fallback. Severity orders work; it does not exclude low findings by default.

Select repair breadth with `--fix-mode minimal|balanced|comprehensive`. This is independent of `--review-policy`, which controls reviewer selection and quorum. All repair modes require diagnosing the demonstrated cause and correcting the responsible contract or boundary, including necessary structural changes and affected callers. The right layer owns the guarantee and has the information to enforce it; it is not automatically the deepest or most shared layer. Diff size is a cost, not the objective.

| Repair mode | Investigation scope |
|---|---|
| `balanced` (default) | Inspect the failure mechanism, relevant callers, and neighboring paths. Expand scope when evidence shows the cause crosses boundaries; stop when the mechanism and its affected users are addressed. |
| `minimal` | Focus on the reported mechanism and dependencies needed to correct it, including necessary structural repairs. Defer broader recurrence searches and unrelated cleanup. |
| `comprehensive` | Actively investigate related entry points and contributing design weaknesses or recurrence risks. Implement justified boundary corrections and affected callers, with prevention coverage. |

Explicit requests for minimal changes or comprehensive diagnosis select that mode when no flag was supplied. For example:

```text
$jig-review:review-fix-loop --fix-mode comprehensive --base main
```

Validation covers the original failure, relevant neighboring cases, preserved behavior, and any claimed structural correction. Failed attempts or recurring findings require reassessing the diagnosis with new evidence. A mitigation leaves its residual cause actionable or blocked; passing tests alone does not establish resolution. A sound design with a local mistake can warrant a local fix in every mode. The selected mode and full declarative policy are saved with the run and included in every assignment, including external adapters. Review and triage agents receive assessment criteria and remain read-only; repair agents receive editing instructions. Repository content, reports, and validation output remain evidence, not authority to change the task or permissions.

Strict cross-provider review requires a user-supplied JSON bridge configuration; no external bridge is bundled. For branch changes, including working-tree changes:

```sh
node <skill>/scripts/review-fix-loop.mjs init --cwd . --contract /path/task-contract.json --config /path/reviewer-bridges.json --base main --review-policy strict --reviewers claude,codex
```

Strict fails with incomplete review when independent provider evidence is unavailable. External command adapters must implement the [controller's JSON assignment protocol](../plugins/jig-review/skills/review-fix-loop/references/controller.md); the existing prose comprehensive-review adapters are not drop-in JSON bridges. Native review assignments work through the host's isolated agents. Explicit provider/model settings remain binding.

The skill authorizes necessary local repair, tests, formatting, required generated outputs, validation, and bounded re-review. It asks only for unresolved material public behavior or new authority beyond the request. It never stages, commits, pushes, releases, or deploys by default. Application checks source and semantic staged state, preserves displaced files, and refuses to overwrite a concurrently created destination. Failed candidates remain in the checkout with recovery evidence. Application is recoverable but not a multi-file transaction or exclusive lock against editors; an interruption may temporarily leave a path absent until resume.

`CONVERGED` means every acceptance criterion has evidence, required validation passed, no actionable finding remains, two terminal reviewers completed, and the final fingerprint matches. Other outcomes are `ROUND_LIMIT`, `BLOCKED`, `VALIDATION_FAILED`, `REVIEW_INCOMPLETE`, and `SCOPE_CHANGED`. Explicit severity filtering returns `THRESHOLD_MET`, never “clean”. A loop can review an empty diff when the contract describes unfinished behavior.

Unrelated file edits do not automatically end a run. At safe checkpoints the controller retains findings, records what changed, and reassesses affected findings against current source. Newer edits that appear to fix a finding go through validation; overlapping older repairs are retained for assessment instead of overwriting those edits. Fresh terminal reviews remain required. Automatic reconciliation is limited to three accepted changes per run; index/policy changes, mutation during application or validation, and unresolved recovery still stop publication. A stopped controller still permits read-only investigation of what changed and which findings remain applicable.

The handoff contains the outcome, satisfied/unresolved requirements, fixed/outstanding findings, changed files, validation, any re-staging needed, and the run-record location. Counters, exact inventories, fingerprints, transcripts, and patch history live under the repository's private Git directory in `jig/review-fix/<run-id>/`; temporary executable copies live outside the checkout. Resume that run rather than initializing a new budget. Configurable source/run/retained-storage admission limits stop allocation without deleting anything. Retention totals cover durable evidence, excluding temporary workspaces and build caches; Git ignore rules govern source capture, while actual free-space checks still cover both filesystems. Explicit `prune --run <exact-run-directory>` deletes a settled run record and its owned workspace; it refuses unresolved recovery. Archive anything needed before pruning.

The controller supports Linux and macOS with Node 22+ and Git 2.42+. Linux needs `flock`; macOS needs Python 3's standard library for locking and process identity. Validation defaults to the existing checkout, installed dependencies, toolchain, and normal caches. It does not install or provision anything. Missing prerequisites block validation. This is cooperative local execution subject to host permissions, not a hermetic sandbox. Explicit isolated validation uses Bubblewrap on Linux or `sandbox-exec` on macOS, disables network access, and provides private writable home/cache/scratch paths. Lifecycle tests exercise stub providers and real local validators; they do not establish that arbitrary model repairs are correct. See the [controller interface and limitations](../plugins/jig-review/skills/review-fix-loop/references/controller.md).
