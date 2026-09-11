# SQLx safe-pattern examples

These checks apply only within the requested review. Patterns are investigation signals: confirm consequences and examine safeguards before reporting; assign severity by impact, not syntax.

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
