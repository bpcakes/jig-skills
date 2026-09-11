# Database Fallback Rules

Use these rules only when reviewed Rust code uses Diesel, SeaORM, or lower-level/raw SQL drivers instead of SQLx.

Treat API and syntax markers as leads. Confirm a consequential injection, decode, cardinality, resource, or public-contract failure after checking validation, schema constraints, caller handling, and intentional shared projections. Raw SQL, missing comments, or a shared DTO alone does not establish a defect.

## Diesel

Prefer Diesel's typed query DSL for normal application queries.

When raw Diesel SQL is used:

- `diesel::sql_query` is for entire raw SQL queries. Parameters must be bound with `.bind()`.
- `diesel::dsl::sql` is for small literal SQL fragments inside the query builder. Parameters must be bound with `.bind()`.
- `QueryableByName` and raw SQL type annotations are not fully compiler-verified against the SQL result; review aliases and SQL types carefully.
- Trace `format!`, concatenation, `push_str`, and request-controlled identifiers in `sql_query`/`sql`; report when an untrusted value can alter SQL structure after validation.
- Apply the same cardinality, row count, N+1, and DTO-boundary checks as SQLx.

## SeaORM

Prefer SeaORM entity/query-builder APIs for normal CRUD and relation queries.

When raw SeaORM SQL is used:

- Prefer `raw_sql!` or `Statement::from_sql_and_values` for values so parameters are separate from SQL text.
- `Statement::from_string` is acceptable only for static SQL or strictly allow-listed structure; flag dynamic values in the string.
- `execute_unprepared` is high risk and should be limited to static DDL/admin statements where prepared execution is not available or not useful.
- `query_one_raw` and `query_all_raw` require the same cardinality, nullability, and result-size checks as SQLx `fetch_optional`/`fetch_all`.
- Check `ExecResult::rows_affected()` when business logic depends on mutation count.

## Raw Drivers

For lower-level drivers, require prepared statements and parameter arrays/tuples for all values:

```rust
client.query("SELECT * FROM users WHERE id = $1", &[&user_id]).await?;
conn.execute("UPDATE users SET email = ? WHERE id = ?", params![email, user_id])?;
```

Flag:

- direct interpolation of user data into SQL,
- manual escaping as the main defense,
- dynamic identifiers without allow-listing,
- unbounded result collection,
- ignored mutation counts when the operation's contract depends on them,
- panic-prone row extraction,
- DB rows returned as API DTOs when they expose fields or coupling that violate the public contract.
