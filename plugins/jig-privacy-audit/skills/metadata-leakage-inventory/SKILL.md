---
name: metadata-leakage-inventory
description: Inventory metadata leakage in privacy, E2EE, zero-knowledge, messaging, collaboration, sync, telemetry, and claims audits. Use to map metadata to linkability, identifiability, behavioral inference, social graph, timing, and minimization risks.
---

# Metadata Leakage Inventory

Use this skill to audit metadata that remains visible even when content is encrypted or redacted. The goal is to produce an evidence-backed inventory, explain privacy risk from metadata alone, compare observed behavior to product claims and privacy-policy statements, and recommend minimization.

## Required Setup

1. Read `../audit-common/SKILL.md` before finalizing severity, confidence, limitations, redactions, or findings.
2. Identify the exact claim set: product UI, marketing site, security whitepaper, help docs, privacy policy, retention policy, subprocessor list, app-store text, and in-product consent or telemetry settings.
3. Load `references/metadata-leakage-baselines.md` when you need source-backed terminology or citations.
4. Use `templates/metadata-leakage-report.md` for human-readable deliverables.

## Metadata Categories

Classify each row with one primary category and any relevant risk tags.

- `operational_metadata`: Plaintext metadata required for routing, authorization, abuse prevention, billing, sync, reliability, or legal/account administration within the stated privacy model. It still needs purpose, retention, access, and precision review.
- `avoidable_metadata`: Plaintext metadata that is not needed for the stated purpose, is too precise, stable, high-cardinality, widely shared, long-retained, content-derived, or available to unnecessary readers.
- `sensitive_metadata`: Metadata that can reveal identity, relationships, activity patterns, location, device state, health/finance/work/religion/politics/sexuality, membership, safety status, secrets, or other sensitive attributes even when message/content bodies are encrypted.
- `claim_contradicting_metadata`: Observed metadata conflicts with an explicit or strongly implied claim such as "we cannot see who you contact", "metadata private", "anonymous", "no tracking", "not shared with third parties", "zero knowledge", "only you can access", or "we collect only what is necessary".
- `unknown`: Evidence is incomplete or contradictory. Unknown is not a pass; state the missing artifact, environment, account role, or test needed.

Suggested tags: `identifier`, `stable-id`, `cross-context`, `content-derived`, `relationship`, `group-membership`, `contact-graph`, `timestamp`, `timing-pattern`, `size-pattern`, `location`, `ip-address`, `device`, `notification`, `presence`, `read-receipt`, `search-index`, `admin-visible`, `third-party`, `retention`, `policy-gap`, `consent-gap`.

## Risk Mapping

For every non-trivial metadata item, map the strongest supported risks.

- `linkability`: Can events, records, sessions, devices, pseudonyms, recipients, tenants, or third-party records be correlated across time or contexts?
- `identifiability`: Can the metadata directly identify a person, or reidentify them through a small anonymity set, unique device/app fingerprint, account join, payment, IP, location, content clue, or external dataset?
- `behavioral_inference`: Can a reader infer habits, interests, work patterns, health status, purchases, travel, feature use, emotional state, or other sensitive behavior from counts, timing, sizes, topics, errors, or interactions?
- `social_graph_exposure`: Can a reader infer contacts, group membership, sender/recipient pairs, collaborator roles, shared folders, invite chains, address-book entries, blocked users, or community membership?
- `timing_inference`: Can a reader infer presence, sleep/work schedule, co-location, message reads, typing, location movement, automated routines, incident response, or event participation from timestamps, order, latency, frequency, polling, or push notifications?

## Evidence To Collect

Prefer artifacts that tie the same metadata field across at least two surfaces.

- Claims and policy: marketing copy, privacy/security pages, policy sections on collection/use/sharing/retention, consent screens, telemetry settings, subprocessor disclosures, help articles.
- API and protocol: OpenAPI/GraphQL/protobuf schemas, request/response headers, auth/session tokens, object IDs, conversation IDs, routing fields, pagination cursors, ETags, websocket events, webhooks.
- Storage and indexing: DB migrations, ORM models, indexes, search documents, cache keys, object-store keys/metadata, queue messages, warehouse models, backup/export schemas.
- Observability and operations: logs, traces, metrics labels, analytics events, crash reports, alert payloads, support/admin views, fraud/abuse tooling, billing and audit logs.
- Client and notifications: local storage, mobile keychain preferences, offline caches, push notification payloads, widgets, share sheets, preview/thumbnail/title generation, OS-level metadata.
- Third parties: SDK payloads, tag managers, CDNs, email/SMS/push providers, payment providers, AI/model providers, analytics, error monitoring, customer support, data warehouses.
- Runtime tests: sentinel metadata values, two-account interaction tests, contact/group mutations, precise timestamp tests, differential tests changing one field at a time, searches for exact/encoded/hashed/truncated/normalized variants.

## Workflow

1. Bound scope. State product area, environment, accounts, user roles, date, included/excluded systems, and whether production-like third parties are in scope.
2. Extract claims. Build a claim table with source, exact promise or policy statement, covered data/metadata, stated purpose, sharing, retention, user controls, and exceptions.
3. Inventory metadata. Enumerate candidate fields and derived signals from schemas, code, captures, storage, observability, notifications, admin/support tools, exports, and third parties.
4. Normalize each item. Record semantic field, observed representation, source/sink, reader, purpose, precision, stability, cardinality, retention, sharing, and transformation.
5. Classify conservatively. Mark operational metadata only when a concrete purpose is supported. Mark avoidable or claim-contradicting metadata when the purpose, precision, retention, reader, or claim alignment fails.
6. Map privacy risks. Assign risk modes from the rubric above and explain the inference path: "Actor can infer X from Y because Z."
7. Compare claims and policy. Check whether observed collection, use, disclosure, retention, and controls match policy/product promises. Treat vague policy language as a limitation unless it conflicts with specific product claims.
8. Recommend minimization. Prefer removing collection or sharing first; then reduce precision, retention, stability, cardinality, reader set, third-party exposure, and derivation from content or contacts.
9. Produce report and findings. Use `MLI-###` finding IDs for concrete leakage, claim conflicts, or materially missing evidence. Separate confirmed findings, hypotheses, limitations, and positive evidence.

## Minimization Recommendations

Choose recommendations that preserve the stated product function with less metadata exposure.

- Do not collect, derive, persist, log, export, or share the metadata if the feature can operate without it.
- Move derivation client-side; encrypt metadata at the application layer; hide titles, filenames, previews, labels, contact aliases, and group names from servers where claims require it.
- Reduce precision: coarse timestamps, rounded sizes, region-level location, fewer device details, lower-cardinality metrics labels, sampled or aggregated analytics.
- Reduce stability: rotate identifiers, partition identifiers by context, use pairwise IDs, avoid global account IDs in third-party tools, expire linkable state.
- Reduce exposure: strip metadata before third-party SDK calls, notifications, webhooks, admin views, exports, support tools, logs, traces, warehouses, and object keys.
- Reduce retention: apply short TTLs, delete after delivery/sync, separate audit/security logs from behavioral telemetry, document backup deletion limits.
- Reduce inference: pad or bucket sizes, batch/delay events, suppress read/typing/presence signals by default, avoid contact discovery uploads, use private set intersection or equivalent when available.
- Add controls and transparency: user-visible settings, consent boundaries, policy updates, internal access controls, processor contracts, tests, alerts for new high-cardinality fields.

## Failure Signals

Report these as findings when supported by evidence:

- Claims say metadata is private, anonymous, not tracked, or not shared, but captures, logs, storage, admin tools, telemetry, or third parties expose identifiers, contacts, recipients, titles, timestamps, locations, devices, or activity.
- A "zero knowledge" or E2EE product leaves relationship, title, filename, preview, search, notification, folder, sharing, or collaboration metadata readable by the server without clear disclosure.
- Stable identifiers link user activity across products, devices, sessions, tenants, third parties, or time periods without necessity or disclosure.
- Logs/traces/metrics contain high-cardinality labels such as email, user ID, conversation ID, document title, filename, recipient, IP address, location, URL query, auth subject, or raw request body.
- Push notifications, email/SMS, webhooks, object names, CDN URLs, or analytics events disclose sensitive metadata outside the encrypted channel.
- Contact discovery, invite, sharing, block, read receipt, presence, or group membership flows reveal a social graph beyond intended recipients.
- Timestamp, ordering, polling, size, or frequency patterns reveal presence, sleep/work schedule, travel, sensitive events, or message reads.
- Retention, backup, export, warehouse, or support copies outlive the stated operational purpose.
- Privacy policy omits a material metadata collection, use, sharing, retention, or user-control behavior observed in the product.
- A field marked hashed, pseudonymous, redacted, or anonymized remains linkable or reversible in the audited context.

## Severity Hints

Use `../audit-common/SKILL.md` as authoritative. Typical mappings:

- `high`: metadata exposes sensitive relationships, precise location, health/finance/safety status, protected-class inference, secrets/tokens, or a central privacy claim contradiction at meaningful scale.
- `medium`: durable identifiers, social graph, content-derived metadata, precise timing/activity, third-party sharing, or policy contradiction creates meaningful linkability, identifiability, or behavioral inference.
- `low`: overcollection, excessive retention, missing controls, ambiguous disclosure, or lower-impact metadata exposure with limited readers or weak evidence.
- `informational`: inventory rows, positive evidence, limitations, or minimization recommendations without a concrete failure.

## Limitations To State

- Metadata absence in a sampled trace does not prove absence across environments, feature flags, error paths, background jobs, or production third parties.
- Encrypted content does not imply encrypted metadata; TLS or encryption at rest does not hide metadata from the receiving service.
- Hashing, pseudonymization, deterministic encryption, truncation, or tokenization may remain linkable or personal data depending on keys, salt, stability, and join context.
- Policy comparison is not legal advice; report factual alignment and gaps, not compliance conclusions.
- Some operational metadata is necessary for routing, abuse prevention, billing, reliability, or legal duties; minimization may reduce precision, retention, or exposure rather than remove it.
- Traffic analysis can infer behavior from timing, size, order, and frequency even when payloads are encrypted and sent through expected endpoints.
