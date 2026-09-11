# Task ownership and cancellation

These checks apply only within the requested review. Patterns are investigation signals: confirm consequences and examine safeguards before reporting; assign severity by impact, not syntax.

### 1. Dropped `tokio::spawn` handles without lifecycle ownership

Investigate ignored or detached spawn results. Confirm required results, cleanup, or shutdown work can be lost; alternate supervision, process-lifetime work, or an independent result channel may make detachment appropriate without a local comment.

Danger signs:

- `tokio::spawn(async move { ... });` as a standalone statement
- `let _ = tokio::spawn(...)`
- a handle stored locally but never awaited or aborted
- a task returns `Result` but nobody observes the `JoinError` or inner error
- a parent task spawns children and returns without joining, cancelling, or transferring ownership
- background task captures request-scoped data, database transaction handles, cancellation tokens, lock guards, or channels without a clear cancellation owner

A dropped `JoinHandle` detaches the task. When that violates the task's result or lifecycle contract, possible fixes include:

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

Check whether dropping and recreating the branch loses progress that the operation's contract requires. Intentional abandonment on shutdown may be correct; require redesign only for a consequential loss.

Preferred fixes:

- keep progress outside the selected future
- pin and reuse futures across loop iterations when appropriate
- use cancellation-safe primitives (`recv`, `accept`, `read`, stream `next`) when they match the need
- spawn the non-cancel-safe operation into an owned task and select on its `JoinHandle`
- move shutdown selection to a higher level where partial I/O loss is acceptable
- add explicit comments only when cancellation data loss is intentionally acceptable, such as during process shutdown
