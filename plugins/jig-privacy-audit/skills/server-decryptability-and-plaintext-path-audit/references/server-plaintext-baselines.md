# Server Plaintext Baselines

Load this reference when you need source-backed checks, citations, or a deeper checklist for server decryptability and plaintext-path audits.

## Source-Backed Baselines

- Logs are data sinks. OWASP says sensitive personal data, session IDs, access tokens, passwords, database connection strings, encryption keys, primary secrets, payment data, and higher-classification data should usually be removed, masked, sanitized, hashed, or encrypted instead of recorded directly.
- Telemetry is also a data sink. OpenTelemetry states implementers are responsible for protecting sensitive telemetry data and reviewing instrumentation libraries because they can collect and expose sensitive information.
- API responses and admin/support APIs must enforce property-level authorization. OWASP API3:2023 covers APIs that expose sensitive object properties or allow unauthorized modification of those properties.
- Key custody is a privacy boundary. OWASP Key Management recommends mapping components that process or store key material, protecting keys in storage, avoiding plaintext key storage, using vault/HSM-style isolation where appropriate, and accounting for people who can view or control keys.
- Key compromise changes data exposure. NIST SP 800-57 Part 1 frames key management around protection required for keying material, key inventory, key recovery, compromise, and lifecycle decisions.
- Encryption-at-rest placement matters. OWASP Cryptographic Storage distinguishes application-level, database-level, filesystem-level, and hardware-level encryption. Provider or database encryption does not by itself show that the application server cannot read plaintext.
- Sensitive storage minimization is a baseline. OWASP Cryptographic Storage says avoiding storage of sensitive information is the best protection where possible.
- Object storage metadata is a separate plaintext surface. AWS S3 documents system-defined and user-defined object metadata, object keys, tags, and server-side encryption metadata. Google Cloud Storage similarly documents fixed-key and custom object metadata.

## Server-Side Sink Checklist

Search and inspect these sinks before concluding a sentinel is absent:

- API: request bodies, response bodies, validation errors, GraphQL fields, REST DTOs, gRPC/protobuf messages, OpenAPI schemas, middleware-enriched context, webhooks, file upload processors.
- Database: migrations, ORM models, read replicas, JSON columns, full-text indexes, materialized views, triggers, CDC streams, deletion tombstones, audit tables, tenant partitions, warehouses.
- Object storage: object bodies, keys, prefixes, filenames, custom metadata, content type, content disposition, tags, inventory reports, CDN/cache keys, signed URL paths, object manifests.
- Queues and workers: queue payloads, retry metadata, dead-letter queues, workflow state, notification jobs, cron jobs, migration jobs, import/export jobs, AI/OCR/search jobs, webhook deliveries.
- Observability: structured log fields, request/response logging, exception messages, stack traces, trace attributes/events, metric labels, exemplars, crash reports, alert payloads, sampled debug logs.
- Analytics and data science: event properties, warehouse tables, session replay, product analytics, BI dashboards, embedding input/output tables, model prompts, training/evaluation datasets.
- Operator tools: admin routes, support impersonation, moderation queues, customer exports, compliance/legal-hold exports, incident consoles, runbooks, break-glass scripts, REPL tasks.
- Key services: KMS decrypt/unwrap APIs, grants, key policies, IAM roles, HSM operations, envelope encryption helpers, plaintext DEK lifetimes, key export/import, recovery/escrow stores.
- Retention surfaces: backups, replicas, archives, object versions, retention locks, deleted-item stores, support ticket attachments, audit log retention, third-party processor retention.

## Search Patterns

Use language-appropriate search plus runtime artifact queries. Start with broad concepts, then follow aliases.

Plaintext and protected fields:

```text
plaintext|plain_text|cleartext|clear_text|decrypted|decrypt|unencrypted|rawBody|bodyText|contentText|messageText|noteBody|documentText
title|name|filename|preview|snippet|summary|ocr|thumbnail|subject|push|notification|search_text|searchTokens|embedding
```

Key and unwrap paths:

```text
kms.decrypt|DecryptCommand|unwrap|unwrapKey|dataKey|GenerateDataKey|plaintextKey|dek|kek|vaultKey|accountKey|recoveryKey|escrow|breakGlass
```

Logging and telemetry:

```text
logger|log.|console.|trace|span.setAttribute|set_attribute|metric|analytics.track|captureException|requestBody|responseBody|headers|authorization
```

Queues and worker payloads:

```text
enqueue|publish|sendMessage|queue|topic|deadLetter|retry|workflow|job.payload|worker|cron|webhook|email|sms|push
```

Admin and support:

```text
admin|support|impersonate|moderation|export|legalHold|viewDecrypted|viewPlaintext|downloadUserData|customerData
```

Object metadata:

```text
metadata|x-amz-meta|customMetadata|Content-Disposition|Content-Type|objectKey|blobName|fileName|tagging|signedUrl|presigned
```

## Sentinel Search Guidance

- Generate separate sentinels for body content, title/filename, search query, notification text, metadata, recovery material, and key-like material.
- Search exact and normalized forms: lower/upper case, trimmed, whitespace-normalized, Unicode-normalized, URL encoded, JSON escaped, HTML escaped, Base64/base64url, hex, gzip/zlib after decoding, protobuf/Avro decoded, and tokenized words.
- For content-derived systems, search fragments and expected derivatives such as title words, first line, filename stem, OCR text, thumbnail alt text, embedding input logs, search terms, and notification snippets.
- For deletion and retention tests, search immediately after creation, after worker completion, after delete/reset/export, and after the retention period or purge job if in scope.

## Evidence Interpretation

- Direct DB/log/queue/object/admin evidence is high-confidence when the artifact is from the scoped environment and the sentinel is unique.
- A server decrypt call is not automatically a finding if the product claim permits that mode, but it must be disclosed, access controlled, audited, and scoped to the necessary purpose.
- KMS `Decrypt` or data-key generation in app code is a server-decryptability signal. Confirm whether plaintext keys are returned to general app memory, isolated services, or hardware-backed boundaries.
- Encrypted blobs plus server-side searchable plaintext snippets are still plaintext-path evidence for the snippets.
- Absence in current logs does not rule out sampled, rotated, redacted, dropped, or third-party logs.
- Hashes and blind indexes require leakage analysis: deterministic values may reveal equality, dictionary attacks, or small-domain values.

## Source Links

- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- MITRE CWE-532: https://cwe.mitre.org/data/definitions/532
- OpenTelemetry Handling Sensitive Data: https://opentelemetry.io/docs/security/handling-sensitive-data/
- OWASP API Security API3:2023: https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/
- OWASP Key Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html
- OWASP Cryptographic Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
- NIST SP 800-57 Part 1 Rev. 5: https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final
- Amazon S3 object metadata: https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingMetadata.html
- Google Cloud Storage object metadata: https://cloud.google.com/storage/docs/metadata
