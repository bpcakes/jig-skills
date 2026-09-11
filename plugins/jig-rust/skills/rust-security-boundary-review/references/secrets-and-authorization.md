# Secrets and authorization

These checks apply only within the requested review. Patterns are investigation signals: confirm consequences and examine safeguards before reporting; assign severity by impact, not syntax.

### 1. Secrets: logging, serialization, cloning, Debug

Search leads:

```bash
rg -n "(?i)(password|passwd|pwd|secret|token|api[_-]?key|apikey|private[_-]?key|client[_-]?secret|credential|bearer|authorization|session)" .
rg -n "#\[derive\([^\]]*(Debug|Serialize|Deserialize|Clone)" . --glob '*.rs'
rg -n "(println!|eprintln!|dbg!|format!|panic!|tracing::(debug|info|warn|error)!|log::(debug|info|warn|error)!|serde_json::to_(string|value|vec))" . --glob '*.rs'
rg -n "(expose_secret|into_secret|SecretString|SecretVec|Zeroizing|zeroize|redact|mask)" . --glob '*.rs'
```

Report disclosure only after tracing a reachable path to an unauthorized destination:

- Raw `Debug` output from a password/token/API key/private key/session secret reaches logs, panic reports, diagnostics, or another sink whose audience is not authorized to receive that secret.
- Serialization, logging, metrics labels, tracing fields, or error messages carry an unredacted secret to an unauthorized recipient. Trace the actual formatting/serialization call and destination; a derive alone is not evidence of disclosure.
- A secret clone extends lifetime or exposure into a demonstrably less trusted sink. Avoidable allocation alone is an optional hardening observation.
- A value exposed from a secret wrapper crosses a concrete trust boundary through storage, logging, formatting, serialization, or a response. Merely storing it as `String` or in a struct is not enough; identify the unauthorized access path.
- Raw fields from configuration structs containing database URLs, credentials, OAuth client secrets, signing keys, or webhook secrets reach an unauthorized diagnostic or serialization sink. Check field-level redaction/skips and destination access controls.

Do not flag when:

- The field uses a wrapper whose `Debug` intentionally redacts, such as `secrecy::SecretString`, and no raw `expose_secret()` result escapes.
- Serialization is required to send a token to the legitimate recipient and the token is not logged, cached, or included in URLs.
- A clone is local, unavoidable for an API call, short-lived, and not observable outside the secret-handling function.
- A secret-bearing type derives `Debug` or `Serialize` but has no reachable disclosure sink. Removing derives or adding redaction can be optional hardening; do not report hypothetical future logging as a current defect.

Preferred fixes:

- Use `secrecy::{SecretString, SecretBox}` or an equivalent redacting type.
- Implement custom `Debug` that prints `"<redacted>"`.
- Remove `Serialize` from secret containers or use `#[serde(skip)]` / explicit redacted DTOs.
- Avoid raw `String` propagation after `expose_secret()`; keep exposure at the final cryptographic/network boundary.

### 2. Auth/authz at the right layer

Search leads:

```bash
rg -n "(Router::new|\.route\(|web::resource|#\[(get|post|put|patch|delete)|warp::|rocket::|tonic::|async_graphql|juniper)" . --glob '*.rs'
rg -n "(?i)(auth|authorize|permission|policy|role|scope|claim|principal|subject|tenant|workspace|organization|owner|admin)" . --glob '*.rs'
rg -n "(?i)(user_id|tenant_id|org_id|workspace_id|account_id|owner_id).*Path|Path<|Query<|Json<" . --glob '*.rs'
```

Flag when:

- A handler accepts a resource ID, tenant ID, owner ID, organization ID, workspace ID, or account ID and calls service/repository code without proving the authenticated subject can act on that resource.
- Authz is only route-level role checking when the operation also requires object ownership, tenant membership, scope, or row-level policy.
- A reachable service/domain caller bypasses required authorization. A missing subject parameter alone is not proof: checked capabilities, enforced caller boundaries, or row-level policies may suffice.
- Auth checks exist only in frontend code, request comments, OpenAPI metadata, tests, or route names.
- Admin/internal endpoints are mounted behind weak assumptions such as "only called by internal clients" without middleware, network boundary, mTLS, signed request, or equivalent enforcement.
- Multi-tenant queries filter by user-supplied tenant/org/workspace ID rather than the authenticated subject's allowed tenant set.

Right-layer rule:

- Authentication may be at middleware/extractor level.
- Authorization must be enforced at the trusted operation boundary where the resource/action/tenant is known. For sensitive service methods, the method signature should make bypass hard, usually by requiring a subject/context and checking policy there or by using a repository/query layer that enforces tenant/resource scoping by construction.

Preferred fixes:

- Pass `Subject`/`Principal` into service methods and centralize policy checks near the operation.
- Load the resource, then authorize against its owner/tenant before returning or mutating it.
- Derive tenant/org scope from claims/session, not from request parameters alone.
- Add deny-by-default route/middleware groups for authenticated and admin routes.
