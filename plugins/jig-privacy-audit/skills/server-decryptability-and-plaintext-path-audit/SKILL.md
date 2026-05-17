---
name: server-decryptability-and-plaintext-path-audit
description: Audit backend decryptability and plaintext paths that conflict with zero-knowledge, E2EE, client-side encryption, or "only you can read it" claims. Use for handlers, key unwraps, stores, queues, logs, admin tools, and sentinel searches.
---

# Server Decryptability and Plaintext Path Audit

Use this skill to determine whether a backend, operator, support workflow, or server-side dependency can recover user plaintext or key material, or whether protected content is copied into server-readable stores. This is a privacy-claim audit surface, not a full cryptographic proof.

Always read `../audit-common/SKILL.md` before assigning severity, confidence, evidence level, or limitations. Use its redaction rules and shared `templates/finding.schema.json` conventions. Load `references/server-plaintext-baselines.md` when you need source-backed baseline checks or citations. Use `templates/server-plaintext-path-report.md` when the user asks for an audit deliverable.

## Safety Constraints

- Work only on authorized repositories, local/staging environments, test accounts, approved production scopes, and explicitly provided artifacts.
- Use synthetic sentinel content. Do not place real customer content, live credentials, private keys, recovery phrases, regulated PII, medical data, or financial data into test flows.
- Do not exfiltrate, decrypt, unwrap, or print live secrets or customer data. Prove reachability with test fixtures, mocks, canaries, access-control evidence, or redacted metadata whenever possible.
- Treat database dumps, queue captures, object manifests, observability exports, support screenshots, and admin exports as sensitive artifacts.
- Redact tokens, cookies, credentials, keys, private user content, account identifiers, and hostnames unless disclosure is authorized and necessary.

## What This Audit Can And Cannot Prove

This audit can confirm server decryptability, plaintext storage, plaintext processing, or claim conflicts when code paths, runtime artifacts, access policies, or sentinel matches show recoverable plaintext or key material.

It cannot prove a product is zero knowledge or E2EE. Negative sentinel results only mean the searched stores and flows did not contain the tested values. Production-only jobs, delayed workers, sampled telemetry, shadow indexes, retention windows, backups, third-party processors, and emergency access tooling can hide relevant paths.

## Workflow

### 1. Bound The Claim And Trust Boundary

Identify the exact claim, feature, account type, environment, commit/build, and data classes under review. Define who is considered "server side": app services, databases, search/index systems, caches, object stores, queue consumers, notification workers, observability vendors, analytics pipelines, admin/support tools, batch jobs, recovery services, KMS/HSM operators, and third-party processors.

State whether the claim permits server-side plaintext for any mode, such as import/export, OCR, AI summaries, notifications, search, abuse review, migration, escrow recovery, enterprise compliance, or customer support.

### 2. Inventory Server-Side Stores And Workers

Build a concrete list of server-visible sinks:

- request handlers, RPC/GraphQL resolvers, middleware, serializers, validators, webhooks, and file upload endpoints;
- primary databases, read replicas, migrations, materialized views, cache entries, session stores, and feature-flag context;
- object storage bodies, object keys, filenames, tags, content type, content disposition, custom metadata, checksum metadata, and CDN/cache metadata;
- queues, dead-letter queues, workflow engines, retry payloads, cron jobs, notification workers, email/SMS/push payload builders, export/import workers, and webhook deliveries;
- logs, trace spans, metrics labels, crash reports, analytics events, audit logs, warehouse/ETL jobs, BI tables, data science notebooks, and model/embedding inputs;
- admin consoles, support impersonation, moderation/review tools, "view decrypted" buttons, break-glass flows, exports, backups, and incident tooling.

### 3. Trace Plaintext And Key Material

For each protected field or sentinel, follow creation through validation, serialization, encryption/decryption, persistence, indexing, fanout, notification, logging, export, deletion, and retention.

Track these representations separately:

- direct plaintext;
- reversible encodings such as JSON escaping, URL encoding, Base64/base64url, hex, gzip/zlib, protobuf, Avro, multipart form data, or JWT segments;
- content-derived plaintext such as previews, snippets, titles, filenames, OCR text, thumbnails, embeddings input, search tokens, notification text, or audit descriptions;
- deterministic hashes, keyed hashes, blind indexes, encrypted blobs, wrapped keys, KMS ciphertext, key IDs, and access-control metadata.

Encoding is not encryption. Server-side encryption at rest is not zero knowledge if the service can request decrypt, unwrap keys, or read plaintext before encryption.

### 4. Audit Server Decrypt And Key-Unwrap Paths

Search for any code path where the server can recover plaintext or usable keys:

- KMS/HSM decrypt, unwrap, sign, derive, export, import, rewrap, grant, assume-role, and break-glass calls;
- envelope encryption helpers that return plaintext data-encryption keys to app code;
- server-held account/vault keys, recovery secrets, escrow shares, enterprise keys, backup keys, or password-derived keys;
- migration, repair, search, preview, virus-scan, DLP, AI, moderation, backup, export, or support flows that decrypt content;
- debug endpoints, test-only flags, admin-only methods, console tasks, REPL scripts, and incident runbooks;
- IAM policies, service accounts, KMS key policies, grants, audit logs, and separation-of-duties controls.

For each path, record who or what can trigger it, what input is required, whether user consent is required, whether access is logged, whether plaintext leaves the trusted process, and whether the path is reachable in production.

### 5. Run Sentinel Searches Across Server Stores

Use unique synthetic sentinels for content, metadata, filenames, notification text, search terms, key-like values, recovery material, and low-sensitivity controls. Search exact, normalized, encoded, truncated, tokenized, compressed, serialized, and content-derived forms across approved artifacts.

Minimum search surfaces when available:

- relational rows, JSON columns, full-text indexes, document stores, vector/embedding pipelines, cache dumps, and warehouse tables;
- object keys, object metadata, tags, manifests, CDN logs, and object inventory exports;
- queue messages, workflow state, dead-letter queues, worker logs, webhook payloads, and notification payloads;
- application logs, trace attributes/events, metric labels, crash context, analytics events, support audit logs, and admin exports;
- backups, migrations, import/export bundles, search snapshots, and retained deleted-item stores.

Preserve raw evidence privately when authorized. In final output, include sentinel category and artifact location, not the full sentinel value.

### 6. Inspect Outputs And Operator Views

Check whether server-readable outputs expose protected content or content-derived data:

- API responses, admin/support pages, CSV/PDF/JSON exports, audit trails, compliance exports, moderation queues, incident reports, emails, SMS, push notifications, webhooks, and third-party callbacks;
- search results, snippets, thumbnails, title lists, recent-activity feeds, autocomplete, analytics dashboards, BI reports, and model prompts/responses;
- error messages, exception values, structured logs, tracing attributes, metric labels, sampling exemplars, and alert payloads.

Do not treat "admin only" or "support only" as non-server-readable. Record whether access is gated, justified, least-privilege, audited, temporary, and aligned with the claim.

### 7. Classify Failure Signals

Report concrete failures as findings:

- server code can decrypt claimed E2EE/zero-knowledge content or unwrap keys without user-held secrets;
- plaintext protected content appears in DB rows, object metadata, queues, caches, indexes, logs, traces, metrics, analytics, notifications, exports, backups, admin tools, or third parties;
- content-derived data appears where the claim implies content privacy, such as snippets, filenames, OCR, embeddings, previews, push text, email subject/body, or search tokens;
- key material, recovery secrets, KMS data keys, wrapped-key plaintext, passwords, tokens, or Authorization headers appear in logs, traces, queues, analytics, or support tooling;
- workers, migrations, retries, DLQs, or webhooks bypass encryption/redaction used by primary APIs;
- break-glass, impersonation, enterprise recovery, legal hold, or support access defeats the claim without clear disclosure, authorization, logging, and retention limits;
- sentinel values are found in server-side stores after deletion, account reset, export, backup, or retention expiry expectations.

## Severity Guidance

Use `../audit-common/SKILL.md` as authoritative. Typical mappings:

- `critical`: service/operator/support, a compromised server role, or a server-triggered workflow can recover protected user plaintext or keys at scale despite a central E2EE/zero-knowledge claim.
- `high`: sensitive plaintext, key material, recovery secrets, credentials, or claimed encrypted fields leak into server stores, logs, telemetry, queues, admin/support tools, exports, or third parties.
- `medium`: sensitive metadata or content-derived data leaks into server-readable indexes, notifications, object metadata, analytics, traces, or search systems contrary to the claim.
- `low`: missing inventory, unclear escrow/support disclosure, overbroad KMS grants, weak audit logging, retention ambiguity, or test gaps without confirmed plaintext exposure.
- `informational`: scoped positive evidence, a limitation, or a follow-up recommendation without a concrete failure.

## Output Guidance

Use finding IDs like `SERVER-PLAIN-001`. For each finding include:

- affected claim and protected data class;
- exact server-side surface and artifact path, query, row, queue, object key, log id, trace id, admin route, or KMS/API call;
- plaintext class: `direct_plaintext`, `encoded_plaintext`, `content_derived_plaintext`, `server_decrypt_path`, `key_unwrap_path`, `operator_plaintext_view`, or `retained_plaintext`;
- evidence level and confidence from `../audit-common/SKILL.md`;
- reproduction or retest steps using synthetic sentinels;
- who can access or trigger the path;
- impact, root-cause hypothesis, recommended fix, and limitations.

For no-match results, say only that the searched artifacts did not contain the configured sentinels. Do not claim that the backend cannot decrypt or that no plaintext exists.

## Remediation Patterns

Recommend fixes that preserve the product model:

- move encryption, decryption, search-token creation, preview generation, and notification text generation to trusted clients when the claim requires it;
- remove plaintext fields, object metadata, queue payload fields, log attributes, analytics properties, and admin views; migrate or purge historical copies where feasible;
- replace plaintext search/indexing with client-side search, encrypted indexes, blind indexes with documented leakage, or explicitly disclosed server-readable search;
- keep envelope decryption inside KMS/HSM or isolated services and prevent app code from receiving plaintext keys when the privacy claim depends on that boundary;
- narrow KMS/IAM grants, add separation of duties, break-glass approval, user consent, audit logs, alerting, and retention controls for allowed access paths;
- add regression tests that create synthetic sentinels and scan server-side stores, logs, queues, telemetry, and outputs.

## Limitations To State

Include relevant limitations explicitly:

- Source review cannot prove runtime absence of plaintext in production.
- Sentinel searches miss untested flows, delayed jobs, sampled telemetry, retention gaps, encrypted binary stores, third-party systems without export, and deleted historical data.
- KMS audit logs and IAM policies show who can request decrypt/unwrap, not necessarily what plaintext was exposed after decryption.
- "Encryption at rest" or provider-managed server-side encryption does not answer whether the application server sees plaintext.
- Hashing, tokenization, deterministic encryption, blind indexing, and embeddings may still leak linkable or content-derived information.
- Backups, replicas, warehouses, and observability systems can retain older plaintext after application fixes.

## Research Anchors

These sources inform the baseline language; verify current versions when citing user-facing reports:

- OWASP Logging Cheat Sheet: data to exclude from logs and sanitization guidance.
- MITRE CWE-532: insertion of sensitive information into log files.
- OpenTelemetry "Handling sensitive data": telemetry implementers are responsible for sensitive-data review, minimization, and attribute deletion/redaction.
- OWASP API Security Top 10 2023 API3: APIs that expose sensitive object properties can disclose data.
- OWASP Key Management and Cryptographic Storage Cheat Sheets: key inventory, storage, accountability, and minimizing sensitive storage.
- NIST SP 800-57 Part 1 Rev. 5: key-management guidance, key protection, key recovery, key inventory, and compromise considerations.
- Cloud object-storage docs such as Amazon S3 and Google Cloud Storage metadata docs: object bodies, keys, fixed metadata, and custom metadata are separate server-visible surfaces.
