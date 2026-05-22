# Rust async concurrency review playbook

Use this playbook after loading `SKILL.md` when the diff is large or the async risk is non-trivial. Apply the severity rubric from `SKILL.md` when using the examples below.

## Fast grep map

Look for these symbols first, then inspect surrounding code manually:

```text
tokio::spawn
spawn_blocking
spawn_local
JoinHandle
JoinSet
TaskTracker
CancellationToken
tokio::select!
select!
unbounded_channel
mpsc::channel
broadcast::channel
watch::channel
Mutex
RwLock
Semaphore
std::fs
std::thread::sleep
reqwest::blocking
blocking_recv
blocking_send
timeout(
sleep(
LocalSet
Rc<
RefCell
#[tracing::instrument]
.instrument(
in_current_span
info_span!
debug_span!
```

## Code path questions

For each spawned task:

1. Who owns the task?
2. Who observes the result or panic?
3. Who cancels it?
4. Who waits for it to finish?
5. Can it outlive the request/connection/transaction that created it?
6. Does it have a tracing span with the parent context?

For each `select!`:

1. Which branches can be dropped?
2. Does any dropped branch own partial progress?
3. Is it inside a loop?
4. Are any branches known cancellation-unsafe?
5. Is `biased;` starving shutdown or cancellation?
6. Are futures recreated every loop iteration when they should be pinned?

For each channel:

1. What is the maximum number of queued messages?
2. What happens when full?
3. Who closes it?
4. Can senders outlive the receiver?
5. Are messages carrying large buffers, owned requests, database work, or task handles?
6. Are lag/backlog metrics emitted for long-lived queues?

For each lock:

1. Is the guard held across `.await`?
2. Is this a sync mutex, async mutex, parking_lot guard, or borrow guard?
3. Is the protected data ordinary memory or an I/O resource?
4. What is the contention behavior under load?
5. Can another task on the same executor need the same lock to make progress?

For each external I/O call:

1. What is the timeout/deadline?
2. Is timeout per-attempt, total, or both?
3. What error is returned/traced on timeout?
4. Does retry logic multiply the total duration?
5. Can the future actually yield, or is it blocking work disguised as async?

## Common false positives

Do not flag these without additional evidence:

- A short-lived task whose `JoinHandle` is inserted into a `JoinSet` drained by the same function.
- A truly process-lifetime metrics/logging daemon with explicit documentation, no request-scoped captures, and acceptable lost return value.
- `std::sync::Mutex` in async code when the guard is scoped before `.await`, the protected data is ordinary memory, and contention is low.
- `tokio::sync::Mutex` held across `.await` for an I/O resource when access must be serialized and the critical section is intentional.
- `unbounded_channel` for rare finite control-plane events when code proves producer count and message count are bounded.
- `select!` cancellation during final shutdown when partial data loss is explicitly acceptable.

## High-value review comments

Good comment shape:

```text
High — this spawned task is detached and can outlive the request.
`tokio::spawn` returns a `JoinHandle`, but this code drops it immediately. The task captures `user_id` and `db`, returns `Result`, and has no shutdown owner, so errors are lost and the task can keep running after the caller has timed out. Store it in the service `JoinSet`/`TaskTracker`, wire it to the request or service `CancellationToken`, and join it during shutdown.
```

Bad comment shape:

```text
Consider handling this JoinHandle.
```

Good comment shape:

```text
Critical — this `select!` can lose bytes.
The loop races `read_exact(&mut header)` against shutdown. If shutdown or the timer branch wins after `read_exact` has partially filled the header buffer, the future is dropped and the next iteration restarts from an unknown frame boundary. Use cancellation-safe `read` with an explicit state machine, or move frame reading into a task and select on the task handle during shutdown.
```

Bad comment shape:

```text
read_exact may not be cancellation-safe.
```

## Acceptance criteria for risky exceptions

When accepting a risky pattern, require the code or review to document:

- the bound: queue capacity, max tasks, max recursion depth, max shutdown wait, max blocking jobs
- the owner: which struct/scope owns handles, channels, cancellation tokens, and joins
- the shutdown path: signal, stop accepting, close, wait, timeout, forced abort if needed
- the observability: spans/fields/events that make production failure diagnosable
- the test: a targeted test that would fail if the assumption is broken
