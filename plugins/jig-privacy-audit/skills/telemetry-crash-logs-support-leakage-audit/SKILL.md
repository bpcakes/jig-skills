---
name: telemetry-crash-logs-support-leakage-audit
description: Audit telemetry, crash reports, logs, traces, support tools, exports, redaction, and observability payloads for privacy leakage. Use to find exposed content, metadata, identifiers, credentials, keys, tokens, or claim-conflicting plaintext.
---

# Telemetry Crash Logs Support Leakage Audit

Use this skill to inspect whether observability, analytics, crash reporting, support, and diagnostic systems leak data that product claims, privacy expectations, or security boundaries require to stay private.

Always reference `../audit-common/SKILL.md` before finalizing findings. Use its evidence, severity, redaction, limitations, and shared finding schema rules. Do not repeat or weaken those rules.

Read `references/logging-privacy-baselines.md` when you need source-backed baseline language for logs, crash reports, telemetry attributes, app privacy disclosures, minimization, retention, or personal-data classification.

## Safety Constraints

- Work only on authorized repositories, local/staging environments, approved test accounts, or explicitly scoped production artifacts.
- Use synthetic sentinels. Do not place real customer content, live credentials, production keys, recovery phrases, regulated personal data, or real support cases into test flows.
- Treat logs, crash reports, traces, support exports, tickets, and analytics payloads as sensitive evidence. Redact tokens, cookies, secrets, personal data, customer content, and full sentinel values from final output.
- Do not bypass support/admin authorization, tenant boundaries, audit logging, rate limits, legal holds, or other safety controls. Use owner-provided test accounts, staging systems, scoped log queries, fixtures, documented test harnesses, or approved exports instead.
- If live production logs are in scope, prefer querying for synthetic test values and metadata patterns, not pulling broad raw logs.

## Audit Goal

Determine whether sensitive values appear in any diagnostic or support sink:

- analytics events, event properties, user properties, cohorts, feature-flag context, A/B assignments, attribution payloads, marketing pixels;
- crash reports, non-fatal exceptions, breadcrumbs, custom keys, attachments, minidumps, stack traces, handled error reports;
- application logs, structured logs, debug logs, console logs, mobile logs, syslog, audit logs, background job logs;
- traces, spans, baggage, resource attributes, metric labels, exemplars, profiling samples, session replay, RUM;
- support tools, impersonation/session replay, admin consoles, ticket attachments, exports, DSAR exports, debug bundles;
- sentinel generation, error boundaries, validation errors, retry queues, dead-letter queues, webhook logs, CI/test logs, data warehouse copies.

## Required Outputs

Use `templates/telemetry-leakage-report.md` for narrative reports. Emit finding candidates using `templates/telemetry-leakage-finding.schema.json` or the shared `../audit-common/templates/finding.schema.json`.

Every concrete finding should include:

- finding id prefixed `TCLS`, such as `TCLS-001`;
- affected claim or expectation;
- sink and vendor/system owner;
- evidence artifact, path, log query, event name, trace id, crash id, ticket id, export name, or screenshot id;
- redacted excerpt and transform needed to reveal the value;
- data class, audience that can read it, retention/access notes, and third-party processor notes;
- reproduction and retest steps;
- limitation if evidence is static, sampled, environment-specific, or only negative sentinel evidence.

## Data Classes

Tag each observed field or payload with one or more classes:

- `user_content`: message bodies, notes, documents, attachments, comments, support free text, uploaded files, voice/photo/video content.
- `sensitive_metadata`: titles, filenames, search terms, tags, contacts, recipients, folder paths, location, precise timestamps, relationship graph, collaboration state.
- `identifier`: user id, account id, tenant id, device id, installation id, advertising id, IP address, email, phone, cookie id, push token, session id.
- `secret_or_credential`: password, passphrase, OTP, access token, refresh token, API key, cookie, authorization header, DSN with secret, webhook secret.
- `key_or_recovery_material`: private key, symmetric key, wrapped key, seed phrase, recovery code, escrow blob, backup code.
- `operational_diagnostic`: crash frame, error code, status, feature flag, coarse build/device/runtime data, non-sensitive counters.
- `support_access_artifact`: impersonation grant, admin note, ticket export, debug bundle, support transcript, session replay.
- `unknown`: ambiguous, encoded, hashed, sampled, vendor-managed, or insufficiently traced data.

## Workflow

1. Define scope and claims.
   - Record exact privacy, E2EE, zero-knowledge, "not logged", support-access, analytics opt-out, crash collection, and retention claims.
   - Identify first-party and third-party sinks, vendors, SDKs, ingestion endpoints, local stores, dashboards, support tools, exports, and warehouses.
   - Record environment, build, commit, account, region, consent/opt-out state, feature flags, sampling settings, and retention tier.

2. Inventory telemetry and support surfaces.
   - Search dependencies and manifests for SDKs: Sentry, Firebase/Crashlytics/Analytics, Datadog, New Relic, Bugsnag, Rollbar, Amplitude, Segment, Mixpanel, PostHog, FullStory, LogRocket, OpenTelemetry, Honeycomb, LaunchDarkly, Statsig, Intercom, Zendesk.
   - Inspect logger wrappers, exception handlers, middleware, request/response logging, tracing instrumentation, metric labels, analytics helpers, error boundaries, mobile crash hooks, support/admin controllers, export jobs, and debug bundle builders.
   - Include generated code, mobile privacy manifests, Play/App Store disclosure config, CI log upload steps, and infrastructure log pipelines.

3. Map emitted fields to sinks.
   - Build a matrix of event names, log keys, trace attributes, crash custom keys, breadcrumbs, user properties, support export fields, and attachments.
   - For each field, note source object, redaction point, serializer, sink, principal able to read it, retention, indexing/searchability, and whether it is sent to a third party.
   - Distinguish client-side redaction before collection from server-side or vendor-side scrubbing after collection.

4. Generate synthetic sentinels.
   - Use unique values per class and flow: content, metadata, identifier-like, token-like, recovery-like, support-text, search-term, filename, validation-error, and crash-context values.
   - Use `templates/sentinel-manifest.template.json` as a private manifest shape. Do not commit real sentinel values.
   - Test exact, normalized, encoded, truncated, hashed, tokenized, lowercased, URL-encoded, base64/base64url, JSON-escaped, gzip-wrapped, and stack-trace-rendered forms.

5. Exercise representative flows.
   - Normal flows: onboarding, login/logout, content create/edit/delete, search, share, import/export, attachment upload, settings, billing, notification, sync, background refresh.
   - Error flows: validation failure, authorization failure, network timeout, retry, non-fatal exception, crash, unhandled rejection, panic, API 4xx/5xx, dead-letter job, webhook failure.
   - Support flows: ticket creation, support reply, attachment upload, debug bundle export, impersonation/start/end, account lookup, support search, DSAR/account export.
   - Consent flows: analytics disabled, crash reporting opt-out, "do not sell/share", regional privacy modes, child/minor mode where applicable.

6. Inspect runtime artifacts.
   - Pull only scoped artifacts: event debugger output, crash issue payloads, log query results, trace ids, metric series labels, support ticket fields, export files, warehouse rows, replay payload metadata.
   - Search for sentinels and derivatives. Manually inspect matched payloads and nearby fields to identify source and sink.
   - Verify redaction failure modes: nested objects, arrays, exception messages, stack locals, request bodies, headers, URL query strings, breadcrumbs, attachments, free text, and fallback serializers.

7. Test controls and failure behavior.
   - Confirm logging failures do not reveal sensitive data through fallback logs, console output, local files, crash loops, retries, queues, or support bundles.
   - Confirm redaction is deny-by-default for sensitive domain types or allowlist-based for outbound telemetry fields.
   - Confirm support impersonation and exports produce access logs, approval records, bounded scopes, expiry, and least-privilege views.
   - Confirm deletion/retention handles vendor-side data, backups, warehouses, tickets, crash attachments, replay sessions, and derived analytics.

8. Classify and report.
   - Report confirmed sentinel or sensitive-field exposure as findings.
   - Report unknowns separately as missing evidence, not as passing controls.
   - For no-match results, state only that tested artifacts did not contain configured sentinels. Do not claim telemetry is leak-free.

## Static Search Seeds

Use these as starting points, then adapt to the stack:

- SDK imports/config: `sentry`, `crashlytics`, `firebase.analytics`, `analytics.track`, `segment`, `mixpanel`, `amplitude`, `posthog`, `datadog`, `newrelic`, `bugsnag`, `rollbar`, `otel`, `opentelemetry`, `fullstory`, `logrocket`.
- Logging: `logger.`, `log.`, `console.`, `print(`, `NSLog`, `Log.`, `Timber`, `zap`, `zerolog`, `winston`, `pino`, `LogInformation`, `tracing::`, `span!`, `event!`.
- Risky payloads: `request.body`, `response.body`, `headers`, `authorization`, `cookie`, `password`, `token`, `secret`, `privateKey`, `recovery`, `seed`, `content`, `message`, `title`, `filename`, `search`.
- Crash context: `setUser`, `setTag`, `setContext`, `setExtra`, `setCustomKey`, `recordException`, `captureException`, `breadcrumb`, `attachment`, `minidump`, `stack`, `cause`.
- Support/admin: `impersonate`, `sudo`, `admin`, `support`, `ticket`, `debug bundle`, `export`, `download`, `DSAR`, `data export`, `audit log`.
- Redaction: `redact`, `mask`, `scrub`, `sanitize`, `filter`, `pii`, `sensitive`, `allowlist`, `denylist`, `SafeLog`, `Secret`, `Sensitive`.

## Failure Signals

Create a finding when evidence shows:

- protected user content, sensitive metadata, keys, recovery material, credentials, authorization headers, cookies, or session ids in logs, traces, crash reports, analytics, support exports, tickets, or third-party payloads;
- request/response body logging includes claim-protected fields or secrets;
- exception messages, validation errors, stack locals, breadcrumbs, crash custom keys, or debug attachments include sensitive free text;
- analytics event names, properties, user properties, metric labels, trace attributes, or feature-flag contexts include high-cardinality identifiers or content-derived values;
- support impersonation exposes encrypted/private content without strong authorization, expiry, audit logging, user visibility, or claim disclosure;
- support export/debug bundles bypass redaction paths used by primary APIs;
- redaction occurs only after third-party ingestion when claims or obligations require pre-collection minimization;
- opt-out or regional privacy modes do not suppress analytics/crash/support collection as claimed;
- logs or telemetry are retained, indexed, shared, or searchable beyond the stated operational purpose;
- sentinel absence is used as proof of zero knowledge, leak-free operation, or complete privacy.

## Severity Guidance

Use `../audit-common/SKILL.md` as authoritative. Typical mappings:

- `critical`: telemetry/support systems expose key material, recovery secrets, or plaintext content at scale in a way that defeats a central zero-knowledge/E2EE claim.
- `high`: sensitive content, credentials, tokens, cookies, authorization headers, keys, or recovery material leak to logs, traces, crash reports, analytics, support exports, or third parties.
- `medium`: sensitive metadata, durable identifiers, content-derived event properties, support impersonation gaps, or claim-conflicting diagnostic collection leak with meaningful privacy impact.
- `low`: incomplete disclosure, unclear retention, weak redaction tests, broad log access, low-sensitivity overcollection, or hardening gaps without confirmed sensitive exposure.
- `informational`: scoped no-match result, positive control evidence, limitation, or recommended follow-up without a concrete failure.

## Limitations To State

- Static code review cannot prove runtime payloads are clean across environments, sampling modes, crash paths, support paths, or vendor-side processors.
- Sentinel absence in sampled logs, filtered dashboards, or partial crash payloads is limited negative evidence.
- Vendor-side scrubbing may reduce stored exposure but does not prove data was minimized before collection or third-party transmission.
- Hashing, tokenization, pseudonymisation, stable IDs, or deterministic encryption can remain linkable and may still be personal data.
- Production retention, backup, warehouse, replay, support-ticket, and subprocessors may differ from local or staging evidence.
- Debug builds, feature flags, regional modes, consent states, and emergency support procedures can materially change behavior.

## Output Checklist

- Scope, claims, environments, accounts, consent states, and out-of-scope systems are explicit.
- SDKs, logging wrappers, crash reporters, traces, metrics, analytics events, support tools, exports, and pipelines are inventoried.
- Sentinel classes and flows are described without revealing full sentinel values.
- Findings include direct evidence, redacted excerpts, affected claims, impact, root-cause hypothesis, fix, retest, and limitations.
- Unknowns and missing artifacts are listed separately.
- Final output avoids exposing live customer content, credentials, tokens, secrets, or full sentinel values.

## Research Anchors

The baseline reference file summarizes these primary sources; verify current versions when citing user-facing reports:

- OWASP Logging Cheat Sheet.
- NIST SP 800-92, Guide to Computer Security Log Management.
- FTC Protecting Personal Information: A Guide for Business.
- European Commission Data Protection Explained.
- OpenTelemetry semantic convention guidance for sensitive attributes.
- Sentry data scrubbing documentation.
- Firebase Android data disclosure and Crashlytics collection documentation.
- Apple App Privacy Details and privacy manifest documentation.
