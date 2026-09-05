# Rust Leaky-Abstraction Taxonomy

Use this catalog to generate review hypotheses. A signal becomes a finding only after the boundary, intrusion, consequence, evidence, and intent checks in `SKILL.md` succeed.

## AP-01 — Representation Leakage

The boundary exposes the data structure, layout, mutability model, or storage shape it appears intended to own.

### Rust signals

- public fields or public tuple fields on a type that is supposed to enforce invariants;
- `pub type` aliases to `Vec`, `HashMap`, `BTreeMap`, `IndexMap`, tuples, arrays, or backend-owned row/message types;
- `Deref<Target = Inner>`, broad `AsRef<Inner>`, `Borrow<Inner>`, `into_inner`, `as_inner`, or unrestricted `get_mut` on a domain wrapper;
- public enum variants or union fields that mirror private state, backend representation, or ABI layout;
- concrete iterator types such as collection-specific `Iter`, `Drain`, or `IntoIter` in signatures;
- `#[repr(C)]`, `#[repr(transparent)]`, `#[repr(packed)]`, or layout-sensitive transmute assumptions outside an explicit ABI boundary;
- callers depending on field order, map ordering, vector indices, allocation behavior, or exact enum variants.

### Proof questions

- What invariant or representation choice does the type's name or documentation imply it owns?
- Can callers construct invalid values, mutate around validation, or depend on a container-specific operation?
- Would changing the internal collection, field layout, or state representation require consumer edits despite preserving the advertised semantics?

### Common false positives

- the collection semantics are deliberately part of the contract;
- the newtype is explicitly transparent and exists only for type distinction;
- the type is a plain schema object whose public representation is the product.

## AP-02 — Backend and Dependency Leakage

A backend-neutral boundary exposes a concrete library, driver, SDK, framework, or infrastructure type.

### Rust signals

- domain or application APIs mention `sqlx`, Diesel, SeaORM, Redis, Kafka, cloud SDK, HTTP framework, RPC, database, or filesystem adapter types;
- repository or service traits return concrete pools, connections, transactions, rows, requests, responses, clients, or SDK errors;
- core crates import infrastructure crates solely to call an allegedly neutral port;
- `pub use` re-exports an implementation crate through a facade;
- public trait bounds require implementation-specific traits not meaningful to callers;
- feature flags select concrete backends while preserving a supposedly stable facade, but the exposed types change with the feature.

### Proof questions

- Is the boundary named and documented as backend-neutral?
- Does the caller need the concrete dependency for a task the boundary should own?
- Could a second implementation satisfy the same semantics without reproducing the leaked dependency type?
- Does the concrete dependency appear in downstream manifests only because of this API?

### Common false positives

- the type is explicitly an adapter such as `SqlxOrderStore` or `TokioTaskSpawner`;
- interoperability with that ecosystem is the documented purpose;
- the dependency type carries semantics intentionally promised by the API.

## AP-03 — Ownership, Lifetime, and Allocation Leakage

Internal borrowing, sharing, pinning, or allocation choices spread into callers.

### Rust signals

- public lifetimes exist solely because the implementation returns references into internal storage;
- callers must thread lifetimes through otherwise owned domain operations;
- public APIs force `Arc`, `Rc`, `Box`, `Pin`, `Cow`, or arena handles because of hidden implementation choices;
- consumers clone, box, pin, or leak values only to satisfy the boundary;
- guards or borrowed views prevent callers from performing unrelated work because an internal borrow remains active;
- return-position `impl Trait` or async methods accidentally expose restrictive lifetime capture or auto-trait behavior;
- a public type's hidden fields determine `Send`, `Sync`, `Unpin`, or unwind-safety behavior that downstream code relies on unexpectedly.

### Proof questions

- Is the ownership policy semantically meaningful to the caller, or merely how the implementation stores data?
- Could the abstraction return an owned value, boundary-owned view, or operation result instead?
- Does changing internal storage or sharing force signature changes or widespread clone/boxing changes?
- Are auto-trait or lifetime commitments documented and intentional?

### Common false positives

- zero-copy borrowing is an explicit performance and lifetime contract;
- shared ownership is the core semantic model;
- pinning or allocation is required by a public protocol the API intentionally implements.

## AP-04 — Concurrency and Runtime Leakage

The abstraction exposes its lock, task, channel, executor, cancellation, or scheduling mechanism.

### Rust signals

- returning `MutexGuard`, `RwLockReadGuard`, `RwLockWriteGuard`, semaphore permits, or lock-specific mapped guards;
- exposing `tokio::task::JoinHandle`, Tokio channels, timers, runtime handles, or executor-specific traits from a runtime-neutral service;
- public APIs require callers to lock internal state, select memory orderings, or manage poisoning;
- caller code must know that a method holds a lock across `.await`, blocks a thread, spawns work, retries, or detaches tasks;
- the boundary returns a raw transaction/permit whose cleanup or commit semantics callers must manage;
- feature combinations alter `Send` or runtime requirements.

### Proof questions

- Does the caller need to coordinate the mechanism, or only request a semantic operation?
- Could lock strategy, task model, or runtime change without changing callers?
- Does the exposure create deadlock, cancellation, resource-lifetime, or testability risk?
- Are blocking and cancellation semantics explicit enough to be a deliberate contract?

### Common false positives

- a synchronization primitive library intentionally exposes guards;
- a runtime adapter is explicitly Tokio-specific;
- the caller must compose transactions or permits as a first-class semantic capability.

## AP-05 — Error Leakage

The boundary's error contract exposes backend causes, unstable implementation variants, or hidden downcasting requirements.

### Rust signals

- public errors contain `sqlx::Error`, `reqwest::Error`, SDK errors, parser errors, or other foreign types as matchable variants;
- `#[error(transparent)]` or `#[from]` forwards a dependency's error directly through a neutral boundary;
- callers match on backend-specific variants to decide domain behavior;
- a library returns `anyhow::Error` or `Box<dyn Error>` while callers downcast to recover hidden variants;
- private implementation changes add or remove public error variants;
- raw status codes, SQL states, OS errors, or protocol details escape where domain outcomes would suffice.

### Proof questions

- Which error distinctions are semantically actionable for callers?
- Does changing the backend change the public error type or caller matches?
- Are foreign errors preserved as sources without becoming the stable match surface?
- Is opaque error erasure forcing downcasting and therefore leaking the supposedly hidden cause anyway?

### Common false positives

- the API is an adapter whose purpose is to expose the underlying library faithfully;
- the foreign error is itself the documented interoperability contract;
- no stable semantic mapping exists and the boundary explicitly promises pass-through behavior.

## AP-06 — Serialization, Protocol, and Persistence Leakage

Internal domain representation becomes the wire, file, database, cache, or RPC schema by accident.

### Rust signals

- public domain types directly derive `Serialize` and `Deserialize` and are reused for API, storage, cache, and internal logic;
- `#[serde(flatten)]`, default variant names, field names, or enum tagging expose internal composition;
- database row structs, ORM entities, protobuf messages, GraphQL objects, or HTTP framework extractors appear in domain APIs;
- callers understand internal field names, migration versions, table columns, HTTP status codes, headers, or RPC metadata;
- a refactor of internal fields would silently change persisted or transmitted data;
- versioning logic is spread through domain call sites rather than owned by a codec or adapter.

### Proof questions

- Is the Rust type intentionally the canonical external schema?
- Can domain evolution and schema evolution proceed independently?
- Is compatibility policy explicit, tested, and versioned?
- Do transport or storage concerns appear in otherwise semantic operations?

### Common false positives

- the crate defines a schema type and intentionally makes it canonical;
- serde is used only for ephemeral test fixtures;
- the representation is a documented stable format with explicit compatibility guarantees.

## AP-07 — Invariant and State-Machine Leakage

Callers must preserve internal validity rules or operation ordering that the abstraction could enforce.

### Rust signals

- public fields or mutable inner access bypass constructor validation;
- methods require undocumented call order such as `init`, `configure`, `start`, `stop`, `flush`, and `close`;
- invalid states are representable through booleans, `Option` combinations, or public enum variants;
- callers repeat validation, normalization, deduplication, cleanup, retry, or commit logic;
- public unsafe methods require callers to uphold invariants created by private representation;
- typestate exists internally but is erased at the boundary, forcing runtime checks in consumers;
- constructors return a partially initialized object that must be completed manually.

### Proof questions

- Can the type make invalid states unrepresentable or centralize the transition?
- Is the caller genuinely the owner of the policy, or merely compensating for missing operations?
- What happens when one caller forgets the hidden rule?
- Would a representation change alter the required call sequence?

### Common false positives

- the workflow is inherently user-directed and cannot be encoded without unreasonable state explosion;
- an unsafe systems API deliberately delegates an invariant at an explicit low-level boundary;
- validation belongs to a higher policy layer, not this type.

## AP-08 — Trait, Generic, and Extension Leakage

Implementation variability, coherence constraints, or extension obligations escape in the wrong direction.

### Rust signals

- public types carry many generic parameters that callers never choose meaningfully;
- backend/executor/cache/serializer types propagate through constructors, fields, aliases, and return types;
- trait methods expose concrete implementor types or implementation-only associated types;
- an unsealed public trait invites downstream impls even though future methods or invariants are not stable;
- blanket impls expose accidental API commitments or create coherence conflicts;
- foreign types cross the boundary, preventing the crate from owning trait implementations under Rust's orphan rules;
- callers add bounds such as `Send + Sync + 'static` only because of an internal executor or storage design;
- hidden implementation changes alter observable auto traits.

### Proof questions

- Which type parameters are true caller-controlled policy, and which are composition plumbing?
- Is downstream implementation a supported extension point?
- Does the boundary own the type needed to express its invariants and trait implementations?
- Could associated types, private adapters, erasure, or construction-time selection contain the variability without unacceptable cost?

### Common false positives

- the API is intentionally a zero-cost generic framework;
- downstream implementations are a core product requirement;
- explicit bounds communicate real semantic guarantees rather than implementation accidents.

## AP-09 — Macro Hygiene and Expansion Leakage

An exported macro exposes internal paths, dependencies, names, or evaluation assumptions to the caller.

### Rust signals

- `#[macro_export]` expansion references `crate::` instead of `$crate` for the defining crate;
- callers must import a hidden dependency for the macro to compile;
- generated code names private implementation modules or unstable helper symbols;
- public `#[doc(hidden)]` helpers become accidental semver surface;
- macro arguments are evaluated multiple times or require undocumented ownership and borrowing behavior;
- expansion exposes concrete backend types that the function API otherwise hides.

### Proof questions

- Does the macro compile in a downstream crate without extra imports beyond the documented API?
- Could internal modules or dependencies move without breaking expansions?
- Are hidden support items intentionally stable enough to be public?
- Does generated ownership or evaluation behavior force caller workarounds?

### Common false positives

- a macro deliberately generates code against a named ecosystem dependency;
- public hidden helpers are the established compatibility mechanism and are tested as such.

## AP-10 — Unsafe, FFI, and Raw-Resource Leakage

A safe or high-level boundary pushes memory, ABI, ownership, or resource-lifetime obligations onto callers.

### Rust signals

- public unsafe functions require knowledge of private invariants;
- raw pointers, `NonNull`, raw file descriptors, handles, C strings, or allocator ownership cross a nominally safe boundary;
- callers must know who allocates, frees, closes, pins, or aliases a resource;
- `#[repr(...)]` and layout assumptions leak through non-FFI code;
- safe methods permit creation of values that make later safe use unsound;
- wrappers expose raw access more broadly than the underlying interoperability use requires.

### Proof questions

- Can the crate verify or encode the invariant itself?
- Is the raw exposure confined to a clearly named low-level layer?
- Are ownership transfer, aliasing, lifetime, thread, and cleanup rules explicit?
- Does the high-level abstraction remain safe when callers use only safe methods?

### Common false positives

- explicit FFI and OS-handle crates are expected to expose raw resources;
- the unsafe contract is irreducible and fully documented;
- zero-cost interoperability requires transparent layout by design.

## AP-11 — Feature, Platform, and Configuration Leakage

Cargo features, target configuration, or deployment details alter the boundary in ways consumers must understand.

### Rust signals

- the same public name resolves to different concrete types by feature or target;
- mutually exclusive backend features shape public signatures;
- downstream crates repeat `cfg(feature = ...)` to call the API;
- optional dependencies appear in public types only under certain combinations;
- target-specific APIs force callers to branch outside a platform adapter;
- feature unification can create an invalid or ambiguous public surface;
- behavior depends on environment variables or global configuration not represented in the API.

### Proof questions

- Are features additive capabilities or hidden implementation selectors?
- Can all advertised feature combinations compile and preserve coherent semantics?
- Does the caller need to mirror internal feature logic?
- Is platform variation owned by a platform abstraction or scattered across consumers?

### Common false positives

- the crate intentionally offers target-specific low-level APIs;
- a feature explicitly opts into a new public capability;
- platform differences are the very semantics the API exposes.

## AP-12 — Behavioral and Performance Leakage

Consumers depend on undocumented timing, ordering, retry, caching, allocation, batching, blocking, or failure behavior.

### Rust signals

- callers sleep, poll, retry, flush, sort, deduplicate, or batch because the abstraction's behavior is only implicit;
- hidden caches require manual invalidation from callers;
- iteration order or deterministic hashing is assumed without a contract;
- a supposedly async method blocks, or a supposedly cheap method performs I/O or allocation that callers schedule around;
- callers know internal retry counts, queue sizes, buffering, backpressure, or lazy initialization details;
- tests assert implementation timing or call counts rather than documented semantics, and production code mirrors those assumptions.

### Proof questions

- Is the behavior a meaningful semantic guarantee or an implementation accident?
- Would a valid internal optimization break callers?
- Should the contract expose a capability, consistency model, cancellation rule, or cost instead of the mechanism?
- Is the consumer compensating for missing observability or control?

### Common false positives

- performance characteristics are explicitly documented and necessary;
- deterministic order is part of the semantic contract;
- the caller legitimately owns retry or batching policy.

## Cross-Cutting Evidence Patterns

Strong evidence often combines two or more of these:

- **Surface evidence:** the leaked type or obligation appears in an effective public or layer-facing signature.
- **Consumer evidence:** call sites import, match, unwrap, lock, downcast, clone, pin, branch, or compensate around the detail.
- **Duplication evidence:** the same hidden rule appears in multiple consumers.
- **Alternative evidence:** another implementation or test fake cannot satisfy the boundary without reproducing the leaked type.
- **Change evidence:** a realistic internal change causes a concrete signature, manifest, feature, or caller edit.
- **Invariant evidence:** safe or ordinary consumers can bypass validation or enter an invalid state.
- **Documentation mismatch:** the public promise is neutral while the implementation detail is specific.

Weak evidence includes a type-name preference, a single generic parameter, an unused escape hatch, or an imagined backend with no relationship to the boundary's purpose.
