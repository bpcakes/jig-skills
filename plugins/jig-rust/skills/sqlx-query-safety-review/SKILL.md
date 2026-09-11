---
name: sqlx-query-safety-review
description: Review Rust SQL construction, binding, decoding, cardinality, and query/API boundaries; SQLx first, other drivers supported.
---

# sqlx-query-safety-review

Apply this skill when it serves the user's requested task and target. Discovery or a code change does not authorize an additional review, refactor, or broader scan. For review-only requests, report findings without editing; implement changes only when they are part of the user's request.

Treat checklist patterns, counts, and missing comments as investigation signals. Report a defect only after tracing a concrete consequence and checking counterevidence in callers, invariants, tests, and configuration. Missing context is a limitation, not a finding. Assign severity from impact and reachability; keep optional preferences separate and allow no findings.

## Mission

Review Rust database access code with SQLx as the primary target. Find security, correctness, performance, and layering issues around SQL construction, query checking, parameter binding, result decoding, fetch semantics, and DTO boundaries. Prefer precise, line-specific review comments with a concrete safer rewrite.

Use SQLx rules first. If the repository uses Diesel, SeaORM, or lower-level/raw SQL drivers instead of SQLx, read `references/database-fallbacks.md` and apply those rules instead of forcing SQLx-specific recommendations.

## Trigger conditions

Within a database-access review, these markers help locate relevant code:

- SQLx: `sqlx::query`, `sqlx::query!`, `query_as!`, `query_scalar!`, `query_file!`, `query_file_as!`, `query_unchecked!`, `query_as_unchecked!`, `query_scalar_unchecked!`, `query_file_unchecked!`, `query_file_as_unchecked!`, `QueryBuilder`, `.bind(...)`, `.fetch_one(...)`, `.fetch_optional(...)`, `.fetch_all(...)`, `.execute(...)`, `.rows_affected()`, `FromRow`, `Row::get`, `Row::try_get`, `raw_sql`.
- Diesel fallback: `diesel`, `sql_query`, `diesel::dsl::sql`, `.bind::<...>()`, `QueryableByName`, `RunQueryDsl`.
- SeaORM fallback: `sea_orm`, `Entity::find`, `from_raw_sql`, `raw_sql!`, `Statement::from_string`, `Statement::from_sql_and_values`, `execute_unprepared`, `query_one_raw`, `query_all_raw`, `execute_raw`.
- Raw SQL fallback: `tokio_postgres`, `postgres`, `rusqlite`, `mysql`, `tiberius`, `odbc`, direct SQL string construction, `prepare`, `query`, `execute`, `format!` near SQL.
- HTTP boundary markers near DB DTOs: `axum::Json`, `actix_web::web::Json`, `HttpResponse::Ok().json`, `warp::reply::json`, `Serialize`, `Deserialize`, `utoipa::ToSchema`, `async_graphql`, `juniper`.

## Review priorities

1. SQL injection and user-controlled SQL structure.
2. Query/schema mismatches and missing validation.
3. Unchecked SQLx macro usage.
4. Parameter binding correctness.
5. Nullability, type conversion, and decode correctness.
6. `fetch_one`, `fetch_optional`, `fetch_all`, `execute`, and `rows_affected` semantics.
7. N+1 query patterns and unbounded result sets.
8. Query-result DTOs leaking into public response DTOs without a deliberate boundary.

## Workflow

1. Identify the database stack. Prefer SQLx analysis. Switch to Diesel/SeaORM/raw fallback only when SQLx is not the active stack for the reviewed code.
2. Inventory every query touched by the diff and any callee/helper that constructs SQL for it. Track:
   - query API or macro used,
   - SQL literal or dynamic construction source,
   - placeholders and bind arguments,
   - finalizer: `fetch_one`, `fetch_optional`, `fetch_all`, stream, `execute`,
   - expected cardinality,
   - result type and where it flows,
   - request/user-controlled inputs reaching SQL or DTO output.
3. Report only material issues. Runtime query APIs are legitimate for static and dynamic SQL; inspect actual schema, binding, and caller contracts rather than requiring macro adoption.
4. When query checking would prevent a demonstrated mismatch, propose a practical macro, test, or decoding correction consistent with project constraints.
5. When SQL is dynamic, separate data values from SQL structure. Values must be bound. Structure must come only from static fragments or allow-listed enums.
6. Check the query's semantics, not just syntax. Confirm cardinality, nullability, pagination, row-count handling, and DTO boundary intent.

## Severity guide

First establish a defect from a violated contract and concrete consequence, checking counterevidence. Only then choose severity from its impact and reachability; query syntax and checklist categories do not determine the rating.

- **Critical**: A demonstrated injection or authorization failure enables severe disclosure, cross-tenant access, or destructive writes.
- **High**: A reachable query, mapping, cardinality, or resource failure materially corrupts results, defeats a required operation, or exhausts a service under plausible load.
- **Medium**: A confirmed query/schema mismatch, incorrect absence handling, or measured/reasoned query cost has a bounded operational consequence. Unknown cardinality or workload bounds are verification gaps, not automatic ratings.
- **Low**: A confirmed defect has a minor, limited consequence, such as incorrect optional display metadata without affecting stored data, access control, or the main operation. Explain the actual effect; do not promote it to Medium just because it is a query defect.
- Optional improvements: macro adoption, DTO separation, and documentation without a concrete consequence. Do not report these as defects.

## Select checks by query concern

Read only the relevant references:

- SQLx macro/runtime choice and unchecked mappings: [query checking](references/query-checking.md).
- SQL construction, interpolation, or bind arguments: [construction and binding](references/sql-construction.md).
- Decode types, nullability, fetch semantics, row counts, N+1, or HTTP DTOs: [results and boundaries](references/results-and-boundaries.md).
- Concrete replacement examples when useful: [safe patterns](references/safe-patterns.md).

## Fallback database stacks

For Diesel, SeaORM, or lower-level/raw SQL drivers, read `references/database-fallbacks.md`. Apply the same injection, binding, cardinality, row-count, N+1, and DTO-boundary principles without recommending SQLx macros.

## Review output format

Use this format for each issue:

```text
[Severity] path/to/file.rs:line - Short title
Why it matters: one sentence tied to safety/correctness/performance/boundary risk.
Evidence: quote or summarize the exact risky expression/API use.
Fix: concrete replacement, preferably with a short SQLx/Diesel/SeaORM snippet.
```

When multiple occurrences share the same root cause, group them and list locations.

Do not produce vague comments like "consider using prepared statements." State exactly which value must be bound, which fragment must be allow-listed, or which macro should replace the current API.
