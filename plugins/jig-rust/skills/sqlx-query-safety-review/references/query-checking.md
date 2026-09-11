# SQLx query checking

These checks apply only within the requested review. Patterns are investigation signals: confirm consequences and examine safeguards before reporting; assign severity by impact, not syntax.

## SQLx compile-time checking rules

Prefer SQLx checked macros for static application queries:

- Use `query!` for ad hoc row records.
- Use `query_as!` when mapping into a named struct.
- Use `query_scalar!` for a single selected column.
- Use `query_file!` or `query_file_as!` for large static SQL in a file.

Runtime APIs are supported choices, even for static SQL. Investigate actual schema, type, or bind mismatches and existing integration coverage. Macro adoption alone is an optional improvement:

```rust
// Runtime-checked; not a defect solely because macros are available.
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
// A valid runtime mapping if schema and types agree.
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

Do not flag `sqlx::query()` solely for missing macro use, including for static SQL. Situations where runtime APIs are especially useful include:

- SQL structure is legitimately dynamic and built from static/allow-listed fragments.
- A query builder is required for variable predicate counts or variable-length inserts.
- The code is a migration or DDL path where SQLx macros are not the appropriate interface.
- A generated query cannot be represented by the macros, and the code has binding, allow-listing, tests, and reviewable invariants.

Still flag any dynamic query if user input can alter SQL structure.

## Unchecked SQLx macros

Investigate the input/output assumptions of:

- `query_unchecked!`
- `query_as_unchecked!`
- `query_scalar_unchecked!`
- `query_file_unchecked!`
- `query_file_as_unchecked!`
- any project-local wrapper that expands to unchecked SQLx macros.

Reason: unchecked SQLx macro variants retain SQL parsing/validation but skip input/output type checking. That removes the strongest SQLx guarantee.

Unchecked macros do not establish a defect by themselves. Inspect project constraints, database-specific type limitations, and compensating validation:

- why the checked macro cannot work,
- what input and output types are expected,
- a runtime/integration test proving the mapping,
- why the result type does not cross an unsafe public boundary.

Report a concrete unsupported mapping or lost validation guarantee with consequences. Missing local justification alone is not a defect; macro replacement can remain an optional improvement.
