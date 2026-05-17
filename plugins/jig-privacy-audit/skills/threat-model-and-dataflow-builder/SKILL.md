---
name: threat-model-and-dataflow-builder
description: Build evidence-focused privacy and security threat models. Use to extract assets, actors, components, trust boundaries, data flows, STRIDE-style security threats, LINDDUN-style privacy threats, assumptions, and controls.
---

# Threat Model and Dataflow Builder

Use this skill to turn code, docs, configs, network traces, architecture notes, or stakeholder answers into an audit-grade threat model and data-flow inventory. The output should support privacy, E2EE, zero-knowledge, telemetry, and metadata audits.

## Support Skill

Read `../audit-common/SKILL.md` before finalizing findings or severity. Use its evidence levels, severity language, redaction rules, limitations, and finding-schema expectations. Do not duplicate that guidance here.

## Source Basis

This workflow follows primary guidance from:

- OWASP Threat Modeling Cheat Sheet: model the system, identify threats, determine responses, and review; DFDs should show trust boundaries, data flows, data stores, processes, and external entities.
- OWASP Threat Modeling Process: use DFDs to decompose the system and STRIDE or similar categories to determine threats, then identify countermeasures or risk treatment.
- OWASP Threat Model Library: model actors, components, data stores, data sets, data flows, assumptions, threats, controls, and risks; missing trust boundaries can itself be a threat-model finding.
- LINDDUN: reason about privacy threats using Linking, Identifying, Non-repudiation, Detecting, Data Disclosure, Unawareness/Unintervenability, and Non-compliance; use system sketches or DFDs as the shared model.
- NIST Privacy Framework resource entry for LINDDUN: LINDDUN systematically elicits and mitigates privacy threats in software architectures.

## Inputs To Collect

Prefer concrete artifacts over narrative claims:

- Architecture docs, sequence diagrams, API specs, schemas, queue/topic definitions, infrastructure-as-code, deployment configs.
- Source paths for auth, authorization, encryption, telemetry, logging, sync, import/export, sharing, recovery, billing, support/admin, and third-party integrations.
- Runtime artifacts: HAR files, proxy traces, logs, screenshots, storage snapshots, DB rows, message payload samples, test account actions.
- Policy or product claims: privacy policy, security whitepaper, zero-knowledge/E2EE claims, retention statements, subprocessors, DPA excerpts.
- Scope boundaries: target system, excluded systems, test data, environments, attacker profiles, compliance regimes if explicitly in scope.

If inputs are missing, continue with a clearly labeled assumption list and evidence gaps.

## Workflow

1. Load `../audit-common/SKILL.md`.
2. Establish scope: system name, environment, target users, protected data, explicit exclusions, product/privacy/security claims.
3. Inventory model elements:
   - `actors`: humans, services, admins, support staff, operators, third parties, attackers, automated agents.
   - `assets`: sensitive data, secrets, keys, tokens, metadata, account state, audit logs, availability, consent state, privacy claims.
   - `components`: clients, APIs, services, workers, databases, object stores, queues, analytics, identity providers, admin tools.
   - `data_stores`: persistent stores, local caches, browser/mobile storage, backups, logs, data lakes, support systems.
   - `entry_points`: network endpoints, UI forms, deeplinks, webhooks, imports, sync endpoints, admin panels, CI/CD paths.
   - `trust_boundaries`: user device/server, unauthenticated/authenticated, tenant/admin, service/service, first-party/third-party, encryption domain, network zone, operator-access boundary.
   - `data_flows`: source, destination, protocol/channel, data classes, transformations, auth context, encryption state, retention, observability.
4. Build a data-flow view:
   - Create a Mermaid flowchart when useful.
   - Mark every cross-boundary flow and every store that contains personal data, content, metadata, secrets, or keys.
   - Note where plaintext, ciphertext, hashes, pseudonyms, identifiers, derived data, and telemetry are produced or transformed.
5. Enumerate threats:
   - Apply STRIDE to each actor, entry point, component, store, and flow.
   - Apply LINDDUN to each personal-data, metadata, identity, telemetry, sharing, retention, and user-control hotspot.
   - Keep threat statements concrete: "An attacker/operator/service can [action] against [asset] through [element/flow] because [missing or assumed control]."
6. Identify required controls:
   - Preventive, detective, and corrective controls.
   - Include owner, control status, evidence, test/retest approach, and linked threats.
   - For accepted or transferred risks, document explicit owner and rationale; do not silently downgrade.
7. Separate confirmed findings from hypotheses:
   - Confirmed: backed by source/runtime evidence.
   - Hypothesis: plausible but needs validation.
   - Assumption: accepted temporarily to complete the model.
   - Gap: missing artifact, inaccessible environment, or unresolved stakeholder answer.
8. Prioritize with `audit-common` severity and confidence language.

## STRIDE Prompts

Use STRIDE as prompts, not as a rigid taxonomy exercise:

- Spoofing: Can an actor impersonate a user, service, device, tenant, admin, webhook sender, or build/deploy identity?
- Tampering: Can data, code, configuration, telemetry, keys, permissions, logs, or messages be modified without detection?
- Repudiation: Can security- or privacy-relevant actions occur without trustworthy logs, integrity, non-repudiation controls, or user-visible history?
- Information disclosure: Can plaintext, metadata, secrets, keys, identifiers, or inferred sensitive data leak to unauthorized actors, logs, telemetry, storage, or third parties?
- Denial of service: Can availability, deletion, export, consent withdrawal, key recovery, or privacy-right workflows be blocked or degraded?
- Elevation of privilege: Can an actor cross tenant, role, service, admin, operator, device, or cryptographic boundaries?

## LINDDUN Prompts

Use LINDDUN categories for privacy harms and data-protection design failures:

- Linking: Can records, events, sessions, devices, pseudonyms, metadata, or telemetry be correlated across contexts?
- Identifying: Can a data subject be directly identified or reidentified from identity fields, small anonymity sets, content, metadata, or side channels?
- Non-repudiation: Does the system create evidence that attributes sensitive actions, memberships, messages, reads, edits, locations, or preferences to a person where deniability matters?
- Detecting: Can an observer infer that a person exists, uses a feature, has a condition/status, contacted someone, or performed an action from traffic, timing, errors, side effects, or storage traces?
- Data Disclosure: Is personal data unnecessarily collected, processed, retained, exposed internally, sent to subprocessors, logged, exported, backed up, or made too granular?
- Unawareness/Unintervenability: Are users insufficiently informed or unable to access, correct, delete, export, consent, object, change privacy settings, or understand impacts on others?
- Non-compliance: Do the preceding threats imply missing lawful basis, purpose limitation, minimization, retention, data-subject controls, security management, or policy/implementation alignment?

## Required Output

Use `templates/threat-model-report.md` for human-readable results. Use `templates/threat-model.schema.json` when the user needs structured output or downstream processing.

At minimum, include:

- Scope, sources reviewed, exclusions, assumptions, and limitations.
- Data classification summary and protected assets.
- Actors, components, data stores, entry points, trust boundaries, and data flows.
- Diagram or text-only data-flow map.
- STRIDE security threats and LINDDUN privacy threats with affected elements and evidence level.
- Required controls with status: `present`, `partial`, `missing`, `unknown`, `not_applicable`.
- Findings and hypotheses separated, with severity/confidence from `audit-common`.
- Retest plan and open evidence requests.

## Output Discipline

- Redact secrets, tokens, credentials, private keys, personal data, and live customer content.
- Do not claim the system is compliant, zero knowledge, secure, or cryptographically sound from a threat model alone.
- Treat missing trust boundaries, unknown data retention, unverified third-party sharing, and undocumented operator access as model gaps or findings depending on evidence.
- Prefer stable IDs:
  - `TM-DF-###` for model/data-flow gaps.
  - `TM-STRIDE-###` for security threats.
  - `TM-LINDDUN-###` for privacy threats.
  - `TM-CTRL-###` for required controls.
- Avoid broad generic threats. Tie every threat to a specific asset, flow, store, entry point, component, actor, or boundary.
- When evidence is weak, say what would confirm or refute the issue.
