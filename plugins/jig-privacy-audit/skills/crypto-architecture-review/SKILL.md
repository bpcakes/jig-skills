---
name: crypto-architecture-review
description: Review E2EE and zero-knowledge cryptographic architecture. Use for key hierarchy, AEAD/nonces, KDFs, wrapping, multi-device, recovery, sharing, revocation, metadata, and server-influence claims.
---

# Crypto Architecture Review

## Overview

Review whether an E2EE or zero-knowledge design supports its privacy claims and whether the implementation evidence matches the design. This skill is for architecture and implementation review; it is not a substitute for professional cryptanalysis.

## Required Setup

1. Read `../audit-common/SKILL.md` before assigning severity, confidence, evidence level, or limitations.
2. Identify the product claims under review: E2EE, zero knowledge, client-side encryption, encrypted backup, secure sharing, encrypted metadata, recovery, or operator access limits.
3. Load `references/crypto-review-baselines.md` when you need standards-backed review points or citations.
4. Use `templates/crypto-architecture-report.md` for report structure when the user asks for an audit deliverable. Use `templates/crypto-architecture-finding.schema.json` only when machine-readable crypto-specific finding details are useful.

## Evidence To Collect

Prefer direct evidence over diagrams alone:

- threat model, protocol spec, key hierarchy diagram, and recovery/sharing flow docs;
- client crypto call sites, server APIs, migrations, feature flags, and remote config;
- serialized encrypted object formats, key IDs, version fields, AAD fields, and nonce fields;
- device enrollment, public-key directory, backup, recovery, reset, and revocation code paths;
- telemetry/logging/analytics paths near plaintext, keys, recovery secrets, ciphertext, and metadata;
- reproducible test accounts, network traces, local storage snapshots, server rows, and logs with secrets redacted.

## Review Workflow

### 1. Bound the Claim

Map who can see plaintext or key material: user devices, new devices, recovery providers, servers, operators, support tools, queues, web clients, build/update systems, third-party SDKs, and adversarial servers. State what the design does not protect, especially metadata, malicious client updates, compromised endpoints, screenshots/export, and recipients who retain data.

### 2. Trace the Key Hierarchy

List each root key, identity key, device key, account/vault key, data-encryption key, key-encryption key, conversation/group key, recovery key, and wrapping key. For each key, record generation source, derivation inputs, storage location, wrapping parent, rotation trigger, destruction path, and which party can cause or observe changes.

Look for missing domain separation, one key used for multiple purposes, server-generated user secrets, undocumented key IDs, unauthenticated public keys, and unclear migration behavior.

### 3. Check Primitives And Binding

Prefer vetted library constructions. Require authenticated encryption for sensitive content. Verify associated data binds the ciphertext to the intended user/account, tenant, object ID, object type, version, algorithm suite, sender/device, recipient/group, and policy context when those fields affect interpretation.

Flag unauthenticated encryption, ECB, ad hoc MAC composition, custom padding, hand-rolled protocol state machines without tests, unauthenticated algorithm agility, and parsing ambiguity around AAD or headers.

### 4. Review Nonce And IV Strategy

For each AEAD key, prove nonce uniqueness or document why each message uses a one-time key. Check counters for persistence across crashes, restores, multi-process writers, offline edits, imports, forks, and migrations. Check random nonces against collision bounds and library limits. Treat nonce reuse in GCM or stream-cipher AEAD under the same key as high risk unless the mode is explicitly misuse-resistant and the design accounts for its limits.

### 5. Review KDFs And Password-Derived Keys

Distinguish key derivation from password hardening. Check salts, memory/cost parameters, context labels, extract-then-expand patterns, output separation, versioning, and upgrade paths. For password-derived vault/account keys, evaluate the offline attacker model and whether the server can reduce KDF cost, substitute parameters, or test guesses.

### 6. Review Wrapping, Recovery, And Reset

Verify that encrypted keys are wrapped with integrity and clear purpose separation. Recovery must not silently give the server or support staff the ability to reconstruct user plaintext unless the product claim explicitly allows escrow. Account reset should either make old encrypted data unrecoverable or document a user-controlled recovery path. Flag recovery flows that store recovery secrets in logs, email, SMS, analytics, or server-readable databases.

### 7. Review Multi-Device And Public-Key Trust

Check how new devices are authenticated, how device public keys are verified, and whether the server can add or replace devices without user-visible evidence. Review safety-number, key-transparency, cross-signing, QR, passkey, or existing-device approval flows. Test stale/offline devices, device removal, and server replay of old device lists.

### 8. Review Sharing And Revocation

For shared data, trace initial invitation, recipient authentication, group key distribution, permission changes, member removal, owner transfer, and link sharing. State the revocation limits: already-decrypted copies, offline recipients, backups, exports, and cached keys. Require rekeying or new content keys when future access must be revoked.

### 9. Test Server Influence

Actively look for server-controlled values that affect encryption: public keys, KDF parameters, feature flags, crypto suite versions, recovery policy, remote web code, wrapped-key blobs, object IDs used in AAD, and migration triggers. A zero-knowledge claim is weak if the server can silently alter these values to capture future plaintext or keys without detectable evidence.

### 10. Report Findings

Use `../audit-common/SKILL.md` severity rules. Use `CRYPTO-ARCH-###` finding IDs. Include affected claim, exact key or flow, evidence, exploit/reproduction path, impact, recommended design change, retest steps, and limitations. Mark positive evidence separately from confirmed findings.

## Severity Hints

- `critical`: server/operator/support or a malicious server-controlled flow can recover plaintext or user keys at scale despite an E2EE/zero-knowledge claim.
- `high`: plaintext, private keys, wrapping keys, recovery secrets, or reusable password-derived keys leak to server, logs, telemetry, backups, or unauthenticated recipients.
- `medium`: nonce/IV collision risk, missing AAD binding, weak separation, stale device revocation, undocumented recovery escrow, or server key-substitution risk with meaningful privacy impact.
- `low`: unclear documentation, missing cryptoperiod rationale, hardening gap, incomplete tests, or bounded metadata leakage.

## Human Cryptographer Review Required

Escalate instead of overclaiming when the design uses novel protocols, custom primitives, custom group ratchets, PAKEs, threshold recovery, deniable authentication, key transparency, post-quantum hybrids, misuse-resistant AEAD variants, formal security claims, hardware-backed key policy, side-channel-sensitive code, or large-scale nonce/counter bounds. State the specific question a cryptographer must answer.

Do not declare a system cryptographically sound from source review, canary testing, or absence of plaintext in traffic. Phrase conclusions as evidence-backed observations within the audited scope.
