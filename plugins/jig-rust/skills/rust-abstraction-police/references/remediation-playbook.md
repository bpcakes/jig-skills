# Rust Abstraction-Leak Remediation Playbook

Choose the smallest repair that restores the boundary's real promise. Do not create indirection merely to conceal syntax. Every recommendation should state the compatibility, allocation, dispatch, ownership, performance, and migration trade-offs that matter.

## 1. Encapsulate Representation and Invariants

### Use private fields and semantic methods

Replace unrestricted field access with constructors and operations that preserve invariants.

```rust
// Leaky: callers can create or mutate an invalid percentage.
pub struct Percentage(pub u8);

// Contained: the type owns validation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Percentage(u8);

impl Percentage {
    pub fn new(value: u8) -> Result<Self, PercentageOutOfRange> {
        (value <= 100)
            .then_some(Self(value))
            .ok_or(PercentageOutOfRange { value })
    }

    pub const fn get(self) -> u8 {
        self.0
    }
}
```

Do not remove all observation. Expose the smallest stable semantic operation callers need.

### Avoid broad `Deref` for invariant-bearing newtypes

`Deref` exports the inner type's method set and often allows representation-specific code to spread. Prefer named methods, iterators, or narrow trait implementations.

```rust
pub struct NonEmpty<T>(Vec<T>);

impl<T> NonEmpty<T> {
    pub fn first(&self) -> &T {
        &self.0[0]
    }

    pub fn iter(&self) -> impl ExactSizeIterator<Item = &T> {
        self.0.iter()
    }
}
```

Keep `Deref` when transparent smart-pointer behavior is the explicit contract.

### Own the type when trait coherence matters

A newtype lets the boundary implement local traits, enforce construction, and avoid orphan-rule dependence on a foreign representation.

## 2. Separate Domain Values from Transport and Storage DTOs

Use explicit conversion at adapter boundaries when the domain model and external schema need independent evolution.

```rust
// Domain-owned value.
pub struct User {
    id: UserId,
    display_name: DisplayName,
}

// Adapter-owned persistence shape.
#[derive(sqlx::FromRow)]
struct UserRow {
    id: uuid::Uuid,
    display_name: String,
}

impl TryFrom<UserRow> for User {
    type Error = UserMappingError;

    fn try_from(row: UserRow) -> Result<Self, Self::Error> {
        Ok(Self {
            id: UserId::from_uuid(row.id),
            display_name: DisplayName::new(row.display_name)?,
        })
    }
}
```

Do not split types reflexively. A dedicated schema crate may intentionally make one representation canonical.

## 3. Map Foreign Errors into Stable Semantic Errors

Expose distinctions callers can act on. Preserve the concrete cause through `source()` without making it the match surface.

```rust
#[derive(Debug, thiserror::Error)]
pub enum LoadUserError {
    #[error("user was not found")]
    NotFound,
    #[error("user store is unavailable")]
    Unavailable {
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
}
```

The exact design depends on the library contract:

- libraries usually need typed, stable errors;
- applications may reasonably use `anyhow` internally;
- opaque sources reduce coupling but also reduce structured diagnostics;
- mapping must not erase distinctions consumers genuinely need.

Avoid adding one public variant per backend error. That merely renames the leak.

## 4. Keep Transactions, Guards, and Resource Lifetimes Inside the Boundary

### Prefer semantic operations over raw resource return

```rust
// Leaky: application code now depends on SQLx and PostgreSQL transactions.
async fn begin(&self) -> Result<sqlx::Transaction<'_, sqlx::Postgres>, StoreError>;

// More contained: the repository owns transaction mechanics.
async fn transfer(&self, command: Transfer) -> Result<TransferReceipt, TransferError>;
```

### Use a boundary-owned capability when composition is required

A unit-of-work or transaction capability can be appropriate when several operations must be composed atomically. Keep backend types private.

```rust
pub trait UnitOfWork {
    type Users: UserRepository;
    type Ledger: LedgerRepository;

    fn users(&mut self) -> &mut Self::Users;
    fn ledger(&mut self) -> &mut Self::Ledger;
    async fn commit(self) -> Result<(), CommitError>;
}
```

This still has trade-offs: object safety, async trait design, generic propagation, and borrow complexity. Use it only when cross-operation composition is a real caller requirement.

### Consider closure-based access carefully

A `with_resource` closure can prevent guards from escaping, but higher-ranked trait bounds, async closures, cancellation, and error conversion can make the API harder than the original leak. Do not recommend it without sketching a workable signature.

## 5. Contain Runtime and Concurrency Choices

Expose semantic cancellation, completion, backpressure, and shutdown behavior instead of a specific executor's handles when runtime neutrality is part of the promise.

Possible repairs:

- return a boundary-owned task handle with only `cancel`, `join`, or `status` operations;
- use runtime-neutral traits only when the crate genuinely supports more than one runtime;
- keep channels private and expose `send`, `recv`, subscription, or stream semantics;
- return owned snapshots instead of lock guards;
- move lock acquisition inside methods so callers cannot accidentally hold guards across unrelated work or `.await`.

Do not erase a runtime dependency in a crate that is explicitly a runtime adapter. Name the commitment honestly instead.

## 6. Contain Generic and Lifetime Contagion

### Move composition to construction time

If callers never vary internal policies per use, select them in a builder or private constructor and expose a stable facade.

### Use associated types when the implementor owns the choice

A generic parameter says the caller chooses or propagates the type. An associated type says the implementation chooses it. That distinction can reduce generic spread, but may affect object safety and type inference.

### Use `impl Trait` to hide a concrete return type

This is useful for iterators, futures, and streams when callers need capabilities rather than representation. Check lifetime capture and auto-trait requirements; hidden types still have observable bounds.

### Use trait objects only when runtime substitution is required

`Box<dyn Trait>` or `Arc<dyn Trait>` can contain concrete types, but adds dynamic dispatch, often allocation, object-safety constraints, and more complex lifetime or `Send` requirements. Do not present it as the default cure for generics.

### Return owned values when borrowing is accidental

Owned results can decouple callers from storage lifetimes at the cost of allocation or cloning. State that cost and check whether zero-copy behavior is a deliberate contract.

## 7. Stabilize Trait Extension Boundaries

### Seal traits when downstream implementation is not supported

```rust
mod sealed {
    pub trait Sealed {}
}

pub trait Format: sealed::Sealed {
    fn encode(&self, out: &mut Vec<u8>);
}
```

Sealing prevents downstream implementations and preserves room to evolve required methods. It is wrong when third-party implementation is a genuine extension point.

### Use default methods or extension traits for additive evolution

A separate extension trait can add convenience without expanding the core implementor obligation.

### Use `#[non_exhaustive]` deliberately

It can preserve room to add enum variants or struct fields, but shifts callers toward wildcard matches and may reduce exhaustiveness guarantees. Apply it to an intentionally evolving public taxonomy, not as a blanket semver charm.

## 8. Decouple Serialization and Schema Commitments

Possible repairs:

- separate DTOs from domain types;
- use explicit `serde(rename = ...)`, tagging, defaults, and version fields when the schema is stable;
- implement `Serialize` or `Deserialize` manually when internal layout must evolve independently;
- put codecs and migrations in adapter modules;
- test round trips and compatibility fixtures at the schema boundary;
- avoid `serde(flatten)` when it makes internal composition part of the external contract unintentionally.

If the Rust type is intentionally the canonical schema, document that fact instead of pretending the representation is hidden.

## 9. Repair Exported Macros

- use `$crate` for paths into the defining crate;
- re-export required support dependencies through a documented or `#[doc(hidden)]` path only when necessary;
- keep support items stable and test the macro from a downstream fixture crate;
- avoid repeated evaluation of expressions unless documented;
- document ownership, borrowing, and hygiene requirements;
- prefer a normal function when macro expansion is not required.

`#[doc(hidden)] pub` remains externally reachable and can become semver surface. Hiding documentation does not make an API private.

## 10. Internalize Unsafe and Raw Resource Rules

- provide safe constructors that validate pointers, lengths, alignment, encoding, ownership, and lifetime;
- wrap raw handles in RAII types that own close/free behavior;
- make raw escape hatches narrow, explicit, and named after ownership transfer (`as_raw_*` versus `into_raw_*`);
- document every irreducible unsafe precondition;
- keep `unsafe` at the lowest layer that has enough information to verify the invariant;
- test that safe methods cannot create states that make later safe operations unsound.

Do not hide raw access when low-level interoperability is the API's purpose. Separate the safe facade from the raw module instead.

## 11. Make Feature and Platform Boundaries Honest

- prefer additive features over mutually exclusive implementation selectors;
- avoid changing the meaning or concrete identity of the same public type across feature sets;
- keep target branching inside platform adapters;
- expose a stable capability surface and fail construction when a capability is unavailable, when appropriate;
- test meaningful feature combinations and target-specific public API shape;
- document when a feature intentionally adds public types or trait impls.

A feature is part of the API contract. Moving a leak behind `cfg` does not contain it when consumers must mirror the same `cfg` logic.

## 12. Repair Behavioral Leakage with Explicit Semantics

- document ordering, blocking, cancellation, consistency, retry, caching, and backpressure guarantees that are intentionally stable;
- expose policy objects or options only when callers should control the policy;
- add explicit `flush`, `invalidate`, `shutdown`, or transactional methods when those are real semantic operations;
- centralize retries and normalization when every caller repeats the same rule;
- add observability rather than forcing callers to infer hidden state;
- change misleading names when an operation performs I/O, blocks, or has non-obvious cost.

Sometimes the correct repair is documentation. An undocumented but useful guarantee is still a leak because callers must discover it from implementation or tests.

## Migration Patterns

For public crates, avoid presenting a theoretically clean end state without a migration path. Consider:

1. Add the contained API alongside the old one.
2. Implement the old API through the new boundary where possible.
3. Deprecate escape hatches with a concrete replacement.
4. Provide conversions at adapter edges.
5. Add compile tests or downstream fixtures for macro and API compatibility.
6. Remove the old surface only in the next permitted breaking release.

For internal crates, migration can be narrower but still identify affected call sites and feature combinations.

## Recommendation Quality Check

A good remediation answers all of these:

- Which detail moves behind which boundary?
- Which caller operation replaces the leaked access?
- Which invariants become enforceable?
- What performance, allocation, dispatch, lifetime, or ergonomics cost is introduced?
- How do existing callers migrate?
- What remains intentionally exposed and why?
