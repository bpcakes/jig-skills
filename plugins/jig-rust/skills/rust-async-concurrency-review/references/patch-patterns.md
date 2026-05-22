# Rust async patch patterns

These are patch shapes, not mandatory implementations. Adapt to the project's architecture.
The snippets intentionally use placeholder error types; adapt them to the crate's existing `anyhow`, `thiserror`, or domain error model before copying.

## Own spawned tasks with `TaskTracker` and `CancellationToken`

```rust
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tracing::{info_span, Instrument};

pub struct WorkerGroup {
    token: CancellationToken,
    tasks: TaskTracker,
}

impl WorkerGroup {
    pub fn new() -> Self {
        Self {
            token: CancellationToken::new(),
            tasks: TaskTracker::new(),
        }
    }

    pub fn spawn_worker(&self, worker_id: usize) {
        let token = self.token.clone();
        self.tasks.spawn(
            async move {
                loop {
                    tokio::select! {
                        _ = token.cancelled() => break,
                        result = do_one_unit(worker_id) => {
                            if let Err(error) = result {
                                tracing::warn!(%worker_id, %error, "worker unit failed");
                            }
                        }
                    }
                }
            }
            .instrument(info_span!("worker", worker_id)),
        );
    }

    pub async fn shutdown(self) {
        self.token.cancel();
        self.tasks.close();
        self.tasks.wait().await;
    }
}

async fn do_one_unit(_worker_id: usize) -> Result<(), Error> {
    Ok(())
}
```

## Drain a `JoinSet` instead of dropping handles

```rust
use tokio::task::JoinSet;

let mut tasks = JoinSet::new();

for item in items {
    tasks.spawn(async move { process(item).await });
}

while let Some(result) = tasks.join_next().await {
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::warn!(%error, "task failed"),
        Err(join_error) if join_error.is_cancelled() => {
            tracing::warn!(%join_error, "task cancelled");
        }
        // Early return drops the JoinSet and aborts remaining tasks. If cleanup
        // matters, signal cancellation first and continue draining. This also
        // requires From<JoinError> for the surrounding error type.
        Err(join_error) => return Err(join_error.into()),
    }
}
```

## Bound fanout with a semaphore

```rust
use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

let limit = Arc::new(Semaphore::new(32));
let mut tasks = JoinSet::new();

for item in items {
    let permit = limit.clone().acquire_owned().await?;
    tasks.spawn(async move {
        let _permit = permit;
        process(item).await
    });
}

while let Some(result) = tasks.join_next().await {
    result??;
}
```

## Release a lock before `.await`

These examples use `std::sync::Mutex`. Tokio's async `Mutex` is not poisoned, so `.lock().await` returns the guard directly. Being cancelled while queued for a Tokio mutex loses queue position, so keep the same shape either way: extract the needed value, end the guard's scope, then await.

```rust
let value = {
    let guard = state.lock().expect("state lock poisoned");
    guard.value.clone()
};

send_value(value).await?;
```

Even better, put lock access in a non-async method:

```rust
impl State {
    fn snapshot(&self) -> Snapshot {
        let guard = self.inner.lock().expect("state lock poisoned");
        guard.snapshot()
    }
}

let snapshot = state.snapshot();
write_snapshot(snapshot).await?;
```

## Replace cancellation-unsafe `read_exact` in a `select!` loop

Suspicious:

```rust
loop {
    tokio::select! {
        _ = shutdown.cancelled() => break,
        result = reader.read_exact(&mut header) => {
            result?;
            handle_header(header).await?;
        }
    }
}
```

Safer shape: keep progress in an explicit state machine and use cancellation-safe reads.

```rust
let mut filled = 0;
let mut header = [0_u8; HEADER_LEN];

loop {
    tokio::select! {
        _ = shutdown.cancelled() => break,
        read = reader.read(&mut header[filled..]) => {
            let n = read?;
            if n == 0 {
                break;
            }
            filled += n;
            if filled == HEADER_LEN {
                handle_header(header).await?;
                filled = 0;
                header = [0_u8; HEADER_LEN];
            }
        }
    }
}
```

## Timeout external I/O with structured error handling

The `Error` variants and conversions below are placeholders. Adapt them so the surrounding function can represent timeout errors, retry exhaustion, and the inner operation error.

```rust
use std::time::Duration;
use tokio::time::timeout;

let response = timeout(Duration::from_secs(3), client.send(request))
    .await
    .map_err(|_| Error::DeadlineExceeded { operation: "send request" })??;
```

For retries, use both per-attempt timeout and total deadline:

```rust
let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
let max_attempts = 3; // Choose a budget appropriate for the operation.

for attempt in 1..=max_attempts {
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
        return Err(Error::DeadlineExceeded { operation: "total retry budget" });
    }

    let attempt_timeout = remaining.min(Duration::from_secs(2));
    match timeout(attempt_timeout, call_remote()).await {
        Ok(Ok(value)) => return Ok(value),
        Ok(Err(error)) if should_retry(&error) => {
            tracing::warn!(attempt, %error, "remote call failed; retrying");
        }
        Ok(Err(error)) => return Err(error),
        Err(_) => tracing::warn!(attempt, "remote call timed out; retrying"),
    }
}

return Err(Error::RetriesExhausted);
```

## Preserve tracing context across spawned tasks

```rust
use tracing::{info_span, Instrument};

let span = info_span!(
    "sync_customer_task",
    customer_id = %customer_id,
    request_id = %request_id,
);

tokio::spawn(
    async move {
        tracing::info!("task started");
        let result = sync_customer(customer_id).await;
        if let Err(error) = &result {
            tracing::warn!(%error, "task failed");
        }
        result
    }
    .instrument(span.or_current()),
);
```

## Do not hold `Span::enter` across `.await`

Suspicious:

```rust
let span = tracing::info_span!("work", id = %id);
let _guard = span.enter();
do_async_work().await;
```

Preferred:

```rust
use tracing::Instrument;

do_async_work()
    .instrument(tracing::info_span!("work", id = %id))
    .await;
```
