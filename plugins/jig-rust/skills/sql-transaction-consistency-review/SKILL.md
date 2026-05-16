---
name: sql-transaction-consistency-review
description: Use when reviewing Rust code that reads or mutates SQL-backed state and may affect transaction boundaries, isolation assumptions, commit/rollback behavior, multi-step invariants, SELECT-before-INSERT races, side effects around commits, retries, or connection lifetime safety.
---

# SQL Transaction Consistency Review

Use this skill when reviewing code that reads or mutates SQL-backed state and the change may affect transactional correctness, concurrency safety, or domain invariants. Trigger strongly for pull requests involving multi-step writes, SQLx transactions, repository/executor abstractions, SELECT-before-INSERT flows, cache/email/webhook/queue side effects, isolation-level changes, idempotency, retries, or long-running async work near database code.

This is a correctness review, not a style review. Prefer specific findings with a concrete failure mode over generic advice such as "wrap this in a transaction."

## Core judgment

A transaction boundary is correct only when it protects the domain invariant being changed, uses the correct database handle for every query in that unit, commits or rolls back intentionally, does not leak irreversible side effects before the commit is durable, and remains safe under concurrent execution.

## Review workflow

1. **Map the state-changing flow.** Identify all reads that influence writes, all inserts/updates/deletes, and all external side effects in the same request/job/handler.
2. **Name the invariant.** State what must remain true, for example: one active subscription per account, inventory never below zero, a ledger transfer debits and credits exactly once, a payment state and audit row agree, or an idempotency key maps to one result.
3. **Find the transaction owner.** Locate `begin`, transaction creation, commit, rollback, helper/repository calls, and any pool/connection acquisition.
4. **Trace every query handle.** Confirm every query that must participate in the unit of work uses the transaction handle, not a pool or separately acquired connection.
5. **Check concurrency.** Construct a two-request interleaving. If both executions can pass a read check and then write conflicting state, require a constraint, upsert, lock, stronger isolation, or retry.
6. **Check side effects.** Verify emails, webhooks, queue publishes, cache writes, and other external effects happen after successful commit, or are modeled through a compensating/idempotent design such as a transactional outbox.
7. **Check lifetime.** Ensure transactions and checked-out connections are not held across slow external calls, sleeps, user I/O, large CPU work, or unrelated awaits.
8. **Check error paths.** Verify commit and rollback behavior is explicit enough for the codebase and that commit failures, rollback failures, serialization failures, and deadlocks are not swallowed.
9. **Report only actionable issues.** Each finding must identify the invariant at risk, the unsafe interleaving or failure path, and the smallest credible fix.

Read `references/research.md` only when validating or updating the skill's transaction, SQLx, or PostgreSQL claims; ordinary reviews should use the checklist below.

## Required checks

### 1. Multi-step state changes are atomic

Flag when a domain operation performs multiple dependent writes without one transaction. Common examples:

- create parent plus children;
- update business state plus audit/event/idempotency row;
- transfer, reserve, allocate, or decrement-and-increment operations;
- delete or archive data across related tables;
- mark payment/order/job state plus record the result;
- read a current value, compute a new value, then write it.

Accept a non-transactional implementation only when a single SQL statement enforces the invariant, the database constraints alone are sufficient, or the code intentionally uses a documented saga/compensation pattern.

### 2. Transaction boundaries match domain invariants

The transaction should start after cheap validation and after gathering external inputs that do not need locks. It should include all SQL reads and writes that establish the invariant. It should end before unrelated work.

Flag boundaries that are too narrow:

- validation read occurs outside the transaction and controls an in-transaction write;
- helper/repository writes use a pool instead of the active transaction;
- audit, ledger, idempotency, or outbox rows are written after commit even though they are part of the invariant;
- nested helper starts its own transaction instead of joining the caller's transaction.

Flag boundaries that are too broad:

- transaction begins before remote API calls, email rendering, queue publish, cache refresh, file upload, sleep/backoff, or other slow work;
- connection is checked out long before first query;
- code holds locks while waiting on data that could have been collected first.

### 3. No irreversible side effects before commit

Flag side effects before successful commit unless the design explicitly handles compensation or idempotency. Side effects include:

- emails, SMS, push notifications;
- webhooks and remote API calls;
- queue/topic publishes;
- cache writes/invalidation and Redis mutations;
- file/object-store writes that represent committed domain state;
- analytics or audit messages that users/operators rely on as truth.

Preferred fixes:

- perform side effects only after `commit` succeeds;
- use a transactional outbox: insert an outbox/event row in the same transaction, then let a separate dispatcher publish after commit;
- make pre-commit effects idempotent and compensatable, with the compensating behavior documented and tested.

Do not accept "rollback will undo it" for external systems. SQL rollback does not undo an email, webhook, cache write, queue message, or remote API call.

### 4. Commit and rollback behavior is explicit

For SQLx/Rust, a transaction starts with `Pool::begin` or `Connection::begin`; success paths should end with `commit().await?`, and explicit abort paths should use `rollback().await?` when clarity or resource release matters. SQLx rolls back on drop if a transaction is still in progress, but relying on drop must be intentional and safe.

Flag:

- missing `commit` on the success path;
- ignored `commit` result;
- code that performs side effects before checking whether `commit` succeeded;
- `rollback` errors blindly swallowed in paths where cleanup failure matters;
- early returns where rollback-on-drop is accidental rather than understood;
- manual `BEGIN`/`COMMIT` strings executed through a pool instead of a transaction handle;
- nested transaction/savepoint behavior that is assumed but not verified.

Treat rollback-on-drop as a safety net, not a reason to make transaction lifecycle ambiguous.

### 5. Isolation level is sufficient for the invariant

Default isolation is often not enough for invariants based on absence, counts, aggregates, ranges, or cross-row rules. Flag code that relies on "we checked first" when concurrent transactions can invalidate the check.

Patterns requiring scrutiny:

- check no active row exists, then insert active row;
- count rows, then insert if below limit;
- select max/last/next sequence-like value, then insert;
- sum balances/inventory/capacity, then update;
- two transactions update different rows while violating a cross-row invariant;
- range booking/scheduling conflicts;
- "read current status, if pending then transition" without locking or conditional update.

Potential fixes, depending on database and invariant:

- schema constraints: unique, partial unique, exclusion, foreign key, check constraint;
- atomic SQL: conditional `UPDATE ... WHERE ...`, `INSERT ... ON CONFLICT`, `RETURNING`, compare-and-swap version checks;
- row locks such as `SELECT ... FOR UPDATE` for existing rows;
- guard rows or advisory locks for absence/range invariants when constraints are not enough;
- `SERIALIZABLE` or equivalent isolation with retry of the entire transaction.

Do not recommend stronger isolation alone if the code lacks retry behavior for serialization/deadlock failures.

### 6. SELECT-then-INSERT races are replaced by constraints/upserts

Flag this shape unless a constraint or lock makes it safe:

```sql
SELECT id FROM table WHERE key = ?;
-- if none
INSERT INTO table (key, ...) VALUES (?, ...);
```

Safe alternatives usually include:

- a unique or exclusion constraint that exactly represents the invariant;
- `INSERT ... ON CONFLICT DO NOTHING/UPDATE ... RETURNING ...`;
- insert and handle the unique violation as a concurrent success/failure case;
- idempotency-key table with a unique key and stored result;
- serializable transaction with whole-transaction retry, where appropriate.

A code-level mutex is not enough unless all writers are guaranteed to run in the same process and the invariant is not externally observable. In most services, prefer database enforcement.

### 7. Pool acquisition is not transaction ownership

A checked-out connection is not automatically a transaction. A pool is not a transaction. Passing `&Pool` to a repository from inside a transaction can execute queries on a separate connection outside the transaction.

For SQLx/Rust, watch for:

- `pool.begin().await?` followed by helper calls that receive `&pool` instead of `&mut tx`;
- `execute(&pool)`, `fetch_*(&pool)`, or repository methods taking `PgPool` during an active transaction;
- `pool.acquire().await?` treated as if it began a transaction;
- helpers that call `pool.begin()` internally when they should join the caller's transaction;
- transaction object not threaded through all dependent reads/writes.

Preferred pattern: make repository functions accept an executor/transaction-compatible handle and pass the active transaction through the full unit of work. For SQLx, code often uses `&mut Transaction<'_, DB>` or `&mut *tx`/connection-style parameters consistently across all queries in the invariant.

### 8. Connections are not held during slow external work

Flag transactions or checked-out connections held across:

- HTTP/gRPC calls;
- payment provider calls;
- email/webhook/queue publishing;
- cache rebuilds;
- sleeps, retries, timers, or rate-limit waits;
- long CPU work, report generation, file/object storage operations;
- user interaction or streaming responses.

Preferred fix: do slow work before acquiring the transaction if it only gathers inputs, or after commit if it is a side effect. If the external action must be coordinated with database state, use an outbox, reservation, lease, idempotency key, or saga design rather than holding locks while waiting.

### 9. Retry behavior exists where needed

Require bounded retry of the whole transaction when the code deliberately uses isolation/locking patterns that can fail transiently, especially serializable/repeatable-read transactions, deadlock-prone lock acquisition, and high-contention conditional writes.

Check that retry logic:

- retries the whole transaction body, not only the failed statement;
- detects database-specific transient errors, for example PostgreSQL `40001` serialization failure and `40P01` deadlock detected;
- uses a bounded attempt count with backoff/jitter for high contention;
- is safe to repeat because non-idempotent side effects are outside the retried transaction or represented by durable idempotency/outbox state;
- preserves request idempotency and does not duplicate ledger/audit/outbox rows;
- logs enough context to debug repeated contention.

Do not demand retries for every transaction. Demand them when the chosen isolation/lock strategy can legitimately abort under concurrency and retry is part of correctness.

## Language and framework-specific search hints

Use these patterns while reviewing. Adapt to the repository's language and database library.

```text
begin|commit|rollback|transaction|savepoint|isolation|serializable|repeatable read
Pool::begin|Connection::begin|Transaction|PgPool|SqlitePool|MySqlPool|acquire\(
execute\(&pool|fetch_.*\(&pool|execute\(&mut \*tx|fetch_.*\(&mut \*tx
ON CONFLICT|UPSERT|INSERT IGNORE|ON DUPLICATE KEY|MERGE
SELECT .* FOR UPDATE|FOR SHARE|SKIP LOCKED|NOWAIT
SELECT .*INSERT|find.*create|get.*or.*create|first.*or.*create
email|sms|webhook|publish|enqueue|queue|topic|cache|redis|invalidate|outbox
reqwest|http|grpc|sleep|timeout|spawn|tokio::spawn|join!
40001|40P01|deadlock|serialization_failure|busy|lock wait timeout
```

## Findings format

Use this structure for every issue:

```text
[Severity] Category: concise title
Location: file:line or function
Invariant at risk: the business rule that can be violated
Failure mode: the shortest concrete interleaving or error path that breaks it
Why current code is insufficient: transaction/pool/isolation/side-effect/retry reason
Recommended fix: specific transaction boundary, constraint/upsert/lock/isolation/outbox/retry change
Test to add: concurrency, rollback, side-effect ordering, or retry test
```

Severity guidance:

- **Critical:** money, authorization, inventory, ledger, payment, or irreversible external side effect can become wrong or duplicated.
- **High:** durable domain invariant can be violated under realistic concurrency or failure.
- **Medium:** lifecycle, retry, or connection-lifetime issue can cause intermittent failures, pool starvation, stale cache, or operational inconsistency.
- **Low:** clarity or maintainability issue that could become dangerous but has no current concrete invariant failure.

## Do not over-report

Do not flag code merely because it lacks an explicit transaction when:

- the operation is a single SQL statement whose atomicity is sufficient;
- database constraints fully enforce the invariant and errors are handled correctly;
- the flow is read-only and does not require a consistent multi-query snapshot;
- a documented saga/compensation/outbox/idempotency design intentionally splits work;
- the code is test setup or a migration where transaction semantics are managed by the migration framework.

When uncertain, state the missing fact needed to decide, such as the exact database, default isolation level, unique/partial indexes, whether a helper uses the caller's transaction, or whether an outbox dispatcher exists.

## Preferred review mindset

- Make the invariant explicit before proposing a fix.
- Prefer database-enforced invariants over application-only checks.
- Prefer small transaction scopes that include all relevant SQL and exclude slow external work.
- Treat commit as the point after which external truth may be emitted.
- Treat retries as part of serializable/deadlock correctness, not as generic resilience decoration.
- Avoid vague advice. Show the interleaving.
