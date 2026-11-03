# Guarded task execution

Use this path when a verified adapter can perform and inspect the requested external operation. The manual runtime transitions remain available when it cannot. Configure adapters and grants under existing setup authority; a driver cannot supply executable commands or change its grant.

## Standing task authority

At admission, supply `acceptance_ref` and `actions` alongside the existing task, driver, native identity, checkout and canonical claim. The helper atomically records a grant for that driver. Alternatively use `delegate` after admission. Driver grants containing `close` require a nonempty acceptance pin. For a legacy task, the coordinator uses `pin_acceptance` with the original `acceptance_ref` and sourced `evidence` after all executions/intents settle, then renews the grant. Pinning clears the old grant and cannot replace an existing contract; drivers cannot pin their own acceptance. Grant only actions already authorized for that task; ordinary delivery often needs implementation, review, repair, validation, push, PR and merge, while deployment and closure depend on the actual contract.

New grants bind the task/driver/host/profile/native identity, checkout, branch, tracker owner and acceptance reference. Live run authority, task/run holds, pause/cancellation, dependencies, budgets, capacity and launch cutoffs still gate each launch. A harmless configuration revision does not revoke the grant. Changing identity/ownership clears or invalidates it. Removing run authority removes that action from standing grants; restoring it requires an explicit new delegation. A pending grant may be narrowed, including to no actions, but not expanded or transferred. A saved legacy grant remains policy-version-bound until explicitly renewed; upgrading files does not silently expand its authority.

## Configure an adapter

Add entries to configuration `adapters`, using coordinator-owned `configure`. For example:

```json
{
  "task-validation": {
    "kind": "validate",
    "host": "worker-1",
    "argv": ["/opt/delivery/validate", "dispatch"],
    "inspect_argv": ["/opt/delivery/validate", "inspect"],
    "timeout_seconds": 600
  }
}
```

These are executable paths supplied and verified by the deployment, not bundled domain adapters. Both argument arrays execute on the coordinator host, without a shell. A configured adapter can use an established SSH route; the request cannot choose a command. `host` binds the adapter to the task's registered host. A changed adapter invalidates an unissued preparation. Issued operations retain the original inspection command for recovery; keep it installed until they settle.

The runner sends one JSON object on stdin with `mode` (`dispatch` or `inspect`), `operation_id`, `task_id`, `kind`, `target`, `evidence`, `gates`, `refs`, and `task` (the bound task/driver/location/acceptance information). The operation ID is the stable external correlation key. `refs` contains the exact accepted request/reservation references, including newly introduced run or job identifiers. A separate task-reference snapshot detects source/reference drift before dispatch. The adapter must:

- Verify the actual target and fresh external gates immediately before mutation. For merge, verify controller/PR/CI/feedback and use the exact head guard. For tracker closure, verify acceptance, ownership and publication. A helper assertion alone is insufficient.
- Dispatch at most the named operation. Respect native approvals and actual Herdr context/identity. Do not fabricate managed context or respond to a worker's approval prompt.
- Implement read-only inspection by the same operation ID and target. An absent receipt is not proof of non-execution. Observe surviving remote jobs and descendants before claiming settlement.
- Retain the inherited operation-lock descriptor for its process lifetime. The runner deliberately passes it through so a surviving adapter blocks another invocation after parent loss. Detached/remote descendants require their own durable handles and settlement evidence.
- Return one JSON object on stdout; diagnostic output belongs on stderr. Do not print secrets. Both streams are retained privately.

The normalized result is:

```json
{
  "status": "succeeded",
  "receipt": {
    "ref": "/durable/evidence/result.json",
    "observed_at": "2026-11-03T12:00:00Z",
    "all_jobs_settled": true
  }
}
```

`status` is `succeeded`, `failed`, `not_started`, or `unknown`. All terminal results require `all_jobs_settled:true`. `not_started` also requires `no_effects:true`. If a launch acknowledgement arrives while jobs remain active, return `unknown` with durable handles/evidence and inspect later; do not claim terminal success. Merge receipts additionally bind `head` and `merge_commit`. Closure receipts bind canonical `authority`, `task_id`, `owner`, `status:"closed"`, `unpublished:false`, `criteria_met:true`, and the pinned `acceptance_ref`.

Nonzero exit, timeout or malformed output remains unknown because an effect may already have happened. The runner kills its local process group on timeout; that does not establish remote settlement. A process that cannot be started is recorded as `not_started`. The protocol output limit is one MiB. Inspectors must not mutate, retry, or manufacture a successful receipt.

## Execute and continue

Local coordinator command:

```sh
python3 <skill-root>/scripts/supervise.py execute --run-dir <private-run-dir> --request <request.json>
```

A driver sends the same request with `op:"execute"` through its restricted `serve` route:

```json
{
  "op": "execute",
  "action_id": "A-validation-001",
  "task_id": "A",
  "expected_policy": 4,
  "expected_task": 12,
  "kind": "validate",
  "adapter": "task-validation",
  "target": {"head": "exact-candidate-oid"},
  "refs": {"run_id": "registered-review-run"},
  "evidence": {"ref": "/durable/evidence/ready.json", "observed_at": "2026-11-03T12:00:00Z"}
}
```

Merge requests also carry the ordinary runtime `gates`; deployment targets carry the current staging generation; closure uses the ordinary canonical target and acceptance evidence. First preparation requires the observed task version. An older valid policy version is accepted only after live restrictions pass. The helper atomically reserves capacity/counts and records intent; failed gates leave neither a reservation nor consumed counts. Before dispatch it checks current authority again, plus the pinned source/identity, adapter, budget and resource ownership.

Continue an interrupted or unknown operation with just its identity:

```json
{"op":"execute","action_id":"A-validation-001","task_id":"A"}
```

The runner holds a per-operation lock outside state transactions. The state engine requires that process-local guard for dispatch and issued-operation reconciliation; no JSON field can grant it. Dispatch also requires the prepared executor, including at the raw helper boundary. Runner subrecords live in the private `execution-actions` namespace, separate from caller action IDs, so an unrelated `/complete` or `/dispatch` action cannot obstruct recovery. Matching old completion records remain readable; old unknown operations are inspected and write new guarded records. Concurrent invocations return `status:"busy"`. A durable dispatch record is the issuance boundary: once present, continuation only inspects. Even a crash between that record and process creation cannot authorize blind replay. A known `not_started` terminal result permits a separately prepared attempt under current limits; the old action never dispatches again. Completed actions return their bound result. Supplied fields on continuation must match the original request; omit obsolete version fields.

The runner records outcomes and observed settlement together, retaining the slot for the next stage. Drivers can immediately continue their authorized pipeline. Unknown results retain reservations, ownership and budget expenditure. For a successful closure action, it also records helper closure and frees the slot. If changed authority or prerequisites prevent that final reconciliation, it returns `closure_pending` while retaining the external success; reconcile closure using its exact receipt after the blocker is resolved. Replaying the completed operation returns its historical result, not a new closure attempt.

For explicit recovery through `apply`/`serve`, `prepare` takes the execution request fields. Raw `finish` takes `operation_id`, `status` and `receipt`, plus ordinary action/task/version fields, and can settle only an unissued preparation as `not_started` with no-effects/settlement evidence. Raw `dispatch` and `outcome` cannot act on runner-owned operations, and raw `finish` cannot reconcile issued ones. Resume `execute` for lock-held inspection and settlement, including after an unknown outcome. Manual operations without a runner binding retain their existing receipt protocol. A coordinator may inspect an issued worker action after route loss, but cannot use recovery to launch that worker's prepared action. Preserve current holds and source-writer boundaries.

## Wait for a useful change

The restricted `query` response includes a `change_token`, current task/control/staging evidence, and relevant capacity, dependency and budget conditions. A driver waiting for those conditions can send:

```json
{"op":"watch","task_id":"A","after":"token-from-query","timeout_seconds":30}
```

`watch` returns on change or timeout with `changed` and a new token. It rechecks caller scope while waiting. Scheduler-only changes do not wake the driver. This is a bounded read-only wait through the existing route, not a new event service or permission to send prompts. A local equivalent is `supervise.py watch --run-dir ... --task A --after ...`. On a genuine condition change, inspect the returned evidence and attempt the next permitted action. Scheduled reconciliation remains available when a driver or route disappears.

Use existing ready evidence, preparation/action timestamps, `dispatched_at`, and completion records to measure ready-to-dispatch delay and coordinator interventions. Keep delivery time, regressions, and incorrect transitions alongside those measurements; fewer round trips alone do not prove faster accepted delivery.
