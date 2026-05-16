---
name: sqlx-query-safety-review
description: Use when reviewing Rust database access code that uses SQLx queries, query macros, QueryBuilder, or SQL result DTOs. Check compile-time query checking, bind-parameter safety, nullability, fetch and execute semantics, unchecked macro usage, dynamic SQL risk, row counts, N+1 queries, and query/result boundary correctness. Also applies as a fallback review for Diesel, SeaORM, and raw Rust SQL drivers.
---

# sqlx-query-safety-review

## Mission

Review Rust database access code with SQLx as the primary target. Find security, correctness, performance, and layering issues around SQL construction, query checking, parameter binding, result decoding, fetch semantics, and DTO boundaries. Prefer precise, line-specific review comments with a concrete safer rewrite.

Use SQLx rules first. If the repository uses Diesel, SeaORM, or lower-level/raw SQL drivers instead of SQLx, read `references/database-fallbacks.md` and apply those rules instead of forcing SQLx-specific recommendations.

## Trigger conditions

Run this review when code contains any of these markers:

- SQLx: `sqlx::query`, `sqlx::query!`, `query_as!`, `query_scalar!`, `query_file!`, `query_file_as!`, `query_unchecked!`, `query_as_unchecked!`, `query_scalar_unchecked!`, `query_file_unchecked!`, `query_file_as_unchecked!`, `QueryBuilder`, `.bind(...)`, `.fetch_one(...)`, `.fetch_optional(...)`, `.fetch_all(...)`, `.execute(...)`, `.rows_affected()`, `FromRow`, `Row::get`, `Row::try_get`, `raw_sql`.
- Diesel fallback: `diesel`, `sql_query`, `diesel::dsl::sql`, `.bind::<...>()`, `QueryableByName`, `RunQueryDsl`.
- SeaORM fallback: `sea_orm`, `Entity::find`, `from_raw_sql`, `raw_sql!`, `Statement::from_string`, `Statement::from_sql_and_values`, `execute_unprepared`, `query_one_raw`, `query_all_raw`, `execute_raw`.
- Raw SQL fallback: `tokio_postgres`, `postgres`, `rusqlite`, `mysql`, `tiberius`, `odbc`, direct SQL string construction, `prepare`, `query`, `execute`, `format!` near SQL.
- HTTP boundary markers near DB DTOs: `axum::Json`, `actix_web::web::Json`, `HttpResponse::Ok().json`, `warp::reply::json`, `Serialize`, `Deserialize`, `utoipa::ToSchema`, `async_graphql`, `juniper`.

## Review priorities

1. SQL injection and user-controlled SQL structure.
2. Missed SQLx compile-time query checking.
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
3. Report only material issues. Do not complain about `query()` solely because it is runtime-checked when dynamic SQL makes macros impossible and binding/allow-listing is correct.
4. When a safer SQLx macro is practical, propose the exact macro replacement.
5. When SQL is dynamic, separate data values from SQL structure. Values must be bound. Structure must come only from static fragments or allow-listed enums.
6. Check the query's semantics, not just syntax. Confirm cardinality, nullability, pagination, row-count handling, and DTO boundary intent.

## Severity guide

- **Critical**: User/request-controlled input can change SQL syntax or identifiers; `QueryBuilder::push`, `format!`, `push_str`, string concatenation, `join`, `write!`, `replace`, `Statement::from_string`, `execute_unprepared`, Diesel `sql_query`, or raw driver calls incorporate untrusted input without binding or a strict allow-list.
- **High**: `query_unchecked!`/`query_as_unchecked!`/unchecked file or scalar variants are used where checked macros are practical; raw SQL discards returned rows or row-count checks needed for authorization/correctness; unbounded `fetch_all` on a public/request path can exhaust memory; nullability override can produce runtime `UnexpectedNull` or panic; N+1 query pattern is on a hot or externally triggered path.
- **Medium**: `sqlx::query()`/`query_as::<_, T>()`/`query_scalar::<...>()` uses a static literal where SQLx checked macros would work; `fetch_one`/`fetch_optional` ignores possible duplicate rows; `fetch_all` lacks obvious pagination but result size is probably limited; `rows_affected` result is ignored when business logic likely depends on it; raw row decoding uses unchecked assumptions.
- **Low**: Query DTO and HTTP DTO boundaries are blurred but no sensitive fields are currently exposed; missing documentation for an otherwise safe dynamic SQL allow-list; minor type/nullability clarity issues.

## SQLx compile-time checking rules

Prefer SQLx checked macros for static application queries:

- Use `query!` for ad hoc row records.
- Use `query_as!` when mapping into a named struct.
- Use `query_scalar!` for a single selected column.
- Use `query_file!` or `query_file_as!` for large static SQL in a file.

Flag runtime-checked SQLx APIs when compile-time checking was practical:

```rust
// Flag when static and normal application query.
sqlx::query("SELECT id, email FROM users WHERE id = $1")
    .bind(user_id)
    .fetch_one(pool)
    .await?;

// Prefer:
sqlx::query!("SELECT id, email FROM users WHERE id = $1", user_id)
    .fetch_one(pool)
    .await?;
```

For named structs:

```rust
// Flag when static and fields are known.
sqlx::query_as::<_, UserRow>("SELECT id, email FROM users WHERE id = $1")
    .bind(user_id)
    .fetch_one(pool)
    .await?;

// Prefer:
sqlx::query_as!(UserRow, "SELECT id, email FROM users WHERE id = $1", user_id)
    .fetch_one(pool)
    .await?;
```

Treat compile-time checking as practical when all are true:

- SQL is a string literal or literal concatenation, not generated from runtime values.
- Tables, columns, joins, sort clauses, selected fields, and predicates are static.
- The query is not a migration, one-off admin statement, multi-statement raw SQL, or vendor feature that SQLx macros cannot introspect.
- The project can reasonably support SQLx macro checking through `DATABASE_URL` at build time or committed offline metadata under `.sqlx`.
- The query returns a shape SQLx can model, or the only obstacle is a simple type/nullability override that should be expressed with SQLx's override syntax.

Do not flag `sqlx::query()` solely for missing macro use when:

- SQL structure is legitimately dynamic and built from static/allow-listed fragments.
- A query builder is required for variable predicate counts or variable-length inserts.
- The code is a migration or DDL path where SQLx macros are not the appropriate interface.
- A generated query cannot be represented by the macros, and the code has binding, allow-listing, tests, and reviewable invariants.

Still flag any dynamic query if user input can alter SQL structure.

## Unchecked SQLx macros

Flag these by default:

- `query_unchecked!`
- `query_as_unchecked!`
- `query_scalar_unchecked!`
- `query_file_unchecked!`
- `query_file_as_unchecked!`
- any project-local wrapper that expands to unchecked SQLx macros.

Reason: unchecked SQLx macro variants retain SQL parsing/validation but skip input/output type checking. That removes the strongest SQLx guarantee.

Accept unchecked use only when the review can see a deliberate, narrow justification, such as a documented database-specific type limitation that cannot be expressed with checked macro overrides. The justification must include:

- why the checked macro cannot work,
- what input and output types are expected,
- a runtime/integration test proving the mapping,
- why the result type does not cross an unsafe public boundary.

If that justification is absent, recommend checked macro replacement or explicit type/nullability overrides.

## Dynamic SQL and SQL injection rules

Never allow user/request-controlled input to alter SQL structure directly. This includes table names, column names, sort keys, sort directions, operators, raw `WHERE` fragments, `LIMIT`, `OFFSET`, CTE names, JSON path fragments, function names, and entire clauses.

Flag these patterns when any interpolated value is tainted by request/user/configurable tenant input unless it is proven to come from a closed allow-list:

```rust
format!("SELECT * FROM users WHERE email = '{email}'")
format!("ORDER BY {sort}")
sql.push_str(&request.query)
write!(sql, " WHERE name = '{}'", name)
ids.iter().map(ToString::to_string).join(",")
query_builder.push(user_input)
Statement::from_string(db, format!("SELECT * FROM cake WHERE id = {id}"))
db.execute_unprepared(&sql)
```

Correct value binding:

```rust
sqlx::query!("SELECT * FROM users WHERE email = $1", email)
```

Correct dynamic structure allow-listing:

```rust
enum UserSort { CreatedAt, Email }

let sort_sql = match sort {
    UserSort::CreatedAt => "created_at",
    UserSort::Email => "email",
};

let direction_sql = match direction {
    SortDirection::Asc => "ASC",
    SortDirection::Desc => "DESC",
};

let mut qb = sqlx::QueryBuilder::<sqlx::Postgres>::new(
    "SELECT id, email FROM users WHERE org_id = "
);
qb.push_bind(org_id)
  .push(" ORDER BY ")
  .push(sort_sql)
  .push(" ")
  .push(direction_sql)
  .push(" LIMIT ")
  .push_bind(limit);
```

`QueryBuilder::push` is acceptable only for static SQL fragments or values selected from a strict allow-list. `QueryBuilder::push_bind` is required for values.

Do not accept manual escaping as the primary defense. Prepared statements and bind parameters are the baseline. Allow-list validation is for SQL structure that cannot be parameterized.

## Parameter binding rules

For SQLx checked macros, verify values are passed as macro arguments rather than interpolated into the SQL string:

```rust
sqlx::query!("UPDATE users SET email = $1 WHERE id = $2", email, user_id)
```

For SQLx runtime APIs, verify each dynamic value is bound in correct placeholder order:

```rust
sqlx::query("UPDATE users SET email = $1 WHERE id = $2")
    .bind(email)
    .bind(user_id)
```

Check database placeholder style:

- Postgres through SQLx uses `$1`, `$2`, ... placeholders.
- MySQL, MariaDB, and SQLite commonly use `?` placeholders and require bind order to match placeholder order.

Flag:

- quoted placeholders like `WHERE id = '$1'` or `WHERE id = '?'`,
- bind count/order mismatch in runtime APIs,
- constructing `IN (...)` by joining values into a string,
- concatenating `LIKE '%{term}%'` instead of binding `term`,
- using `LIMIT {limit}` / `OFFSET {offset}` from request input rather than validated bounds and binding or allow-listing as appropriate,
- mixing SQL structure and user values in the same `format!` call.

For variable-length `IN` lists, prefer one of:

- Postgres array binding: `WHERE id = ANY($1)` with an array/slice where supported.
- `QueryBuilder` with `.separated(", ")` and `.push_bind(...)` for each value.
- SeaQuery/SeaORM raw SQL array expansion where it produces bound parameters.

## Nullability and type conversion rules

Checked SQLx macros infer many output types, but review the semantic edge cases:

- Columns from the optional side of `LEFT JOIN`, `RIGHT JOIN`, or `FULL JOIN` must be `Option<T>` unless the query filters them back to non-null.
- SQL expressions, aggregate expressions, `VALUES`, JSON extraction, `COALESCE`, casts, and database functions may have nullability that differs from intuition.
- `Option<T>` bind values become SQL `NULL`; equality with `NULL` does not behave like normal equality. Use `IS NULL`, `IS NOT NULL`, `IS [NOT] DISTINCT FROM`, database-specific null-safe comparison, or explicit query branching.
- `foo as "foo!"` / `foo!` forced-not-null overrides require proof. If the proof is not local and obvious, flag it.
- `foo as "foo?"` / `foo?` forced-nullable overrides are appropriate when outer joins or query plans make SQLx inference too optimistic.
- `foo as "foo: T"`, `foo as "foo!: T"`, and `foo as "foo?: T"` custom type overrides should match a real `sqlx::Type`/decode path and should not hide lossy conversions.
- `expr as _` for bind parameters tells the SQLx macro not to type-check that bind expression. Flag it unless there is a clear reason and coverage.

Flag these patterns:

```rust
row.get::<String, _>("maybe_null_column")
record.optional_name.unwrap()
record.optional_name.unwrap_or_default() // when default changes business meaning
select nullable_col as "nullable_col!"
let id: i32 = row.try_get("bigint_id")?; // lossy or wrong width if DB type is BIGINT
```

Prefer:

- `try_get` over `get` for raw row extraction unless panic is intentionally impossible.
- `Option<T>` at the DB boundary with explicit domain conversion.
- clear domain validation before converting DB values to narrower application types.

## Fetch and execution semantics

### `fetch_one`

Use only when exactly one row is required and the query enforces at most one row through a primary key, unique predicate, aggregate without `GROUP BY`, or explicit `LIMIT 1` where "first row" is truly intended.

Flag:

- `fetch_one` on a lookup that can legitimately return zero rows; use `fetch_optional` and map `None` to 404/not-found/domain absence.
- `fetch_one` on a non-unique predicate without `ORDER BY ... LIMIT 1` when "first" is intended.
- `fetch_one` where duplicates indicate corruption but extra rows would be silently ignored; recommend `LIMIT 2` and handling `> 1` if uniqueness must be enforced outside the DB.

### `fetch_optional`

Use for zero-or-one cardinality. The query must still guarantee at most one meaningful row.

Flag:

- optional fetch on a non-unique predicate where duplicates would be ignored.
- missing `ORDER BY` when choosing a first/last/latest row.
- using `fetch_optional` to hide data integrity problems.

### `fetch_all`

Use only when the result set is intentionally bounded.

Flag:

- public endpoint or request-driven path with no `LIMIT`, pagination, keyset cursor, tenant bound, or known-small table.
- `SELECT *` in list endpoints where the response needs only a subset.
- unbounded `fetch_all` followed by application-side filtering/sorting that should be pushed into SQL.

Prefer streaming or paginated/keyset queries for large results.

### `execute`

Use for statements where returned rows are not needed. Flag `execute` when:

- the SQL contains `RETURNING` / output columns that are discarded,
- the result should be fetched to obtain generated IDs, updated version numbers, or computed fields,
- the statement is a `SELECT`,
- application correctness depends on whether a row was changed but `rows_affected()` is ignored.

### `rows_affected`

Check row counts when they encode business facts:

- `UPDATE ... WHERE id = $1 AND owner_id = $2`: `0` may mean not found or unauthorized; handle deliberately.
- Optimistic concurrency: require `rows_affected() == 1` when updating by `id` and `version`.
- Deletes by ID: decide whether `0` is idempotent success or not found; do not leave it accidental.
- Bulk updates/deletes: ensure the broad predicate is intentional and tenant-scoped.

## N+1 query detection

Flag database calls inside loops over rows/items unless the code is explicitly a tiny bounded batch or uses a batching abstraction.

Patterns:

```rust
for user in users {
    let posts = sqlx::query_as!(PostRow, "SELECT ... WHERE user_id = $1", user.id)
        .fetch_all(pool)
        .await?;
}

stream.try_for_each(|row| async move {
    sqlx::query!("SELECT ... WHERE id = $1", row.id).fetch_one(pool).await
}).await?;

join_all(ids.iter().map(|id| repo.load_one(*id))).await;
```

Prefer:

- a `JOIN` plus projection when row multiplication is manageable,
- batched `WHERE id = ANY($1)` / `IN (...)` queries,
- prefetch into `HashMap<Id, Vec<Row>>`,
- CTEs or aggregation queries,
- a DataLoader/batch loader for GraphQL-like resolvers.

Report N+1 as High when externally triggered or on a hot path. Report as Medium when the batch is plausibly small but not proven.

## Query-result DTO and HTTP boundary rules

Database result DTOs should not leak directly into HTTP/API response DTOs unless that is a deliberate boundary.

Flag direct leakage when a type:

- derives or implements `sqlx::FromRow`, is used as a `query_as!` output, or is named like `*Row`, `*Record`, `*Entity`, `Db*`,
- also derives `Serialize` / OpenAPI schema traits or is returned directly through JSON/GraphQL response code,
- contains internal fields, security-sensitive fields, audit columns, tenant IDs, soft-delete markers, password hashes, tokens, role internals, or fields not explicitly part of the public contract.

Risky pattern:

```rust
#[derive(sqlx::FromRow, serde::Serialize)]
struct UserRow {
    id: Uuid,
    email: String,
    password_hash: String,
    tenant_id: Uuid,
    deleted_at: Option<DateTime<Utc>>,
}

pub async fn get_user(...) -> Json<UserRow> { ... }
```

Prefer an explicit mapping boundary:

```rust
struct UserRow { /* DB shape */ }

#[derive(serde::Serialize)]
struct UserResponse { id: Uuid, email: String }

impl From<UserRow> for UserResponse {
    fn from(row: UserRow) -> Self {
        Self { id: row.id, email: row.email }
    }
}
```

Accept shared DB/API DTOs only when all are true:

- the type is intentionally named and documented as an API DTO,
- the selected SQL explicitly returns only public fields,
- no sensitive/internal fields exist on the type,
- the type is stable as a public contract, not an incidental query result.

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

## Safe-pattern examples

### Static SQLx query

```rust
let user = sqlx::query_as!(
    UserRow,
    r#"SELECT id, email, created_at FROM users WHERE id = $1"#,
    user_id
)
.fetch_optional(pool)
.await?;
```

### Dynamic filters with safe values

```rust
let mut qb = sqlx::QueryBuilder::<sqlx::Postgres>::new(
    "SELECT id, email FROM users WHERE tenant_id = "
);
qb.push_bind(tenant_id);

if let Some(email) = email_filter {
    qb.push(" AND email = ").push_bind(email);
}

let rows = qb.build_query_as::<UserRow>().fetch_all(pool).await?;
```

### Dynamic sort with allow-listed structure

```rust
let sort_sql = match sort {
    UserSort::CreatedAt => "created_at",
    UserSort::Email => "email",
};
let direction_sql = match direction {
    SortDirection::Asc => "ASC",
    SortDirection::Desc => "DESC",
};

qb.push(" ORDER BY ").push(sort_sql).push(" ").push(direction_sql);
```

### Batch instead of N+1

```rust
let user_ids: Vec<Uuid> = users.iter().map(|u| u.id).collect();
let posts = sqlx::query_as!(
    PostRow,
    r#"SELECT id, user_id, title FROM posts WHERE user_id = ANY($1)"#,
    &user_ids
)
.fetch_all(pool)
.await?;
```

## Final review checklist

Before finishing, verify:

- Static SQLx queries use checked macros where practical.
- Unchecked SQLx macros have a narrow, documented reason and tests.
- User values are bound, never interpolated.
- Dynamic SQL structure is static or allow-listed.
- Nullability and custom type overrides are justified.
- Fetch method matches expected cardinality.
- `fetch_all` is bounded or intentionally streamed/paginated.
- `execute` does not discard needed returned rows.
- `rows_affected` is checked where mutation count matters.
- No N+1 pattern exists on request/hot paths.
- DB result DTOs do not accidentally become public response DTOs.
