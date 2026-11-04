# Reconcile an upstream landing

Use `reconcile-upstream` after a pinned prerequisite lands when the combined candidate already has settled successful controller evidence. This operation retains the immutable reports, their reviewer identities and original fingerprints. It records a separate applicability relationship and reruns configured validation and prerequisites. It does not publish GitHub statuses or satisfy repository merge protections.

```bash
node <skill>/scripts/review-fix-loop.mjs reconcile-upstream --run <returned-run-directory> --receipt /absolute/path/landing.json
node <skill>/scripts/review-fix-loop.mjs run --run <returned-run-directory>
```

The receipt is an explicit, sourced assessment, not a waiver. Inspect the prerequisite PR and its actual published head/landing before preparing it:

```json
{
  "from": "<controller's original fingerprint>",
  "upstream": {"pr": 415, "head": "<pinned source OID>", "landing": "<merge/squash OID>", "target": "<observed target OID>"},
  "evidence": "/evidence/pr415-landed.json",
  "assessment": {
    "history": {"applicable": true, "evidence": "<why the original review conclusions survive the history change>"},
    "environment": {"applicable": true, "evidence": "<environment comparison and effect on review conclusions>"},
    "tools": {"applicable": true, "evidence": "<review tool/version and policy comparison>"},
    "generatedOutputs": {"applicable": true, "evidence": "<generator inputs, outputs and provenance comparison>"}
  }
}
```

The controller checks that the source commit belongs to the reviewed candidate and the landing belongs to the observed target. The receipt's author verifies the GitHub PR-to-commit relationship and any squash/rebase equivalence; Git ancestry cannot prove those external facts. Do not claim applicability when the assessment found a material change.

Supported scope is intentionally narrow: the current checkout's owning run must be settled `CONVERGED` or `THRESHOLD_MET`, with its original quorum intact, a clean committed branch, identical full source and tree, identical fixed base/merge base, exclusions, comparison configuration, contract, review policy and reviewer identities. Reports created before applicability capture was supported cannot be retroactively qualified. The same candidate can retain its exact fingerprint; an identical-content new commit gets an explicit binding in `status.upstreamLandings`. Original report files and prior outcomes remain unchanged in the audit history. A threshold-limited run remains threshold-limited.

The operation returns to `VALIDATE`; it is not a new convergence verdict. All configured prerequisites and checks rerun, including history-sensitive checks. Prior validation receipts stay historical and cannot satisfy this cycle, even when the fingerprint stayed identical. Failing checks follow normal triage/repair rules and block convergence. New repairs require fresh reviews. Round counters, provider attempts and findings persist.

After an interrupted call, inspect the run and continue it. Repeating the identical receipt for its still-current candidate returns the recorded state without scheduling another validation cycle. A new landing or assessment needs new evidence.

Changed code, generated outputs, base, exclusions, Git comparison configuration or review policy are refused without rebinding state. Settle any ongoing jobs first. For material changes use [source reconciliation](recovery.md#source-reconciliation) or a permitted successor with the actual scope, carried findings and cumulative budget. This operation does not reopen an interrupted wave, import a standalone panel report as terminal evidence, or downgrade quorum. Handoffs remain discovery inputs.
