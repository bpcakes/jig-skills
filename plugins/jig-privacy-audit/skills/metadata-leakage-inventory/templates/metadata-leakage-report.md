# Metadata Leakage Inventory Report

## Scope

- Product/component:
- Environment:
- Date:
- Reviewer:
- Accounts/roles tested:
- Included systems:
- Excluded systems:
- Claims and policy sources:

## Sources Reviewed

| Source | Type | Coverage | Notes |
|---|---|---|---|
|  | claim / policy / code / schema / capture / DB / log / trace / telemetry / third-party / admin / export |  |  |

## Claims and Policy Comparison

| ID | Source | Statement | Metadata Covered | Observed Alignment | Evidence | Gap or Limitation |
|---|---|---|---|---|---|---|
| MLI-CLAIM-001 |  |  |  | matches / partial / conflicts / unknown |  |  |

## Metadata Inventory

| ID | Metadata Item | Surface / Artifact | Observed Representation | Readers | Purpose | Precision / Stability / Retention | Category | Risk Modes | Affected Claim | Evidence | Confidence | Limitation / Retest |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| MLI-ITEM-001 |  | API / DB / log / trace / telemetry / notification / support / third-party / export | plaintext / encrypted / hashed / pseudonymous / derived / absent / unknown | client / server / operator / support / third party / recipient / public |  |  | operational_metadata / avoidable_metadata / sensitive_metadata / claim_contradicting_metadata / unknown | linkability / identifiability / behavioral_inference / social_graph_exposure / timing_inference |  | file:line, request id, trace id, row id, screenshot, command | high / medium / low |  |

## Risk Summary

| Risk Mode | Evidence-Backed Inference | Affected Items | Severity Driver |
|---|---|---|---|
| linkability |  |  |  |
| identifiability |  |  |  |
| behavioral_inference |  |  |  |
| social_graph_exposure |  |  |  |
| timing_inference |  |  |  |

## Minimization Recommendations

| ID | Metadata Item / Flow | Recommendation | Preserved Purpose | Expected Risk Reduction | Owner | Retest |
|---|---|---|---|---|---|---|
| MLI-MIN-001 |  | remove / encrypt / aggregate / coarse-grain / rotate / partition / shorten retention / restrict readers / strip before third party / pad or batch |  |  |  |  |

## Findings

From this template directory, use `../../audit-common/templates/finding.schema.json` for machine-readable findings. Prefix ids with `MLI`, for example `MLI-001`.

| ID | Title | Severity | Confidence | Affected Claim | Evidence | Impact | Recommended Fix | Retest |
|---|---|---|---|---|---|---|---|---|
| MLI-001 |  |  |  |  |  |  |  |  |

## Open Evidence Needed

| ID | Missing Evidence | Why It Matters | Suggested Test / Artifact |
|---|---|---|---|
| MLI-GAP-001 |  |  |  |

## Limitations

- 
