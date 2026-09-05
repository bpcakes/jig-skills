# Fowler's Refactoring Principles, Adapted for Rust

## Contents

1. Scope and attribution
2. Core principles
3. What behavior preservation means in Rust
4. Rust-specific decision rules
5. Refactoring timing and prioritization
6. Safety protocol
7. Sources

## 1. Scope and attribution

This reference synthesizes Martin Fowler's public refactoring material and adapts it to modern Rust. The Rust mappings are an interpretation for this skill; they are not Fowler-authored Rust guidance.

Target the repository's declared Rust edition and minimum supported Rust version (MSRV). Rust 2024 idioms are the modern default when the project permits them, but a refactor must not silently raise the MSRV, alter feature compatibility, or change a public API contract.

## 2. Core principles

### Preserve observable behavior

Refactoring changes internal structure without intentionally changing external behavior. In Rust, “observable behavior” includes more than returned values:

- public API signatures and trait implementations;
- error variants, panic behavior, and error text when consumers depend on them;
- ordering, allocation, latency, and blocking characteristics when contractually relevant;
- feature-gated behavior and `no_std` compatibility;
- serialization formats, ABI/FFI layout, and unsafe invariants;
- synchronization, cancellation, and wake-up behavior in concurrent or async code.

A cleanup that changes one of these is not a pure refactor. It may still be valuable, but it must be planned and reviewed as a behavior or compatibility change.

### Move in tiny, verifiable steps

Each step should be small enough that a failure has one likely cause. Keep the crate compiling and the relevant tests green after each transformation. Prefer a sequence such as rename → extract → move → tighten visibility over a single rewrite.

For Rust, compilation is a powerful structural oracle, but it is not a behavior oracle. The borrow checker can prove ownership and aliasing properties; it cannot prove business behavior, protocol compatibility, error semantics, or performance equivalence.

### Wear one hat at a time

Separate behavior-preserving restructuring from feature or bug behavior changes. A practical Rust sequence is:

1. establish characterization tests or other behavioral checks;
2. perform the structural refactor while behavior stays fixed;
3. make the requested functional change;
4. optionally refactor the new shape again.

Mixing a public API change, a data-model change, and a cleanup in one patch destroys causal clarity and makes review harder.

### Treat smells as hypotheses, not verdicts

A smell is a fast signal of a possible deeper design problem. It is not proof that the code is wrong. Long functions, data-only structs, exhaustive matches, and wrapper types can all be correct Rust.

A valid finding needs all three:

1. concrete evidence in the code or change history;
2. a plausible maintenance cost or violated invariant;
3. a safer or clearer target design that fits Rust's ownership and type model.

Do not refactor solely to satisfy a metric, personal taste, or an automated warning.

### Refactor in service of a change

The strongest refactoring target is code that is actively blocking a feature, bug fix, safety improvement, or comprehension task. Preparatory refactoring makes the next change easy. Opportunistic refactoring leaves touched code slightly better. Large speculative cleanups without a change driver deserve skepticism.

### Let tests and feedback control risk

Before structural changes, identify the cheapest trustworthy feedback loop. Depending on the crate, this may include unit tests, integration tests, doctests, snapshot/golden tests, property tests, compile-fail tests, fuzz targets, benchmarks, Miri, loom-style concurrency tests, or external compatibility suites.

When coverage is weak, add characterization tests around the behavior that must remain stable. Avoid writing tests that merely lock in private implementation details.

## 3. What behavior preservation means in Rust

### Ownership and borrowing

A refactor must preserve intentional ownership costs and aliasing boundaries. Do not make extraction “work” by adding broad `clone()` calls, `Rc<RefCell<_>>`, `Arc<Mutex<_>>`, or `'static` bounds without proving the tradeoff is acceptable.

Use signatures to state the actual contract:

- borrow when the function only observes or temporarily mutates caller-owned data;
- take ownership when the function must retain, transform, or consume the value;
- return modified values when that makes data flow clearer than multiple mutable out-parameters;
- prefer slices and string slices over borrowing concrete containers when container identity is irrelevant.

### Enums, matches, and traits

Fowler's object-oriented catalog often replaces conditionals with polymorphism. Porting that literally to Rust is usually a mistake.

Use an enum plus exhaustive `match` when:

- the variant set is closed and known in the crate;
- variants carry different data;
- exhaustiveness is useful during evolution;
- behavior naturally belongs in an inherent method on the enum.

Use a trait when:

- the implementation set is intentionally open;
- downstream crates should provide behavior;
- the abstraction is a stable semantic capability rather than a way to avoid a match;
- static dispatch, trait objects, object safety, and code-size tradeoffs have been considered.

Before introducing a trait, try moving repeated matches into methods on the enum. Before replacing a trait with an enum, verify that downstream extension is not part of the contract.

### Data-only structs

A Rust struct that only stores data is not automatically Fowler's “Data Class” smell. Transparent records, DTOs, configuration, serialization models, protocol messages, and ECS components are normal.

It becomes a stronger candidate when:

- validation is repeated at many call sites;
- fields can represent invalid combinations;
- behavior that protects invariants is scattered elsewhere;
- callers navigate or mutate internals that should be private;
- the same field group travels together through many APIs.

The idiomatic response may be a newtype, enum, validated constructor, private fields, a domain struct, or a conversion from an external DTO into an internal validated model.

### Errors and panics

Fowler's “Replace Error Code with Exception” does not map literally because Rust uses explicit sum types rather than exceptions for recoverable failures.

The Rust adaptation is generally:

- use `Result<T, E>` for recoverable failure;
- use `Option<T>` for ordinary absence when no error detail is needed;
- give library-facing errors meaningful types and preserve sources where useful;
- use `?` to propagate while retaining context at appropriate boundaries;
- reserve panics for bugs, impossible states proven by invariants, or documented precondition violations.

Do not replace an error-returning API with `unwrap`, `expect`, or panic in the name of simplification.

### Mutation and shared state

Rust defaults to immutable bindings and restricts aliasing of mutable references. Use those constraints to localize state changes rather than fighting them.

Candidates include:

- wide `&mut` scopes;
- multiple mutable parameters coordinated by one function;
- mutable globals;
- pervasive interior mutability;
- locks held across expensive work or `.await` points;
- caches with unclear invalidation.

The target is not “zero mutation.” The target is explicit ownership, narrow mutation, clear synchronization, and invariants that can be explained and tested.

### Unsafe, FFI, macros, and async

Refactors in these areas need extra proof:

- **Unsafe:** preserve safety preconditions, pointer provenance assumptions, layout, drop order, and aliasing. Keep or improve `SAFETY:` documentation. Run Miri or specialized tests when available.
- **FFI:** preserve `repr`, symbol names, ABI, ownership transfer, unwinding boundaries, and lifetime conventions.
- **Macros:** inspect generated code or expansion-sensitive tests. A visually small macro edit can change many call sites.
- **Async:** preserve cancellation safety, `Send` bounds, lock scope, task spawning, wake behavior, pinning assumptions, and ordering.

## 4. Rust-specific decision rules

Apply these rules before recommending a Fowler move:

1. **Respect edition, MSRV, features, and `no_std`.** A modern idiom unavailable to the project is not an improvement.
2. **Prefer domain types over primitive bundles.** Newtypes and enums should enforce meaning or invariants, not merely add wrapping noise.
3. **Prefer private-by-default module design.** Widen visibility only for a real caller; narrow it when change history shows accidental coupling.
4. **Do not abstract before the variation is understood.** A trait, generic parameter, macro, or builder has a maintenance cost.
5. **Do not force iterator pipelines.** Use them when they clarify a transformation. Keep a loop when control flow, state mutation, or early exits are clearer imperatively.
6. **Do not optimize clones by reflex.** Some clones are cheap and clarify ownership; some hide a poor boundary. Measure or inspect the data path.
7. **Do not use interior mutability as extraction glue.** It should encode a real sharing requirement.
8. **Treat public refactors as semver work.** Renames, visibility changes, field privacy, trait changes, generic changes, and error changes may break downstream users.
9. **Preserve performance contracts explicitly.** Iterator rewrites, boxing, dynamic dispatch, allocation changes, and enum layout changes can matter in systems code.
10. **Favor compiler-guided mechanical steps.** `rust-analyzer` rename, `cargo fix`, Clippy suggestions, and compiler errors are useful for narrow transformations, not architectural judgment.

## 5. Refactoring timing and prioritization

Prefer findings with current change pressure and high leverage:

1. a design obstacle directly blocking the requested change;
2. duplicated or scattered logic that creates correctness risk;
3. invalid states or unsafe invariants that the type system can encode;
4. module/API boundaries causing broad change propagation;
5. comprehension friction in a frequently changed hotspot;
6. local idiom improvements with low risk;
7. aesthetic or speculative abstraction changes last.

Use repository history when available. A plain long file is weak evidence; a long file that changes for unrelated reasons and repeatedly co-changes with many modules is stronger evidence of Divergent Change or Shotgun Surgery.

## 6. Safety protocol

For each proposed refactoring:

1. State the behavior and compatibility constraints.
2. Identify or add the smallest trustworthy characterization test.
3. Name the Fowler move and the Rust form it will take.
4. Break the move into independently compiling steps.
5. Run the narrowest fast check after each step, then the broader suite.
6. Keep commits or patches small enough to revert.
7. Separate cleanup from new behavior.
8. Re-run formatting, compiler checks, Clippy, tests, doctests, and specialized checks relevant to unsafe, async, or performance.
9. Remove transitional adapters, deprecated paths, feature flags, or duplicated implementations once migration is complete.

## 7. Sources

Research snapshot: 2026-08-05.

- Martin Fowler, **Refactoring** overview and definition: https://refactoring.com/
- Martin Fowler, **Catalog of Refactorings**: https://refactoring.com/catalog/
- Martin Fowler, **Code Smell**: https://martinfowler.com/bliki/CodeSmell.html
- Martin Fowler, **Opportunistic Refactoring**: https://martinfowler.com/bliki/OpportunisticRefactoring.html
- Martin Fowler, **Workflows of Refactoring** and the “two hats” model: https://martinfowler.com/articles/workflowsOfRefactoring/
- Martin Fowler, **An example of preparatory refactoring**: https://martinfowler.com/articles/preparatory-refactoring-example.html
- Martin Fowler, **Refactoring with Loops and Collection Pipelines**: https://martinfowler.com/articles/refactoring-pipelines.html
- The Rust Programming Language, current book: https://doc.rust-lang.org/book/
- Rust Book, enums and pattern matching: https://doc.rust-lang.org/book/ch06-00-enums.html
- Rust Book, traits: https://doc.rust-lang.org/book/ch10-02-traits.html
- Rust Book, ownership and borrowing: https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html
- Rust Book, error handling: https://doc.rust-lang.org/book/ch09-00-error-handling.html
- Rust Book, iterators and closures: https://doc.rust-lang.org/book/ch13-00-functional-features.html
- Rust Book, advanced types and the newtype pattern: https://doc.rust-lang.org/book/ch20-03-advanced-types.html
- Rust Book, unsafe Rust: https://doc.rust-lang.org/book/ch20-01-unsafe-rust.html
- Cargo `check`, `test`, `clippy`, `fmt`, and `fix` command documentation: https://doc.rust-lang.org/cargo/commands/
- Clippy lint index: https://rust-lang.github.io/rust-clippy/master/
- Rust API Guidelines checklist: https://rust-lang.github.io/api-guidelines/checklist.html
