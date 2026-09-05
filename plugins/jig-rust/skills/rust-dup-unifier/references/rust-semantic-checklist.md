# Rust Semantic Checklist

Use this checklist before recommending that similar Rust abstractions be unified. Shape similarity is only discovery evidence.

## Type Identity and Public API

- Is either type public, re-exported, mentioned in public signatures, or constructed with struct/enum syntax downstream?
- Would a merge change import paths, inference, pattern matching, exhaustiveness, or turbofish requirements?
- Are `#[non_exhaustive]`, sealed traits, private fields, or constructor functions intentionally controlling evolution?
- Would a type alias preserve enough compatibility, or is distinct nominal identity required?
- Are there downstream trait implementations that would become impossible or conflicting after unification?

## Ownership, Borrowing, and Lifetimes

- Does one abstraction own data while another borrows it?
- Are lifetime relationships part of the safety or performance contract rather than incidental syntax?
- Would unification introduce unnecessary allocation, cloning, reference counting, or lifetime propagation?
- Are `Cow`, view types, arenas, interning, or zero-copy parsing better shared-core targets than a direct merge?

## Traits, Coherence, and Dispatch

- Compare inherent methods, trait implementations, associated types, generic bounds, and where-clauses.
- Check orphan/coherence constraints and overlapping blanket impl risk.
- Check object safety and whether callers rely on `dyn Trait`.
- Check auto traits: `Send`, `Sync`, `Unpin`, `UnwindSafe`, and `RefUnwindSafe` can change through fields and generic parameters.
- Check negative impls, marker traits, specialization assumptions, and sealed extension points.
- Distinguish a shared behavior contract from a convenience trait that merely hides incompatible types.

## Layout, FFI, and Unsafe Code

- Treat `#[repr(C)]`, `#[repr(transparent)]`, integer reprs, packed layout, alignment, discriminants, and field order as hard evidence.
- Check FFI symbols, bindgen/cbindgen output, transmute assumptions, pointer provenance, pinning, and self-referential structures.
- Review `unsafe impl` blocks and safety comments. A merge must not silently widen the set of values covered by an unsafe promise.
- Check drop order, `Drop` implementations, destructor side effects, and ownership transfer.

## Serialization and Protocol Contracts

- Compare `serde`, `borsh`, `prost`, `rkyv`, custom codec, and schema attributes.
- Check rename rules, defaults, flattening, tagging, skip conditions, unknown fields, enum representation, and versioning.
- Wire, storage, and domain models may deliberately share fields while requiring separate compatibility contracts.
- Do not merge versioned protocol types by taking the union of variants unless the protocol model explicitly supports that representation.

## Async, Concurrency, and Cancellation

- Sync/async pairs may share parsing, validation, state transitions, or request construction while retaining separate I/O surfaces.
- Compare cancellation behavior, backpressure, wakeups, pinning, lock scope, blocking behavior, and executor assumptions.
- Check `Send` requirements across await points and whether one implementation intentionally supports `!Send` futures.
- A generic I/O trait can increase compile time, code size, or complexity; a private shared state machine may be safer.

## Features, Platforms, and Build Modes

- Compare `cfg`, target architecture, OS, feature, test, docs, and `no_std` conditions.
- Confirm all supported feature combinations. Similar definitions may be mutually exclusive and intentionally optimized for different environments.
- Check MSRV before proposing language or library features.
- Generated and platform binding code may need a shared schema or generator, not a shared Rust type.

## Behavior and Error Semantics

- Compare validation order, defaults, normalization, panic behavior, fallibility, retry policy, logging, metrics, and error source chains.
- Error enums with similar variants may belong to different abstraction levels; merging can leak implementation details or erase recovery semantics.
- Check equality, ordering, hashing, formatting, and conversion behavior.
- Compare partial-state and failure atomicity: two builders with the same fields may commit differently.

## Performance and Compilation

- Check allocation, copying, monomorphization, dynamic dispatch, inlining, cache locality, binary size, and compile-time cost.
- A generic unification can duplicate machine code; a trait-object unification can add indirection.
- Benchmark-sensitive or hot-path code needs evidence before consolidation.

## Common False Positives

- Read model versus write model.
- Wire DTO versus validated domain type.
- Public API type versus internal optimized representation.
- Owned versus borrowed/view type.
- Sync versus async facade with a shared private core.
- Platform-specific or feature-exclusive implementation.
- Test fixture mirroring a production type intentionally.
- Generated bindings or protocol-version snapshots.
- Error types at different recovery boundaries.
- Builders that share field names but enforce different state transitions.
- Newtypes created specifically to prevent unit, privilege, tenant, or capability confusion.

## Strong Signals of Accidental Drift

- Repeated bug fixes landing in one sibling but not another.
- Near-identical tests with different expected edge behavior and no documented rationale.
- Bidirectional conversion code that is effectively identity mapping.
- Repeated adapters required solely because names or wrapper layers differ.
- Comments referring to another type as the source of truth.
- One abstraction gaining fields or variants that callers of the sibling also need.
- Copy-pasted implementations with isolated naming substitutions and one or two inconsistent branches.
