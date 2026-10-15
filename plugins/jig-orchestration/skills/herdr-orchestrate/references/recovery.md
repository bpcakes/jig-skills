# Recovery and scheduling

## Diagnosed task recovery

Consume the controller's exact `recovery` record and retained artifacts. Recurrence and flat counts are investigation signals, not diagnoses. The local controller owns causal triage, repairs, validation and adjudication; the coordinator owns tracker changes, successors, cumulative budgets and scheduling. Do not add Beads commands to the local controller.

After all controller/native reviewer/validation executions settle and uncertain effects are reconciled, use `recover` with the decision, original `acceptance_ref` and settlement evidence. It verifies the registered controller run, records the decision immutably and releases the execution slot. Repeating an observation cannot reopen a resolved decision. Claims, worktrees, staging obligations and cumulative counts remain owned. Uncertain execution keeps its slot until settlement is proven.

For a wrong design, retain the failed attempt's commits and snapshots and derive a short design note from findings, rejections and researched answers. Continue the controller's supported local reimplementation when possible. If a settled terminal run requires a successor, record its causal purpose and exact previous/new references using `observe`; preserve original acceptance and every unresolved finding. Never reset source, rewrite history or discard edits automatically. `resolve_recovery` records the enabling decision or changed evidence before a new assignment; it grants no additional budget or authority.

For `split`, use coordinator-owned `intent` / `outcome` with kind `split`. Pin one stable causal key per prerequisite, concrete child acceptance and the original parent acceptance reference. Use the configured tracker's supported create/dependency operations under existing authority; verify their contract before invocation. Persist the intent before the external effect and reconcile lost acknowledgements by that same identity and causal key. Unknown or partially published creation remains pending: inspect existing tasks rather than create them again. A successful receipt must identify published canonical child IDs and real parent `blocked_by` edges. The helper accumulates those links across splits and rejects duplicate creation keys. Parent merge and closure recheck all prerequisites, including reopened children. Register the authorized child IDs with `configure` before claiming/admitting them; preserve admission freezes and unfinished-task limits. If those limits prevent admission, park with that exact constraint instead of bypassing it.

Every created child inherits the parent's `budget_root`; task limits aggregate all attempts in that family, and run limits continue to aggregate the entire run. Complete prerequisites under normal review and acceptance gates before resolving the parent's recovery. Splitting preserves the original guarantee; it never marks it delivered.

Reuse existing prerequisites in the same split transaction by adding `existing_task` to their target entries. Register their canonical IDs in the authorized scope before issuing the intent. The receipt's `reused` map confirms those exact IDs; its `children` map contains only newly created tasks. Reused tasks keep their ownership, budget family, counters and history, including when shared with another parent or awaiting admission. Every dependency participates in the same completion/reopening gates. Dependency cycles, including cycles through pending split intents, are rejected before issuing the action. Reconcile lost acknowledgements with the original action ID; do not recreate tasks or reissue already-associated causal keys.

For a dispute, use the controller's fresh-context judge on another selected provider. Its verdict binds only the exact source and claim evidence, and new evidence reopens it. Unavailable judges are capability blockers, not permission to declare a claim rejected. For a human choice, record one precise question, options, recommendation and evidence. Route the answer back to the controller's supported `answer` operation or record it as a successor decision. Continue ready tasks; if none remain, wait for an answer or a relevant state change.

Below-threshold defects become linked follow-ups only under existing tracker authority and stable causal keys. They may satisfy an explicitly limited review but never imply full convergence. Full-convergence merge gates remain in force. Finish the batch report with tasks done, tasks parked with questions/next actions, and tasks created; `status.summary` provides those three lists. A parked task never appears in `done`.

Use this reference for restarts, scheduling, shared staging, relocation, or retirement. Keep exact controller/job/agent references; current orchestration state is an index into evidence, not a replacement for it.

## Reconciliation and restart

Run one bounded reconciliation at a time. Read compact current state, inspect the registered external identities and artifacts, and apply observations using current policy/task versions. Never hold a state lock across an external command or model turn. A blocker records its predicate, evidence source, observation time, and next action; historical/unknown data is not a fresh failure.

Before restarting a session, inspect the actual pane occupant, surviving background jobs/reviewer handles, unsent input, and saved handoff. Adopt an existing replacement when appropriate. Rebind profile/session/native identity without losing claim, source revision, run IDs, active jobs, prior findings, limits, or tool denials. Native approval settings survive recovery.

Use the coordinator-only `recover_session` transition for a verified replacement at the existing host/worktree, supplying the exact old identity and evidence that the old model stopped and the replacement was inspected. It preserves reservations and uncertain outcomes; reconcile those by their original IDs before any new assignment. Revalidate delegation after recovery. Settled relocation remains a separate `handoff`; do not mark surviving jobs settled to replace only the model session.

Follow registered run IDs and explicit successor relationships. Do not use latest filename or modification time. A missing record makes an observation unknown; it cannot be replaced by nearby successful evidence. Network silence is not termination or a takeover grant. V1 offers no automatic cross-host coordinator failover: a replacement must establish that its predecessor stopped and reconcile unfinished effects.

Persist intent before prompts, claims, merges, deployment, or other external effects. After timeout, query the external result and durable action by ID before retrying. Distinguish command failure, inability to durably record a result, and unknown execution. If durable intent cannot be saved, stop the side effect. Optional diagnostic-log failure should not kill supervision.

## Scheduled supervision

Only schedule when requested/authorized. Run `supervise.py supervise` as a supervised foreground command in a registered Herdr control pane with genuine inherited context, separate from the coordinator agent it prompts. The [runtime](runtime.md) provides its commands. It verifies the endpoint and agent/pane/native identity before delivery, enforces one scheduler, coalesces pending wakes, and never prompts itself. Do not set `HERDR_ENV` or attach to a focused replacement when the managed session is unavailable.

The wake targets the registered pane and validates the returned agent identity. A changed or missing identity leaves delivery unconfirmed without automatic retry. The current Herdr prompt API has no atomic native-session precondition, so an occupant change during the call remains a race; the wake also tells its receiver to verify its registered identity before acting. A blocked or unrecognized coordinator produces a health failure with its pane location, rather than a healthy busy skip.

Ticks wake the coordinator for a bounded reconciliation; they do not meter all task progress. Honor any minimum cadence, including “only every N minutes.” Event wakes require corresponding authority. Record attempted, delivered, and completed checks separately: a busy skip or transport acknowledgement is not completed supervision.

Changing cadence recomputes the stored next due time from the latest attempt or completion under the new interval. It preserves pending wake identities and event requests; a pending pass still needs completion, and queued events remain subject to the new minimum cadence.

After a full reconciliation, record its wake completion. A full manual check can consume a pending catch-up and reset the next eligible check. A short status reply cannot. Coalesce missed ticks into one catch-up. Promise another automatic check only after the scheduler is observed running; delivery evidence is stronger than an intended due time.

Automatic completion preserves event wakes received after dispatch for the next minimum-cadence-eligible tick. A full manual reconciliation consumes the currently queued catch-up; use manual completion only after including that catch-up in the check.

A full manual check records the pending wake it consumed separately from the manual completion ID. A late completion for that most recently consumed wake is a no-op, preserving the manual check's evidence and cadence even if another wake is now pending. Unknown wake IDs still fail; only completing the pending wake can consume it.

An independently configured host timer may call the state-only `wake` or `health` command; neither controls Herdr. With an authorized notification argv/destination, the health check reports overdue heartbeat/delivery or recorded scheduler failure and deduplicates unchanged alerts. A scheduler stop suppresses expected-inactivity alerts; a work pause/cancellation does not. Blocker alerts likewise require an authorized destination and a new actionable change.

Fresh heartbeats and repeated attempts do not prove progress. With no pending or busy pass, health also detects reconciliation overdue by more than two effective intervals after eligibility (the effective interval is the larger of cadence and minimum cadence). It measures from completed/dispatched work, or run creation before the first pass; an event wake can advance eligibility. The incident remains stable until progress resumes. If health cannot persist its alert claim, it reports unhealthy storage failure and does not send an unrecorded notification.

Only proved notifier non-start is automatically retryable. This includes a missing executable or permission denial, and an unsent claim released after failed claim persistence. Repair the executable or storage problem; a `not_started` record permits the next health call at least 60 seconds after its recorded attempt time to retry, with at most three total attempts for the same failure. Releasing a recovered claim preserves its attempt time and count, so storage-only failures can exhaust the budget even when no notifier ran. An exhausted budget requires inspection. A nonzero exit may follow an emitted notice; like a timeout or lost acknowledgement, it remains deduplicated and must be inspected before any manual resend. Delivery acknowledgements arriving after a completed coordinator pass retain separate delivery evidence without reopening that pass.

When claim persistence fails after a claim was prepared, the `storage_failed` result includes `claim_reconciled`. The invocation has not run the notifier and tries to release its exact claim as `not_started`, including a claim recovered from the transaction journal. `true` means it confirmed that the exact failed claim no longer remains; it does not prove delivery or guarantee a retry if the incident or authorization changed. `false` means reconciliation could not be confirmed. Preserve that result and its `failure.id`, restore storage, and inspect the incident's durable alert record before any manual resend. Journal recovery can leave a `dispatching` record that later health calls report as `already_attempted`; restoring storage alone does not make that record automatically retryable. A missing receipt alone cannot prove non-delivery.

Repeated endpoint failures with the same cause retain one incident ID and alert budget until recovery is observed. A later failure starts a new incident even if the health timer never polled during the healthy interval. Continuous failure does not generate a new notice on every tick.

A manual full reconciliation does not establish endpoint recovery and retains any endpoint failure and its alert history. Only an identity-verified lookup with a working, idle, or done coordinator clears that failure, including when a concurrent manual check already consumed the scheduled pass.

Busy skips remain valid until `busy_timeout_seconds` elapses (default: three effective check intervals). Beyond that, health reports a stable busy-timeout alert even while the scheduler heartbeat remains current. Configure a longer interval for expected long work; the alert does not cancel or replace the active coordinator. A full reconciliation or a new dispatched wake resets the busy interval.

The independent health invocation must actually be installed/configured under scheduling authority; the managed process cannot detect and report its own total disappearance. Without an alert channel, disclose local evidence only. This covers managed-process/server failure while the host survives; v1 does not monitor host loss. Transport acceptance does not prove the user read or answered an alert.

## Shared staging

Use one helper-owned record with owner, generation, purpose, deployed revision/configuration, release condition, and evidence references. Grant/release/handoff checks expected owner/generation, current authority and holds, and settlement/cleanup evidence. All participating actors must use this authority; existing environment ownership tooling needs one verified binding instead of competing grants.

A grant to a non-null successor checks both the outgoing and incoming tasks' pause, cancellation, and deployment holds, including for coordinator requests. A settlement-only release to no owner remains available during pause/cancellation or holds after owned work settles; it grants no successor authority.

Acquire the grant before a deployment intent and include its current generation in the managed staging target. The helper rejects deployment by another owner or with a stale generation. This v1 binding covers one shared staging resource; it does not silently permit an unmanaged destination.

Capture cleanup resource IDs when creating them, including failure paths. The outgoing owner must settle all mutations before release/transfer. The successor begins only after the durable ownership transition succeeds. On a lost acknowledgement, query the same action ID; do not emit another transfer. A comment, label, timeout, cached state, or disconnected owner never grants ownership.

With verified helper return routes, the authorized outgoing driver requests a direct handoff and the successor verifies its recorded grant without waiting for a coordinator tick. Without current authority, preserve ownership and pause new transfers. Freeing an execution slot does not free staging.

## Relocation and retirement

For authorized relocation, settle the source writer/controller and verify published revision first. Transfer task contract, original/review base history, findings, consumed limits, and evidence references. Recheck destination capabilities and create an explicit successor where required. Git does not transport live process handles or machine-specific validation applicability.

Use allowed linked worktrees. If Herdr cannot create from one, supported Git worktree creation and Herdr attachment are valid; do not inspect a protected main working tree as a workaround.

Retire only registered owned locations under cleanup authority, after inspecting active jobs, unsent input, unpublished changes, and controller backup/cleanup obligations. Preserve current referenced payloads, reports, receipts, findings, and recovery data. Obsolete reproducible executable/build copies may be removed once consumers settle, through supported cleanup or an inspected owner-scoped procedure; preserve protected caches.

Removing a linked worktree also removes checkout-specific Git metadata that may contain its controller runs. Before removal, resolve that directory, satisfy native settlement/backup obligations, archive required manifests/blobs/logs/receipts and referenced records, verify hashes/resolvability, and update external locators. Keep immutable records unchanged. If backups must remain at original paths or cleanup cannot settle, retain the worktree/admin directory. Copying `run.json` alone is insufficient.

Archive superseded snapshots outside the normal read path with restoration references. Retire mappings only after verified removal. An archive cannot turn failure into acceptance, and moving files on the same filesystem does not reclaim disk space.
