---
name: rust-async-concurrency-review
description: Use when reviewing Rust async and concurrency correctness in scoped changes, including Tokio tasks, async cancellation, select!, channels, locks, Send/Sync, blocking work, backpressure, timeouts, task shutdown, and tracing. Do not use as a generic error-handling, SQL transaction, or synchronous Rust review.
---

# Rust async concurrency review

## Purpose

Review scoped Rust changes for async/concurrency correctness, especially Tokio. This is not a style pass and not a generic error-handling pass. Treat async bugs as lifecycle, cancellation, scheduling, backpressure, and observability failures that may compile successfully and only fail under load, shutdown, or partial cancellation.

This skill owns task lifecycle, cancellation, scheduling, backpressure, and async observability. Use `rust-error-handling-review` for how errors are propagated once observed, `sql-transaction-consistency-review` for database transaction invariants, retries, and connection-lifetime safety, and `rust-architecture-review` for broader module boundaries or service topology unless the async runtime behavior itself is the risk.

Use this skill when the change touches any of these surfaces:

- `tokio::spawn`, `spawn_blocking`, `spawn_local`, `JoinHandle`, `JoinSet`, `TaskTracker`, `CancellationToken`
- `tokio::select!`, cancellation, shutdown, signals, dropped futures
- channels, streams, bounded/unbounded queues, fanout, producer/consumer loops
- locks, `Mutex`, `RwLock`, semaphores, `Send`, `Sync`, `LocalSet`, `Rc`, `RefCell`
- blocking filesystem, synchronous APIs, CPU-heavy work, compression, parsing, crypto, FFI
- external I/O, network calls, database calls, RPC, HTTP clients, retries, timeouts
- `tracing`, spans/events, task context propagation, async diagnostics

Do not use this skill for purely synchronous Rust, formatting-only diffs, or general API design unless an async/concurrency concern is implicated.

## Review stance

Be strict. A clean compile is not evidence of async correctness. Rust prevents many memory-safety bugs, but it does not automatically prevent detached tasks, lost cancellation progress, runaway queues, unbounded task fanout, starvation, deadlocks from lock guards held across `.await`, missing shutdown, or useless logs across task boundaries.

Prefer concrete findings over broad warnings. A finding must identify the exact code path, explain the failure mode, and propose a fix or a required justification. Do not merely say "consider adding a timeout" or "consider backpressure"; say what can hang or grow, under what condition, and what bound or lifecycle should own it.

## Optional scanner

Before deep review, you may run the bundled scanner. It accepts the Rust repo or file to scan as an optional argument, defaulting to the current directory, so from the repository root use:

```bash
python3 plugins/jig-rust/skills/rust-async-concurrency-review/scripts/scan_async_rust.py .
```

Use scanner hits only as leads. Never report a hit as a finding until you inspect the surrounding code and confirm the failure mode. For lock-heavy diffs or task-collection method spawns, add `--include-noisy` to include receiver-agnostic `.lock()` and `.spawn()` leads that are intentionally disabled by default.

## Review workflow

1. Establish the async boundary map.
   - Identify every new or changed spawned task, async loop, channel pair, lock acquisition, `select!`, external I/O operation, and shutdown path.
   - Identify the owner of each task and resource. If ownership is not clear, that is likely the bug.

2. Follow lifecycle before dataflow.
   - For each spawned task, answer: who can cancel it, who waits for it, what happens on parent return, what happens on runtime shutdown, and where does its error/panic go?
   - For each loop, answer: what makes it stop, what bounds its input, and what prevents it from starving shutdown?

3. Check cancellation semantics.
   - In every `select!`, assume every non-winning branch is dropped at an `.await`.
   - In every timeout, assume the inner future is cancelled only if it yields; blocking or CPU-heavy work is not preempted.
   - In shutdown, distinguish graceful cooperative cancellation from abrupt abort.

4. Check scheduler health.
   - Async runtime worker threads must not be blocked by sync filesystem calls, sync network calls, thread sleeps, long CPU loops, or blocking locks under contention.
   - `spawn_blocking` is a tool, not an escape hatch: bound CPU work, avoid long-lived blocking tasks, and remember started blocking tasks cannot be reliably aborted.

5. Check backpressure.
   - Every producer/consumer edge must have a capacity, a rate bound, a drop/coalesce policy, or a strong reason why unbounded growth is impossible.
   - Unbounded channels require explicit justification in code or review notes.

6. Check observability.
   - Spawned tasks need tracing spans that preserve causality across task boundaries.
   - Important async lifecycle events need structured fields: request/job id, peer/tenant, task role, channel capacity/lag where relevant, cancellation reason, join/abort outcome.

7. Report only actionable issues.
   - Include exact file/line references where possible.
   - Classify severity using the rubric below.
   - Include a minimal patch shape or explicit acceptance criteria.

## Severity rubric

Use **Critical** when a bug can cause data loss, permanent hang, unbounded resource growth, durable orphan work, deadlock, or inability to shut down under plausible production conditions.

Use **High** when a bug can cause latency collapse, lost task results, invisible task failures, cancellation leaks, significant memory growth, starvation, or broken causality in production diagnostics.

Use **Medium** when the design is probably safe only because of unstated assumptions, missing tests, missing code comments for a dangerous exception, or weak bounds that are acceptable for now but easy to regress.

Use **Low** for local clarity improvements that reduce future async misuse but do not currently create a demonstrated failure mode.

## Required review checks

### 1. Dropped `tokio::spawn` handles without lifecycle ownership

Flag every new or changed `tokio::spawn`, `tokio::task::spawn`, `spawn_local`, `spawn_blocking`, `JoinSet::spawn`, or equivalent where the result is ignored, assigned to `_`, not awaited, not inserted into a `JoinSet`/`TaskTracker`, not stored in an owner, and not explicitly documented as a daemon task.

Danger signs:

- `tokio::spawn(async move { ... });` as a standalone statement
- `let _ = tokio::spawn(...)`
- a handle stored locally but never awaited or aborted
- a task returns `Result` but nobody observes the `JoinError` or inner error
- a parent task spawns children and returns without joining, cancelling, or transferring ownership
- background task captures request-scoped data, database transaction handles, cancellation tokens, lock guards, or channels without a clear cancellation owner

A dropped `JoinHandle` does not cancel the task; it detaches it and loses the return value. Require one of these fixes:

- await the handle and handle `JoinError`
- store the handle in an owning struct with `Drop`/shutdown behavior
- insert the task into `JoinSet` and drain with `join_next`
- use `tokio_util::task::TaskTracker` and wait during shutdown
- use `CancellationToken` plus a join/wait phase
- explicitly mark a daemon task and justify why detached lifecycle and lost result are safe

### 2. Cancellation-unsafe `select!` branches

In `tokio::select!`, all non-winning branches are cancelled. In a loop, that means any branch-local progress can be lost repeatedly.

Flag branches that do work before an `.await`, own partial buffers/state, mutate external state before completing, or call known cancellation-unsafe operations.

Common unsafe or suspicious cases:

- `read_exact`, `read_to_end`, `read_to_string`, `write_all` inside a repeatedly-entered `select!`
- custom async functions that own a buffer, parser, transaction, retry state, or stream cursor across `.await`
- `mpsc::Sender::send` used where losing queue position or message ownership matters
- `Mutex::lock`, `RwLock::read`, `RwLock::write`, `Semaphore::acquire`, or `Notify::notified` in a race where losing fairness queue position matters
- `select!` loops that recreate `sleep`, request futures, or stream combinators each iteration without pinning or externalizing state
- `biased;` with a busy data branch before shutdown or cancellation branches

Ask: if this branch is dropped and recreated, is that a no-op? If not, require a redesign.

Preferred fixes:

- keep progress outside the selected future
- pin and reuse futures across loop iterations when appropriate
- use cancellation-safe primitives (`recv`, `accept`, `read`, stream `next`) when they match the need
- spawn the non-cancel-safe operation into an owned task and select on its `JoinHandle`
- move shutdown selection to a higher level where partial I/O loss is acceptable
- add explicit comments only when cancellation data loss is intentionally acceptable, such as during process shutdown

### 3. Holding locks or borrows across `.await`

Flag lock guards or borrow guards that may live across `.await`, especially:

- `std::sync::MutexGuard`, `parking_lot` guards, `RwLock` guards, `RefCell` borrows
- `tokio::sync::MutexGuard` held while doing network/database/file I/O
- lock acquisition inside loops with slow awaits under the guard
- lock guards hidden in helper structs or method receivers that survive `.await`

Synchronous mutex guards across `.await` are usually a deadlock or non-`Send` hazard. `tokio::sync::Mutex` may be held across `.await`, but still serialize the protected resource and should usually be reserved for shared async I/O resources, not ordinary data.

Preferred fixes:

- restrict the guard to a lexical scope that ends before `.await`
- clone/copy the needed data, release the lock, then await
- move lock use into non-async methods on a wrapper type
- shard the lock or use a concurrent data structure for hot data
- use an actor/task with bounded message passing for I/O resources

Prefer lexical scopes over `drop(lock)` because they make the guard lifetime visible. Accept explicit `drop(guard)` only when the surrounding structure clearly ends the guard before `.await` and a scope cannot be introduced cleanly.

### 4. Blocking filesystem, blocking I/O, or CPU work inside async tasks

Flag synchronous work in async contexts when it can block a runtime worker thread or monopolize polling:

- `std::fs::*`, `File::open`, blocking reads/writes, sync metadata walking
- `std::thread::sleep`, blocking locks under contention, sync channel receive/send
- `reqwest::blocking`, blocking database clients, blocking DNS, command execution waits
- heavy CPU loops, compression, hashing, parsing large payloads, crypto, ML inference, FFI
- `spawn_blocking` used for unbounded CPU fanout or long-lived loops

Preferred fixes:

- use async APIs where available (`tokio::fs`, async clients)
- use `tokio::task::spawn_blocking` for bounded, short-lived blocking work
- gate CPU-heavy `spawn_blocking` with a `Semaphore`, use a dedicated worker pool, or use Rayon
- use `thread::spawn` or a dedicated service thread for long-lived blocking workers
- add cooperative yields or chunking for CPU loops that remain async

Remember: `spawn_blocking` tasks that have started cannot be reliably aborted, so shutdown must not depend on aborting them.

### 5. Unbounded channels without backpressure justification

Flag `mpsc::unbounded_channel`, unbounded queues, `VecDeque` mailboxes, unlimited `FuturesUnordered`, and any producer loop that can outrun a consumer.

Require one of:

- bounded channel capacity chosen from a documented memory/latency budget
- `try_send` with drop/coalesce/degrade policy
- semaphore or permit-based admission control
- hard upper bound on producers/messages established by code, not hope
- explicit justification that the channel is only used for rare, finite control-plane events

A vague claim that "messages are small" or "this is unlikely" is not a justification. Small messages become large when unbounded and retained by backlogs.

### 6. Missing graceful shutdown

Every long-lived task, listener loop, worker loop, and background service needs a shutdown path and a wait path.

Flag:

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

Flag external I/O without a timeout/deadline:

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

Flag recursion or loops that spawn tasks or create futures without a bound.

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

Flag changes that use `LocalSet`, `spawn_local`, `#[tokio::main(flavor = "current_thread")]`, `Rc`, `RefCell`, or `!Send` futures to make code compile without proving the concurrency model.

Questions to answer:

- Is production actually single-threaded via a `current_thread` runtime, or is this hiding a task migration issue?
- Is `LocalSet` being used for real thread affinity, or only to make `!Send` futures compile inside an otherwise multi-threaded runtime?
- Does the task hold a non-`Send` lock/borrow across `.await`?
- Will a later `tokio::spawn` accidentally move work out of `LocalSet`?
- Are tests using `current_thread` or `LocalSet` while production uses multi-threaded Tokio?

Remember that `tokio::spawn` inside a `LocalSet` does not keep the new task in the `LocalSet`; use `spawn_local` when the task must remain local.

Accept `current_thread`, `LocalSet`, and `spawn_local` only when thread affinity is a real requirement, ownership is explicit, and the review proves no deadlock/borrow hazard is being hidden.

### 10. Poor tracing spans across task boundaries

Async logs without spans are often causally useless. Flag new async task boundaries that lack structured tracing.

Require meaningful spans/events for:

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

## Output format

Use this structure for reviews:

```text
Async concurrency review: <pass/fail/risk level>

Findings
1. <Severity> — <short title>
   Location: <file:line>
   Problem: <specific failure mode>
   Why it matters: <production consequence>
   Fix: <minimal patch shape or acceptance criteria>

Notes / assumptions
- <Only include assumptions that affect correctness.>

Tests to add or run
- <Cancellation, shutdown, timeout, backpressure, or tracing tests.>
```

If there are no test-worthy findings, write `Tests to add or run: None required.`

If there are no findings, explicitly state which async surfaces were inspected, such as spawned tasks, `select!`, channels, locks, timeouts, shutdown, and tracing. Do not simply say "looks good."

## Test guidance

Request tests that force the failure mode:

- cancellation: select branches lose progress only when cancelled; add tests that make the competing branch win
- shutdown: signal cancellation, close channels, and assert all tasks exit before a bounded deadline
- timeout: use `#[tokio::test(start_paused = true)]` or controlled clocks where possible
- backpressure: fill bounded queues and assert producer behavior
- fanout: feed large input and assert concurrency cap is respected
- tracing: assert spans include key fields when the project has tracing test infrastructure
- scheduling: run with multi-threaded Tokio when production is multi-threaded; do not rely only on `current_thread` tests

Use Loom only when reviewing low-level synchronization primitives or custom concurrency code where exhaustive interleaving is worth the cost.

## References

For deeper examples and patch shapes, read:

- `references/review-playbook.md`
- `references/patch-patterns.md`
- `references/source-notes.md`
