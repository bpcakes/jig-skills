# Locks, blocking work, and backpressure

These checks apply only within the requested review. Patterns are investigation signals: confirm consequences and examine safeguards before reporting; assign severity by impact, not syntax.

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

Prefer lexical scopes over `drop(lock)` because they make the guard lifetime visible. An explicit `drop(guard)` is also valid when it ends the guard before `.await`; no style exception is required.

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

Investigate unbounded queues and task collections. Show a plausible sustained producer/consumer imbalance and resource consequence; finite input or admission limits can already bound growth.

For a confirmed growth risk, consider:

- bounded channel capacity chosen from a documented memory/latency budget
- `try_send` with drop/coalesce/degrade policy
- semaphore or permit-based admission control
- hard upper bound on producers/messages established by code, not hope
- explicit justification that the channel is only used for rare, finite control-plane events

A vague claim that "messages are small" or "this is unlikely" is not a justification. Small messages become large when unbounded and retained by backlogs.
