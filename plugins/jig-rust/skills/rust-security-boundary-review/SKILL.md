---
name: rust-security-boundary-review
description: Use for focused Rust code reviews of security boundaries in PRs, diffs, or repositories. Check secrets handling, auth/authz placement, user-controlled input reaching SQL/file/redirect/header/shell sinks, CORS, cookies, token/API-key comparison and URL placement, sensitive-endpoint rate limiting, and error-response leakage. Do not use as a generic security, dependency, architecture, testing, unsafe Rust, or cryptography review.
---

# Rust Security Boundary Review

This skill performs a narrow Rust security-boundary review. It exists because these findings are easy to bury under architecture, error handling, or test-review noise. Stay inside this scope unless the user explicitly asks for a broader review.

## Scope

Review only these boundaries:

1. Secret exposure boundary: secrets must not be logged, serialized, cloned unnecessarily, or exposed through `Debug`.
2. Authentication and authorization boundary: checks must happen at the correct trusted layer, not only at the UI/client, route decoration, or caller convention.
3. User-controlled input boundary: untrusted input must not control SQL structure, file paths, redirects, headers, or shell commands unless validation/allowlisting proves it safe.
4. Browser credential boundary: CORS and cookies must not accidentally make credentialed responses readable or credentialed actions usable cross-site.
5. Token/API-key boundary: tokens and API keys must be compared safely and must not appear in URLs.
6. Abuse boundary: sensitive endpoints must have rate limiting or equivalent abuse throttling.
7. Diagnostic boundary: public error responses must not leak internals.

Do not spend review budget on dependency CVEs, supply-chain audit, memory safety, `unsafe`, TLS/cipher choices, generic input validation, business logic unrelated to access control, test coverage, or style unless it directly affects one of the boundaries above.

## Review procedure

1. Determine the review target.
   - Prefer the changed diff when reviewing a PR: `git diff --stat`, `git diff --name-only`, and `git diff -U5`.
   - If no diff is available, review route/API entry points plus files matching the boundary searches below.
   - Treat generated code and vendored code as out of scope unless the application edits or trusts it directly.

2. Build a boundary map before judging findings.
   - Entry points: axum/actix/warp/rocket/tonic routes, GraphQL resolvers, CLI handlers, background job consumers, webhook handlers.
   - Untrusted inputs: HTTP `Path`, `Query`, `Json`, `Form`, headers, cookies, multipart filenames, request bodies, webhook payloads, message queues, CLI args, environment-backed runtime config that can be tenant/user controlled.
   - Identity context: `Claims`, `Session`, `User`, `Subject`, `Principal`, `TenantId`, `OrgId`, `WorkspaceId`, roles, permissions, scopes.
   - Sensitive sinks: logs, serialization, `Debug`, SQL/query builders, filesystem APIs, redirects, response/request headers, `Command`, CORS config, cookies, token/API-key checks, rate-limit middleware, error response conversion.

3. Use searches to collect leads, then prove dataflow. A text match is not a finding by itself.
   - Optional helper: run `scripts/rust_security_boundary_scan.sh [repo-root]` from this skill directory. Its output is a lead list only.
   - Manually inspect the matched code paths and nearby callers.
   - Read `references/security-basis.md` only when validating or updating the skill's security claims; ordinary reviews should use the checklist below.

4. Report only concrete boundary failures.
   - Every finding must include file/line evidence, the attacker-controlled source or sensitive value, the sink or missing control, why the existing guard is insufficient, likely impact, and a minimal fix.
   - If evidence is incomplete, report it under `Needs verification`, not as a confirmed vulnerability.

## Boundary-specific checks

### 1. Secrets: logging, serialization, cloning, Debug

Search leads:

```bash
rg -n "(?i)(password|passwd|pwd|secret|token|api[_-]?key|apikey|private[_-]?key|client[_-]?secret|credential|bearer|authorization|session)" .
rg -n "#\[derive\([^\]]*(Debug|Serialize|Deserialize|Clone)" . --glob '*.rs'
rg -n "(println!|eprintln!|dbg!|format!|panic!|tracing::(debug|info|warn|error)!|log::(debug|info|warn|error)!|serde_json::to_(string|value|vec))" . --glob '*.rs'
rg -n "(expose_secret|into_secret|SecretString|SecretVec|Zeroizing|zeroize|redact|mask)" . --glob '*.rs'
```

Flag when:

- A type containing password/token/API key/private key/session secret derives or implements `Debug` in a way that prints the raw value.
- A secret-bearing type derives `Serialize` or is passed to `serde_json::to_*`, `Debug`, logging, panic, metrics labels, tracing fields, or error messages without redaction.
- `#[derive(Clone)]` or explicit `.clone()` creates extra copies of raw secrets where borrowing, `Arc<Secret<_>>`, a secret wrapper, or narrower ownership would avoid it.
- A secret is exposed from a wrapper and then stored as `String`, logged, formatted, serialized, returned, or placed into a broad-scope struct.
- Configuration structs with database URLs, credentials, OAuth client secrets, signing keys, or webhook secrets derive `Debug`/`Serialize` without field-level redaction/skips.

Do not flag when:

- The field uses a wrapper whose `Debug` intentionally redacts, such as `secrecy::SecretString`, and no raw `expose_secret()` result escapes.
- Serialization is required to send a token to the legitimate recipient and the token is not logged, cached, or included in URLs.
- A clone is local, unavoidable for an API call, short-lived, and not observable outside the secret-handling function.

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
- Service/domain methods that mutate or read sensitive resources do not take a `Subject`/`Principal`/claims context and rely on callers to have checked permissions.
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

### 3. User input controlling SQL structure

Search leads:

```bash
rg -n "(sqlx::query|sqlx::query_as|query!|query_as!|diesel::sql_query|rusqlite::Connection::prepare|prepare_cached|sea_query|Statement::from_string)" . --glob '*.rs'
rg -n "(format!\(|push_str\(|write!\(|\+).*?(SELECT|INSERT|UPDATE|DELETE|WHERE|ORDER BY|GROUP BY|LIMIT|OFFSET|FROM|JOIN)" . --glob '*.rs' -i
rg -n "(?i)(sort|order|filter|field|column|table|direction|limit|offset).*Query|Query<|Path<|Json<" . --glob '*.rs'
```

Flag when:

- User input is concatenated/interpolated into SQL text, including `ORDER BY`, column names, table names, operators, `LIMIT`, `OFFSET`, `WHERE` fragments, or `IN (...)` lists.
- Dynamic SQL uses request-provided field/table/operator names without an allowlist mapping to known identifiers.
- Numeric pagination values are interpolated as strings rather than bound or range-checked.
- Query builders accept raw user strings as SQL fragments.

Do not flag when:

- User input is bound as values through placeholders/bind APIs.
- Dynamic identifiers are selected from a closed enum/allowlist controlled by server code.
- SQL text is built dynamically but every user-controlled value remains parameterized and every structural choice comes from a server-owned enum.

Preferred fixes:

- Use bind parameters for values.
- Map user-facing sort/filter names to server-owned enum variants and static SQL fragments.
- Reject unknown columns/operators/directions; constrain pagination bounds.

### 4. User input controlling file paths

Search leads:

```bash
rg -n "(PathBuf::from|\.join\(|std::fs::|tokio::fs::|File::open|File::create|NamedFile|TempDir|tempfile|multipart|file_name|filename)" . --glob '*.rs'
rg -n "(?i)(path|filename|file_name|upload|download|attachment).*?(Path<|Query<|Json<|Form<|header|multipart)" . --glob '*.rs'
```

Flag when:

- Request-controlled path or filename reaches `join`, `open`, `read`, `write`, `remove`, `rename`, `NamedFile`, archive extraction, or upload storage without strict validation.
- Validation only checks for `..` as a substring but misses absolute paths, encoded separators, Unicode separator lookalikes, Windows drive paths, symlinks, leading dots, or path normalization issues.
- A base directory is joined with user input but the resolved/canonical final path is not proven to remain inside the base directory.
- User-controlled filenames are reused for storage paths, shell args, public URLs, or response headers without sanitization and uniqueness.

Preferred fixes:

- Prefer opaque server-generated IDs/filenames over user-provided paths.
- Allowlist filename characters and length; reject separators, leading dots, absolute paths, and platform-specific path prefixes.
- Canonicalize base and target where appropriate, then verify target starts with canonical base; account for symlinks and race conditions for writes.
- Store uploads outside executable/static roots unless explicitly intended.

### 5. User input controlling redirects

Search leads:

```bash
rg -n "(Redirect::to|Redirect::temporary|Redirect::permanent|SeeOther|Found|TemporaryRedirect|PermanentRedirect|LOCATION|Location|append_header\(.*Location|insert_header\(.*Location)" . --glob '*.rs'
rg -n "(?i)(next|return_to|redirect|redirect_uri|callback|continue|url).*?(Query<|Path<|Json<|Form<)" . --glob '*.rs'
```

Flag when:

- `next`, `return_to`, `redirect_uri`, `callback`, or similar input can set an absolute URL or scheme-relative URL.
- Validation uses weak substring/suffix checks such as `contains("example.com")` or `ends_with("example.com")` without parsing host boundaries.
- OAuth/login/logout flows accept arbitrary redirect destinations.

Preferred fixes:

- Prefer relative-path-only redirects beginning with a single `/` and not `//`.
- For external redirects, parse and allowlist exact scheme/host/port combinations.
- Store redirect targets server-side and reference them by nonce.

### 6. User input controlling headers

Search leads:

```bash
rg -n "(HeaderMap|HeaderName|HeaderValue|insert_header|append_header|headers\.insert|headers\.append|CONTENT_DISPOSITION|SET_COOKIE|LOCATION|StatusCode)" . --glob '*.rs'
rg -n "(?i)(header|user_agent|referer|origin|filename|download|attachment|disposition).*?(Query<|Path<|Json<|Form<|headers?)" . --glob '*.rs'
```

Flag when:

- User input controls header names or sensitive header values without allowlisting.
- User input is embedded in `Location`, `Set-Cookie`, `Content-Disposition`, cache, CSP, CORS, or auth-related headers without parser/encoder validation.
- Filenames in `Content-Disposition` are not encoded/sanitized.
- Application forwards user-provided `Origin`, `Host`, `X-Forwarded-*`, or `Authorization` into security decisions or response headers without trusted proxy rules and validation.

Preferred fixes:

- Use typed header APIs where possible.
- Allowlist header names and use `HeaderValue::from_str` plus stricter semantic validation.
- Use framework cookie builders and content-disposition encoders rather than string formatting.

### 7. User input controlling shell commands

Search leads:

```bash
rg -n "(std::process::Command|tokio::process::Command|Command::new|\.arg\(|\.args\(|sh -c|bash -c|cmd /C|powershell|duct::|xshell|shell_words)" . --glob '*.rs'
rg -n "(?i)(command|cmd|program|executable|arg|script).*?(Query<|Path<|Json<|Form<|env::args)" . --glob '*.rs'
```

Flag when:

- User input controls the program name, shell string, or command template.
- Code uses `sh -c`, `bash -c`, `cmd /C`, or `powershell -Command` with any user-controlled content.
- User input controls flags/options where an attacker can add new flags, file operands, or command separators.
- Escaping is treated as the primary defense when a shell can be avoided.

Do not flag when:

- The executable is static, shell is not used, and user input is passed as a single `.arg()` value to a command whose option semantics are safe for that value.
- User input is mapped to a closed allowlist of server-owned subcommands/arguments.

Preferred fixes:

- Avoid shells; use static `Command::new` and separate `.arg()` calls.
- Map user choices to closed enums.
- Validate value syntax, length, and allowed characters; insert `--` before user operands where supported.

### 8. CORS not permissive by accident

Search leads:

```bash
rg -n "(CorsLayer|actix_cors|warp::cors|rocket_cors|allow_origin|allow_any_origin|AllowOrigin|Any|mirror_request|allow_credentials|Access-Control-Allow-Origin|Access-Control-Allow-Credentials|CORS|cors)" . --hidden --glob '*.rs' --glob '*.toml' --glob '*.yaml' --glob '*.yml' --glob '*.env*' --glob '!target/**' --glob '!**/.git/**'
```

Flag when:

- Authenticated or sensitive endpoints allow `*`, `Any`, `allow_any_origin`, `mirror_request`, or a predicate that returns true for arbitrary origins.
- `allow_credentials(true)` is combined with broad/mirrored origins.
- Environment/config defaults fall back to permissive CORS in production when a variable is missing or malformed.
- Origin checks use weak suffix/substring matching, wildcard subdomains, or trust `Origin` as an auth control.
- CORS is enabled globally for routes that include credentialed private APIs when only public APIs need it.

Do not flag when:

- The endpoint is intentionally public, returns no sensitive data, does not rely on browser credentials, and the code/comment/config makes that intent explicit.
- Development-only permissive CORS is gated by compile-time feature, environment, or explicit local profile that cannot silently apply in production.

Preferred fixes:

- Allowlist exact origins per environment.
- Disable credentials unless browser cookies/auth headers are required.
- Split public and credentialed APIs into separate CORS layers.
- Fail closed if origin configuration is absent or invalid.

### 9. Cookies: HttpOnly, Secure, SameSite

Search leads:

```bash
rg -n "(Cookie::build|CookieBuilder|set_cookie|Set-Cookie|SameSite|http_only|secure\(|max_age|expires|domain\(|path\()" . --glob '*.rs'
```

Flag when:

- Session, refresh-token, CSRF-relevant, login-state, or other auth cookies lack `HttpOnly` unless JavaScript access is explicitly required and justified.
- Auth cookies lack `Secure` outside a clearly dev/local-only path.
- `SameSite` is missing for browser-session cookies where CSRF matters.
- `SameSite=None` is used without `Secure` or without a real cross-site use case.
- Cookie `Domain` is broader than necessary, especially across subdomains with different trust levels.
- Cookies are manually formatted and omit security attributes or allow header injection.

Preferred fixes:

- Use cookie builders: `.http_only(true)`, `.secure(true)`, `.same_site(SameSite::Lax)` or `Strict` where workable.
- Use `SameSite=None; Secure` only for explicit cross-site flows.
- Keep Domain narrow; prefer host-only cookies.

### 10. Tokens/API keys: safe comparison and no URLs

Search leads:

```bash
rg -n "(?i)(api[_-]?key|apikey|token|bearer|authorization|x-api-key|secret).*?(==|!=|eq\(|contains\(|starts_with\(|ends_with\()" . --glob '*.rs'
rg -n "(?i)(api[_-]?key|apikey|token|access_token|refresh_token|session|jwt|bearer|password).*?(Query<|Path<|uri|url|redirect|Location|format!|params|query)" . --glob '*.rs'
rg -n "(ConstantTimeEq|ct_eq|constant_time|subtle|ring::constant_time|hmac|verify)" . --glob '*.rs'
```

Flag when:

- API keys, bearer tokens, webhook secrets, reset tokens, session IDs, or HMAC signatures are compared with `==`, `!=`, normal string equality, early-return byte loops, `starts_with`, `contains`, or prefix matching.
- API keys/tokens/passwords appear in route paths, query strings, redirect URLs, `Location` headers, logs, referrer-prone links, or generated emails as URLs when a safer one-time code/body/header approach is available.
- Token verification accepts unsigned/unverified claims before authorization decisions.
- Stored API keys are plaintext when they could be hashed/HMACed and compared using constant-time verification.

Do not overstate:

- Constant-time comparison protects token equality checks; it does not fix weak entropy, plaintext storage, or missing expiration.
- For public non-secret identifiers, normal equality is fine. Prove the value is a secret before flagging.

Preferred fixes:

- Compare secrets using `subtle::ConstantTimeEq`, HMAC verification, or a vetted verifier.
- Hash/HMAC stored API keys and compare derived values safely.
- Put credentials in `Authorization`/custom headers or request bodies, not URLs.
- For password reset/email verification, use short-lived one-time tokens and avoid logging the full URL.

### 11. Rate limiting for sensitive endpoints

Search leads:

```bash
rg -n "(?i)(login|signin|auth|token|refresh|password|reset|forgot|verify|verification|otp|mfa|2fa|invite|webhook|admin|export|search|graphql|upload|email|sms)" . --glob '*.rs'
rg -n "(?i)(rate|limit|throttle|governor|tower_governor|actix_governor|leaky|bucket|quota|backoff|captcha|lockout|slow_down)" . --glob '*.rs' --glob '*.toml'
```

Flag when sensitive endpoints lack rate limiting or equivalent abuse control:

- Login/sign-in, token issuance, refresh, password reset, email/phone verification, OTP/MFA, invitation, account creation.
- API-key/token validation endpoints where guessing is possible.
- Webhooks or signed callbacks if replay/guessing/flooding is possible.
- Expensive exports, searches, uploads, or GraphQL operations that can exhaust resources.

Adequate rate limiting should be specific enough:

- Keyed by relevant dimensions such as account/user, IP, tenant, token/client ID, and route.
- Enforced before expensive work where possible.
- Not bypassable through GraphQL batching, alternate aliases, proxy headers, IPv6 rotation assumptions, or parallel endpoint variants.
- Configured differently for sensitive flows than for ordinary traffic.

Do not flag ordinary low-risk read endpoints unless the code path is expensive or security-sensitive.

Preferred fixes:

- Add middleware or service-level throttling with fail-closed configuration.
- Add account-based throttles for credential attacks, not just IP throttles.
- Add replay windows/nonces for signed webhooks when applicable.

### 12. Error responses do not leak internals

Search leads:

```bash
rg -n "(IntoResponse|ResponseError|ErrorBadRequest|ErrorInternalServerError|anyhow|thiserror|eyre|Display for|Debug for|format!\(.*err|format!\(.*error|to_string\(\)|backtrace|source\(\)|panic!|unwrap\(|expect\()" . --glob '*.rs'
rg -n "(?i)(database|sql|internal|stack|backtrace|path|file|line|config|secret|token).*?(error|response|message)" . --glob '*.rs'
```

Flag when:

- Public responses include `Debug` output, backtraces, SQL text, database errors, file paths, environment/config details, internal service names, secrets, tokens, or raw upstream errors.
- `anyhow::Error`, `eyre::Report`, `sqlx::Error`, `reqwest::Error`, or filesystem errors are converted directly to response bodies.
- Different auth errors reveal account existence, token validity details, or authorization policy internals where that creates enumeration risk.
- Panics/unwraps are reachable from malformed external input and produce framework default debug pages in production.

Preferred fixes:

- Convert internal errors to stable public error codes/messages.
- Log detailed internals server-side with request/correlation ID, then return the correlation ID and generic message.
- Keep 4xx/5xx semantics accurate without exposing implementation details.

## Severity guidance

Use severity only for prioritization, not drama.

- Critical: Direct auth/authz bypass for sensitive data/actions, token/API-key disclosure enabling account takeover, command injection with attacker-controlled shell/program, or cross-tenant access at scale.
- High: SQL injection affecting structure, path traversal exposing sensitive files, open redirect in auth/OAuth flow, permissive credentialed CORS exposing private data, plaintext secret exposure in logs/responses, missing rate limit on login/token flows with practical brute-force risk.
- Medium: Secret `Debug`/`Serialize` exposure not currently logged but likely to be, unsafe token comparison on high-entropy secrets, broad cookie/CORS misconfig with partial exploit conditions, error leakage of meaningful internals.
- Low: Hardening gaps with limited exploitability, dev-only risks that could become production through config mistakes, missing comments/tests for security-critical validation where code appears correct.

## Output format

Use this exact structure:

```markdown
# Rust Security Boundary Review

Scope reviewed: <diff / files / routes>

## Confirmed findings

### <Severity>: <specific title>
- Location: `<file>:<line>`
- Boundary: <secret/authz/input/CORS/cookie/token/rate-limit/error>
- Evidence: <source -> sink or missing control>
- Why it matters: <concrete exploit or failure mode>
- Fix: <minimal code/design change>

## Needs verification

### <title>
- Location: `<file>:<line>`
- What is unclear: <missing caller/config/runtime fact>
- How to verify: <specific check>

## Checked but OK

- <briefly list important security-boundary areas reviewed that had adequate controls>
```

Rules for output:

- Do not include generic security advice.
- Do not bury confirmed security findings beneath style or architecture commentary.
- Do not report a finding unless you can explain attacker control or secret exposure.
- Prefer one precise high-signal finding over five speculative ones.
- When no findings exist, say what boundaries were checked and why they appear safe.
