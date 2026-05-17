# Privacy Field Matrix

Scope:

- Product or component:
- Environment:
- Claims reviewed:
- Test account/data:
- Artifacts reviewed:
- Date:

## Summary

| Class | Count | Notes |
| --- | ---: | --- |
| encrypted_content | 0 |  |
| encrypted_metadata | 0 |  |
| plaintext_operational_metadata | 0 |  |
| avoidable_plaintext_leakage | 0 |  |
| unknown | 0 |  |

## Field Matrix

| Field | Semantic field | Surface | Artifact | Observed representation | Class | Plaintext readers | Operational purpose | Affected claim | Evidence | Confidence | Limitation / retest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  | source schema / API / DB / frontend / trace / log / queue / storage |  | plaintext / ciphertext / hash / token / derived / absent | encrypted_content / encrypted_metadata / plaintext_operational_metadata / avoidable_plaintext_leakage / unknown | client / server / operator / DB admin / support / third party / recipient / public |  |  | file:line, request id, trace id, row id, screenshot, command | high / medium / low |  |

## Open Evidence Needed

| Field or claim | Missing evidence | Why it matters | Suggested test |
| --- | --- | --- | --- |
|  |  |  |  |

## Findings

From this template directory, use `../../audit-common/templates/finding.schema.json` for machine-readable findings. Prefix ids with `PCFC`, for example `PCFC-001`.
