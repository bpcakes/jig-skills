# Logging Privacy Baselines

Use this file only when source-backed language is needed for telemetry, crash, logging, support, or diagnostics findings.

## Source-Backed Principles

- OWASP Logging Cheat Sheet treats logs as security-relevant application features and says selected frameworks may write locally, remotely, or both. It warns to exclude legally unsanctioned data and to protect collected logs because they may contain personal, sensitive, code, and business information. It also calls for masking, sanitizing, hashing, or encryption during examination/extraction; testing logging failures; checking access controls; and performing due diligence before sending logs to third parties.
- NIST SP 800-92 frames log management as an enterprise lifecycle: establishing log management infrastructure and developing, implementing, and maintaining effective log management processes. Use this to justify checking generation, collection, transport, storage, analysis, retention, and disposal rather than only application call sites.
- FTC Protecting Personal Information emphasizes minimization and retention: do not collect and retain personal information unless it is integral to the product or service; keep sensitive data only while there is a business reason; and maintain retention/disposal rules for data that must be kept.
- European Commission GDPR guidance treats directly or indirectly identifying data as personal data. IP addresses, cookie IDs, advertising IDs, and similar online identifiers can be personal data. De-identified, encrypted, or pseudonymised data remains personal data if re-identification is possible; anonymous data requires irreversible anonymisation.
- OpenTelemetry semantic convention guidance says attributes should have clear benefit and use cases, and if an attribute might contain PII or sensitive information, that must be explicitly called out in the attribute note. Use this to challenge custom high-cardinality or user-content attributes.
- Sentry data scrubbing documentation distinguishes SDK-side sensitive-data management from server-side scrubbing, and describes server-side options that redact before saving in Sentry. Use this to distinguish pre-collection minimization from post-ingestion scrubbing.
- Firebase Android data disclosure documentation notes that Crashlytics can collect developer-defined custom keys, logs, free-text user IDs, non-fatal events with custom stack traces, Analytics breadcrumbs, Remote Config rollout metadata including parameter keys and values, and data from transitive dependencies. Use this to inspect custom Crashlytics context and SDK dependency effects.
- Apple App Privacy Details require developers to know data collected by the app and third-party partners. Apple lists product interaction, identifiers, crash data, performance data, customer support data, user content, search history, and diagnostics as disclosure-relevant data types, and says data sent off device for longer than needed to service a real-time request can be collection. Apple privacy manifests are the standard format for app/SDK data-collection practices, and Apple reminds developers they are responsible for third-party SDK code they integrate.

## Sensitive Data Exclusion Checklist

Treat these as high-risk in logs, traces, telemetry, crash reports, support exports, and tickets:

- Credentials, access tokens, refresh tokens, API keys, cookies, authorization headers, session IDs, DSNs with embedded secrets, webhook secrets.
- Private keys, symmetric keys, wrapped keys, recovery secrets, seed phrases, backup codes, OTPs, passphrases.
- User-authored content, free-form support text, attachments, document/message bodies, photos/videos/audio, search terms.
- Sensitive metadata: titles, filenames, folder paths, tags, recipients, contacts, social graph, precise timestamps, location, device identifiers, IP addresses.
- Payment, government, health, biometric, child, or other regulated data.
- High-cardinality or durable identifiers in event names, metric labels, trace attributes, log fields, feature flags, or user properties.
- Request/response bodies, URL query strings, headers, exception messages, stack locals, breadcrumbs, debug attachments, and replay payloads that include any of the above.

## Control Expectations

- Prefer allowlisted telemetry fields over object dumping or denylist-only redaction.
- Redact before collection and before third-party transmission when possible; do not treat vendor-side scrubbing as equivalent to minimization.
- Make sensitive domain types hard to log accidentally, for example by using explicit safe renderers or redacted display implementations.
- Avoid high-cardinality user-derived values in metric labels, trace attributes, event names, and tags.
- Keep support impersonation scoped, approved, expiring, auditable, and visible according to the product claim.
- Include log and telemetry systems in tests: normal flows, error flows, crash flows, connectivity loss, full disk/write failure, vendor outage, and redaction edge cases.
- Define retention and deletion for logs, crash payloads, replay sessions, support tickets, exports, warehouse copies, backups, and vendor processors.

## Source URLs

- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- NIST SP 800-92: https://csrc.nist.gov/pubs/sp/800/92/final
- FTC Protecting Personal Information: https://www.ftc.gov/business-guidance/resources/protecting-personal-information-guide-business
- European Commission Data Protection Explained: https://commission.europa.eu/law/law-topic/data-protection/data-protection-explained_en
- OpenTelemetry semantic convention guidance: https://opentelemetry.io/docs/specs/semconv/how-to-write-conventions/
- Sentry Data Scrubbing: https://docs.sentry.io/security-legal-pii/scrubbing/
- Firebase Android data disclosure: https://firebase.google.com/docs/android/play-data-disclosure
- Apple App Privacy Details: https://developer.apple.com/app-store/app-privacy-details/
- Apple Privacy Manifest Files: https://developer.apple.com/documentation/bundleresources/privacy-manifest-files
- Apple Third-Party SDK Requirements: https://developer.apple.com/support/third-party-SDK-requirements/
