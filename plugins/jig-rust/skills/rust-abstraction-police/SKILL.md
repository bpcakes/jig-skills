---
name: rust-abstraction-police
description: "Use when reviewing a Rust crate, workspace, module boundary, patch, or public API for leaky abstractions: implementation details crossing boundaries, backend/runtime/protocol/representation coupling, invariant escape hatches, generic or lifetime contagion, foreign error types, serialization and layout commitments, public lock guards or raw handles, feature-shaped APIs, and callers compensating for hidden behavior. Do not use as a general Rust style review."
---

# Rust Abstraction Police

Find abstraction boundaries that claim to hide a detail but force consumers to know, preserve, or compensate for that detail.

This is not a purity audit. A concrete type, generic parameter, `Arc`, `serde` derive, or `Deref` implementation is not automatically a defect. Report a leak only when the implementation detail contradicts the boundary's intended promise and creates a concrete caller, compatibility, invariant, or change-cost consequence.

## Confirmation Rule

A reportable leak must satisfy all five conditions:

1. **Boundary** — identify the module, crate, trait, newtype, service, repository, facade, or public API that is supposed to contain a concern.
2. **Intrusion** — show the implementation detail that crosses the boundary or the hidden fact consumers must know.
3. **Consequence** — show how a realistic change within the abstraction's apparent promise would force consumer changes, expose invalid states, or break a safety or semantic invariant.
4. **Evidence** — cite exact source locations. Include a consumer or call-site example when the repository contains one; a directly exposed public API is sufficient for a library with no in-repository consumers.
5. **Intent check** — rule out an explicit, deliberate contract such as FFI layout, a documented runtime requirement, a deliberately transparent newtype, or an API whose purpose is to expose the concrete mechanism.

Do not promote regex matches, aesthetic preferences, hypothetical future backends, or "this could be more abstract" into findings.

## Operating Modes

- **Repository scan:** inspect the requested workspace, crate, or path and rank confirmed leaks by blast radius.
- **Diff review:** inspect changed boundaries, their definitions, affected callers, and the nearest alternative implementations. Report only leaks introduced or materially worsened by the change unless the user asks for a broader audit.
- **API review:** focus on externally reachable items, documented contracts, semver commitments, macros, feature combinations, and downstream caller burden.
- **Layer review:** treat `pub(crate)`, `pub(super)`, and package-internal interfaces as real boundaries when the repository architecture intends separation between domain, application, infrastructure, transport, or platform layers.

Rust visibility is syntactic, not automatically effective. A `pub` item inside a private module may not be externally reachable. Resolve the module tree and re-exports before claiming a public API leak.

## Safe Source Inspection

Work source-first and offline. Do not install tools or fetch dependencies for this review.

Useful non-executing inventory commands include:

```bash
cargo metadata --no-deps --format-version 1 --offline
rg -n --glob '*.rs' '^\s*pub(\([^)]*\))?\s+(use|mod|struct|enum|trait|type|fn|const|static|unsafe|extern)\b'
rg -n --glob '*.rs' '#\[(macro_export|repr|serde|cfg|doc\(hidden\))'
rg -n --glob '*.rs' '(Deref|AsRef|Borrow|into_inner|as_inner|as_raw|into_raw|downcast_(ref|mut))'
```

Resolve `<skill_dir>` to the directory containing this `SKILL.md`. The bundled candidate collector is optional:

```bash
python3 <skill_dir>/scripts/collect_candidates.py <repository-root> --format markdown
```

Its output is a lead list, never a finding list.

`cargo check`, `cargo clippy`, `cargo test`, `cargo doc`, build scripts, procedural macros, `cargo public-api`, and `cargo semver-checks` can compile or execute repository-controlled code. Use them only when repository execution is allowed. The optional Cargo subcommands may be used as supporting evidence only when already installed; never install them during the review.

## Workflow

### 1. Resolve the promise of each boundary

Read the nearest `Cargo.toml`, crate root, module declarations, public re-exports, README, rustdoc, examples, and architectural notes. Establish:

- what the boundary is named and documented to do;
- which concerns it appears to own;
- which dimensions it promises, or strongly implies, callers need not know;
- whether it is a stable public API, an internal layer boundary, or a deliberately transparent adapter.

Do not invent a promise solely to manufacture a leak. A type named `SqlxUserRepository` is allowed to expose SQLx more freely than a type named `UserRepository` in a domain crate.

### 2. Inventory the effective surface

Inspect all items that can carry implementation commitments:

- reachable `pub` items and `pub use` chains;
- `pub(crate)`, `pub(super)`, and `pub(in ...)` interfaces between intended layers;
- public fields, tuple fields, union fields, enum variants, type aliases, trait methods, associated types, bounds, and blanket impls;
- constructors, conversion traits, `Deref`, `AsRef`, `Borrow`, raw-handle methods, and `into_inner`-style escapes;
- `#[macro_export]`, public declarative macros, procedural macro APIs, and `#[doc(hidden)] pub` support items;
- `#[repr(...)]`, `#[non_exhaustive]`, `#[cfg(...)]`, `#[serde(...)]`, and derive-driven contracts;
- return-position `impl Trait`, async APIs, captured lifetimes, and observable auto-trait bounds such as `Send` and `Sync`;
- public unsafe functions, raw pointers, handles, guards, transactions, and platform-specific types.

### 3. Generate hypotheses using the Rust leak taxonomy

Load `references/leak-taxonomy.md`. Treat each signal as a question:

- Is a representation, backend, runtime, protocol, storage model, ownership policy, lock strategy, wire schema, error taxonomy, or state machine escaping?
- Are callers reaching through the abstraction because its operations are incomplete?
- Are generic parameters, lifetimes, feature flags, or auto-trait properties spreading because of hidden implementation choices rather than intentional polymorphism?
- Can callers bypass validation or safety invariants through fields, `Deref`, conversion methods, raw handles, or public unsafe obligations?
- Does an exported macro require the caller to know hidden paths or dependencies?

### 4. Trace both directions

For every plausible leak, perform both traces when possible.

**Boundary outward:** follow the public or layer-facing signature into concrete dependencies, representations, bounds, lifetimes, error variants, macros, or hidden state.

**Consumer inward:** find call sites that:

- pattern-match implementation-specific variants;
- call `inner`, `raw`, `lock`, `transaction`, `downcast`, or backend-specific methods;
- repeat validation, ordering, retry, batching, serialization, cleanup, or lifecycle logic that the boundary should own;
- add clones, `Arc`, boxing, pinning, lifetime plumbing, feature gates, or executor constraints solely to satisfy the implementation;
- import infrastructure crates into a domain or application layer to use the boundary.

Do not treat test-only white-box access as production leakage unless the same contract is externally reachable or tests reveal an actual caller requirement.

### 5. Apply the change test

Ask one precise counterfactual, not a vague demand for flexibility:

> Could the implementation change in a way that remains consistent with this abstraction's stated or evident purpose without forcing consumers to change?

Relevant Rust counterfactuals include:

- swapping a storage driver, HTTP stack, async runtime, lock type, allocator, collection representation, or cache implementation;
- changing borrowed storage to owned storage, or internal sharing from `Arc` to another policy;
- adding an internal state or error cause;
- renaming or restructuring domain fields without changing the wire or persistence contract;
- enforcing an invariant inside a newtype without allowing callers to mutate the representation;
- changing an iterator, future, stream, guard, transaction, or task implementation;
- making a safe internal change without altering downstream `Send`, `Sync`, lifetime, layout, or feature requirements.

A "no" is not enough. Confirm that the proposed change falls inside the boundary's actual promise. If the concrete mechanism is the product, there is no leak.

### 6. Seek counterevidence

Before reporting, look for:

- documentation that explicitly commits to the concrete type or behavior;
- naming that makes the adapter or backend transparent by design;
- FFI, ABI, zero-copy, embedded, `no_std`, or performance constraints that require the exposure;
- downstream extension as an intentional goal of an unsealed trait;
- a public representation intended as the canonical data model;
- migration or compatibility guarantees that make the exposed schema deliberate;
- evidence that an escape hatch is restricted, unsafe for a documented reason, or used only by an adapter layer.

Record material counterevidence. Reject the candidate when it defeats the leak claim.

### 7. Calibrate severity and confidence

Use `references/report-template.md`.

**High**

- A safe abstraction exposes an unsafe obligation or allows invariant bypass with realistic impact.
- A central public boundary makes its advertised implementation independence false and changing the hidden mechanism would break many consumers or the ecosystem.
- A leaked lifetime, guard, transaction, raw handle, or runtime requirement creates broad correctness, deadlock, cancellation, or resource-lifecycle risk.

**Medium**

- Multiple consumers are coupled to a backend, runtime, protocol, schema, error type, representation, or feature shape that the boundary appears intended to hide.
- Callers repeatedly compensate for missing behavior or duplicate invariant logic.
- The leak creates meaningful semver or architectural change cost but not immediate safety risk.

**Low**

- The leak is real but localized to a narrow internal boundary or one consumer.
- The likely change cost is limited and the invariant risk is minor.

Do not report "informational" candidates as findings. Place useful but unproven signals in residual observations.

Confidence is independent of severity:

- **High:** direct surface evidence plus consumer evidence or an unavoidable public compatibility consequence.
- **Medium:** direct surface evidence with limited consumer evidence or some ambiguity about intent.
- **Low:** meaningful evidence remains missing. Low-confidence items should normally stay out of the confirmed findings section.

### 8. Recommend the smallest effective repair

Load `references/remediation-playbook.md`. Prefer containing the specific leak over adding abstraction layers reflexively.

Typical repairs include:

- private fields plus capability-focused methods;
- a newtype that owns validation and trait coherence;
- domain-owned values separated from transport, persistence, or serialization DTOs;
- mapping foreign errors into a stable domain error with preserved sources;
- returning owned values or boundary-owned handles instead of lock guards and transactions;
- closure- or capability-based access when resource lifetime must remain internal;
- moving generic parameters or associated implementation types behind a private adapter;
- using an associated type, `impl Trait`, or trait object only when its trade-offs fit the intended variability;
- sealing a trait, adding `#[non_exhaustive]`, or documenting extension obligations when extensibility is not the contract;
- custom serialization or explicit schema types instead of deriving the external contract from internal layout;
- `$crate` paths and hidden re-exports for exported macro support;
- a safe wrapper that internalizes unsafe invariants;
- documenting and naming a concrete commitment when exposure is intentional and removal would make the API dishonest.

Do not recommend a trait solely because there is one implementation. Do not replace compile-time polymorphism with dynamic dispatch without addressing object safety, allocation, performance, and ownership consequences. Do not hide a useful semantic guarantee just to make the API look abstract.

## Rust-Specific False Positives

Reject or qualify these common overreaches:

- `Vec<T>` is not a leak when ordered, contiguous, owned sequence semantics are part of the contract.
- `Arc<T>` is not a leak when shared ownership is explicitly the API's semantic model.
- `Uuid`, `PathBuf`, `Bytes`, or a concrete error type is not a leak merely because it comes from another crate.
- `pub struct UserId(pub Uuid)` may be intentionally transparent; report only when it defeats validation, representation independence, or coherence goals.
- `impl Iterator`, `impl Future`, and async functions often reduce representation exposure; inspect captured lifetimes and auto-trait behavior rather than flagging them by default.
- Public generics can be the intended zero-cost extension mechanism. "Many type parameters" is only a signal when implementation choices infect consumers without useful caller-controlled variability.
- `serde` derives are valid when the Rust type is intentionally the canonical wire or storage schema.
- An unsealed trait is valid when third-party implementation is a supported extension point.
- `#[repr(C)]`, raw handles, and unsafe functions can be correct at an explicit FFI or systems boundary.
- Backend-specific types are expected in backend-specific adapters. The leak occurs when they escape into a backend-neutral boundary.

## Output Contract

Return findings in descending severity and blast radius. Use this structure for each finding:

```markdown
### AP-RUST-001 — <specific title>

**Severity:** high | medium | low  
**Confidence:** high | medium  
**Boundary:** `<crate::module::item>`  
**Leak kind:** <taxonomy category>

**Leaked detail**  
<one precise sentence>

**Evidence**
- `<path>:<line>` — <what the boundary exposes>
- `<path>:<line>` — <how a consumer depends on or bypasses it>

**Consequence**  
<current caller burden, invariant risk, or compatibility cost>

**Change test**  
<one realistic implementation change and the exact consumer changes it would force>

**Intent and counterevidence**  
<why this is not an explicit contract, or what ambiguity remains>

**Remediation**  
<smallest repair, migration shape, and important trade-off>
```

End with:

- boundaries reviewed;
- confirmed finding count by severity;
- rejected high-signal candidates and the reason they were not leaks, when useful;
- coverage limits and residual risk.

If no leaks are confirmed, say so directly. List the important boundaries reviewed and the strongest rejected candidates. Never invent a finding to make the report look useful.

## Example Trigger Phrases

- "Abstraction-police this Rust crate."
- "Find leaky abstractions in this Rust PR."
- "Check whether our domain layer leaks SQLx, Tokio, Serde, or transport details."
- "Review this Rust public API for representation and lifetime leaks."
- "Find callers that reach through wrappers or compensate for hidden behavior."
