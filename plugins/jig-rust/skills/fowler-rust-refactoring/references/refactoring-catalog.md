# Fowler-to-Rust Refactoring Catalog

## Contents

1. How to select a move
2. Basic transformations
3. Data and type transformations
4. Conditional and collection transformations
5. API and error transformations
6. Moving responsibilities and modules
7. Inheritance-oriented refactorings in Rust
8. Worked micro-examples

## 1. How to select a move

Use Fowler's catalog names to describe intent, then state the actual Rust mechanism. Do not claim that an object-oriented mechanism is automatically idiomatic in Rust.

A useful plan line looks like this:

> Apply **Introduce Parameter Object** by creating a private `DateRange` value type with a validating constructor; migrate one caller at a time; preserve the public wrapper until the next major release.

A weak plan line looks like this:

> Clean up the parameters and make the code more idiomatic.

Every selected move should identify:

- the smell and evidence;
- the Rust target shape;
- compatibility and ownership constraints;
- the smallest migration sequence;
- the check run after each step.

## 2. Basic transformations

| Fowler refactoring | Idiomatic Rust form | Guardrail |
|---|---|---|
| Extract Function | Private free function, inherent method, closure, or local helper | Extract a coherent concept; do not add clones or broad lifetimes solely to satisfy extraction. |
| Inline Function | Replace a trivial wrapper with its body | Keep wrappers that enforce type distinction, visibility, semver, tracing, or invariants. |
| Extract Variable | Named immutable local, pattern binding, or helper predicate | Prefer names that expose domain meaning; do not name every obvious expression. |
| Inline Variable | Use a transparent expression directly | Preserve a local when it explains meaning, controls borrow scope, or avoids recomputation. |
| Rename Variable / Field | Compiler- or rust-analyzer-guided rename | Check serde names, SQL columns, macros, FFI symbols, generated code, and public API compatibility. |
| Change Function Declaration | Rename, reorder, add/remove parameter, change receiver, borrow, or return type | Public changes may be semver-breaking. Use adapters or deprecation for staged migration. |
| Replace Temp with Query | Pure helper method/function computes the value | Do not duplicate expensive work; keep caches explicit and correctly invalidated. |
| Split Variable | Separate bindings for distinct meanings; use shadowing deliberately | Rust shadowing can clarify phased conversion, but avoid using one name for unrelated concepts. |
| Slide Statements | Move statements to reveal phases and narrow borrows | Preserve drop order, lock scope, temporary lifetime, and side-effect order. |
| Remove Dead Code | Delete unreachable/unused items, feature branches, adapters, or flags | Verify feature combinations, build scripts, proc macros, examples, and downstream/public use. |
| Substitute Algorithm | Replace an implementation with a clearer equivalent | Establish output, ordering, allocation, complexity, and floating-point constraints first. |

## 3. Data and type transformations

| Fowler refactoring | Idiomatic Rust form | Guardrail |
|---|---|---|
| Encapsulate Variable | Private field/module state plus focused functions or methods | Do not create getters/setters mechanically for transparent data. |
| Encapsulate Record | Struct with private fields and constructors/conversions | Public field privacy changes are breaking; preserve serde/wire shape separately if needed. |
| Encapsulate Collection | Expose `&[T]`, `&mut [T]`, iterators, or domain operations | Avoid `&Vec<T>`/`&String` when container identity is irrelevant; do not over-generalize blindly. |
| Replace Primitive with Object | Tuple-struct newtype, enum, validated struct, standard domain type | The wrapper should enforce units, validation, identity, formatting, or allowed states. |
| Introduce Parameter Object | Named input/config/request struct, often borrowed | Avoid a catch-all context object that hides dependencies. |
| Preserve Whole Object | Pass a cohesive owner or view rather than derived fragments | Do not increase coupling by passing a huge object when a stable small value is the real concept. |
| Change Reference to Value | Own/clone a small immutable value; derive `Copy` only when semantically correct | `Copy` is a semantic commitment, not merely an optimization hint. |
| Change Value to Reference | Borrow, use `Arc`, arena IDs, interning, or stable handles | Introduce identity/sharing only when required; avoid reflexive `Rc<RefCell<_>>`. |
| Replace Derived Variable with Query | Compute from source fields through a method | Keep materialized data when computation is expensive or persistence is the contract; document cache invalidation. |
| Change Reference to Value | Convert an identity object to a value-like newtype/struct | Ensure equality and cloning semantics match the domain. |
| Introduce Assertion | `assert!`, `debug_assert!`, type invariant, or compile-time assertion | Do not panic on ordinary invalid external input; use a result-producing validation path. |
| Remove Setting Method | Private field, constructor/builder, or state transition method | Keep mutation APIs where incremental construction or performance requires them. |
| Replace Type Code with Subclasses | Usually an enum with data-bearing variants; sometimes a trait | Prefer enums for closed sets and traits for open implementation sets. |
| Introduce Special Case | `Option`, explicit enum variant, null-object-like value, or default strategy | `Option` is preferable when absence is the meaning; a special object must have coherent behavior. |
| Replace Subclass with Fields | Collapse type hierarchy into enum fields or data | Relevant when migrating OO designs; preserve illegal-state prevention. |

## 4. Conditional and collection transformations

| Fowler refactoring | Idiomatic Rust form | Guardrail |
|---|---|---|
| Decompose Conditional | Named predicates and branch functions | Keep simple conditions inline; preserve evaluation and side-effect order. |
| Consolidate Conditional Expression | Combine equivalent branches or extract a predicate | Do not combine checks with different error messages or timing semantics. |
| Replace Nested Conditional with Guard Clauses | Early `return`, `?`, `let ... else`, `if let`, `matches!` | Preserve cleanup/drop order and make the normal path visible. |
| Replace Conditional with Polymorphism | First: enum inherent methods. Second: trait/static dispatch. Third: trait object if heterogeneity is required | An exhaustive `match` is not a smell by itself. Do not introduce dynamic dispatch merely to remove it. |
| Replace Control Flag with Break | `break`, labeled break, `continue`, `return`, iterator search | Preserve result values and cleanup. |
| Replace Loop with Pipeline | Iterator adapters and fallible combinators | Use only when clearer; check allocation, short-circuiting, borrowing, and ordering. |
| Split Loop | Separate loops or extracted passes for distinct responsibilities | A second pass may change complexity/cache behavior; measure when hot. |
| Replace Inline Code with Function Call | Use an existing standard/library/domain operation | Confirm semantics exactly match, including Unicode, path, time, overflow, and error behavior. |

### Useful Rust collection forms

- `iter().map(...).collect::<Vec<_>>()`
- `into_iter().filter_map(...)`
- `iter().find(...)`, `any(...)`, or `all(...)`
- `try_for_each(...)` for fallible side effects
- `try_fold(...)` for fallible accumulation
- `collect::<Result<Vec<_>, E>>()` for fallible transformation
- `partition(...)` or `unzip(...)` for splitting results

Do not force a pipeline that requires repeated `inspect`, hidden mutation, or deeply nested closures to remain understandable.

## 5. API and error transformations

| Fowler refactoring | Idiomatic Rust form | Guardrail |
|---|---|---|
| Replace Magic Literal | `const`, enum variant, newtype, standard type, or config value | Name stable domain meaning, not every literal. Consider units and protocol compatibility. |
| Parameterize Function | Generic value parameter, enum policy parameter, closure, or trait bound | Prefer the narrowest stable variation. Excess generics increase signature and compile-time cost. |
| Replace Parameter with Query | Read from a cohesive receiver/context | Do not hide dependencies in globals or oversized context objects. |
| Replace Query with Parameter | Inject data or behavior explicitly | Useful for testability and determinism; avoid plumbing incidental values through many layers. |
| Remove Flag Argument | Enum or separate explicit methods | Preserve a boolean when it expresses a fact and remains obvious. |
| Replace Constructor with Factory Function | Inherent `new`, `try_new`, `from_*`, `TryFrom`, builder, or module factory | Constructors are associated functions in Rust; use fallible construction for validation. |
| Replace Function with Command | Struct owning multi-step state with an `execute`/`run` method | Use only when the operation needs durable state, configuration, undo, scheduling, or instrumentation. |
| Replace Command with Function | Pure or focused function replacing a stateful command object | Keep an object when state or lifecycle is real. |
| Separate Query from Modifier | `&self` query plus `&mut self`/owned command, or return updated value | Interior mutability may make a query physically mutate a cache; document logical semantics. |
| Replace Error Code with Exception | Rust adaptation: typed `Result<T, E>`, not exceptions | Preserve recoverability and source/context. Avoid `Result<_, ()>` and panic-based normal control flow. |
| Replace Exception with Precheck | Validate before pure/domain work, or match the actual error | For I/O and concurrency, prechecks can create time-of-check/time-of-use races; handle the operation's result. |
| Return Modified Value | Consume `self` and return `Self`, or return a new/updated value | Use when it clarifies ownership; avoid expensive copying hidden behind a fluent API. |

### Public API migration pattern

For a breaking signature improvement, use an expand-migrate-contract sequence:

1. add the new API and implement it using existing behavior;
2. make the old API delegate to the new API;
3. migrate internal callers and tests;
4. deprecate the old API with a precise replacement;
5. remove it only under the project's compatibility policy.

## 6. Moving responsibilities and modules

| Fowler refactoring | Idiomatic Rust form | Guardrail |
|---|---|---|
| Move Function | Move a free function/method to the module or type owning its data/policy | A free function is fine when no natural receiver exists. Check visibility and circular dependencies. |
| Move Field | Move state to the struct that owns its invariant or lifecycle | Migration may affect serialization, layout, borrowing, and drop order. |
| Extract Class | Extract a cohesive struct, enum, module, or service | Split by invariant/reason to change, not line count. |
| Inline Class | Remove a wrapper type/module that adds no meaning | Retain newtypes and wrappers that protect type safety, visibility, semver, or unsafe boundaries. |
| Hide Delegate | Add a focused method at the owner boundary | Method chains are not inherently bad; hide only leaked internal graph knowledge. |
| Remove Middle Man | Let callers use the real dependency or inline forwarding | Preserve capability restriction, instrumentation, mocking, and compatibility boundaries. |
| Combine Functions into Class | Inherent `impl` or state-owning struct | Do this when functions share state/invariants, not merely a namespace. |
| Combine Functions into Transform | Pure conversion function producing an intermediate struct | Useful for parsing/normalization/reporting pipelines; avoid duplicate source-of-truth fields. |
| Split Phase | Separate parse → validate → domain → side effect phases with explicit types | One of the highest-value Rust moves because phase types can encode invariants. |
| Move Statements into Function | Centralize repeated setup/cleanup or invariant-preserving sequence | Preserve call-site-specific ordering and error context. |
| Move Statements to Callers | Keep variation at call sites and shrink an overgeneral helper | Do not duplicate stable policy across callers. |

## 7. Inheritance-oriented refactorings in Rust

Rust has traits and composition, not class inheritance. Translate the design intent rather than the mechanics.

| Fowler refactoring | Rust analogue |
|---|---|
| Extract Superclass | Extract a capability trait, shared helper, or composed value type. |
| Pull Up Method | Trait default method or shared free function when semantics are truly common. |
| Push Down Method | Split an over-broad trait; move behavior into only the relevant implementation/type. |
| Pull Up Field | Compose a shared value struct; traits cannot store fields. |
| Push Down Field | Move data into the enum variant or concrete struct that needs it. |
| Collapse Hierarchy | Remove unnecessary trait/wrapper layers and use a concrete type or enum. |
| Replace Subclass with Delegate | Prefer composition: store a strategy/service value and forward focused behavior. |
| Replace Superclass with Delegate | Replace inherited assumptions with an explicit composed capability. |
| Refused Bequest response | Split traits, remove irrelevant supertraits, or stop implementing the broad contract. |

Before extracting a trait, answer:

1. Is the implementation set open or closed?
2. Is the trait a semantic capability or only test plumbing?
3. Should dispatch be static or dynamic?
4. Must the trait be object-safe?
5. Can downstream crates implement it safely?
6. Would a private enum or generic closure be simpler?

## 8. Worked micro-examples

### A. Remove Flag Argument with an enum

Before:

```rust
fn render(report: &Report, compact: bool) -> String {
    if compact {
        render_compact(report)
    } else {
        render_full(report)
    }
}

let text = render(&report, true);
```

After:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RenderMode {
    Compact,
    Full,
}

fn render(report: &Report, mode: RenderMode) -> String {
    match mode {
        RenderMode::Compact => render_compact(report),
        RenderMode::Full => render_full(report),
    }
}

let text = render(&report, RenderMode::Compact);
```

Small-step plan:

1. introduce `RenderMode`;
2. add `render_with_mode` using existing branches;
3. migrate call sites;
4. rename it to `render` and remove the boolean wrapper if compatibility permits.

### B. Replace Primitive with Object using a validated newtype

Before:

```rust
fn send_retry(delay_ms: u64) {
    // repeated range checks elsewhere
}
```

After:

```rust
use std::time::Duration;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RetryDelay(Duration);

#[derive(Debug)]
struct InvalidRetryDelay;

impl TryFrom<Duration> for RetryDelay {
    type Error = InvalidRetryDelay;

    fn try_from(value: Duration) -> Result<Self, Self::Error> {
        if value.is_zero() || value > Duration::from_secs(30) {
            return Err(InvalidRetryDelay);
        }
        Ok(Self(value))
    }
}

fn send_retry(delay: RetryDelay) {
    // callers now supply a validated value
}
```

Do not add this type if the value has no invariant or domain distinction; `Duration` alone may be sufficient.

### C. Split Phase with validated types

Before:

```rust
fn import(input: &str, store: &mut Store) -> Result<usize, ImportError> {
    // parse, validate, normalize, and persist in one function
    todo!()
}
```

After target shape:

```rust
fn parse_input(input: &str) -> Result<RawImport, ParseError> {
    todo!()
}

fn validate(raw: RawImport) -> Result<ValidatedImport, ValidationError> {
    todo!()
}

fn persist(import: ValidatedImport, store: &mut Store) -> Result<usize, StoreError> {
    todo!()
}
```

The phase types make invalid transitions harder to express. The refactor must preserve error classification and transaction behavior.

### D. Repeated matches: move behavior into a closed enum

Before:

```rust
enum JobState {
    Queued,
    Running,
    Failed { retryable: bool },
    Done,
}

fn is_terminal(state: &JobState) -> bool {
    matches!(state, JobState::Failed { .. } | JobState::Done)
}

fn label(state: &JobState) -> &'static str {
    match state {
        JobState::Queued => "queued",
        JobState::Running => "running",
        JobState::Failed { .. } => "failed",
        JobState::Done => "done",
    }
}
```

After:

```rust
impl JobState {
    fn is_terminal(&self) -> bool {
        matches!(self, Self::Failed { .. } | Self::Done)
    }

    fn label(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Failed { .. } => "failed",
            Self::Done => "done",
        }
    }
}
```

This centralizes behavior without replacing an idiomatic closed enum with dynamic dispatch.

### E. Replace Loop with Pipeline—only when clearer

Before:

```rust
fn active_names(users: &[User]) -> Vec<String> {
    let mut names = Vec::new();
    for user in users {
        if user.is_active() {
            names.push(user.name().to_owned());
        }
    }
    names
}
```

After:

```rust
fn active_names(users: &[User]) -> Vec<String> {
    users
        .iter()
        .filter(|user| user.is_active())
        .map(|user| user.name().to_owned())
        .collect()
}
```

The pipeline states filter → map → collect directly. Keep the loop if later requirements introduce complex state or early exits that the pipeline obscures.

### F. Encapsulate Collection with slices

Before:

```rust
fn checksum(bytes: &Vec<u8>) -> u64 {
    bytes.iter().map(|byte| u64::from(*byte)).sum()
}
```

After:

```rust
fn checksum(bytes: &[u8]) -> u64 {
    bytes.iter().map(|byte| u64::from(*byte)).sum()
}
```

This accepts vectors, arrays, and slices without exposing ownership or capacity. For a public function, stage the signature change under the project's compatibility policy.

### G. Rust adaptation of Replace Error Code with Exception

Before:

```rust
fn load_config(path: &std::path::Path) -> Result<Config, ()> {
    todo!()
}
```

After target shape:

```rust
#[derive(Debug)]
enum LoadConfigError {
    Read(std::io::Error),
    Parse(ParseConfigError),
}

fn load_config(path: &std::path::Path) -> Result<Config, LoadConfigError> {
    todo!()
}
```

The point is not a specific error library. The point is preserving meaningful recoverable failure in the type system.
