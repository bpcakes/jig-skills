---
name: rust-security-boundary-review
description: Review Rust auth, secrets, untrusted-input sinks, and browser credential boundaries; excludes general security audits.
---

# Rust Security Boundary Review

Apply this skill when it serves the user's requested task and target. Discovery or a code change does not authorize an additional review, refactor, or broader scan. For review-only requests, report findings without editing; implement changes only when they are part of the user's request.

Treat checklist patterns, counts, and missing comments as investigation signals. Report a defect only after tracing a concrete consequence and checking counterevidence in callers, invariants, tests, and configuration. Missing context is a limitation, not a finding. Assign severity from impact and reachability; keep optional preferences separate and allow no findings.

This skill performs a narrow Rust security-boundary review. It exists because these findings are easy to bury under architecture, error handling, or test-review noise. Stay inside this scope unless the user explicitly asks for a broader review.

## Scope

Review only these boundaries:

1. Secret exposure boundary: trace secrets through logging, serialization, cloning, and `Debug` formatting to determine whether they reach an unauthorized recipient. Derives or avoidable allocation alone do not prove disclosure.
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
   - If the requested diff is empty or unavailable, report that limitation. Review route/API entry points and search matches only within a named file or repository audit scope.
   - Treat generated code and vendored code as out of scope unless the application edits or trusts it directly.

2. Build a boundary map before judging findings.
   - Entry points: axum/actix/warp/rocket/tonic routes, GraphQL resolvers, CLI handlers, background job consumers, webhook handlers.
   - Untrusted inputs: HTTP `Path`, `Query`, `Json`, `Form`, headers, cookies, multipart filenames, request bodies, webhook payloads, message queues, CLI args, environment-backed runtime config that can be tenant/user controlled.
   - Identity context: `Claims`, `Session`, `User`, `Subject`, `Principal`, `TenantId`, `OrgId`, `WorkspaceId`, roles, permissions, scopes.
   - Sensitive sinks: logs, serialization, `Debug`, SQL/query builders, filesystem APIs, redirects, response/request headers, `Command`, CORS config, cookies, token/API-key checks, rate-limit middleware, error response conversion.

3. Use searches to collect leads, then prove dataflow. A text match is not a finding by itself.
   - Optional helper: run `scripts/rust_security_boundary_scan.sh [repo-root]` from this skill directory. Its output is a lead list only.
   - Manually inspect the matched code paths and nearby callers.
   - Read `references/security-basis.md` only when validating or updating the skill's security claims; ordinary reviews should select the boundary-specific references below.

4. Report only concrete boundary failures.
   - Every finding must include file/line evidence, the attacker-controlled source or sensitive value, the sink or missing control, why the existing guard is insufficient, likely impact, and a minimal fix.
   - If evidence is incomplete, report it under `Needs verification`, not as a confirmed vulnerability.

## Select checks by boundary

Read only the references relevant to the mapped sources and sinks:

- Secret types, logging, or authorization: [secrets and authorization](references/secrets-and-authorization.md).
- SQL, file paths, redirects, headers, or commands: [input sinks](references/input-sinks.md).
- CORS, cookies, token verification, rate limits, or public errors: [browser, tokens, and diagnostics](references/browser-tokens-and-diagnostics.md).

## Severity guidance

Use severity only for prioritization, not drama.

- Critical: Direct auth/authz bypass for sensitive data/actions, token/API-key disclosure enabling account takeover, command injection with attacker-controlled shell/program, or cross-tenant access at scale.
- High: SQL injection affecting structure, path traversal exposing sensitive files, open redirect in auth/OAuth flow, permissive credentialed CORS exposing private data, plaintext secret exposure in logs/responses, missing rate limit on login/token flows with practical brute-force risk.
- Medium: Demonstrated boundary failures with bounded exposure, such as meaningful internal data reaching an unauthorized caller. Trace actual sinks and attacker capabilities before assigning severity to secret formatting, token comparison, or cookie/CORS configuration.
- Low: Demonstrated boundary failures with limited impact. Keep hardening suggestions and missing-context questions separate from confirmed defects.

A secret type deriving `Debug` or `Serialize` without a reachable disclosure sink is a hardening consideration, not a confirmed finding. Put genuinely unresolved sink or deployment facts in Needs verification; do not infer future logging as evidence of exposure.

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
