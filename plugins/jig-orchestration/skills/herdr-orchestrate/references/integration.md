# Proactive integration checks

Read when setting up a run, publishing a candidate, or handling an integration blocker. Git 2.43+ and authenticated read access to the source are required on the coordinator. Git 2.43 includes the [fix for `merge-tree --attr-source` crashing](https://github.com/git/git/commit/e95bafc52f); review-only hosts retain their review controller's separate prerequisite. The helper probes committed snapshots in `<run-dir>/integration/objects.git`, never the worker's index, working tree, branch or `FETCH_HEAD`. It does not resolve conflicts or certify uncommitted work.

## Configuration and candidates

Integration checks are enabled by default, including for resumed state. The default source is the configured repository's `origin` URL. The configured repository path must be available on the coordinator so its merge policy can be inspected. A deployment with a remote-only checkout must establish a coordinator checkout and verified source binding before adopting this path; absence remains unknown. Configure an explicit source or repository-specific overlap groups when needed:

```json
{
  "integration": {
    "source": "ssh://git@example.invalid/team/repository.git",
    "timeout_seconds": 30,
    "max_age_seconds": 120,
    "overlap_groups": {
      "migrations": ["db/migrations/*"],
      "api-generation": ["schema/*", "generated/api/*"]
    }
  }
}
```

Use `configure` with existing setup authority and capability evidence. `source` is coordinator-owned; a worker cannot choose an executable, remote URL or another task's observation route. Without `source`, `remote` selects a registered Git remote name (default `origin`). A scan has a total time budget, at most 60 seconds; evidence age is bounded at stage admission and dispatch (default 120 seconds, configurable up to 3600). Default overlap groups cover common migration directories and generated-file paths. An explicit `overlap_groups` replaces those defaults; `{}` retains exact-path overlap detection only.

Admission registers candidate `branch` at `refs/heads/<task-branch>`. Older tasks without candidate registrations use the same fallback. Publish useful commits early so the source can supply them. A missing branch or inaccessible commit is unknown, not a conflict or a clean result. For a PR, bind that candidate to the PR number and its fetchable ref through the normal authenticated transition:

```json
{
  "op": "candidate", "action_id": "A-pr-42", "task_id": "A",
  "expected_policy": 1, "expected_task": 2,
  "candidate": {"id": "branch", "ref": "refs/pull/42/head", "pr": 42},
  "evidence": {"ref": "/evidence/PR-42.json", "observed_at": "2026-11-03T12:00:00Z"}
}
```

Use actual versions, references and observations. Multiple PRs have distinct candidate IDs; explicitly retire obsolete registrations with `active:false`. A confirmed merge retires candidates bound to that PR. A new PR on a reused branch requires a new or reactivated registration. Candidate changes do not rewrite active review references or authorize another writer.

## Mechanical checks and gates

The CLI `apply`, restricted `serve`, and configured `execute` paths refresh observations before new final stages. Successful merge, push and PR outcomes durably invalidate observations before attempting a scan; a crash or busy scanner leaves that invalidation for recovery. Resuming a completed runner action performs any pending refresh without replaying the external operation. Scheduler passes scan at the authorized cadence, and `complete` scans before recording a new full reconciliation. Neither creates an extra coordinator prompt for each probe. For an explicit bounded refresh:

```sh
python3 <skill-root>/scripts/supervise.py integration --run-dir <private-run-dir>
python3 <skill-root>/scripts/supervise.py integration --run-dir <private-run-dir> --task A
```

The restricted route accepts `{"op":"integration","task_id":"A"}` and returns only that driver's compact evidence. A scan refreshes registered candidates together, using one remote ref listing and at most one object fetch. One failed ref does not make other candidates unknown. Results are cached by source/target commit pair, Git version and relevant policy. A failed remote observation cannot reuse an old clean result as fresh evidence. A transient listing failure gets one bounded retry inside code. Concurrent stage refreshes return `busy` and record a waiting predicate; superseded scans cannot publish over newer registrations or observations. Reconciliation completion waits for the shared scan within the configured time budget and retries superseded snapshots in code. If that budget expires, the scheduler retains `integration_completion` and resumes that completion on a later tick without another coordinator prompt. An expired scan cannot publish: earlier observations remain last-known evidence, stale for admission, without new unknown-result notifications. A stopped scheduler retains the pending completion until resumed or explicitly completed.

New `review`, `merge`, and final `validate` stages require `target.head` as the exact source SHA and a fresh clean observation. Select `candidate_id` explicitly when more than one candidate is active. The helper binds the candidate, source SHA and probe configuration at reservation/intent, then rechecks them before dispatch. A target-only change that is freshly clean updates the observation and adapter payload while keeping the same assignment, counter and frozen review references. Changed source, merge policy, conflicts or unknown evidence still prevent dispatch. Rejected admission consumes no attempt or slot; an already counted preparation retains its history and must be settled as unstarted before replacement when replacement is necessary. Raw `Engine.apply` performs no Git commands and requires already refreshed observations; use the CLI/route wrappers for automatic refresh.

`validate` defaults to `purpose:"final"`. Use `purpose:"repair"` for focused repair checks and `purpose:"acceptance"` for post-merge acceptance (which requires a recorded merge). Carry the same purpose from reservation to intent. These checks, implementation, repair and publishing remain available during an integration blocker. Do not relabel final validation to bypass a gate. Successful probes do not establish validation applicability or replace required CI, review, feedback or repository merge policy.

Adapters receive `integration:{candidate_id,head,target,configuration}` and the stage `purpose`. Verify the live candidate and target immediately before the side effect; a supplied `target_current:true` remains an assertion about repository policy, not an alternative to integration evidence. The helper's check cannot atomically freeze the remote target. Preserve required queues/protections and the existing [merge contract](delivery.md#merge-gate).

The probe uses Git's real `merge-tree --write-tree` machinery and validates structured output as well as exit status. Missing objects, unsupported Git, unrepresentable custom merge drivers/attributes or command failures remain unknown. Alternate attribute sources (`attr.tree` or `GIT_ATTR_SOURCE`) are unsupported and produce unknown evidence instead of substituting the target's policy. These need a verified capability repair; do not silently assume default merge semantics. The probe does not execute repository-defined merge drivers. `integration.enabled:false` exists for explicitly retained legacy/manual deployments; it removes automatic enforcement and must be disclosed. Do not disable it to make a blocked candidate appear ready.

## Driver handoff and repair

Task views expose compact current evidence, conflict paths, overlapping owners and the next action. Watch tokens use actionable changes separately from observation timestamps and target freshness. Clean-to-clean refreshes and evidence expiry do not wake a driver. A continuing conflict retains one incident ID even when the target advances; its evidence updates without another conflict notification. Transient unknown results remain silent unless a stage is waiting for evidence. A waiting stage exposes `waiting.status`: `pending`, `ready`, `candidate_changed`, `head_changed`, `policy_changed`, `unknown` or `conflicted`, with an appropriate next action. Waiters retain an existing reservation or preparation's original candidate, head and policy, including while a shared scan is busy. A changed candidate or head requires settling that unstarted assignment before replacing it; changing the request's head cannot make the old assignment ready. Changed heads and completed observation failures wake that driver once; repeated identical outcomes stay silent. Successful gated reservation, intent or dispatch clears the waiter. Freshness remains mandatory at admission and dispatch.

Use `watch` with `until_change:true` (CLI `--until-change`) in the existing waiting process to keep polling inside code until a relevant change, control change or route failure. CLI and restricted watches stop when their response pipe/socket closes; request EOF only delimits JSON and does not end the wait. Programmatic callers supplying their own transport pass its response file descriptor or own cancellation. The default bounded watch remains available; its `changed:false` timeout requires no model reassessment.

Record a driver's acknowledgement with `op:"integration_ack"`, `candidate_id`, `incident_id`, and ordinary action/task versions plus evidence. A recorded or returned handoff is not proof a busy driver has read it. If the driver is busy, deliver one compact handoff using its established supported route or retain it for its next boundary; do not inject cancellation or approval keystrokes. No additional coordinator review or task permission is needed for already authorized repairs.

Let live tests and the active review run settle under their existing contracts. There is no new controller drain/cancel API. At the safe writer boundary, refresh once more and integrate the latest required target, combining intervening target updates. Resolve both tasks' intended behavior, run focused repair checks, then complete required final validation and review. A material integration after review begins needs an explicit successor with the new fixed base, full PR scope, carried findings and cumulative budget. Preserve any user-pinned immutable-base contract. A target SHA change by itself does not require a merge or a new full review.

Exact shared paths and configured groups are advisory signals between distinct candidates, including multiple PRs owned by one task. Different migration files can still conflict operationally; generator inputs and outputs can need coordinated regeneration. Inspect a concrete overlap with its owners, establish a dependency only when supported, and run the relevant integration checks. A clean Git result is not semantic acceptance. Unrelated tasks continue independently. An observation failure retains last-known paths and their evidence; all affected partners keep the advisory marked `overlaps_stale`, with original evidence references in `overlap_evidence`. Stale/fresh bookkeeping does not repeat the notification. A successful observation or explicit retirement can resolve the overlap.

## Evidence and rollout

State retains current integration observations separately from task references, grants, counters and active execution records. Immutable scan and pair results live in the private integration directory. Integration statistics count scans, probes, cache hits, fetches, failed scans and blocked stage requests. Conflict incidents retain target-observation, detection, acknowledgement and resolution times, plus executions active at detection; these identify review work potentially invalidated by target movement without falsely declaring it wasted.

Compare elapsed delivery time and actual reported tokens per accepted task on comparable workloads. Review/validation discarded because of target movement and no-op wakeups are overhead. Use existing provider usage evidence; missing usage is unknown, never zero. The tests establish event/gate behavior, not a measured production speedup.

Adopt 0.5.0 in the selected coordinator/driver profiles through the existing setup route. Verify the source and probe once, then continue existing work. Active executions can still report outcomes and settle; only new final stages require the new evidence. Keep standing grants, claims, counters, findings and saved review bases. Do not overwrite a run or restart surviving workers to backfill observations.
