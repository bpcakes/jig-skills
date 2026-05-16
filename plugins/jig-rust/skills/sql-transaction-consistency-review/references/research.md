# Research notes for sql-transaction-consistency-review

Primary references used to build this skill:

- OpenAI Codex skills documentation: a skill is a directory containing `SKILL.md`; `SKILL.md` must include `name` and `description` metadata. The description is used for implicit skill activation.
  - https://developers.openai.com/codex/skills
- SQLx Rust `Transaction` documentation: a transaction starts with `Pool::begin` or `Connection::begin`; it should end with `commit` or `rollback`; rollback is called on drop if still in progress.
  - https://docs.rs/sqlx/latest/sqlx/struct.Transaction.html
- SQLx Rust `Pool` documentation: `Pool::acquire` gets a connection from the pool; dropped connections return to the pool; passing `&Pool` as an executor automatically checks out a connection.
  - https://docs.rs/sqlx/latest/sqlx/struct.Pool.html
- PostgreSQL transaction isolation documentation: Serializable guarantees an effect equivalent to running transactions one at a time; weaker levels allow specific phenomena, including serialization anomalies at weaker levels.
  - https://www.postgresql.org/docs/current/transaction-iso.html
- PostgreSQL serialization failure handling: applications using Repeatable Read or Serializable must be prepared to retry transactions that fail with SQLSTATE `40001`.
  - https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html
- PostgreSQL explicit locking documentation: locks can be used for application-controlled concurrency where MVCC is not sufficient.
  - https://www.postgresql.org/docs/current/explicit-locking.html
- PostgreSQL INSERT / ON CONFLICT documentation: `ON CONFLICT` handles unique/exclusion conflicts and `ON CONFLICT DO UPDATE` guarantees an atomic insert-or-update outcome under high concurrency, absent independent errors.
  - https://www.postgresql.org/docs/current/sql-insert.html
- PostgreSQL constraints documentation: unique constraints enforce uniqueness and create an underlying unique B-tree index; primary keys enforce uniqueness and non-nullness.
  - https://www.postgresql.org/docs/current/ddl-constraints.html
