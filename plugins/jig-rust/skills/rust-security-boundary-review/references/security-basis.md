# Research basis

This skill is intentionally narrow. It maps common Rust web/API review failure modes to widely used security guidance and Rust crate capabilities.

- OpenAI Codex skills are directories anchored by `SKILL.md` with required `name` and `description` frontmatter; optional scripts/references are supported.
- OWASP Logging guidance says access tokens, authentication passwords, database connection strings, encryption keys, and primary secrets should usually not be recorded directly in logs; they should be removed, masked, sanitized, hashed, or encrypted.
- OWASP CORS testing guidance calls out wildcard origins, reflecting request origins without checks, and credentialed CORS with wildcard origins as insecure patterns.
- OWASP Authorization guidance emphasizes robust authorization logic in the application context; authentication alone does not grant access to every resource/action.
- OWASP REST Security guidance says passwords, security tokens, and API keys should not appear in URLs because URLs can be captured in logs.
- OWASP Error Handling guidance says public errors should not provide implementation details because that can cause information leakage.
- Rust `secrecy` provides wrappers that make secret exposure explicit, prevent accidental debug leakage, and wipe secrets on drop via `zeroize`.
- Rust `subtle::ConstantTimeEq` provides an equality-like trait whose equality function should execute in constant time.

Source URLs:

- https://developers.openai.com/codex/skills
- https://developers.openai.com/cookbook/examples/skills_in_api
- https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/11-Client-side_Testing/07-Testing_Cross_Origin_Resource_Sharing
- https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html
- https://docs.rs/secrecy/latest/secrecy/
- https://docs.rs/subtle/latest/subtle/trait.ConstantTimeEq.html
