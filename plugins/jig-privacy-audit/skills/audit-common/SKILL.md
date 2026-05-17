---
name: audit-common
description: (Internal/support) Shared finding, evidence, severity, redaction, and limitation rules for Jig privacy-audit skills. Use only as support for privacy, E2EE, metadata, telemetry, or remediation audit outputs.
---

# Audit Common

This is a support skill for the Jig privacy-audit suite. Do not use it alone for an audit. Use it to normalize evidence, findings, limitations, and severity across the narrower audit skills.

## Core Rules

- Separate confirmed findings from hypotheses and missing evidence.
- Do not claim an app is zero knowledge, secure, compliant, SOC 2 ready, ISO 27001 certified, or cryptographically sound from one audit surface.
- Prefer audit-grade evidence: file paths and line numbers, HAR entries, request IDs, storage snapshots, DB rows, logs, screenshots, command output, reproduction steps, and exact test data.
- Redact secrets, tokens, credentials, private keys, personal data, and live customer content in final output. Preserve enough structure for retesting.
- Treat absence of a sentinel in network traffic as limited evidence: it can disprove simple plaintext leakage, but it cannot prove correct cryptography.
- Stay within authorized targets, test accounts, local systems, staging environments, or explicitly approved production scopes.

## Evidence Levels

- `high`: directly observed exploit, plaintext leak, key exposure, code path, storage row, log entry, or reproducible runtime behavior.
- `medium`: strong static or dynamic evidence with one unverified assumption, such as a serializer path likely reached by the tested flow.
- `low`: plausible risk, missing control, missing documentation, or partial evidence requiring owner confirmation.

## Severity

- `critical`: server/operator/attacker can recover user plaintext or key material at scale, malicious updates can silently exfiltrate keys, or recovery defeats a central zero-knowledge claim.
- `high`: plaintext sensitive content, encryption keys, recovery secrets, or claimed encrypted fields leak to network, server storage, telemetry, logs, queues, or third parties.
- `medium`: sensitive metadata leakage, missing binding/integrity, weak key lifecycle, limited plaintext exposure, or claim conflict with meaningful privacy impact.
- `low`: hardening issue, documentation gap, weak evidence retention, ambiguous claim, or lower-impact privacy leakage.
- `informational`: scope note, limitation, positive evidence, or recommended follow-up without a concrete failure.

## Finding Schema

Use `templates/finding.schema.json` for machine-readable findings. Each finding should include:

- stable id with a skill prefix, such as `ZK-NET-001`;
- title, severity, confidence, audit skill, and surface;
- affected product claims;
- evidence entries with type, file or artifact, location, and redacted excerpt;
- reproduction and retest steps;
- impact, root-cause hypothesis, recommended fix, and limitations.

## Shared References

Read `references/audit-baselines.md` only when you need source-backed baseline context for OWASP, NIST, SLSA, Sigstore, or OpenSSF terminology. Routine skill execution should not load it.

JSON schemas in `templates/` are reference contracts for emitted artifacts and review outputs. Helper scripts validate only where their own usage text says so; otherwise treat schemas as authoring targets and run external schema validation when a workflow requires it.
