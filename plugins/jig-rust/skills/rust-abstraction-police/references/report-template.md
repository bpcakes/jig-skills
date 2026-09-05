# Report Template and Calibration

## Executive Summary

```markdown
## Rust Abstraction Review

**Scope:** <workspace, crate, path, or diff>  
**Mode:** repository | diff | API | layer  
**Boundaries reviewed:** <list>  
**Confirmed leaks:** <high count> high, <medium count> medium, <low count> low

<Two to five sentences identifying the dominant leak pattern and its concrete cost.>
```

Do not open with generic architecture advice. State what is actually leaking, through which boundary, and why it matters.

## Finding Template

```markdown
### AP-RUST-001 — <specific, mechanism-based title>

**Severity:** high | medium | low  
**Confidence:** high | medium  
**Boundary:** `<crate::module::item>`  
**Leak kind:** representation | backend/dependency | ownership/lifetime | concurrency/runtime | error | schema/protocol/storage | invariant/state machine | trait/generic | macro | unsafe/FFI | feature/platform | behavior/performance

**Leaked detail**  
<The exact mechanism or knowledge that crosses the boundary.>

**Evidence**
- `<path>:<line>` — <definition or reachable API evidence>
- `<path>:<line>` — <consumer, alternative implementation, documentation mismatch, or invariant-bypass evidence>

**Consequence**  
<What callers must import, match, preserve, duplicate, or know; or what invalid state becomes possible. Include blast radius.>

**Change test**  
<One realistic internal change that remains consistent with the abstraction's purpose, followed by the exact downstream changes it would force.>

**Intent and counterevidence**  
<Documentation, naming, performance, FFI, schema, or extension evidence considered. Explain why it does not defeat the finding, or state the remaining ambiguity.>

**Remediation**  
<The smallest effective repair. Include migration and material trade-offs.>
```

## Title Guidance

Good titles identify both boundary and leaked mechanism:

- `Repository port exposes SQLx transactions to application services`
- `Validated collection leaks mutable Vec access through Deref`
- `Domain event layout doubles as the persisted Serde schema`
- `Runtime-neutral worker API returns Tokio JoinHandle`
- `Opaque service error forces callers to downcast to reqwest::Error`

Weak titles are vague:

- `Bad abstraction`
- `Too much coupling`
- `Use a trait`
- `Implementation detail exposed`

## Severity Decision Table

| Severity | Invariant or safety risk | Change blast radius | Typical examples |
|---|---|---|---|
| High | Safe callers can violate a critical invariant, or leaked lifecycle/concurrency details create realistic correctness risk | Central public API or many crates/consumers | raw resource obligations through a safe facade; public lock/transaction lifetime at a core boundary; advertised backend-neutral API that exposes backend types everywhere |
| Medium | No immediate severe safety issue, but callers duplicate rules or bind to hidden mechanism | Multiple consumers or meaningful public semver cost | foreign errors, runtime handles, DTO/domain collapse, generic contagion, feature-shaped public types |
| Low | Minor invariant or change cost | One internal boundary or localized caller | narrow `into_inner` escape, representation-specific iterator in an internal module |

Severity is about consequence, not how aesthetically impure the API looks.

## Confidence Rules

**High confidence** requires direct source evidence and either:

- a real consumer dependence;
- a real invariant bypass; or
- an unavoidable public compatibility consequence.

**Medium confidence** is acceptable when the surface leak is direct but repository consumers are absent or intent has limited ambiguity.

Do not publish low-confidence candidates as confirmed findings. Put them under residual observations with the missing evidence named.

## Rejected-Candidate Format

Use this only for strong signals that a reviewer would reasonably ask about:

```markdown
- `crate::Id(pub Uuid)` — rejected: the crate documents the UUID representation as the interoperability contract, construction performs no hidden validation, and downstream conversion is the type's purpose.
```

This section demonstrates discrimination. Do not dump every regex match.

## Coverage Footer

```markdown
## Coverage and Residual Risk

Reviewed: <crate roots, public modules, layer interfaces, representative consumers, macros, features inspected>.  
Not reviewed: <generated code, excluded crates, unavailable feature combinations, external downstream callers>.  
Residual risk: <specific areas where intent or consumer evidence was unavailable>.
```
