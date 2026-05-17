---
name: client-encryption-boundary-audit
description: Audit client-side encryption boundaries in privacy, zero-knowledge, and E2EE products. Use to trace content flows to encryption, serialization, upload, telemetry, local persistence, and plaintext sinks.
---

# Client Encryption Boundary Audit

Use this skill to determine whether protected user content becomes ciphertext before it crosses the intended client encryption boundary. The main question is: for each user-content flow, does plaintext reach crypto before it reaches serializers, upload clients, sync queues, telemetry, logs, local persistence, search indexes, or third-party SDKs?

## Required Setup

1. Read `../audit-common/SKILL.md` before assigning severity, confidence, evidence level, limitations, or finding IDs.
2. Identify the exact privacy claim under test: client-side encryption, E2EE, zero knowledge, encrypted sync, encrypted sharing, encrypted backup, encrypted import/export, or encrypted metadata.
3. Use `references/client-encryption-boundary-baselines.md` when you need source-backed review anchors.
4. Use `templates/client-encryption-boundary-report.md` for audit deliverables and `templates/client-encryption-boundary-finding.schema.json` for machine-readable findings.
5. Coordinate with sibling skills when useful:
   - `../crypto-implementation-static-review/SKILL.md` for primitive/API misuse.
   - `../crypto-architecture-review/SKILL.md` for key hierarchy, recovery, sharing, and server-influence design.
   - `../network-payload-zero-knowledge-test/SKILL.md` for sentinel-based HAR/payload capture.

## Scope

Review paths that handle protected user-created or user-imported content, including:

- create, edit, duplicate, delete/restore, conflict resolution, autosave, drafts, and undo history;
- share, invite, permission changes, link sharing, recipient key wrapping, and revocation updates;
- import, migration, attachment processing, thumbnails, OCR, previews, search indexing, and export/download;
- offline queues, retry queues, background sync, service workers, push handlers, scheduled jobs, and crash recovery;
- API submission, GraphQL variables, RPC DTOs, multipart upload, WebSocket messages, batch sync, telemetry, logs, local databases, files, caches, and browser/mobile secure storage.

Do not treat intentional user-controlled plaintext export as a finding by itself. Do check that exported plaintext is not silently uploaded, logged, cached, or sent to telemetry.

## Boundary Model

For every flow, identify:

- `plaintext source`: UI input, imported file, decrypted record, clipboard, attachment, generated content, or migration reader;
- `encryption point`: exact function/method that encrypts, seals, wraps, or creates the encrypted envelope;
- `serialization point`: JSON/protobuf/form-data/Codable/serde/ORM/request DTO conversion;
- `submission point`: API client, fetch/axios/RPC/WebSocket/upload SDK, background queue, or sync engine;
- `local sink`: storage, cache, file, logs, crash reports, analytics, search indexes, previews, thumbnails, or queues;
- `ciphertext envelope`: version, algorithm, key id, nonce/IV, tag/MAC, AAD/context, ciphertext, and wrapped keys.

The expected order for protected content is:

```text
plaintext source -> validation/normalization -> encryption -> ciphertext envelope serialization -> local/network submission
```

Anything that sends, stores, logs, indexes, or queues protected plaintext before encryption is a candidate finding.

## Workflow

### 1. Build The Flow Inventory

List each protected field and whether the claim covers content, metadata, attachments, filenames, titles, tags, folder names, search terms, timestamps, or sharing graph data. Include both foreground and background variants.

For each user action, record entry points:

- Web/React: form submit handlers, mutations, service workers, IndexedDB/localStorage writers, upload clients, analytics calls.
- iOS/Swift: SwiftUI actions, view models, Codable encoders, URLSession clients, CoreData/SQLite/files, background tasks, crash/analytics SDKs.
- Android/Kotlin: ViewModels, repositories, serializers, Room/SQLite/files, WorkManager, Retrofit/OkHttp, analytics/logcat.
- Backend-assisted clients: desktop sync daemons, CLIs, Electron/Tauri preload bridges, mobile bridges, extensions, and WASM workers.

### 2. Trace Source To Crypto To API

For each flow, follow the protected value by file and line number:

1. From UI/import/decrypt output into domain model or DTO.
2. Through validators, normalizers, markdown/HTML/rendering, attachment transforms, and conflict resolvers.
3. Into the encryption wrapper and encrypted envelope builder.
4. Into serializers and request builders.
5. Into API calls, sync queues, storage writes, telemetry, logs, and third-party SDKs.

Mark reachability as `confirmed`, `likely`, or `unknown`. A static call path is not enough if feature flags, generated code, runtime plugins, or platform bridges decide which path runs.

### 3. Verify Encryption Precedes Serialization And Upload

Look specifically for these order failures:

- serializer/request DTO is built from plaintext before encryption;
- encryption is applied only to a nested field while surrounding protected fields remain plaintext;
- request body, GraphQL variables, multipart metadata, or batch sync includes protected plaintext;
- background queue persists plaintext and encrypts only at send time;
- retry, conflict, autosave, draft, import staging, or migration path skips encryption;
- upload helper accepts both plaintext and ciphertext types without type-level separation;
- "encoding" such as base64, URL encoding, gzip, protobuf, or JWT is mistaken for encryption;
- server API accepts plaintext for a field that product claims is client-encrypted.

### 4. Check Plaintext Sinks

Search for protected field names, sentinel values, DTO names, and decrypted model types flowing into:

- logs, debug traces, error messages, crash reports, screenshots, analytics, OpenTelemetry attributes, A/B testing, session replay, and support tooling;
- localStorage, sessionStorage, IndexedDB, Cache API, service workers, SQLite, CoreData, Room, Realm, plist/preferences, files, temp directories, browser downloads, and keychain/keystore misuse;
- search indexes, thumbnails, previews, OCR output, clipboard, notifications, URL paths/query strings, deep links, and share sheets;
- queues, job payloads, offline stores, sync journals, retry buffers, and WebSocket reconnect buffers.

Treat test fixtures as lower risk unless they ship, seed production, or prove production code serializes plaintext.

### 5. Run Targeted Dynamic Tests

Use synthetic sentinels for protected content and metadata. Capture:

- request and response payloads for create/edit/share/import/export/sync flows;
- local storage snapshots before encryption, after save, after offline retry, after crash/restart, and after logout;
- app logs, crash/analytics payloads, telemetry spans, and third-party requests;
- queued background jobs and retry buffers where authorized.

Use the sibling network-payload skill for HAR/payload scanning. Absence of a sentinel in one capture is only limited negative evidence.

### 6. Review Boundary Tests

Look for tests that prove boundary order:

- unit tests asserting serializers receive only encrypted envelope types;
- integration tests intercepting API clients and checking protected sentinels are absent;
- offline/background tests verifying queues persist ciphertext;
- telemetry/log tests with sentinel redaction assertions;
- import/export tests separating intentional plaintext export from sync/upload paths;
- regression tests for newly found plaintext sinks.

Missing tests are usually a limitation or low/medium finding unless the code evidence shows a reachable leak.

### 7. Classify Failure Signals

High-signal failures include:

- protected sentinel appears in outbound API, response echo, telemetry, logs, local DB/file/cache, or third-party payload;
- encryption function is called after API serialization, upload, local queue persistence, or telemetry emission;
- protected plaintext and ciphertext share the same DTO/storage type without a boundary check;
- background sync, import, export, or sharing path bypasses the normal encrypting save path;
- local search/preview/attachment pipeline stores plaintext where the claim says content or metadata is encrypted;
- feature flag, remote config, server-supplied schema, or migration can disable client encryption without user-visible evidence.

## Evidence Commands

Adapt these from the repository root:

```bash
rg -n --hidden -S "encrypt|decrypt|seal|open|wrap|unwrap|cipher|nonce|iv|aad|ciphertext|plaintext|client.?encrypt|end.?to.?end|zero.?knowledge" .
rg -n --hidden -S "fetch\(|axios|URLSession|OkHttp|Retrofit|GraphQL|WebSocket|multipart|FormData|serialize|JSON\.stringify|Codable|serde|protobuf|mutation|sync" .
rg -n --hidden -S "localStorage|sessionStorage|IndexedDB|Cache API|sqlite|CoreData|Room|Realm|writeFile|FileManager|SharedPreferences|UserDefaults|queue|retry|offline|background" .
rg -n --hidden -S "console\.|logger|Log\.|NSLog|print\(|analytics|telemetry|OpenTelemetry|span\.|crash|Sentry|Datadog|Amplitude|Segment|session replay" .
```

Also search for product-specific protected field names, DTO names, API paths, and sentinel values.

## Severity Hints

Use `../audit-common/SKILL.md` as authoritative. Boundary-specific defaults:

- `critical`: server/operator/third party can recover protected user plaintext or keys at scale despite a central zero-knowledge/E2EE claim.
- `high`: protected content, claimed encrypted fields, key material, recovery secrets, or sensitive metadata reaches API, storage, telemetry, logs, queues, or third parties in plaintext.
- `medium`: meaningful metadata/plaintext exposure in a limited flow, missing boundary enforcement for high-risk paths, or background/offline paths likely storing plaintext.
- `low`: missing tests, ambiguous type boundaries, debug-only plaintext with production gating evidence, or documentation gaps.
- `informational`: positive evidence or no observed sentinel match within stated limitations.

Use finding IDs like `CLIENT-ENC-001`.

## Output

For each finding include:

- affected claim, flow, field, and platform/client;
- plaintext source, encryption point, serialization point, submission/local sink, and observed order;
- file paths and line numbers or dynamic artifact IDs;
- redacted excerpts and sentinel category, not full secret values;
- impact, root-cause hypothesis, recommended fix, retest steps, and limitations.

Positive evidence should be separate from findings and state the exact flow tested. Do not conclude the product is zero knowledge or cryptographically sound from this audit alone.

## Limitations

State untested clients, platforms, feature flags, generated code, minified bundles, remote configuration, mobile-only paths, service workers, background jobs, certificate pinning, unavailable HAR bodies, encrypted binary protocols, production-only telemetry, and owner-provided assumptions. Client-boundary review does not prove primitive correctness, key safety, malicious-update resistance, endpoint security, or recipient behavior after decryption.
