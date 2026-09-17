# Optional Beads logging

Read this only for `--log-to-beads`. The flag authorizes storing final actionable findings in the repository's existing Beads tracker. It does not authorize installing or initializing Beads, repairing tracker state, reopening issues, or committing/pushing. Without the flag, do not probe or write Beads. Beads owns issue lifecycle; this skill keeps no second task database or scheduler.

Before initial scope capture, run:

```text
node "<skill-root>/scripts/beads-findings.mjs" preflight "<repository-root>"
```

Save the returned JSON verbatim to a private temporary `beads-receipt.json` outside the repository. Add its `excludePaths` to every scope capture, reviewer, and repair-controller invocation; disclose these exclusions. Only local `.beads` or `_beads` stores with an existing database are supported. Redirected/symlinked stores and effective JSONL-only (`no-db`) configuration are rejected explicitly. If preflight fails, continue the requested review without logging and report the reason; do not silently claim logging is enabled.

Run the requested review and any already-authorized repairs. Retain the flag in the comprehensive-review parent when routing to review-fix-loop; never forward it to the controller or a reviewer. The parent logs once after the controller's terminal handoff, not after each round. Use only verified, still-actionable residual findings from a completed review of the final files. Recheck any retained one-pass findings against the repaired files; disclose that this is verification, not independent re-review. If recovery, drift, or incomplete capture prevents a trustworthy final result, do not publish stale findings. An incomplete provider set may still yield verified findings, with its coverage limitation included in their evidence.

Immediately before the final response, prepare a private JSON file outside the repository:

```json
{
  "scope": {"scope": "working-tree", "excludePaths": [".beads"]},
  "fingerprint": "<final verified scope fingerprint>",
  "findings": [{
    "causalKey": "<stable owning boundary and violated invariant>",
    "title": "<short issue title>",
    "location": "src/file.mjs:42",
    "severity": "medium",
    "kind": "substantive defect",
    "sources": ["Codex"],
    "rootCause": "<verified cause>",
    "impact": "<trigger and observable consequence>",
    "evidence": "<reproduction or source evidence; material uncertainty and coverage limits>",
    "recommendation": "<correction at the responsible layer and behavior to verify>"
  }]
}
```

Use the actual scope, all explicit exclusions, pinned `base` OID and `includeWorkingTree` for branch reviews. Do not use a pre-repair fingerprint for repaired files. Deduplicate by cause before writing. Do not log repaired findings, rejected findings, optional suggestions, or unresolved questions as bugs. Empty `findings` is valid.

Use a stable causal key independent of line numbers, severity, wording, reviewer, or commit. Inspect existing issues with the receipt's pinned database (`br --db <database.path> --no-auto-import --no-auto-flush list --status all --limit 0 --json`). If an existing active issue already covers the same cause under another key or was created manually, set `reuseIssueId` to that ID after verifying equivalence. Automatic deduplication handles identical keys; it cannot establish semantic equivalence by itself. Closed/deleted occurrences get a new deterministic recurrence reference; existing issues are never overwritten or reopened.

```text
node "<skill-root>/scripts/beads-findings.mjs" log "<beads-receipt.json>" "<final-findings.json>"
```

The helper rechecks destination identity, effective storage mode, and the final scope before writing. Preflight uses `br doctor --json` without repair flags to inspect a database snapshot; it rejects damaged storage and pending imports while allowing database changes awaiting export. Do not substitute `br sync --status`, which can automatically rebuild damaged storage. The helper uses named CLI arguments, bounded commands, and Beads' external references for repeat-run deduplication. Automatic lookup pages through issue IDs, statuses, and external references, including tombstones, without retrieving full descriptions. It stores issues in the existing database with automatic import/export disabled; normal Beads synchronization remains the user's workflow. It never stages tracker files or invokes Git writes.

Include created/reused issue IDs in the final response. On failure, preserve the review report, disclose the error and confirmed IDs, and say logging is incomplete. A command can fail after a committed write: the helper re-queries that reference, reports confirmed writes, and stops rather than retrying the mutation. On a later retry, reuse the same causal keys. Do not claim atomic multi-issue publication.
