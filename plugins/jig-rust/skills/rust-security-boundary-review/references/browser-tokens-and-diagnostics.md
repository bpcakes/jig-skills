# Browser credentials, tokens, abuse, and diagnostics

These checks apply only within the requested review. Patterns are investigation signals: confirm consequences and examine safeguards before reporting; assign severity by impact, not syntax.

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
