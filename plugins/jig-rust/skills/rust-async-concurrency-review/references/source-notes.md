# Source notes

These notes summarize the research basis for the review skill. They are not a substitute for inspecting the project code.

## Codex skill format

OpenAI Codex skills are directories containing a required `SKILL.md` file with YAML front matter including `name` and `description`. Optional `scripts/`, `references/`, and `assets/` can be included for progressive disclosure.

- https://developers.openai.com/codex/skills
- https://developers.openai.com/codex/concepts/customization
- https://developers.openai.com/api/docs/guides/tools-skills

## Tokio task lifecycle

Tokio `JoinHandle` starts running when spawned. Dropping a `JoinHandle` detaches the task, loses the return value, and does not cancel the task. Runtime shutdown can drop outstanding tasks regardless of their lifecycle.

- https://docs.rs/tokio/latest/tokio/task/struct.JoinHandle.html
- https://docs.rs/tokio/latest/tokio/task/fn.spawn.html

## `tokio::select!` cancellation

`select!` waits on multiple branches and returns when the first branch completes, cancelling the remaining branches. Cancellation safety matters especially in loops. Tokio documents some cancellation-safe operations and some non-safe operations such as `read_exact`, `read_to_end`, `read_to_string`, `write_all`, and fairness-queue operations like mutex/rwlock/semaphore acquisition.

- https://docs.rs/tokio/latest/tokio/macro.select.html

## Locks across `.await`

Tokio's shared-state tutorial warns that `std::sync::MutexGuard` is not `Send` and should be scoped so its destructor runs before `.await`. It also warns not to evade this issue with non-`Send` local spawning because this can deadlock. Tokio's async `Mutex` can be held across `.await`, but it is more expensive and primarily useful for shared async I/O resources.

- https://tokio.rs/tokio/tutorial/shared-state
- https://docs.rs/tokio/latest/tokio/sync/struct.Mutex.html

## Blocking work

Tokio documents `spawn_blocking` for blocking operations and warns that blocking or compute-heavy work inside a future can prevent the executor from driving other futures. It also warns that started `spawn_blocking` tasks cannot be aborted, and long-lived blocking tasks reduce blocking-pool capacity.

- https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html

## Backpressure

Tokio's unbounded mpsc channel is explicitly without backpressure; if the receiver falls behind, messages are arbitrarily buffered, bounded only by available memory, and can exhaust memory or cause allocation failures. Tokio's channel tutorial warns that unbounded queues can fill all available memory and fail unpredictably.

- https://docs.rs/tokio/latest/tokio/sync/mpsc/fn.unbounded_channel.html
- https://tokio.rs/tokio/tutorial/channels

## Graceful shutdown

Tokio describes graceful shutdown as three parts: deciding when to shut down, telling every part to shut down, and waiting for other parts to shut down. It recommends cancellation tokens for signaling cancellation. `tokio_util::task::TaskTracker` is intended for waiting until tasks exit and is often used with `CancellationToken`.

- https://tokio.rs/tokio/topics/shutdown
- https://docs.rs/tokio-util/latest/tokio_util/task/task_tracker/struct.TaskTracker.html

## Timeouts

`tokio::time::timeout` returns an error and cancels the future when the duration elapses, but the timeout is checked before polling the future. If the future does not yield, it can exceed the timeout without returning an error.

- https://docs.rs/tokio/latest/tokio/time/fn.timeout.html

## `Send`, `spawn_local`, and `LocalSet`

`tokio::spawn` requires the spawned future and output to be `Send + 'static`. `spawn_local` can spawn `!Send` futures on a `LocalSet` or local runtime and runs them on the same thread; using `tokio::spawn` inside a `LocalSet` does not keep the new task in the `LocalSet`.

- https://docs.rs/tokio/latest/tokio/task/fn.spawn.html
- https://docs.rs/tokio/latest/tokio/task/fn.spawn_local.html
- https://docs.rs/tokio/latest/tokio/task/struct.LocalSet.html

## Tracing

Tokio's tracing guide explains that ordinary logs are hard to interpret in async systems because tasks are multiplexed on the same thread and logs are interleaved. `tracing` spans and events preserve structured temporality and causality. The `tracing::Instrument` trait can attach spans to futures and propagate current spans when spawning tasks.

- https://tokio.rs/tokio/topics/tracing
- https://docs.rs/tracing/latest/tracing/trait.Instrument.html
- https://docs.rs/tracing/latest/tracing/struct.Span.html

## Async recursion

Since Rust 1.77, recursive `async fn` calls are supported when the recursive call uses indirection such as `Box::pin`; recursive futures otherwise have infinitely sized types. Review recursive async code not only for compilation strategy, but for allocation cost, missing depth limits, and fanout.

- https://rust-lang.github.io/async-book/07_workarounds/04_recursion.html
- https://blog.rust-lang.org/2024/03/21/Rust-1.77.0/#support-for-recursion-in-async-fn
- https://doc.rust-lang.org/error_codes/E0733.html
