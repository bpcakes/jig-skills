---
name: audit-intake-and-evidence-map
description: Scope privacy, zero-knowledge, and E2EE audits before deeper testing. Use to create an authorized audit scope, evidence checklist, limitations, audit-manifest.json, failure signals, and next privacy-audit skills.
---

# Audit Intake And Evidence Map

Use this skill before narrow privacy, zero-knowledge, E2EE, telemetry, metadata, storage, network, key-management, or remediation audit skills. The output is a scoped audit plan and `audit-manifest.json`; it is not a security certification or final audit report.

## Shared Rules

Read `../audit-common/SKILL.md` before finalizing evidence language, limitations, severity previews, or findings. Reuse its rules and `templates/finding.schema.json` for any finding-like records. Do not duplicate shared severity, evidence-level, or redaction rules here.

Use OWASP ASVS/MASVS and NIST Privacy Framework concepts only as scope framing when useful:

- OWASP ASVS: orient web/API technical verification surfaces.
- OWASP MASVS and MASVS-PRIVACY: orient mobile app privacy, storage, cryptography, networking, and platform surfaces.
- NIST Privacy Framework: orient privacy risk around data processing, individuals' privacy impacts, and outcomes across Identify-P, Govern-P, Control-P, Communicate-P, and Protect-P.

Do not claim standards compliance unless the user explicitly asks for a standards mapping and provides enough evidence for that mapping.

## Required Inputs

Collect or infer these before planning. If a required input is missing, mark it as `unknown` and include an intake question or limitation.

- Product/app name, platform, repo path, deployment target, and environment.
- Authorization: who approved the audit, permitted systems, prohibited systems, production limits, and test-account constraints.
- Audit objective: privacy claim review, E2EE verification, zero-knowledge claim triage, data-flow discovery, telemetry review, storage review, remediation validation, or mixed.
- Claims under test: website copy, privacy policy, security whitepaper, app store disclosures, README, SOC/compliance assertions, or user-provided claims.
- Data classes: user content, account identifiers, device identifiers, contacts, payment data, health/location data, keys, recovery secrets, metadata, logs, analytics events.
- User flows: account creation, login, content creation, sync, sharing, export, delete, recovery, support, crash, analytics opt-in/out, logout, uninstall.
- Evidence sources available: source code, builds, test accounts, proxy/HAR, database snapshots, object storage, logs, telemetry dashboards, CI artifacts, infrastructure config, app store disclosures, policies, diagrams.
- Constraints: timebox, no-network mode, no production access, closed-source binary only, legal restrictions, missing credentials, rate limits, platform tooling limits.
- Output location and format requested by the user.

## Intake Workflow

1. Confirm authorization boundaries before touching live systems, production data, customer content, or third-party services.
2. Inventory claims and convert each claim into a testable audit question.
3. Inventory data classes and map them to flows, storage locations, network paths, logs, telemetry, and third parties.
4. Classify each planned evidence item as available, requested, blocked, or out of scope.
5. Identify refusal conditions and limitations early; do not bury them after the plan.
6. Create `audit-manifest.json` using `templates/audit-manifest.schema.json` and, when useful, `templates/audit-manifest.template.json`.
7. Recommend the next privacy-audit skills based on available evidence and highest-risk claims.

## Evidence Checklist

Populate the manifest with specific artifacts, owners, and collection status. Prefer exact paths, command outputs, request IDs, timestamps, screenshots, and redacted excerpts.

- Claims: privacy policy, marketing pages, app store privacy labels, README/security docs, threat model, cryptography design notes, support docs.
- Source: serializers, API clients, database models, sync engines, crypto modules, key storage, recovery flows, logging wrappers, telemetry SDK calls, feature flags.
- Runtime network: HAR/proxy captures, DNS endpoints, request/response bodies, headers, WebSocket frames, push notification payloads, third-party SDK traffic.
- Runtime storage: local app storage, browser storage, mobile keychain/keystore, SQLite/Core Data/IndexedDB, caches, files, crash dumps, backups, server DB rows, queues, object storage.
- Observability: application logs, server logs, analytics/debug events, crash reports, traces, support tools, admin dashboards.
- Identity and metadata: account IDs, device IDs, IP addresses, contact/social graph, room/channel membership, timestamps, file names, object sizes, sharing metadata.
- Cryptographic materials: key-generation paths, key wrapping, device keys, recovery keys, passphrase/KDF settings, server-held keys, public-key directories, signature or integrity metadata.
- Deletion/export/control: consent state, privacy settings, export artifacts, delete flows, retention jobs, opt-out enforcement.
- Third parties: processors, SDKs, subprocessors, webhook targets, CDN/object storage, analytics, crash, support, messaging, payment providers.

## Refusal And Limitation Rules

Refuse or pause when the request requires unauthorized access, credential bypass, exploitation of unrelated third parties, live customer data inspection, malware, stealth collection, or evasion. Offer a safe alternative such as reviewing local code, test accounts, synthetic data, staging, redacted artifacts, or owner-approved logs.

Record limitations when:

- authorization is ambiguous or excludes a relevant surface;
- evidence is partial, synthetic, stale, sampled, redacted, or owner-attested only;
- traffic capture cannot decrypt TLS, WebSocket, push, or background traffic;
- source code is missing for client, server, crypto, analytics, or infrastructure components;
- tests use a single flow, account, tenant, device, region, build variant, or feature flag state;
- absence of plaintext in one surface is being used only as limited negative evidence;
- a compliance or cryptographic-soundness conclusion would require a broader audit.

## audit-manifest.json

Write a machine-readable manifest for handoff. Use stable IDs so later findings can cite the same claims, flows, evidence, and limitations.

Required top-level sections:

- `audit`: product, objective, requested_by, prepared_by, dates, environment, authorization, and scope boundaries.
- `claims`: testable privacy/E2EE/zero-knowledge statements with source and status.
- `data_classes`: sensitive content, keys, identifiers, metadata, telemetry, and regulated data categories in scope.
- `flows`: user or system flows to test, mapped to claims and data classes.
- `evidence_requests`: artifacts needed, owner/source, status, sensitivity, and redaction notes.
- `evidence_map`: available artifacts mapped to claims, flows, data classes, and likely next skill.
- `limitations`: explicit caveats from this intake.
- `failure_signals`: concrete observations that would trigger findings or deeper audit.
- `recommended_next_skills`: ordered follow-up skills with reasons and prerequisites.

Use `templates/audit-manifest.schema.json` for validation and `templates/audit-manifest.template.json` as a starting point. Keep secrets and live personal data out of the manifest.

## Failure Signals

Treat these as triggers for follow-up findings or deeper testing, not automatic proof without evidence:

- Product claims E2EE, zero knowledge, local-only, private by design, anonymous, or no tracking, but available evidence cannot identify trust boundaries or key custody.
- User content, sensitive fields, keys, recovery secrets, identifiers, or regulated data appear in plaintext network traffic, server storage, local storage, logs, telemetry, crash reports, queues, or third-party payloads.
- Client encrypts data but server can derive, reset, escrow, recover, or silently replace keys without user-visible trust changes.
- Recovery, sharing, search, moderation, support, import/export, notifications, or analytics flows bypass the advertised privacy boundary.
- Metadata materially identifies users, relationships, content type, location, behavior, filenames, object sizes, or communication graph despite stronger privacy claims.
- Consent, opt-out, deletion, retention, or export behavior conflicts with policy/app-store disclosures or observed processing.
- Audit depends on owner assertions where direct source/runtime evidence should be available.

## Recommended Next Skills

Choose only skills that exist in the local privacy-audit suite, or name them as proposed handoff targets if they are not installed yet. Prefer one to three next steps.

- `privacy-claims-field-classifier`: field-level inventory is missing or the product has complex data classes, claims, schemas, storage, or traces.
- `threat-model-and-dataflow-builder`: components, trust boundaries, actors, assets, or data flows are unclear.
- `network-payload-zero-knowledge-test`: captures can test whether sentinels or sensitive fields cross APIs, WebSockets, uploads, sync, push-triggering calls, or third parties in plaintext.
- `client-encryption-boundary-audit`: client code must prove encryption happens before serialization, upload, telemetry, or persistence.
- `crypto-architecture-review`: key hierarchy, custody, wrapping, recovery, device enrollment, sharing, revocation, or server influence is central to the claim.
- `crypto-implementation-static-review`: source code crypto usage, nonce/randomness generation, KDF parameters, or plaintext sinks need static review.
- `metadata-leakage-inventory`: identifiers, graph metadata, timing, object sizes, filenames, or behavioral signals are the primary privacy risk.
- `telemetry-crash-logs-support-leakage-audit`: analytics, logging, crash reporting, traces, support tools, or debug exports are in scope.
- `server-decryptability-and-plaintext-path-audit`: databases, queues, object storage, admin tools, logs, workers, or server-side plaintext/operator access are in scope.
- `vulnerability-disclosure-and-retest-manager`: intake follows a known finding or the user wants remediation tracking and verification criteria for fixes.
- Proposed, not installed: use a handoff note for local/browser/mobile cache audits, claim-policy consistency audits, or key-lifecycle-only audits if they deserve a separate future skill.

## Output Shape

Return:

1. A short scope summary with explicit in-scope and out-of-scope boundaries.
2. Key intake questions if material inputs are missing.
3. A prioritized evidence checklist.
4. Refusals or limitations, if any.
5. The path to `audit-manifest.json` or an inline manifest when no filesystem output is requested.
6. Recommended next skills with reasons.

Avoid audit conclusions in this intake unless directly supported by evidence and normalized through `../audit-common/SKILL.md`.
