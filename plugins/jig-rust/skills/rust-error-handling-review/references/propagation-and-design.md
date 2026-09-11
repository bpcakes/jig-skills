# Error propagation and design

## Discards and defaults

Signals include `.ok()`, `let _ = result`, empty error arms, `if let Ok` without `else`, default-on-error helpers, and logging followed by success.

Trace what the caller was promised. Report when failure is represented as success, corrupt or missing data is accepted, required work is skipped, or needed diagnostics disappear. A missing comment alone is not a defect. Optional parsing, probing, cleanup after a completed operation, and best-effort telemetry can intentionally discard errors; inspect contracts and callers even when this is not commented locally. Conversely, a “best effort” comment does not excuse violating a required write or durability contract.

For `.map_err(|_| ...)`, check whether callers need the source for recovery or diagnosis. Deliberate translation to a stable public error can be appropriate if internal diagnostics are retained where needed. Do not recommend exposing secrets through error chains or responses.

## Context

Multiple same-type fallible operations are a signal to inspect the final rendered error and handler. Neither three operations nor bare `?` proves ambiguity. Existing sources, variant names, operation-specific messages, or structured spans may already identify the failing step. Add context where an operator or caller otherwise cannot distinguish relevant failures; there is no first/last-operation quota.

Include the operation and safe identifiers in proposed messages. Redact connection strings, credentials, tokens, and sensitive payloads. Preserve source/downcasting behavior when callers rely on it.

## Error types

- `#[from]` counts have no defect threshold. Four distinct, informative variants may preserve all required distinctions; one generic conversion can lose the only distinction that matters.
- Check actual `Error::source()` behavior before reporting a missing chain. `thiserror` can infer a field named `source`; `#[from]` implies a source, and transparent wrappers can intentionally forward it. Do not require a redundant attribute.
- Transparent display can be a valid boundary contract. Report only if the resulting diagnostic loses information needed at that boundary.
- Variants can support diagnostics, external users, or future compatibility even when local callers do not match each one. Absence of an in-repository match is not evidence of uselessness.
- `anyhow`, `thiserror`, handwritten errors, and opaque public errors are choices. Check whether a real caller loses required recovery information or must depend on hidden representations; do not mandate one library per layer.
- Consider `#[non_exhaustive]` against the library's evolution policy. A deliberately closed enum can be valid; adding the attribute to an existing API can itself break callers.
- Naming and enum size are optional style observations unless they cause a demonstrated API or maintenance problem.
