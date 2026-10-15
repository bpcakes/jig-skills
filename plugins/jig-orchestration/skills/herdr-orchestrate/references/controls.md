# Controls and budgets

Keep admission policy, execution pause, and scheduler state separate. Apply control changes through the helper, recording scope/source and a new policy revision. Stale delegations, previous slot reservations, and worker messages cannot authorize a new launch after a control change.

## Work controls

| Instruction | Effect |
| --- | --- |
| Finish current; admit nothing new | Freeze exact admitted unfinished task IDs, including already-issued unresolved reopens. Those tasks can resume, repair, review, merge, and complete acceptance. Reopening a member after closure preserves that batch; a task closed before the freeze needs explicit reopened admission. A free slot does not admit unrelated work. |
| Pause, or an unqualified stop | Fence new work stages and consequential transitions. Started executions settle at their supported boundary; observation and receipt recording continue. |
| Cancel active executions | Pause the selected run/tasks and request supported termination of registered workers, controllers, reviewers, and background jobs. Verify each actual outcome. |
| Resume | Clear only the selected pause. Preserve admission freeze, other holds, ownership, findings, and consumed limits. Reconcile cancelled/surviving jobs before a new attempt. |

Immediately report remaining executions, their actual stopping boundary, and pending acknowledgements. A worker assignment or review round may complete after pause. Already-issued actions, including merges, can finish; reconcile their results without claiming rollback. An unreachable host means cancellation unconfirmed and retains capacity.

Cancellation never closes a task, deletes its worktree, undoes a merge, or automatically releases staging. Bounded settlement and receipt recording remain possible during pause; another repair/review/merge/deployment does not. Native approval dialogs require the original user's response through that UI and cannot be bypassed by orchestration.

Pausing/cancelling work keeps supervision and health alerts running. Stopping the supervision mechanism is separate and does not stop workers. A separately authorized recovery slot has a recorded purpose and retirement condition; it does not reopen admission.

Apply authorized configuration changes with `configure` and their instruction/capability evidence. This preserves tasks, findings, and consumed counters. Capacity reductions below current occupancy require settlement first; rebinding an active host/runtime requires parking its tasks. Explicit `reopen_admission` changes the admission policy with instruction evidence. Neither configuration changes nor resume imply that instruction.

Repeating finish-current preserves the existing frozen batch, including members that have since closed and may need regression recovery. A new batch is captured only after admission has explicitly reopened.

## Execution slots

One slot covers one executing task pipeline on its host, including implementation, review, and validation. Acquire it through a locked, version-checked helper transition before dispatch or resumption. Reviewer fanout is separately configured and can create multiple model sessions per pipeline.

A blocked task parks and releases a slot only after every owned execution, reviewer child, and background validation job is observed settled. Uncertain dispatch, lost acknowledgements, or remote silence retain the reservation until reconciled. Parking preserves the task claim, worktree, findings, cumulative counts, and other resource obligations. Releasing execution capacity never transfers staging.

The optional unfinished-task cap counts all admitted incomplete tasks across hosts, including parked and merged-but-unaccepted tasks. It counts tasks, not PRs or reviewer children. Enforce it at admission; it does not prevent an admitted task from acquiring a free slot. An unset cap does not expand authorized scope.

With two slots, A implements and B validates. Once blocked A's jobs settle, it can park; eligible C may start if admissions and the unfinished-task cap permit. If A becomes ready while B and C execute, it waits for a slot. Under finish-current, C must already belong to the frozen batch.

Do not add a generic heavy-test semaphore, CPU partition, capacity-estimate gate, or cross-machine permission queue. Respect actual controller locks and isolate demonstrated port/database/output collisions. Check actual prerequisites and caller-available disk (`f_bavail` or equivalent) before expensive work; estimates do not create arbitrary hard thresholds.

## Enforceable limits

Each limit records its unit, task/run scope, enforcement point, and exhaustion behavior. Prove the integration can enforce the chosen boundary before dependent work. The helper can reserve counts; it cannot prevent unregistered child attempts or autonomous controller repairs unless the driver intercepts those boundaries.

| Control | Guarantee |
| --- | --- |
| Slots / unfinished-task cap | Bound executing pipelines and admitted incomplete tasks. |
| Hard attempt/repair limit | Refuse another counted assignment where every relevant dispatch/retry boundary is integrated. |
| Launch cutoff | Refuse new execution starts after the resolved timestamp/timezone; existing work may continue. |
| Timed cancellation | Apply cutoff and request cancellation at the deadline; remote termination may remain unknown. |
| Cost/token checkpoint | Report attributable observed usage and optionally alert/pause future work. Delayed receipts and in-flight work can overshoot. |

The bundled helper enforces a configured launch cutoff at reservation/launch authorization. It does not terminate processes or collect provider billing. A timed cancellation promise additionally needs a verified deadline wake and a responsible actor able to invoke each registered cancellation control; reject that timing guarantee before dependent work if those capabilities are missing. Record advisory usage receipts and evaluate checkpoints at supported observation boundaries.

Reserve a counted unit before dispatch using its action ID; duplicate delivery is the same attempt. Do not erase a consumed attempt because its response was lost. Counts survive replacement sessions, controller successors, and review epochs within their configured scope. A six-assignment task repair cap blocks the seventh across all runs; separately authorized verification may still proceed.

V1 has no hard dollar cap. A strict spending ceiling is unsupported and prevents dependent launches. Missing provider usage is unknown, never zero; report coverage and observation time. A checkpoint or slots setting is not a maximum-spend guarantee.

## Continuations

Keep source repairs, reviewer/provider attempts, validation retries, and user time/spending constraints distinct. Current controllers have no default repair-round cap; explicit limits remain hard limits. Older controllers may return a default checkpoint. Standing delivery authority can cover a documented successor with a causal purpose after normal settlement; preserve failed evidence, original acceptance and cumulative counts. An explicit limit cannot be evaded through a successor.

Use supported same-run recovery for active work, including evidence-backed retries of known completed validation failures. Terminal runs are not reopened by allocating rounds. Successors have explicit IDs and fresh required evidence; do not assume cross-run receipt import/reuse exists.

When source-edit authority is exhausted but verification is permitted, stop before any repair assignment. A CLI's positive minimum round count grants no edits. A controller that may mutate before the driver's guard is unsupported for verification-only continuation. User hard limits, task holds, scope boundaries, and tool denials remain binding across restarts/profiles.

Repeated attempts without a new mechanism, discriminating observation, or meaningful progress route through [diagnosed recovery](recovery.md#diagnosed-task-recovery). A task budget parks that task while other eligible work continues. Exhaustion of an aggregate run budget prevents further launches charged to that budget throughout the run, including newly split prerequisites. Child tasks share the original task's cumulative limit through their `budget_root`; a new task ID cannot reset expenditure. If all tasks are parked, report and wait for answers or changed evidence instead of repeatedly spending on the same blocker. Operational review timeouts may reflect actual scope; application timing assertions cannot be inflated to hide defects.
