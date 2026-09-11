# Shutdown, deadlines, runtime choice, and observability

These checks apply only within the requested review. Patterns are investigation signals: confirm consequences and examine safeguards before reporting; assign severity by impact, not syntax.

### 6. Missing graceful shutdown

Trace how long-lived work ends and which completion or cleanup guarantees the application requires. Channel closure, supervision, or deliberate process-lifetime cancellation can be sufficient. A separate cancellation token or explicit join is not mandatory when no required result, flush, cleanup, or bounded-shutdown guarantee is lost.

Investigate these signals, then report only a demonstrated violation of those guarantees:

- infinite `loop` with no cancellation branch
- accept/recv loops that ignore shutdown
- tasks that rely on runtime drop for cleanup
- only calling `abort()` where cleanup or flushing is required
- not closing senders/receivers to unblock tasks
- missing joins after signalling cancellation
- `spawn_blocking` work that may keep runtime shutdown waiting indefinitely

Preferred pattern:

- define shutdown trigger: signal, parent cancellation, channel close, supervisor request
- broadcast cooperative cancellation via `CancellationToken` or channel close
- stop accepting new work
- close producers and queues
- await/drain `JoinSet`, `TaskTracker`, or stored handles
- bound shutdown wait with a timeout only after cooperative shutdown has been attempted
- log cancellation reason and completion outcome

### 7. Missing timeouts around external I/O

Investigate external I/O that can stall required progress. Check client defaults, caller deadlines, cancellation, and intentional long-lived streams before reporting missing timeouts:

- HTTP requests, RPC, database calls, broker operations, DNS, socket reads/writes, subprocess waits
- retry loops without per-attempt timeout and total deadline
- `recv`/stream waits on untrusted or remote producers

Preferred fixes:

- use client-native timeouts where available
- wrap awaited operations in `tokio::time::timeout`
- carry request deadlines through call layers rather than creating unrelated local timeouts
- separate connect, request, read, and total deadlines when needed
- ensure timeout errors are classified and traced

Caveat: a timeout cannot preempt blocking or non-yielding CPU work. Do not use `timeout` as a substitute for moving blocking work out of async tasks.

### 8. Async recursion and task fanout explosions

Investigate recursion or loops that spawn tasks or create futures; establish whether input size, admission control, or caller invariants already bound the work before reporting resource growth.

Danger signs:

- recursive `async fn` using boxing or `async_recursion` without depth or budget
- traversals that spawn for every node, child, file, request, or queue item
- `for item in items { tokio::spawn(...) }` where `items` is untrusted or large
- `FuturesUnordered` populated without a concurrency cap
- retry loops that spawn replacement tasks
- recursive cancellation paths that wait for children while children wait for parents

Preferred fixes:

- use bounded concurrency: `Semaphore`, stream `buffer_unordered(N)`, worker pool, or bounded channel
- pass an explicit depth/budget/deadline
- process breadth-first with a bounded queue
- drain `JoinSet` as tasks complete rather than after spawning everything
- make fanout limits configurable and tested

### 9. `Send` issues hidden by single-threaded runtimes or `LocalSet`

Inspect changes using `LocalSet`, `spawn_local`, `#[tokio::main(flavor = "current_thread")]`, `Rc`, `RefCell`, or `!Send` futures for a concrete concurrency-model mismatch. Their presence, or lack of a justification comment, does not establish one.

Questions to answer:

- Is production actually single-threaded via a `current_thread` runtime, or is this hiding a task migration issue?
- Is `LocalSet` being used for real thread affinity, or only to make `!Send` futures compile inside an otherwise multi-threaded runtime?
- Does the task hold a non-`Send` lock/borrow across `.await`?
- Will a later `tokio::spawn` accidentally move work out of `LocalSet`?
- Are tests using `current_thread` or `LocalSet` while production uses multi-threaded Tokio?

Remember that `tokio::spawn` inside a `LocalSet` does not keep the new task in the `LocalSet`; use `spawn_local` when the task must remain local.

A single-threaded runtime or `LocalSet` can be a deliberate simplification even without mandatory thread affinity. Report a reachable ownership, borrow, scheduling, or deployment mismatch, not the runtime choice itself.

### 10. Poor tracing spans across task boundaries

Investigate missing task context when an actual production failure cannot be attributed. Existing job IDs, metrics, error channels, or other observability can be sufficient; spans are not universally required.

When causality is demonstrably lost, consider spans/events for:

- task spawn/start/stop/cancel/error paths
- long-lived loops and workers
- request/job handling entry points
- cross-task handoff through channels
- fanout children that need parent request/job context

Preferred patterns:

- add `#[tracing::instrument(skip(...), fields(...))]` on async entry points
- use `tracing::Instrument` when spawning: `tokio::spawn(fut.instrument(info_span!("worker", job_id = %job_id).or_current()))`
- include stable identifiers: request id, job id, connection id, tenant, peer address, shard, task role
- log structured lifecycle events: queued, started, cancelled, timed_out, completed, join_error
- avoid `Span::enter` guards held across `.await`; use `instrument` on futures instead

Do not accept bare `println!`, unstructured `log::info!`, or child tasks that lose parent context when debugging production causality matters.
