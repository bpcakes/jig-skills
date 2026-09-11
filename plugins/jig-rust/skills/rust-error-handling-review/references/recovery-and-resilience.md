# Recovery and resilience

## Panic paths

Trace `unwrap`, `expect`, indexing, slices, arithmetic, `RefCell` borrows, and fallible work inside `From`. Show a reachable input or runtime condition that violates the API's panic contract. External origin alone does not establish reachability after validation, bounds checks, or type invariants. Nontrivial borrow reasoning is an investigation need, not evidence of a borrow panic.

Tests may intentionally panic on unexpected errors. Prefer invariant-oriented `expect` messages as an optional diagnostic improvement, not a mandatory finding in helpers. Distinguish quick CLI prototypes from services expected to recover. A `catch_unwind` boundary may deliberately isolate plugins; report when it hides required work or leaves invalid state.

## Retries and timeouts

Before reporting a missing retry or timeout, inspect client defaults, middleware, parent deadlines, supervisors, and caller retry policies. A single call can be correct. A second retry layer can amplify load, and retrying non-idempotent work can duplicate side effects.

A timeout finding needs a plausible stalled operation and consequence under the effective deadline policy. A retry finding needs an expected transient failure, a requirement to recover at this layer, and a safe idempotency or deduplication strategy. Do not recommend blanket retries for writes or health checks.

## Degradation and cleanup

Verify whether metrics, cache, audit logging, or other auxiliary work is optional for this operation. Fail-closed audit logging can be required. Check `Drop`, RAII guards, transactions, and compensating actions before claiming a resource leak or partial-write inconsistency. Distinguish durable side effects from automatically released handles.

For spawned tasks, follow the actual owner and supervisor. A dropped handle alone is not a critical finding: process-lifetime tasks or work observed through another channel may be deliberate. Report required results being lost, unobserved failures, shutdown loss, or missing cleanup with a reachable scenario.

## Discarded values

Missing `#[must_use]` on a wrapper, builder, or status result is a signal. Check whether ignoring it can violate a contract and whether the type or compiler already warns. Unit results, side-effecting builders, and intentionally optional outcomes may be valid. Treat a useful lint annotation as an optional improvement unless actual misuse or a material API hazard is shown.
