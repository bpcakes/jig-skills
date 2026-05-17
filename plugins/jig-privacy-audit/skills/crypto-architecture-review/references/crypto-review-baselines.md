# Crypto Review Baselines

Load this file when a crypto architecture review needs standards-backed criteria, citations, or a deeper checklist. Use `../audit-common/SKILL.md` for evidence, severity, and limitations.

## Primary Sources

- NIST SP 800-57 Part 1 Rev. 5, "Recommendation for Key Management: Part 1 - General" (May 2020): https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final
- NIST SP 800-38D, "Recommendation for Block Cipher Modes of Operation: GCM and GMAC" (Nov. 2007): https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-38d.pdf
- NIST SP 800-38F, "Recommendation for Block Cipher Modes of Operation: Methods for Key Wrapping" (Dec. 2012): https://csrc.nist.gov/pubs/sp/800/38/f/final
- OWASP Cryptographic Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
- OWASP Key Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html
- OWASP MASVS, especially MASVS-STORAGE and MASVS-CRYPTO: https://mas.owasp.org/MASVS/
- RFC 5869, HKDF: https://www.ietf.org/rfc/rfc5869
- RFC 9106, Argon2: https://www.ietf.org/rfc/rfc9106.html
- Signal Double Ratchet specification: https://signal.org/docs/specifications/doubleratchet/
- Signal X3DH specification: https://signal.org/docs/specifications/x3dh/
- RFC 9420, Messaging Layer Security: https://www.ietf.org/rfc/rfc9420

## Baseline Expectations

### Architecture And Claims

- Start from the threat model. "Encrypted" is not enough; identify whether the claim is at-rest protection, client-side encryption, E2EE, zero knowledge, or operator exclusion.
- Minimize sensitive data and metadata before encrypting it. Encryption does not remove the need for access control, retention limits, and logging discipline.
- Treat web clients and remote update systems as part of the trust boundary. If the server can change client code, future plaintext capture may be possible even when stored ciphertext is strong.

### Key Hierarchy

- Each key should have one purpose: encrypt data, wrap keys, authenticate, sign, derive, identify a device, or recover access. Reuse across purposes is a finding unless the construction explicitly permits it.
- Record key origin, owner, lifetime, rotation, revocation, destruction, and compromise response. NIST SP 800-57 frames key management as lifecycle management, not just storage.
- Data-encryption keys and key-encryption keys should be independent. OWASP explicitly calls out independent keys when multiple keys are used.
- Key IDs and algorithm suite IDs should be authenticated, not attacker-controlled metadata.

### AEAD And Binding

- Prefer standard AEAD modes such as AES-GCM, AES-CCM, or ChaCha20-Poly1305 through vetted libraries. If a non-AEAD mode appears, require encrypt-then-MAC evidence and expert review.
- Associated data should bind ciphertext to all context that changes meaning: object type, object ID, user/account, tenant, sender/device, recipient/group, version, permissions, and suite.
- Authentication failure must abort without accepting plaintext or committing partial state.

### Nonce And IV Strategy

- For GCM, NIST SP 800-38D requires IV uniqueness for the authenticated encryption function under a given key. Reuse under one key can destroy confidentiality and integrity.
- A deterministic nonce scheme needs persistent counters or a proof that keys are one-time. Check crash recovery, rollback, imports, multi-writer sync, and backups.
- Random nonce schemes need collision analysis at expected scale and clear key rotation limits.
- Do not assume UUIDs, timestamps, object IDs, or database auto-increment IDs are safe nonces unless uniqueness under the exact key is proven.

### KDFs And Password-Derived Keys

- Use extract-and-expand KDFs with context-specific `info` labels when deriving multiple keys from shared secret material. HKDF salt improves separation and source independence.
- Password-derived keys need memory-hard or otherwise explicitly justified parameters, unique salts, parameter versioning, and migration. RFC 9106 recommends Argon2id defaults, with a lower-memory option for constrained environments.
- The server must not be able to silently downgrade KDF parameters, replace salts, or test password guesses in a way that contradicts the zero-knowledge claim.

### Key Wrapping And Storage

- Wrapped keys need confidentiality and integrity. NIST SP 800-38F specifies AES key wrap modes for protecting cryptographic keys; modern AEAD-based wrapping can also be acceptable when designed carefully.
- Store wrapped key metadata so clients can verify purpose, version, owner, and parent key. Treat unauthenticated wrapping metadata as a substitution risk.
- Device keystores and HSMs protect local/server secrets but do not by themselves prove zero knowledge. Check who can invoke unwrap/decrypt operations.

### Recovery And Reset

- Recovery is often where zero-knowledge claims fail. Identify whether recovery is user-held, device-held, social, threshold, escrowed, support-assisted, or server-held.
- If reset preserves access to old encrypted data without a user-held secret or already-authorized device, determine who held the decryption capability.
- Recovery secrets must not be logged, emailed, texted, stored in analytics, embedded in links without expiration, or available to support staff.

### Multi-Device

- A server-provided device or public-key list needs authentication against user intent. Look for cross-signing, existing-device approval, QR verification, passkey-backed approval, key transparency, or user-visible safety changes.
- Device removal should stop future access. State limits for offline devices that already hold keys or plaintext.
- Watch for "ghost device" risks: server can create a new device, replay an old device, replace a public key, or suppress warning UI.

### Sharing And Revocation

- Sharing should authenticate recipient identity and bind permissions into key distribution or encrypted metadata.
- Removing a member generally requires a new content/group key for future confidentiality. Old ciphertext and already-decrypted plaintext cannot be clawed back; state this as a limitation, not necessarily a bug.
- Link sharing needs expiry, audience binding, rate limits, auditability, and clear zero-knowledge implications.

### Server Influence

- Treat server-controlled crypto parameters as hostile unless authenticated or transparency-backed.
- Check whether the server can select algorithms, KDF cost, public keys, recovery policy, object IDs in AAD, device lists, migration format, or wrapped-key blobs.
- For web E2EE, document the code delivery trust problem and whether reproducible builds, signed clients, extensions, or native apps reduce it.

## Escalation Triggers

Require human cryptographer review for custom protocols, novel group messaging, threshold/social recovery, PAKE selection, post-quantum hybrids, deniability, key transparency, formal claims, side-channel defenses, HSM policy semantics, or nonce bounds at very high volume.
