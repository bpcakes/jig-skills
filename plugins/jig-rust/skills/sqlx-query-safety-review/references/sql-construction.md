# SQL construction and binding

These checks apply only within the requested review. Patterns are investigation signals: confirm consequences and examine safeguards before reporting; assign severity by impact, not syntax.

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
