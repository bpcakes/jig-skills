# Metadata Leakage Baselines

Load this reference when a metadata audit needs source-backed terminology or citation anchors. Keep user-facing reports tied to the current source versions and the observed system evidence.

## Primary Sources

- IETF RFC 6973, "Privacy Considerations for Internet Protocols" (`https://www.rfc-editor.org/rfc/rfc6973.html`): useful for identifiers, correlation, fingerprinting, traffic analysis, unlinkability, identifiability, retention, user control, and privacy considerations in protocol/operational design.
- LINDDUN privacy threat types (`https://linddun.org/threat-types/`): useful for Linking, Identifying, Non-repudiation, Detecting, Data Disclosure, Unawareness/Unintervenability, and Non-compliance framing.
- NIST Privacy Framework resource page for LINDDUN (`https://www.nist.gov/privacy-framework/linddun-privacy-threat-modeling-framework`): describes LINDDUN as a framework for systematically eliciting and mitigating privacy threats in software architectures.
- OWASP Threat Modeling Cheat Sheet (`https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html`): use system modeling and DFD-style decomposition before judging what can go wrong and which mitigations are appropriate.
- FTC Protecting Personal Information and Start with Security guides (`https://www.ftc.gov/business-guidance/resources/protecting-personal-information-guide-business`, `https://www.ftc.gov/business-guidance/resources/start-security-guide-business`): use for inventory, need-to-know access, not collecting/retaining unnecessary personal information, vendor access limits, and cleartext/sensitive-data security examples.
- European Commission Data Protection Explained (`https://commission.europa.eu/law/law-topic/data-protection/data-protection-explained_en`): use for broad personal-data framing; encrypted, de-identified, or pseudonymised data can remain personal data if re-identification remains possible.

## Metadata Audit Concepts

- Metadata can be personal or sensitive even when content bodies are encrypted.
- Correlation risk grows with stable identifiers, high-cardinality fields, long retention, and joins across contexts or third parties.
- Linkability can be harmful without direct identity disclosure because it can enable singling out, profiling, and later reidentification.
- Identifiability can come from direct identity fields, small anonymity sets, unique device/app fingerprints, payment/account joins, location, IP address, or identity-revealing content-derived metadata.
- Detectability and timing inference do not require plaintext. Presence, existence, read state, group membership, or sensitive events can be inferred from whether communication, storage, errors, or side effects occur.
- Traffic analysis can use presence, absence, amount, direction, timing, packet/message size, composition, and frequency even when flows are encrypted.
- Data minimization applies to metadata collection, processing, retention, disclosure, observability, and third-party propagation, not only to content fields.
- Pseudonymization, hashing, tokenization, or deterministic encryption can reduce exposure but may preserve linkability or reversibility depending on salt/key custody and join context.

## Review Questions

Use these as prompts, not as a checklist that must be fully answered.

### Identifiers and Linkability

- Which identifiers are global, pairwise, tenant-local, session-local, device-local, or third-party generated?
- How long does each identifier persist, and can users or operators rotate/delete it?
- Can the same identifier appear in API calls, logs, metrics, support tools, warehouses, notifications, object keys, or third-party SDKs?
- Can multiple pseudonymous fields be joined to identify or single out a person?

### Behavioral and Timing Inference

- Are timestamps exact, rounded, delayed, batched, or necessary?
- Can reads, typing, presence, sleep/work patterns, travel, incident response, or feature use be inferred from event timing, order, polling, frequency, sizes, or errors?
- Can encrypted payload size, object count, attachment count, thumbnail dimensions, or queue depth reveal sensitive content categories or events?

### Social Graph Exposure

- Are sender, recipient, invitee, collaborator, group, contact, block, read-receipt, or shared-object relationships visible to servers, operators, support, or third parties?
- Does contact discovery upload raw address books, normalized contact hashes, or stable contact tokens?
- Do notifications, email/SMS, webhooks, logs, or analytics expose relationship edges outside the intended audience?

### Claims and Policy Alignment

- Does product language imply stronger metadata protection than the implementation provides?
- Does the privacy policy disclose the actual categories of metadata collected, purposes, recipients/processors, retention, and controls?
- Are exceptions specific enough for the observed behavior, or are they vague catch-alls that conflict with clearer product claims?
- Are telemetry choices and privacy settings honored in code paths, background jobs, SDKs, error reporting, and server-side logs?

### Minimization

- Can the feature work with no metadata, client-only metadata, encrypted metadata, lower precision, shorter retention, fewer readers, pairwise identifiers, batching, padding, aggregation, or delayed disclosure?
- Can debugging and abuse prevention use separate, access-controlled, short-lived evidence instead of permanent behavioral telemetry?
- Can third-party processors receive coarse or anonymous aggregate events rather than raw identifiers or relationship fields?
