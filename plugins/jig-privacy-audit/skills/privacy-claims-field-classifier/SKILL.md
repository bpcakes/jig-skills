---
name: privacy-claims-field-classifier
description: Classify fields against privacy and encryption claims across schemas, APIs, migrations, frontend models, logs, traces, and storage. Use to produce an evidence-backed privacy field matrix.
---

# Privacy Claims Field Classifier

Use this skill to map product claims like "end-to-end encrypted", "zero knowledge", "metadata private", "we only store what is needed", or "not logged" to concrete fields observed in code, contracts, storage, and traces.

Reference `../audit-common/SKILL.md` for evidence levels, severity, redaction, limitations, and the shared finding schema. Do not repeat or weaken those rules.

## Output

Produce a privacy field matrix and, when warranted, findings. Use `templates/privacy-field-matrix.md` as the preferred matrix format.

Every row should answer:

- What is the field?
- Where did it appear?
- What product claim or expectation does it affect?
- Who can read it in the observed system state?
- Is it necessary for an operational purpose?
- What classification is supported by evidence?
- What remains unknown?

## Field Classes

Use exactly one primary class per row.

- `encrypted_content`: User-authored or user-imported content is ciphertext before it reaches a server, shared store, telemetry system, queue, or trace collector, and observed server-side artifacts do not expose recoverable plaintext. Examples: note body, document text, file bytes, message body, attachment payload.
- `encrypted_metadata`: Metadata about content, relationships, or user activity is protected from the audited server/operator or third party by application-layer encryption, sealed routing, private metadata protocol design, client-only keys, or equivalent evidence. Examples: encrypted conversation title, encrypted sender metadata, encrypted folder name, encrypted thumbnail, encrypted label.
- `plaintext_operational_metadata`: Plaintext fields needed for the service to operate, abuse-prevent, bill, route, sync, authorize, or debug within the stated privacy model. Examples: account id, tenant id, coarse timestamps, ciphertext length, protocol version, delivery destination, rate-limit bucket, payment status.
- `avoidable_plaintext_leakage`: Plaintext sensitive content, sensitive metadata, identifiers, secrets, or high-cardinality linkage fields appear where the claim, design, or business need does not justify them. This includes logs, traces, analytics, crash reports, database columns, indexes, search projections, queues, webhooks, third-party SDKs, admin views, or API responses.
- `unknown`: Evidence is incomplete, contradictory, generated, environment-dependent, or too indirect to classify. Unknown is not a pass; list the missing artifact or test needed.

Secondary tags may be added in a separate column, for example `personal_data`, `pseudonymous`, `content-derived`, `secret`, `third-party`, `derived-index`, `cache`, `retention-risk`, `claim-conflict`, `test-only`.

## Baseline Reasoning

Use these principles when deciding whether plaintext is acceptable:

- Treat personal data broadly. Direct identifiers, online identifiers, device identifiers, IP addresses, cookie ids, precise location, and combinations that identify a person can be personal data.
- Encryption or pseudonymisation does not automatically remove privacy obligations if re-identification remains possible.
- Data minimization matters: if a field is not needed for the stated purpose, collection, storage, or logging can be a leakage finding even when it is "only metadata".
- Logs and traces are data sinks. Sensitive personal data, access tokens, session ids, authentication secrets, database connection strings, encryption keys, and payment or government identifiers should not be logged.
- TLS proves transport protection, not field-level encryption or zero knowledge. A TLS-protected JSON request body containing plaintext content is still plaintext to the receiving service.
- Encrypted content and encrypted metadata are distinct. Some protocols encrypt message content while leaving routing, timing, size, recipient, sender, title, thumbnail, or sharing metadata visible.
- Operational metadata can be valid, but require purpose, retention, access, and minimization notes. High-cardinality or content-derived metadata should be scrutinized.

## Evidence Collection

Inspect only authorized repositories, environments, artifacts, and test accounts. Prefer evidence that links the same field across at least two surfaces.

Static surfaces:

- Source schemas: protobuf, GraphQL, OpenAPI, JSON Schema, Avro, TypeScript interfaces, Swift/Kotlin models, form definitions, validation schemas.
- Persistence: DB migrations, ORM models, indexes, search mappings, cache keys, object metadata, queues, warehouse models, admin exports.
- Crypto paths: encrypt/decrypt call sites, key ownership, serialization order, associated data, client/server boundaries, derived fields.
- Observability: logger calls, trace attributes, metrics labels, crash report context, analytics events, feature flag evaluation context.
- Frontend/mobile: request builders, local storage, sync models, offline caches, previews, thumbnails, notification payloads.

Dynamic surfaces:

- HAR or proxy captures, server logs, trace spans, analytics payloads, DB snapshots, queue messages, object metadata, crash reports, export files.
- Sentinel tests: create unique content and metadata values, exercise sync/search/share/error flows, then search artifacts for exact, normalized, encoded, truncated, hashed, or tokenized forms.
- Differential tests: compare artifacts after changing only one field to identify derived plaintext, lengths, counters, previews, hashes, or indexes.

## Classification Procedure

1. Identify claims and scope. Quote or summarize the exact claim, source, product area, environment, account, and test data. If no explicit claim exists, state the privacy expectation being tested.
2. Build an inventory. List candidate fields from contracts, code models, migrations, traces, and runtime artifacts. Normalize aliases such as `body`, `content`, `ciphertext`, `payload`, `preview`, `title`, `name`, `displayName`, `metadata`, `properties`, `attributes`.
3. Trace each field. Follow creation, serialization, encryption, transport, persistence, indexing, analytics, logging, and read paths. Note which principal can read plaintext: client, service, operator, database admin, support admin, third-party processor, recipient, public link holder.
4. Classify conservatively. Use the strongest direct evidence available. If evidence conflicts, mark the row `unknown` or `avoidable_plaintext_leakage` and explain the conflict.
5. Judge necessity. For plaintext fields, identify the operational purpose and whether a lower-precision, lower-cardinality, client-only, encrypted, hashed, tokenized, delayed, or non-retained form could satisfy it.
6. Produce the matrix. Include evidence references, confidence, affected claim, limitation, and retest action per row.
7. Emit findings. Use the shared finding schema for concrete claim conflicts or leakage. Prefix finding ids with `PCFC`, for example `PCFC-001`.

## Decision Heuristics

Classify as `encrypted_content` when:

- plaintext is encrypted before network/storage boundary crossing;
- server-side storage, logs, and traces contain ciphertext or opaque blobs only;
- keys needed to decrypt are unavailable to the audited server/operator in the tested design.

Classify as `encrypted_metadata` when:

- metadata is encrypted or hidden from the audited service beyond what routing/protocol operation requires;
- the field is content-adjacent or relationship/activity-revealing, not merely payload bytes;
- evidence shows plaintext metadata is absent from storage, logs, traces, indexes, and third parties.

Classify as `plaintext_operational_metadata` when:

- the field is plaintext and intentionally available to the service;
- there is a clear operational purpose tied to routing, authorization, billing, fraud prevention, sync, or reliability;
- retention, access, precision, and cardinality are proportionate to that purpose.

Classify as `avoidable_plaintext_leakage` when:

- claimed encrypted/private fields appear in plaintext in APIs, DB columns, indexes, logs, telemetry, traces, queues, crash reports, admin tools, exports, or third parties;
- user content is copied into previews, titles, embeddings, search indexes, analytics labels, exception messages, notifications, or object names without a documented privacy exception;
- identifiers or linkable metadata are unnecessarily high-cardinality, long-lived, precise, or shared with third parties;
- encryption keys, recovery secrets, access tokens, session identifiers, or authorization headers appear in logs or traces;
- a field is only protected by TLS or "encryption at rest" while the claim implies client-side, application-layer, E2EE, or zero-knowledge protection.

Classify as `unknown` when:

- only type names or generated code are available;
- encryption is claimed but key ownership or call order is not verified;
- no runtime artifacts were captured for the relevant flow;
- production behavior may differ from local/staging;
- redaction, hashing, tokenization, or deterministic encryption cannot be distinguished from plaintext without more evidence.

## Failure Signals

Report concrete failures as findings, not just matrix notes:

- Plaintext user content crosses a server/API boundary contrary to an E2EE, zero-knowledge, client-encrypted, or "only you can read it" claim.
- Content-derived plaintext appears in a different field: preview, snippet, title, filename, alt text, notification, search index, embedding input, model prompt, metric label, trace attribute, or object key.
- Metadata advertised as private is visible to the service or third party: sender, recipient, group membership, item title, folder path, sharing target, precise timestamp, location, device id, IP address, contact graph, or collaboration thumbnail.
- Logs, traces, analytics, crash reports, or support/admin tools expose sensitive personal data, secrets, tokens, keys, recovery material, authorization headers, request/response bodies, or decrypted payloads.
- DB migrations or indexes create plaintext copies of fields that upstream contracts call encrypted.
- API contracts accept both `plaintext` and `ciphertext` forms without server rejection, clear naming, or tests.
- Background jobs, migrations, queues, webhooks, exports, or warehouse pipelines bypass encryption/redaction paths used by primary APIs.
- Test fixtures or debug builds contain real user content or production-like secrets.
- Retention or replication of plaintext outlives the stated operational purpose.

## Severity Guidance

Use `../audit-common/SKILL.md` as authoritative. Typical mappings:

- `critical`: service/operator or attacker can recover plaintext content or key material at scale despite a central zero-knowledge/E2EE claim.
- `high`: sensitive content, secrets, keys, tokens, or recovery material leak in plaintext to storage, network, logs, traces, telemetry, queues, or third parties.
- `medium`: sensitive metadata, content-derived summaries, relationship data, precise location, durable identifiers, or claim-conflicting indexes leak in plaintext.
- `low`: ambiguous naming, missing tests, weak documentation, retention uncertainty, or lower-impact metadata overcollection.
- `informational`: matrix-only classification, limitation, positive evidence, or recommended follow-up without a concrete failure.

## Limitations To State

Include relevant limitations explicitly:

- Static review cannot prove runtime encryption or absence of plaintext in unseen environments.
- Sentinel absence does not prove correct cryptography, only that the tested value was not found in searched artifacts.
- TLS captures may hide on-the-wire data from the auditor; use application logs, client instrumentation, test builds, or endpoint captures when authorized.
- Hashing, tokenization, deterministic encryption, or pseudonymisation may remain linkable and may still be personal data.
- Key custody, recovery flows, server-side rendering, search, AI processing, support tooling, and collaboration modes often change classification.
- Sampling gaps in traces, logs, queues, data warehouses, and third-party SDKs can miss intermittent leakage.

## Matrix Requirements

For each row include at least:

- field name and normalized semantic field;
- source surface and artifact path or capture id;
- observed representation;
- class;
- plaintext readers;
- operational purpose;
- affected claim;
- evidence references;
- confidence;
- limitation or retest.

When reporting unknowns, group them separately under "Open Evidence Needed" so they do not look like passing controls.

## Research Anchors

These sources inform the skill's baseline language; verify current versions when citing in user-facing reports:

- NIST SP 800-122 for PII identification and context-based confidentiality protection.
- European Commission GDPR explainer for broad personal data, encrypted/pseudonymised data, and anonymisation boundaries.
- FTC Protecting Personal Information guide for inventory, minimization, protection, disposal, and incident planning.
- OWASP Logging Cheat Sheet for event logging purpose and data that should be excluded from logs.
- IETF RFC 8446 for the distinction between transport encryption and visible record metadata.
- IETF RFC 9420 and Signal sealed sender design notes for examples separating encrypted content from metadata protection.
