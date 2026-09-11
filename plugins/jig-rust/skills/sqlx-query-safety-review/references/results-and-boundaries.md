# Result decoding, cardinality, cost, and API boundaries

These checks apply only within the requested review. Patterns are investigation signals: confirm consequences and examine safeguards before reporting; assign severity by impact, not syntax.

## Nullability and type conversion rules

Checked SQLx macros infer many output types, but review the semantic edge cases:

- Columns from the optional side of `LEFT JOIN`, `RIGHT JOIN`, or `FULL JOIN` must be `Option<T>` unless the query filters them back to non-null.
- SQL expressions, aggregate expressions, `VALUES`, JSON extraction, `COALESCE`, casts, and database functions may have nullability that differs from intuition.
- `Option<T>` bind values become SQL `NULL`; equality with `NULL` does not behave like normal equality. Use `IS NULL`, `IS NOT NULL`, `IS [NOT] DISTINCT FROM`, database-specific null-safe comparison, or explicit query branching.
- For forced-not-null overrides, inspect schema constraints, filters, expressions, and decoding. Report only a reachable null that violates the target type; non-local proof is valid.
- `foo as "foo?"` / `foo?` forced-nullable overrides are appropriate when outer joins or query plans make SQLx inference too optimistic.
- `foo as "foo: T"`, `foo as "foo!: T"`, and `foo as "foo?: T"` custom type overrides should match a real `sqlx::Type`/decode path and should not hide lossy conversions.
- `expr as _` skips macro bind type checking. Inspect actual binding and schema compatibility; report a consequential mismatch rather than the syntax.

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

- `fetch_one` on an optional lookup when `RowNotFound` is handled incorrectly; existing caller translation may already implement the correct absence contract.
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

- required `RETURNING` / output values are discarded,
- the result should be fetched to obtain generated IDs, updated version numbers, or computed fields,
- a `SELECT` result required by the caller is discarded,
- application correctness depends on whether a row was changed but `rows_affected()` is ignored.

### `rows_affected`

Check row counts when they encode business facts:

- `UPDATE ... WHERE id = $1 AND owner_id = $2`: `0` may mean not found or unauthorized; handle deliberately.
- Optimistic concurrency: require `rows_affected() == 1` when updating by `id` and `version`.
- Deletes by ID: decide whether `0` is idempotent success or not found; do not leave it accidental.
- Bulk updates/deletes: ensure the broad predicate is intentional and tenant-scoped.

## N+1 query detection

Investigate database calls inside loops. Establish batch size, frequency, query latency, and existing batching or caching before reporting a material cost.

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

Assign N+1 severity from demonstrated load and latency/resource consequences. An unknown batch bound is a verification gap, not automatically Medium.

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

The following can support a deliberate shared DB/API DTO; naming or missing comments alone are not defects:

- callers and the public contract intentionally use this projection,
- the selected SQL explicitly returns only public fields,
- no sensitive/internal fields exist on the type,
- the type is stable as a public contract, not an incidental query result.
