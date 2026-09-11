---
name: rust-async-concurrency-review
description: Review Rust async correctness around task ownership, cancellation, locks, backpressure, and shutdown.
---

# Rust async concurrency review

Apply this skill when it serves the user's requested task and target. Discovery or a code change does not authorize an additional review, refactor, or broader scan. For review-only requests, report findings without editing; implement changes only when they are part of the user's request.

Treat checklist patterns, counts, and missing comments as investigation signals. Report a defect only after tracing a concrete consequence and checking counterevidence in callers, invariants, tests, and configuration. Missing context is a limitation, not a finding. Assign severity from impact and reachability; keep optional preferences separate and allow no findings.

## Purpose

Review scoped Rust changes for async/concurrency correctness, especially Tokio. This is not a style pass and not a generic error-handling pass. Treat async bugs as lifecycle, cancellation, scheduling, backpressure, and observability failures that may compile successfully and only fail under load, shutdown, or partial cancellation.

This skill owns task lifecycle, cancellation, scheduling, backpressure, and async observability. Adjacent concerns belong to error handling, transaction consistency, or architecture reviews. Recommend those only when relevant to the user's task; do not launch them just because a boundary is nearby.

Within an async/concurrency review, inspect the relevant surfaces:

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

Prefer concrete findings over broad warnings. A finding must identify the exact code path, explain the demonstrated failure mode, and propose a fix. Do not merely say "consider adding a timeout" or "consider backpressure"; say what can hang or grow, under what condition, and what bound or lifecycle should own it. If a caller invariant is unknown, ask a focused question rather than requiring justification as a defect.

## Optional scanner

Before deep review, you may run the bundled scanner. It accepts the Rust repo or file to scan as an optional argument, defaulting to the current directory, so from the repository root use:

```bash
python3 plugins/jig-rust/skills/rust-async-concurrency-review/scripts/scan_async_rust.py .
```

Use scanner hits only as leads. Never report a hit as a finding until you inspect the surrounding code and confirm the failure mode. For lock-heavy diffs or task-collection method spawns, add `--include-noisy` to include receiver-agnostic `.lock()` and `.spawn()` leads that are intentionally disabled by default.

## Review workflow

1. Establish the async boundary map.
   - Identify every new or changed spawned task, async loop, channel pair, lock acquisition, `select!`, external I/O operation, and shutdown path.
   - Trace the owner of each task and resource through callers and supervisors. Unclear ownership is a lead; report only a reachable lifecycle failure, not missing documentation.

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
   - Trace whether a producer can outpace its consumer enough to violate a resource or latency requirement. Check capacity, admission limits, finite inputs, rate bounds, and drop/coalesce policies.
   - An unbounded channel is not itself a defect. A bound established by code or callers is sufficient counterevidence without an explicit justification comment.

6. Check observability.
   - Check whether failures can be attributed across task boundaries using existing spans, returned errors, job IDs, metrics, or other diagnostics. Do not require tracing spans for every task.
   - Report missing context only when it prevents a required operational diagnosis; identify the lost attribution and the smallest sufficient signal. Structured fields are one possible remedy, not a universal checklist.

7. Report only actionable issues.
   - Include exact file/line references where possible.
   - Classify severity using the rubric below.
   - Include a minimal patch shape or explicit acceptance criteria.

## Severity rubric

Use **Critical** when a bug can cause data loss, permanent hang, unbounded resource growth, durable orphan work, deadlock, or inability to shut down under plausible production conditions.

Use **High** when a bug can cause latency collapse, lost task results, invisible task failures, cancellation leaks, significant memory growth, starvation, or broken causality in production diagnostics.

Use **Medium** for a demonstrated, bounded operational consequence. Missing comments, tests, or context alone are limitations or optional improvements.

Keep clarity improvements without a demonstrated failure mode separate from defect severity.

## Select checks by async surface

- Spawned tasks or competing futures: read [lifecycle and cancellation](references/lifecycle-and-cancellation.md).
- Locks, synchronous work, queues, or task collections: read [locks and backpressure](references/locks-and-backpressure.md).
- Shutdown, I/O deadlines, fanout, runtime choice, or tracing: read [shutdown and runtime](references/shutdown-and-runtime.md).

Read only the relevant references.

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

For a difficult lifecycle analysis, read `references/review-playbook.md`. For a concrete repair example, read `references/patch-patterns.md`. Read `references/source-notes.md` only to verify library semantics or sources.
