---
name: network-payload-zero-knowledge-test
description: Test HAR/network captures for controlled plaintext or secret leakage against zero-knowledge and E2EE claims.
---

# Network Payload Zero-Knowledge Test

Use this skill to run a sentinel-based network audit for zero-knowledge, E2EE, or privacy claims. The goal is to determine whether controlled test values appear in network requests, responses, headers, URLs, cookies, telemetry, or third-party calls.

Always read `../audit-common/SKILL.md` before finalizing findings. Use its severity, evidence, limitation, and `templates/finding.schema.json` conventions.

## Safety Constraints

- Work only on authorized local, staging, test-account, or explicitly approved production targets.
- Use synthetic sentinel data. Do not place real customer content, real credentials, private keys, production recovery phrases, medical data, financial data, or regulated PII into test flows.
- Treat HAR files and proxy captures as sensitive artifacts. Chrome can export sanitized HAR by default and requires an explicit setting for HAR with sensitive data; handle both as confidential.
- Do not bypass access controls, rate limits, payment flows, tenant boundaries, or other safety controls. Use owner-provided test accounts, staging systems, scoped captures, fixtures, documented test harnesses, or approved logs instead.
- Redact secrets, tokens, cookies, Authorization headers, session identifiers, and live account data in final output.

## What This Test Can and Cannot Prove

This test can confirm network leakage when a sentinel appears in captured traffic. It can also provide limited negative evidence that specific sentinels were not observed in the captured flows.

It cannot prove a system is zero knowledge, cryptographically sound, or free of leakage. HAR export settings, browser caching, service workers, compression, encrypted binary protocols, certificate pinning, mobile-only code paths, missed flows, and server-side processing can all hide relevant evidence.

## Workflow

Choose the requested mode first. For supplied captures plus their sentinel manifest, analyze those artifacts directly: skip generation and capture, preserve the original sentinel mapping, and report missing flows as limitations. For an authorized new capture, generate sentinels once and exercise only the scoped flows. Neither mode authorizes live account activity, extra testing, or disclosure beyond the user's task.

1. Define the privacy claim and network scope.
   - Identify first-party domains, third-party domains, browser/app clients, APIs, telemetry SDKs, sync endpoints, upload endpoints, search/indexing endpoints, and recovery flows.
   - Record the exact user-visible claim being tested, such as "notes are end-to-end encrypted" or "we cannot read vault item bodies."

2. For a new capture, generate synthetic sentinels.
   - Use high-entropy, unique, easy-to-search values.
   - Use different sentinel classes for content, metadata, key-like material, recovery data, and credentials so a match can be classified accurately.
   - Keep a private sentinel manifest and do not commit it.

3. For a new capture, exercise representative scoped flows while capturing network traffic.
   - Capture login, onboarding, item create/update/delete, sync, search, share/export/import, attachment upload/download, recovery setup, recovery use, settings changes, telemetry submission, logout, and background refresh.
   - Prefer HAR with response bodies when browser testing. Preserve logs before navigation where needed.
   - For APIs, also save raw request/response payloads from approved proxies, integration tests, or app logs when available.

4. Scan the captured artifacts.
   - Use the supplied manifest or the one generated for this capture; do not replace it at analysis time.
   - Use `scripts/zknet_scan.py scan-har` for HAR files.
   - Manually inspect any match, especially decoded matches and response echoes.

5. Classify each match.
   - Determine whether the sentinel was visible in URL, query string, header, cookie, request body, response body, telemetry, third-party request, or unencrypted HTTP.
   - Distinguish direct plaintext from encoded plaintext. Base64, URL encoding, JSON escaping, hex, gzip/zlib-wrapped data, or JWT base64url segments are encodings, not cryptographic protection.

6. Report findings using the audit-common schema.
   - Use IDs like `ZK-NET-001`.
   - Include artifact path, HAR entry index, method, redacted host/path, direction, decoded transform, sentinel class, reproduction steps, impact, retest steps, and limitations.

## Sentinel Design

Recommended sentinel manifest shape:

```json
{
  "sentinels": [
    {
      "id": "body-001",
      "value": "ZKNET::RUN::BODY::unique-token",
      "category": "plaintext_content",
      "use": "Encrypted note, message, document, or vault body"
    }
  ]
}
```

Use these categories when possible:

- `plaintext_content`: note bodies, messages, document text, vault item values, attachment text.
- `sensitive_metadata`: titles, filenames, tags, folder names, labels, search terms, contact names, timestamps if a claim covers metadata.
- `encryption_key`: test-only symmetric keys, wrapped keys, private-key-like values, device keys.
- `recovery_secret`: test-only recovery phrase, recovery code, backup code, escrow secret.
- `credential`: test-only password, API token, passphrase, OTP, session-like value.
- `low_sensitivity_control`: benign control value expected to appear in traffic.

Do not reuse sentinels across audits. Do not use sentinels that look like real secrets for production systems unless they are confined to test accounts.

## HAR and Payload Surfaces

Inspect at least these HAR fields:

- `log.entries[].request.url`
- `request.queryString[].name/value`
- `request.headers[]`, especially custom headers and telemetry headers; redact auth headers in output.
- `request.cookies[]`
- `request.postData.text`
- `request.postData.params[].name/value/fileName`
- `response.headers[]`, including redirects and set-cookie values only after redaction.
- `response.cookies[]`
- `response.content.text` and `response.content.encoding`

Also inspect payload files copied from proxies, CDP, integration tests, or mobile capture tooling when HAR is incomplete.

## Decoding Expectations

Decode common non-cryptographic encodings before deciding a sentinel is absent:

- URL percent encoding and form encoding.
- HTML entity escaping.
- JSON string escaping and nested JSON string fields.
- Base64 and base64url, including HAR `response.content.encoding: "base64"`.
- JWT header and payload segments.
- Hex encoding.
- gzip or zlib data after base64 or base64url wrapping.
- Binary-heavy decoded values are filtered out when they do not look like plausible text, so sentinel absence in mostly binary blobs is not proof that binary payload handling is safe.

Record the transform chain that revealed the sentinel, such as `raw -> json:body.note -> base64`.

## Leak Classification

Use this mapping as a starting point, then adjust with `../audit-common/SKILL.md`:

- `critical`: network traffic exposes key material, recovery secrets, or plaintext at scale in a way that defeats a central zero-knowledge claim.
- `high`: plaintext sensitive content, credentials, key material, recovery secrets, or claimed encrypted fields appear in request/response bodies, URLs, headers, cookies, telemetry, or third-party payloads.
- `medium`: sensitive metadata appears where the product claims metadata privacy, or sentinels appear in first-party telemetry without user-visible need.
- `low`: demonstrated low-impact leakage or collection that violates the scoped claim or intended recipient boundary.
- `informational`: expected low-sensitivity control matches, positive evidence, missing evidence, or no observed protected-sentinel match in the tested flows, with limitations clearly stated. Expected controls are not defects.

Common finding labels:

- `outbound_plaintext_to_service`: client sent a protected sentinel to a first-party API.
- `inbound_plaintext_from_service`: server returned a protected sentinel, implying server-side receipt or storage.
- `third_party_network_payload`: sentinel reached a third-party domain or telemetry vendor.
- `telemetry_payload`: sentinel reached a first-party analytics, metrics, logging, or crash endpoint.
- `url_or_header_exposure`: sentinel appeared in URL, query string, header, cookie, or redirect.
- `unencrypted_transport`: sensitive sentinel traveled over `http://`.
- `encoded_plaintext`: sentinel was recoverable through reversible encoding.

## Helper Script

Set `JIG_ZKNET_SKILL_DIR` to the directory containing this installed `SKILL.md`, not the target repository. Run the helper from the target repository root or audit workspace. Use a fresh private run directory for new captures; for supplied captures, reuse their original sentinel manifest rather than generating replacement values.

Generate a sentinel manifest:

```bash
JIG_ZKNET_RUN_DIR=$(mktemp -d)
python3 "$JIG_ZKNET_SKILL_DIR/scripts/zknet_scan.py" \
  generate-sentinels --run-id zknet-local-001 --output "$JIG_ZKNET_RUN_DIR/sentinels.json"
```

Scan a supplied HAR and its matching sentinel manifest in a fresh shell. This example does not depend on the generation variable above:

```bash
JIG_ZKNET_OUTPUT_DIR=$(mktemp -d)
python3 "$JIG_ZKNET_SKILL_DIR/scripts/zknet_scan.py" \
  scan-har --sentinels ./sentinels.json --first-party example.com \
  --output "$JIG_ZKNET_OUTPUT_DIR/scan.json" ./capture.har
```

Keep the output directory private and record its path in the audit notes. For a newly generated manifest, either run capture and scan in the same shell as generation or supply the manifest's explicit path; do not generate replacement sentinels for an existing capture.

Pass at least one `--first-party` domain for first-party versus third-party classification. If omitted, the output includes a configuration warning and third-party classification is disabled. Literal or manifest sentinel values must be at least 16 characters to avoid broad false positives. The decoder recursively tries common reversible encodings up to `--max-decode-depth`; deeply nested or very large encoded fields can be expensive, so keep `--max-field-bytes` and `--max-decoded-values` bounded for untrusted captures.

The scanner emits JSON with:

- `summary`: scanned files, entry counts, sentinel count, finding count, skipped fields, and limitations.
- `findings`: schema-shaped finding candidates using `ZK-NET-###` IDs.
- `matches`: lower-level match records for manual triage.
- `positive_evidence`: statement of no observed sentinel matches when none are found.

The script is deterministic for a given HAR and sentinel manifest. `scan-har` exits `1` when finding candidates are emitted and `0` when no matches are found. `generate-sentinels --seed` can be used for repeatable fixtures, but do not use seeded sentinels for real audits.

Fixture-only sentinel values should be visibly non-live, for example `ZKNET::DO-NOT-USE::FIXTURE::...`. Do not use that convention for real audit runs; generate fresh unseeded sentinels instead.

## Manual Review Checklist

- Verify the HAR export included request bodies and response bodies for the relevant flows.
- Confirm the matched value is a test sentinel, not a false positive substring.
- Check whether the endpoint is first-party, third-party, telemetry, crash reporting, analytics, CDN, or redirect infrastructure.
- Check whether the value appears before encryption, after decryption, in local-only debug endpoints, or as an intentional low-sensitivity control.
- Capture reproduction steps precise enough for retesting.
- Redact artifacts before sharing, but retain the original capture in the private audit workspace if permitted.

## Output Guidance

For each confirmed issue, report:

- finding ID, title, severity, confidence, and classification label;
- affected privacy or zero-knowledge claim;
- sentinel category, not the full sentinel value;
- redacted evidence excerpt and decode transform;
- artifact path and HAR entry index;
- method, scheme, host, path, and direction;
- impact and root-cause hypothesis;
- recommended fix and retest steps;
- limitations, including capture settings and untested flows.

For no-match results, say only that the tested captures did not contain the configured sentinels. Do not claim the product is zero knowledge or leak-free.

## Source Anchors

- W3C historical HAR draft: HAR is JSON, has request/response/body fields, supports `content.encoding`, and warns HAR may contain privacy/security sensitive data.
- Chrome DevTools Network reference: DevTools can export sanitized HAR by default and HAR with sensitive data only after an explicit setting.
- Firefox DevTools Network Monitor docs: Network Monitor supports HAR import for analysis.
- OWASP WSTG sensitive information in transit: identify sensitive data in network channels and verify protection.
- OWASP API Security Top 10 2023 API3: inspect API responses for sensitive object properties and minimize returned data.
