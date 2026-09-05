# Evaluation Cases

Use these cases to test whether the skill distinguishes leaks from legitimate concrete contracts. A good response identifies the boundary promise before labeling the syntax.

## 1. Backend-neutral repository returns SQLx transaction — report

```rust
pub trait UserRepository {
    async fn begin(&self) -> Result<sqlx::Transaction<'_, sqlx::Postgres>, sqlx::Error>;
}
```

Context: the trait lives in `domain`, its documentation says adapters may use any store, and application services import SQLx to compose operations.

Expected: confirmed backend, error, and transaction-lifetime leak. The remediation must preserve atomic composition rather than merely deleting transactions.

## 2. SQLx adapter returns SQLx transaction — reject or narrow

```rust
pub struct SqlxUnitOfWork { /* ... */ }

impl SqlxUnitOfWork {
    pub async fn transaction(&self) -> sqlx::Transaction<'_, sqlx::Postgres>;
}
```

Context: the crate is explicitly an SQLx interoperability adapter.

Expected: no backend-neutrality claim. Review safety and lifecycle separately, but do not call the SQLx type a dependency leak solely because it is concrete.

## 3. Validated newtype dereferences mutably — report

```rust
pub struct HeaderName(String);
impl Deref for HeaderName { type Target = String; /* ... */ }
impl DerefMut for HeaderName { /* ... */ }
```

Context: construction validates an ASCII grammar.

Expected: invariant leak because `DerefMut` permits invalid mutation. A narrow `as_str` is a likely repair.

## 4. Transparent identifier newtype — reject without more evidence

```rust
pub struct UserId(pub uuid::Uuid);
```

Context: the crate explicitly standardizes UUID identifiers and performs no additional validation.

Expected: no automatic finding. The representation is deliberate.

## 5. Domain model is persisted through derived Serde — report when coupled

```rust
#[derive(Serialize, Deserialize)]
pub struct Account {
    pub balance: Money,
    pub flags: Vec<Flag>,
}
```

Context: the same type is stored for years, sent over an API, and used internally; field renames have broken old data.

Expected: schema/domain coupling finding with compatibility evidence. Recommend explicit schema/versioning or DTO conversion, not a blanket ban on Serde.

## 6. Schema crate derives Serde — reject

Context: the crate's sole purpose is to define versioned wire messages and its documentation commits to the field schema.

Expected: representation is the contract.

## 7. Runtime-neutral service returns Tokio handle — report

```rust
pub trait Worker {
    fn start(&self) -> tokio::task::JoinHandle<Result<(), WorkerError>>;
}
```

Context: the facade claims runtime independence and has a non-Tokio test implementation.

Expected: runtime and lifecycle leak. Repair should expose completion/cancellation semantics or name the adapter as Tokio-specific.

## 8. Tokio integration crate returns Tokio handle — reject or document lifecycle only

Expected: Tokio itself is not hidden. A finding still may exist if the handle exposes a cleanup invariant that the facade claims to own.

## 9. Generic framework has five public type parameters — reject when intentional

Context: each parameter is selected by users for storage, parser, scheduler, allocator, and policy; monomorphized performance is the product.

Expected: no generic-contagion finding merely from arity.

## 10. Application facade propagates five unnameable adapter types — report

Context: callers never vary the parameters, copy long aliases everywhere, and add `Send + Sync + 'static` only for an internal executor.

Expected: generic and runtime leakage with caller evidence.

## 11. Public error wraps backend error — report when callers match it

```rust
pub enum CheckoutError {
    Database(sqlx::Error),
}
```

Context: callers branch on SQL states to decide whether an item is out of stock.

Expected: backend error taxonomy has replaced domain outcomes. Map actionable cases and preserve the foreign cause as a source.

## 12. Exported macro uses caller-relative `crate::` — investigate, then report if broken downstream

```rust
#[macro_export]
macro_rules! make_id {
    ($v:expr) => { crate::Id::new($v) };
}
```

Expected: compile or reason from a downstream fixture. Recommend `$crate::Id` when the path is meant to reference the defining crate. Do not claim a leak if the macro intentionally references an item in the caller crate.
