# Runtime interface

Use `python3 <skill-root>/scripts/supervise.py --help` for installed commands. Python 3.10+ on Linux/macOS is required. The helper serializes state and authority checks; it does not launch task workers, perform tracker/GitHub operations, cancel processes, or determine whether supplied external evidence is true. The authorized coordinator/driver performs those operations and records observed receipts. The scheduler's only Herdr mutation is a guarded wake prompt to its registered coordinator.

## Initialize and inspect

```sh
python3 <skill-root>/scripts/supervise.py preflight --config <config.json> --host <host-id>
python3 <skill-root>/scripts/supervise.py init --run-dir <private-run-dir> --config <config.json>
python3 <skill-root>/scripts/supervise.py status --run-dir <private-run-dir>
python3 <skill-root>/scripts/supervise.py status --run-dir <private-run-dir> --task <task-id>
```

The run directory must be outside source control, private to the coordinator user, and not a shared cross-host filesystem lock service. It contains configuration/current state plus durable per-action records. Supervisor liveness uses one atomically replaced `heartbeat.json`; state queries include its latest timestamp without adding an action record or changing state versions. Initialization never starts the scheduler. Existing state must be resumed, not overwritten. Do not edit state files directly.

A minimal configuration shape is:

```json
{
  "repository": {"path": "/work/coordinator/repository", "target": "main"},
  "scope": {"task_ids": ["example-A", "example-B"]},
  "tracker": {"kind": "bead", "authority": "configured-coordination-ref"},
  "hosts": {
    "local": {
      "slots": 2,
      "worktree_root": "/work/task-worktrees",
      "endpoint": {"session": "delivery"},
      "roles": ["coordinator", "review", "tracker"],
      "reviewers": ["codex", "claude"],
      "profiles": [{
        "id": "selected-codex-profile",
        "agent_home": "/home/user/.codex-selected",
        "required_skills": ["herdr-orchestrate", "herdr", "comprehensive-review", "review-fix-loop"],
        "skill_paths": {
          "herdr-orchestrate": "/home/user/.codex-selected/skills/herdr-orchestrate",
          "herdr": "/home/user/.codex-selected/skills/herdr",
          "comprehensive-review": "/home/user/.codex-selected/skills/comprehensive-review",
          "review-fix-loop": "/home/user/.codex-selected/skills/review-fix-loop"
        }
      }]
    }
  },
  "actors": {},
  "authority": ["implement", "review", "repair", "validate", "push", "pr", "merge", "close"],
  "unfinished_task_cap": 4,
  "limits": [],
  "scheduler": {"enabled": false}
}
```

Replace example paths/authority/scope with established facts; a syntactically valid config is not a verified setup. Expand an epic into its authorized task IDs at initialization. Add registered remote hosts with their exact endpoint/profile contract. `preflight` inventories the selected host entry **on the current machine**; run it in each actual host/profile environment. It checks versions and installed skill paths/digests. Authentication, matching review-pair compatibility, remote routes, and control behavior require separate receipts. Optional profile `expected_skill_hashes` maps skill names to pinned full-directory digests.

Profiles inherit host `roles` unless they provide their own `roles` list. A review profile must contain both review skills itself; splitting the pair between homes does not satisfy its inventory. A coordinator profile requires `herdr-orchestrate` and `herdr`. Other `required_skills` add the task-specific inventory.

An independently acting driver has an `actors` entry such as `{"worker-a":{"role":"driver","task_ids":["example-A"],"host":"local","helper_route":true}}`. Set `helper_route` true only after the restricted reverse route is verified; otherwise the coordinator mediates consequential transitions. Models, tool versions, acceptance contracts, review policy/fanout, and capability receipts remain configuration context for the driver; the helper does not invent executable adapters from those fields.

Hard counted limits have `id`, `unit`, `scope` (`task` or `run`), integer `max`, and `enforced:true`. Supported units are `implementation`, `source_repair`, `review`, `validation`, `push`, `pr`, `merge`, `deployment`, and `closure`; they correspond to action kinds `implement`, `repair`, `review`, `validate`, `push`, `pr`, `merge`, `deploy`, and `close`. The helper rejects a mismatched kind/unit, but the driver must demonstrate that no relevant assignment bypasses reservation. `launch_cutoff`, when set, is a timezone-aware ISO timestamp. See [controls](controls.md) for unsupported spending caps and cancellation limitations. Configuration metadata must not be described as enforcement the runtime does not provide.

## State transitions

The coordinator submits a JSON request file with:

```sh
python3 <skill-root>/scripts/supervise.py apply --run-dir <private-run-dir> --request <request.json>
python3 <skill-root>/scripts/supervise.py action --run-dir <private-run-dir> --id <action-id>
```

`--request -` reads one object from stdin. Every transition has `action_id`, `op`, and the observed `expected_policy`; an existing task also requires `task_id` and `expected_task`. Read current versions and use the returned versions after a transition. A version rejection requires fresh observation, not merely swapping numbers into a stale decision. Retrying an identical action ID/request returns its original result; changing the request or caller under that ID is rejected. Use `action` to reconcile lost acknowledgements.

For example, a run pause observed at policy version 1 is:

```json
{"action_id":"control-pause-001","op":"control","expected_policy":1,"control":"pause"}
```

| Operation | Additional fields and meaning |
| --- | --- |
| `control` | `control`: `finish_current`, `pause`, `cancel`, `resume`, `hold`, `unhold`, or explicit `reopen_admission`; optional task scope except admission controls. Reopening requires instruction `evidence`; resume never reopens admissions. Holds use `hold_id`, `reason`, and optional `actions`. Control changes advance policy revision. |
| `configure` | Coordinator supplies instruction/capability `evidence` and `fields` from `authority`, `unfinished_task_cap`, `limits`, `launch_cutoff`, `scope`, `hosts`, `actors`, or `scheduler`. Revalidates configuration and advances policy without resetting tasks or consumed counters. Preserve admitted task/host/driver bindings and all unresolved or confirmed unadmitted tracker claims; reconcile/release those claims before removing their tasks. Park affected work before endpoint/runtime rebinding, stop the scheduler before changing its identity, and settle occupancy before reducing a cap below it. Scheduler changes advance its version; an explicit `enabled` value updates effective delivery, while omission preserves its current value. |
| `scheduler` | Coordinator supplies `expected_scheduler` and `fields`. An intentional scheduler stop sets `fields:{"enabled":false}`; this is separate from work pause and leaves workers running. Enablement stays synchronized with configuration and requires a valid registered scheduler identity. Resume delivery only with current authority. |
| `claim_intent` | Coordinator records an authorized unadmitted `task_id`, `target:{"authority":"configured-authority","owner":"tracker-actor"}`, and current readiness `evidence` before the native claim command. Reserves unfinished-task capacity; pending, unknown, and confirmed unadmitted claims count until admission, verified failure, or published release. |
| `claim_outcome` | Same task and matching `intent_id`, `status` (`confirmed`, `failed`, `unknown`), and canonical claim `receipt`. Unknown retains the unresolved claim; confirmed verifies the same task/owner/authority and publication. Recheck readiness before admission. |
| `claim_release_intent` | Coordinator records release of a confirmed unadmitted claim, with its `claim_id`, exact original `target`, and observed `evidence`. Available during pause/cancel/finish-current for ownership cleanup. A pending or unknown release must be reconciled, never repeated. |
| `claim_release_outcome` | Matching release `intent_id` and original `target`, `status` (`succeeded`, `failed`, `unknown`), and `receipt`. Success requires matching `authority`, `owner`, `task_id`, `released:true`, and `unpublished:false`. Unknown retains ownership/capacity; verified failure retains the claim and permits a new release attempt or admission after readiness checks. |
| `admit` | Authorized `task_id`, registered `host`/`driver`, child `worktree` path, `branch`, `identity`, and verified `claim`. Claim includes `ref`, `observed_at`, matching `authority`/`task_id`, `owner`, `confirmed:true`, `ready:true`, `unpublished:false`. |
| `reserve` | `kind` from current authority, counted `unit`, and exact execution `refs`. Returns `reservation_id`; occupies a host slot and counts the assignment before dispatch. |
| `intent` | `kind`, explicit `target` object, `evidence`, and launch `reservation_id` where applicable. Requires current authority/slot and a policy-current delegation for a remote driver; merge also requires all live gate fields below. |
| `outcome` | Matching `intent_id`/`target`, `status` (`unknown`, `succeeded`, `failed`, `not_started`), and observed `receipt`. Unknown retains the pending intent. Merge success needs exact `head` and `merge_commit`. |
| `settle` | `reservation_id`, the reservation's exact `refs`, and settlement `evidence`; all owned jobs must be observed settled and no external intent uncertain. |
| `park` | Settlement `evidence`; releases the slot only after all reservations/intents settle. |
| `observe` | `fields` from `refs`, `blocker`, `next_action`, `findings`, `pr`, `acceptance`, `usage`, `identity`, plus `evidence`. Rebinding existing refs requires settled old execution and `successor` with exact `previous_refs` and settlement evidence. |
| `recover_session` | Coordinator supplies exact `previous_identity`, distinct observed replacement `identity`, and `evidence` with `previous_session_stopped:true`, `replacement_verified:true`, and the existing `host`/`worktree`. Changes only model identity and its recovery receipt, clears delegation for revalidation, and retains jobs, unknown outcomes, refs, slot, ownership, holds and counters. Does not relocate a task or permit another dispatch of surviving work. |
| `handoff` | Coordinator moves a parked, settled task to a registered `host`, `driver`, isolated `worktree`, `branch`, and `identity`. Supply settlement `evidence` plus `source` evidence with exact `revision` and `published:true`. Keeps claim, holds, counters, prior controller references, and the old location/source receipt; clears delegation for a fresh grant. |
| `delegate` | Coordinator supplies registered `executor` and permitted `actions` within run authority. Any policy change requires delegation reconciliation. |
| `staging` | `expected_owner`, `expected_generation`, `to_task` or null, `evidence`; grants need `purpose`/`release_condition`, with revision/configuration as applicable. Prior owner must be settled. |
| `close` | Published canonical `receipt` matching task/owner, `status:"closed"`, `unpublished:false`, `criteria_met:true`, and `acceptance_ref`; no active execution/intent/staging ownership. During pause/cancel, reconciliation requires the exact receipt from the task's last successful `close` outcome. Current authority and holds still apply; new close dispatch remains fenced. |
| `reopen_intent` | Coordinator records a closed task's required regression repair before touching its tracker: matching `target:{"authority":"configured-authority","owner":"existing-owner"}` and contradiction `evidence`. Requires current authority, room under the unfinished-task cap, and no uncertain action. |
| `reopen_outcome` | Matching `intent_id`/`target`, `status` (`unknown`, `succeeded`, `failed`), and canonical `receipt`. Success requires task/authority/owner, `status:"open"`, `unpublished:false`; restores the admitted task with prior closure history and counters. Unknown retains the pending action. |

Evidence objects require `ref` and timezone-aware `observed_at`; settlement additionally requires `all_jobs_settled:true`. These assertions must be backed by the referenced actual observations. Claim before admission through `claim_intent` → native tracker operation → `claim_outcome` → `admit`; an uncertain claim cannot be admitted or replayed. An adopted existing claim needs its confirmed receipt and ownership reconciliation, not another claim command. Record controller/run/active-job IDs in `refs`; do not find them by modification time. A source session's replacement does not imply its jobs settled.

Capacity checks for admission, reopening, and configuration include unadmitted claims. Admission consumes its own claim reservation without counting it twice. Do not remove a confirmed unadmitted claim from scope to discard ownership. If readiness or admission policy changes while claiming, reconcile the native claim, then use `claim_release_intent` → supported native release → `claim_release_outcome`. Keep unresolved releases in state and query their actual result before retrying. Normalize real tracker observations into the release receipt; `released:true` is a helper assertion, not a claimed native CLI field. The old claim receipt cannot admit work after a successful release.

Merge intent `target` includes the configured repository path, target branch as `base`, integer `pr`, and exact `head`. Register certified `review_base` and `review_head` in task `refs` with the exact `controller_id`/`run_id` before requesting merge. Its `gates` assert `complete`, `validation`, `checks`, `feedback`, `findings`, `target_current`, `clean`, matching `review_head`/`checkout_head`/`pr_head`, registered `controller_id`/`run_id`, `review_base`, and `commit_mode`. The gate must match the recorded certification. Adopted `none` mode additionally requires `source_mapping_applicable:true`. Perform [the actual gate](delivery.md#merge-gate) before recording these fields; the helper validates structure/binding, not external truth.

V1 deployment intents use the one managed staging resource. Their `target` requires `environment:"shared-staging"` and the exact integer `staging_generation`; the task must own that generation. An unregistered deployment destination cannot bypass the lease by changing its name. Instructions and tests for other deployment resources require a separately verified binding before support is claimed.

An intent must consume its counted reservation once for execution launches and for any other action kind with a configured hard limit. Current limits and the launch cutoff are rechecked at intent creation; an older reservation cannot bypass a reduced allowance. Replaying a recorded action returns historical evidence, never permission to repeat the external effect.

Reserve → intent → external dispatch → outcome → observed settlement → settle is the ordinary execution sequence. After settlement, keep the slot for the next authorized stage or park it explicitly. If a process survives an agent turn, retain its reservation. New references acquired during dispatch belong in durable output/observations; preserve the reservation's exact references for later settlement.

Task `phase` describes its current work, including acceptance validation after merge. `merged_prs` retains each PR's exact head, merge commit, receipt and action references independently of that phase. A merged entry does not certify acceptance or tracker closure.

## Restricted worker return route

An SSH forced command pins the actual executable, `--run-dir`, and `--caller <registered-actor>` for `serve`; use SSH's restriction facilities to disable arbitrary commands/forwarding. Provisioning that route is a separate setup action under existing authority. Send a single JSON object on stdin with **no remote command**. `serve` rejects `SSH_ORIGINAL_COMMAND` and a payload-supplied `caller`.

`{"op":"query","task_id":"example-A"}` returns that actor's task, current policy/controls, and staging. `{"op":"action","action_id":"previous-id"}` inspects its own action. Other requests use the transition shape above. Workers cannot admit tasks, alter controls, change delegation, close tracker state through the coordinator-only operation, or inspect another actor's records. A route flag or untrusted reply header alone is not authentication.

## Scheduler

Enable scheduling only with a registered **local named coordinator session**. Remote worker forwarding is separate from this scheduler. The `scheduler` config contains:

```json
{
  "enabled": true,
  "cadence_seconds": 1200,
  "minimum_cadence_seconds": 1200,
  "session": "registered-session",
  "control_pane_id": "returned-control-pane-id",
  "agent": {
    "name": "registered-coordinator",
    "agent": "codex",
    "pane_id": "returned-coordinator-pane-id",
    "terminal_id": "returned-terminal-id",
    "agent_session": {"agent":"codex","kind":"returned-kind","value":"returned-native-id"}
  }
}
```

Copy real identity fields from Herdr; do not substitute these example strings. The control and coordinator panes must differ. `herdr_binary` optionally selects the verified executable. With explicit notification authority, `notifier_argv` is an argument array beginning with an absolute executable path and `notification_authorized:true`; preserve the agreed destination.

Optional `busy_timeout_seconds` is positive finite seconds; its default is three times the larger of `cadence_seconds` and `minimum_cadence_seconds`. Health reports prolonged busy status after that interval from the first skipped delivery. Repeated ticks preserve the interval and alert identity. Successful wake dispatch or a completed full manual reconciliation resets it. Choose a longer value for expected long coordinator turns. This health signal only requests inspection: it never interrupts the coordinator, frees capacity, or replays a wake. Scheduler stop suppresses health alerts; work pause does not.

```sh
python3 <skill-root>/scripts/supervise.py supervise --run-dir <private-run-dir>
python3 <skill-root>/scripts/supervise.py tick --run-dir <private-run-dir>
python3 <skill-root>/scripts/supervise.py wake --run-dir <private-run-dir> --reason <reason>
python3 <skill-root>/scripts/supervise.py complete --run-dir <private-run-dir> --wake-id <delivered-wake-id>
python3 <skill-root>/scripts/supervise.py complete --run-dir <private-run-dir> --wake-id manual
python3 <skill-root>/scripts/supervise.py health --run-dir <private-run-dir>
```

`supervise` and `tick` require the genuine registered control pane and verify the coordinator before any prompt. `wake`/`health` are state-only with respect to Herdr and may be called by an independently authorized host timer. `health` passes a JSON notice on stdin to a configured authorized notifier; transport acceptance is distinct from the user seeing it. No notifier means local evidence only. `complete` acknowledges a finished full reconciliation, never merely prompt delivery; `--wake-id manual` consumes the pending catch-up after a full manual check. See [scheduling](recovery.md#scheduled-supervision) for health guarantees and stop behavior.
