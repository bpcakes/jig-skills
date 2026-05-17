# Client Encryption Boundary Baselines

Use these source-backed anchors when reviewing client-side encryption boundaries. Keep conclusions scoped to observed code and runtime evidence.

## Primary Sources

- OWASP Cryptographic Storage Cheat Sheet: start from a threat model; choose the encryption layer based on the threat model; minimize sensitive storage; prefer authenticated encryption modes; use CSPRNGs for keys/IVs/nonces/tokens; manage key lifecycle and storage deliberately.
  Source: https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html

- OWASP Key Management Cheat Sheet: map components that generate, store, use, rotate, back up, recover, destroy, and audit key material. Boundary findings involving key exposure should include lifecycle impact.
  Source: https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html

- NIST SP 800-38D: GCM is authenticated encryption with associated data. For AES-GCM, IV/nonce uniqueness under a key is a security requirement; boundary tests should not ignore nonce generation and envelope pairing when they inspect encryption call sites.
  Source: https://csrc.nist.gov/pubs/sp/800/38/d/final

- W3C Web Cryptography API: browser applications can encrypt documents before upload to remote service providers, and SubtleCrypto covers encryption, decryption, key generation, key derivation, import/export, wrapping, and unwrapping. Review browser clients for where those operations occur relative to storage and network calls.
  Source: https://www.w3.org/TR/webcrypto/

- MDN SubtleCrypto `encrypt()`: Web Crypto encryption APIs are available in secure contexts and workers in common browsers. Treat worker/service-worker paths as part of the client boundary.
  Source: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt

- WHATWG Storage Standard: origin storage includes IndexedDB, Cache API, service worker registrations, localStorage, sessionStorage, application caches, notifications, and related semi-persistent state. Include these in local plaintext sink review.
  Source: https://storage.spec.whatwg.org/

- OWASP WSTG CRYP-03: sensitive data transmitted through network channels should be identified and protected; testing should assess privacy and security of channels carrying sensitive data. Use this for network evidence framing, while remembering HTTPS alone does not prove client-side encryption.
  Source: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/09-Testing_for_Weak_Cryptography/03-Testing_for_Sensitive_Information_Sent_via_Unencrypted_Channels

- OpenTelemetry sensitive-data guidance: telemetry collection can inadvertently capture sensitive or personal information; implementers are responsible for protecting telemetry data, reviewing instrumentation libraries, minimizing collected data, and redacting/filtering attributes.
  Source: https://opentelemetry.io/docs/security/handling-sensitive-data/

## Boundary Rules Of Thumb

- The protected plaintext value should be transformed into an authenticated ciphertext envelope before it reaches generic serializers, API DTOs, upload helpers, sync queues, local persistent stores, telemetry, or logs.
- Client encryption is not the same as TLS. TLS protects transport; it does not stop the service from receiving plaintext if the application sends plaintext.
- Encoding, compression, binary serialization, JWT/base64url, protobuf, or field renaming is not encryption.
- A local plaintext cache can defeat a user-facing "encrypted on your device" or "only you can read it" claim even when the network payload is encrypted.
- Boundary order should be enforced by types or narrow APIs where possible: plaintext domain types should not be accepted by network or persistence code for protected fields.
- Tests should intercept the actual network/storage/telemetry boundary, not only assert that an encryption helper can encrypt sample text.

## Common Root Causes

- shared DTO used before and after encryption;
- encryption wrapper applied in one save path but not autosave, import, retry, background sync, share, or migration;
- local queue stores plaintext for later encryption;
- analytics/logging added near forms, model updates, or error handling before encryption;
- preview/search/thumbnail pipeline writes plaintext derivatives;
- attachment upload sends filename, MIME-derived metadata, OCR text, or extracted title outside the encrypted envelope;
- "debug" or "support" mode uploads protected fields without production gating evidence;
- server-supplied schema/feature flag decides field encryption without client-side enforcement.

## Evidence Quality

- High: sentinel observed in request, response, telemetry, log, local storage, queue, or code path with confirmed runtime reachability.
- Medium: static source-to-sink path with one unverified runtime assumption, or test coverage proving a vulnerable order but without live capture.
- Low: missing tests, unclear ownership, broad API accepting plaintext, or claim conflict without a confirmed protected value reaching a sink.
