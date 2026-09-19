# Controller interface

Run `node <skill>/scripts/review-fix-loop.mjs <command>` on Linux or macOS with Node 22+ and Git 2.42+ (needed to locate system attribute policy). Linux uses `flock` and `/proc`; macOS uses Python 3's standard-library kernel locking and the system `libproc` process API. No packages are installed by the controller. Validation defaults to the repository's existing checkout, installed dependencies, toolchain, and normal caches. It is cooperative local execution subject to host permissions, not a hermetic sandbox. Missing tools or dependencies are failures, not skipped checks or permission to install anything.

## Start and resume

```sh
node <skill>/scripts/review-fix-loop.mjs plan-validation --cwd /repository
node <skill>/scripts/review-fix-loop.mjs init --cwd /repository --contract /tmp/task-contract.json
node <skill>/scripts/review-fix-loop.mjs run --run /repository/.git/jig/review-fix/<id>
node <skill>/scripts/review-fix-loop.mjs advance --run /repository/.git/jig/review-fix/<id>
node <skill>/scripts/review-fix-loop.mjs status --run /repository/.git/jig/review-fix/<id>
```

Always use the returned run path; linked worktrees store the run under the common Git directory. Only one active run may exist for that repository. `run` drives the executable loop until a terminal outcome, an unanswered contract question, or a native assignment requiring a result. `advance` performs one durable transition or consumes/starts one assignment. Neither resets rounds or provider attempts. `status` reads recorded state; a terminal status describes the recorded fingerprint, not later checkout changes.

Automatic branch-base detection checks `refs/remotes/origin/HEAD`, then `main`, `master`, and `trunk`, preferring the local branch over `origin/<name>` for each name. Explicit bases remain binding.

Normalize loop options with `node <skill>/scripts/loop-options.mjs`. The default is native Codex with checkout validation; no configuration file is required. For explicit provider bridges, inherited environment variables, or isolated validation, read [configuration.md](configuration.md) before `init`. The bundled comprehensive-review prose adapters are not JSON bridges.

Capability checks run before allocation. On an unsupported repository or platform, report the reason and stop without bypassing guards or falling back to another workflow. Each run belongs to its original repository and host. Older runs require their original controller; do not migrate or restart them silently.

## Task contract

Create the JSON file outside the working tree. Example:

```json
{
  "goal": "Preserve an item's display order after rename",
  "acceptanceCriteria": [{"id": "order", "description": "Renaming preserves the current ordering"}],
  "nonGoals": ["Changing the sorting UI"],
  "compatibilityConstraints": ["Keep the existing public API"],
  "permittedBehaviorChanges": ["Correct ordering after rename"],
  "requiredValidation": [{"id": "unit", "argv": ["npm", "test", "--", "--runInBand"]}]
}
```

Validation commands are argv arrays, never implicitly interpreted shell strings. Optional relative `cwd` selects a subproject. A check's `timeoutMs` overrides the shared configuration timeout (default 300000 ms); both accept integers from 1 to 2147483647. Set longer check timeouts in the frozen contract when the repository needs them. The resolved timeout is recorded with each result. `optional: true` records a nonrequired check; at least one command must be required. Include formatter checks, build/type checks, affected tests, relevant integration checks, and locally available CI equivalents when repository evidence calls for them. The discovery command reports manifests, task runners, CI files, and package-script candidates; the host must resolve a concrete plan before `init`. No automatic dependency installation occurs. Manifest discovery uses bounded regular-file reads; relative symlinks may resolve only through included repository files. External, cyclic, special-file, or oversized targets stop with their path and reason before run allocation.

Every criterion needs evidence in every review report, referring to required validation IDs. A missing, uncertain, or unsatisfied criterion prevents convergence. The controller checks that evidence is present and that its referenced checks passed; the reviewer must assess whether the evidence actually proves the requirement.

Discovery normalizes every invocation directory to the repository root, exactly as initialization does. Candidate `source` and `cwd` paths are always repository-relative, including when invoked inside a package. Each validation receipt records its actual execution directory, workspace, source root, validation mode, and sandbox.

## Native assignments

At a native boundary, read [assignments.md](assignments.md), return the result matching the supplied `resultSchema`, submit it, and continue the same run. Reviewers receive only their own assignment in a fresh context. Honor its provider/model/effort settings. Triage and repair may run in the parent, subject to their assignment permissions.

Every assignment contains the selected `fixMode` and the full declarative policy pinned at initialization. Review and triage assess that policy while remaining read-only; only repair assignments authorize edits. The controller checks evidence structure, not the truth of a causal explanation. A mitigation's residual cause remains actionable or blocked. Resume keeps the saved mode and policy.

## Validation and waiting

The controller applies a candidate through its recovery journal, then runs the pinned validation commands in the existing checkout by default. Failed checkout candidates remain visible; there is no automatic rollback. Commands may write ignored build/cache outputs, but may not change source inputs or staged content. Include generated source changes in the repair. Only controller validation supplies required validation evidence; checks cannot be waived by triage or severity filtering. Missing dependencies are blockers, not installation permission.

The following candidate rules apply to both `workspaceEdits` and inline `edits`. Repairs are recorded as content-addressed candidates, not staged in the Git index. Recovery receives a failed candidate's patch and failure history and consumes another round. In explicitly isolated mode failed candidates stay outside the checkout. Returning the same file state or an earlier state terminates with no progress or oscillation, with one exception: after an applied checkout candidate fails required validation, an explicitly proposed, causally attributed repair returning exactly to the original contents may consume a recovery round. It uses the normal guarded application journal and stops `BLOCKED` with code `RESTORED_ORIGINAL`, without further review or a claim of convergence or fresh validation of the restored state. Interruption preserves this restore-and-stop decision; concurrent source/index changes still stop application.

When `waiting` is true, poll the same run. Do not launch replacement work. Stop on `cleanupBlocked`; read [recovery.md](recovery.md) for uncertain execution, refused admission, unsupported capabilities, or application/cleanup obligations. Known completed validation failures may enter counted repair recovery; uncertain execution is never replayed, even for optional checks. A terminal verdict does not waive pending cleanup or backup preservation.

## Artifacts and handoff

Version-10 `run.json` is authoritative; it references immutable manifests, source blobs, assignments, reports, patches, logs, and backups. `events.jsonl` and `validation.json` are projections. Keep the run for resume and diagnosis. Read [storage.md](storage.md) only for capacity, archival, or explicitly requested pruning; cleanup of settled workspaces does not authorize deleting the retained run.

Report the outcome succinctly and link the run directory. Re-staging guidance describes final working files; it does not authorize staging. For dirty submodules, perform any separately authorized staging in the owning repository, from the innermost submodule outward. A skipped optional check remains visible. A failed or skipped required check, a missing acceptance criterion, an incomplete reviewer quorum, or an unmatched fingerprint prevents `CONVERGED`.
