---
name: crypto-implementation-static-review
description: Statically review source-code cryptography in privacy, E2EE, and encrypted-app audits. Use for crypto APIs, call graphs, randomness, KDFs, serialization, custom crypto, insecure modes, and plaintext sinks.
---

# Crypto Implementation Static Review

Use this skill to statically inspect source code for cryptographic implementation risks. Load `../audit-common/SKILL.md` first and follow its evidence, severity, limitation, redaction, and finding-schema rules.

## Scope

Review code paths that transform sensitive user-controlled or user-derived data into ciphertext, plaintext, keys, nonces, salts, tags, wrapped envelopes, storage records, network requests, logs, telemetry, cache entries, and background jobs.

Do not certify that cryptography is sound from static review alone. Report confirmed code evidence separately from missing runtime evidence, unproven reachability, and owner assumptions.

## Fast Start

Set `JIG_PRIVACY_AUDIT_PLUGIN` to this checkout's `plugins/jig-privacy-audit` directory. From the target repository root:

```bash
python3 "$JIG_PRIVACY_AUDIT_PLUGIN/skills/crypto-implementation-static-review/scripts/crypto_static_scan.py" --root . --format markdown > crypto-static-scan.md
```

Use the scan as a triage index, not as findings by itself. Confirm each issue by reading the call site, wrapper, tests, and reachable callers. The helper caps output with `--max-results` by default; use a narrower `--root` or raise the limit when investigating large repositories. JSON output includes `test_path: true` when a candidate appears under common test or fixture paths so reviewers can triage without hiding shipped-test risks.

## Review Workflow

1. Establish crypto inventory.
   - Identify crypto libraries and wrappers: imports, dependency files, internal `crypto`, `encryption`, `key`, `vault`, `secrets`, and `cipher` modules.
   - Identify algorithms and modes in use: AEAD, CBC/CTR plus MAC, stream ciphers, RSA padding, signatures, password hashing, KDFs, and key wrapping.
   - Identify encrypted data shapes: envelope fields for version, algorithm, key id, salt, nonce/IV, tag/MAC, AAD, ciphertext, compression, and encoding.

2. Build call graphs around sensitive flows.
   - Start from entry points: HTTP handlers, RPC methods, CLI commands, queue consumers, importers, sync handlers, UI form actions, and file readers.
   - Trace user input to `encrypt`, `seal`, `wrap`, `hash`, `derive`, and serialization calls.
   - Trace `decrypt`, `open`, `unwrap`, and deserialization output to sinks: responses, logs, analytics, database writes, caches, files, queues, search indexes, and third-party SDKs.
   - Record exact paths with file and line numbers. Mark reachability as confirmed, likely, or unknown.

3. Check encryption construction.
   - Prefer high-level AEAD APIs such as AES-GCM, ChaCha20-Poly1305, XChaCha20-Poly1305, or platform sealed boxes when appropriate.
   - Flag custom algorithms, manual block-mode composition, homegrown padding, XOR/rolling-key schemes, ad hoc MAC construction, or unauthenticated encryption.
   - Flag ECB. Treat CBC/CTR/CFB/OFB without encrypt-then-MAC or authenticated envelope verification as a likely finding.
   - For RSA encryption, check OAEP or equivalent randomized padding. Flag raw RSA, `NoPadding`, or legacy PKCS#1 v1.5 unless a strong compatibility justification and oracle resistance exist.

4. Check randomness, nonces, IVs, and salts.
   - Confirm keys, nonces/IVs, salts, and tokens use CSPRNGs or misuse-resistant library generation.
   - Flag `Math.random`, `random.random`, `java.util.Random`, Go `math/rand`, libc `rand`, timestamps, counters without per-key uniqueness proof, UUIDv1, static bytes, zero IVs, and deterministic salts.
   - For GCM/ChaCha20-Poly1305, verify nonce uniqueness for each key. Prefer 96-bit GCM IVs where the platform expects them, unless the library safely abstracts this.
   - Check nonce storage/transmission: nonces need not be secret, but decryption must use the exact nonce paired with the ciphertext and key.

5. Check KDF and password-derived keys.
   - Identify PBKDF2, scrypt, Argon2id, bcrypt, HKDF, and any hash-as-KDF patterns.
   - Record salt source, salt length, iteration/cost/memory/parallelism parameters, digest, output length, and whether parameters are versioned in the ciphertext or account record.
   - Flag hardcoded salts, reused global salts for password-derived encryption keys, too-low costs for the deployment era, missing digest parameters, MD5/SHA1-as-KDF, and direct passphrase bytes as encryption keys.
   - Distinguish password hashing from password-based encryption. Do not recommend reversible encryption for stored passwords.

6. Check key handling and wrapping.
   - Map where data-encryption keys, key-encryption keys, private keys, recovery secrets, and passphrases are generated, stored, exported, cached, rotated, and destroyed.
   - Flag keys in source, fixtures shipped to production, environment variables logged at startup, config files committed with live material, extractable browser keys without need, and server-side possession that conflicts with zero-knowledge claims.
   - Verify wrapped keys authenticate metadata such as user id, key id, algorithm, version, and intended use via AAD or signed structure.

7. Check serialization and envelope binding.
   - Verify the encrypted payload carries or can derive algorithm version, nonce/IV, salt, tag/MAC, key id, and KDF parameters needed for decryption and rotation.
   - Check that authenticated data binds plaintext context: record id, tenant/user id, field name, schema version, content type, and purpose where substitution would matter.
   - Flag ciphertext encodings that drop tags, truncate nonces, confuse bytes and strings, double-encode inconsistently, or parse unauthenticated metadata before verification in a security-sensitive way.

8. Check plaintext sinks.
   - Trace decrypted values and pre-encryption sensitive fields to logs, errors, metrics, analytics, crash reports, network requests, database records, cache keys, filenames, search indexes, queues, and browser storage.
   - Search both code and tests for representative field names, sentinel strings, and serializer DTOs.
   - Treat test-only plaintext as low risk unless fixtures, debug endpoints, sample configs, or snapshots ship in production artifacts.

## Evidence Commands

Use these as starting points and adapt to the language:

```bash
rg -n --hidden -S "encrypt|decrypt|cipher|AES|GCM|CBC|ECB|ChaCha|secret|nonce|iv|salt|pbkdf|scrypt|argon|bcrypt|HKDF|random|logger|telemetry|analytics" .
rg -n --hidden -S "Math\\.random|random\\.random|java\\.util\\.Random|math/rand|rand\\(|createCipher\\(|ECB|NoPadding|MD5|SHA1|PKCS1Padding" .
rg -n --hidden -S "console\\.log|logger\\.|Log\\.|print\\(|NSLog|writeFile|localStorage|sessionStorage|fetch\\(|axios|analytics|telemetry|INSERT|UPDATE" .
```

Prefer language-aware tools when available:

- Java/Kotlin: inspect `Cipher.getInstance`, `GCMParameterSpec`, `IvParameterSpec`, `SecretKeySpec`, `SecureRandom`, Android Keystore, and logging calls.
- JavaScript/TypeScript: inspect `node:crypto`, WebCrypto `subtle`, `crypto-js`, `tweetnacl`, `libsodium`, browser storage, and server/client boundary serialization.
- Go: inspect `crypto/cipher`, `crypto/aes`, `crypto/rand`, `x/crypto`, `Seal`, `Open`, and accidental `math/rand`.
- Python: inspect `cryptography`, PyNaCl, `hashlib`, `hmac`, `secrets`, `os.urandom`, `random`, pickle/JSON encoding, and framework serializers.
- Rust/Swift/.NET: inspect high-level AEAD wrappers, platform key stores, random APIs, Codable/serde/DataProtection boundaries, and logging/telemetry sinks.

## Finding Guidance

Use IDs like `CRYPTO-IMPL-001`. Severity depends on the reachable impact:

- `critical`: recoverable plaintext or key material at scale, nonce/key reuse that compromises many messages, unauthenticated encryption on attacker-controlled ciphertext with practical plaintext recovery, or server-side key access contradicting a central zero-knowledge claim.
- `high`: plaintext sensitive values or keys flow to logs/network/storage/telemetry; static or predictable keys/nonces in production; ECB or custom encryption protects sensitive user content.
- `medium`: CBC/CTR without evident MAC, weak KDF parameters, missing AAD binding, fragile serialization that can drop tags or versioning, poor key rotation/wrapping, or unproven nonce uniqueness.
- `low`: hardening issues, incomplete documentation, ambiguous test fixtures, legacy compatibility paths gated away from sensitive data.

Each finding should include:

- affected algorithm/API and wrapper;
- source-to-crypto and decrypt-to-sink path;
- nonce, key, salt, tag, and envelope evidence;
- exploit or failure scenario;
- exact limitation if reachability, environment, or runtime config is unverified;
- retest steps such as unit tests for nonce uniqueness, tag failure, KDF parameter versioning, and plaintext sink redaction.

## Primary Baselines

Use these source-backed rules in analysis; verify current docs when the target platform version matters.

- OWASP Cryptographic Storage: minimize sensitive storage, prefer vetted algorithms and authenticated modes, avoid custom crypto and ECB, use CSPRNGs, and store keys with platform/cloud key-management mechanisms where available.
- OWASP Key Management: map components that process/store key material and review key lifecycle, storage, compromise, recovery, and zeroization.
- NIST SP 800-132: password-based key derivation for storage depends on salt and iteration count parameters.
- NIST SP 800-38D: GCM security requires IV/nonce uniqueness for a given key; deterministic constructions need non-repeating invocation fields and RBG constructions need sufficient random field length.
- Official platform docs: follow the target library's exact requirements for IV/nonce size, auth tag handling, AAD ordering, key formats, and deprecated APIs.

## Limitations

Static review can miss dynamic configuration, build-time substitutions, generated code, feature flags, library defaults, deployment-specific key stores, and runtime plaintext leakage. Recommend targeted runtime tests for high-impact flows, especially nonce uniqueness, tag verification failures, KDF migration, and logging/telemetry redaction.
