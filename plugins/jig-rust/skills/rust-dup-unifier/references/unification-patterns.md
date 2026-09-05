# Rust Unification Patterns

Choose the smallest pattern that centralizes the proven common invariant. Direct type merging is only one option.

## 1. Shared Data Core by Composition

Use when sibling public or policy types share stable data but retain distinct behavior or compatibility contracts.

```rust
struct TransportCore {
    endpoint: Endpoint,
    timeout: Duration,
}

pub struct HttpOptions {
    core: TransportCore,
    redirects: RedirectPolicy,
}

pub struct RpcOptions {
    core: TransportCore,
    retry: RetryPolicy,
}
```

This is usually safer than a single union type with unrelated optional fields.

## 2. Shared Private Algorithm

Use when representations differ but validation, normalization, parsing, or state transitions are the same.

```rust
fn validate_endpoint(endpoint: &Endpoint, timeout: Duration) -> Result<(), ConfigError> {
    // One invariant, one implementation.
}
```

Keep the helper private unless external callers need a stable contract. A public helper or trait creates a new API commitment.

## 3. Policy-Parameterized Core

Use when mechanics are identical and a small, explicit policy controls the real differences.

```rust
trait RetryPolicy {
    fn next_delay(&mut self, attempt: u32) -> Option<Duration>;
}

struct ClientCore<P> {
    retry: P,
}
```

Check monomorphization, compile-time cost, object safety, and whether callers actually need generic choice. Do not invent a policy abstraction for two branches that are unlikely to evolve together.

## 4. Behavioral Trait

Use when callers need to operate over distinct nominal types through the same behavior. Do not use a trait merely to hide duplicated fields.

```rust
trait RequestLike {
    fn endpoint(&self) -> &Endpoint;
    fn timeout(&self) -> Duration;
}
```

Prefer sealed or crate-private traits when the abstraction is not intended as an ecosystem extension point.

## 5. Macro or Schema Generation

Use when declarations must remain separate—protocol versions, platform bindings, repeated enum mappings—but should be generated from one source of truth.

Good targets include:

- Variant lists and conversion tables.
- Repetitive forwarding implementations.
- Feature- or platform-specific wrappers with identical surfaces.
- Wire definitions generated from an existing schema.

Do not replace understandable code with a macro when the duplication is small and the macro would obscure control flow or diagnostics.

## 6. Canonical Type plus Compatibility Shell

Use when one public abstraction should become canonical but existing paths must continue working.

Possible migration tools:

- Re-export the canonical type from the old module path.
- Use a type alias only when distinct nominal identity and distinct impls are unnecessary.
- Keep a forwarding wrapper with `From`/`TryFrom` during a staged migration.
- Deprecate old constructors while retaining behavior for the promised compatibility window.

Check struct literal construction, enum pattern matching, trait implementations, inference, documentation links, and downstream feature combinations before claiming compatibility.

## 7. Explicit Conversion Boundary

Use when two types are intentionally different layers—wire/domain, borrowed/owned, validated/unvalidated—but conversion code has drifted.

Centralize the mapping and tests rather than erasing the boundary:

```rust
impl TryFrom<WireRequest> for Request {
    type Error = DecodeError;

    fn try_from(value: WireRequest) -> Result<Self, Self::Error> {
        // Single validation and normalization path.
    }
}
```

A useful boundary prevents invalid states or compatibility concerns from leaking inward.

## Anti-Patterns

Avoid:

- A union struct containing every field from every sibling as `Option<T>`.
- A mega-enum that combines unrelated state machines.
- A public trait created solely to reduce a few repeated methods.
- Blanket implementations that risk coherence conflicts or surprising inference.
- Generic parameters that infect the public API without caller value.
- Erasing owned/borrowed distinctions by allocating everywhere.
- Merging error types from different recovery boundaries.
- Declaring duplication solved while duplicate tests, adapters, or conversion branches continue to drift.
