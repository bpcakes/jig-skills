# Completed review handoff

Read after adjudicating a completed review, or when the user authorizes repairing its findings. This artifact lets the controller reuse discovery while retaining guarded repairs, validation, and fresh post-repair reviews.

Keep the shared brief, its pinned hash, the final matching complete scope capture, and the frozen reviewer reports outside the checkout. Write `review.json` there with only `reviewers` and `findings`:

```json
{
  "reviewers": [
    {"name": "Claude", "status": "completed", "coverage": "complete", "limitations": [], "report": "The original frozen report text"},
    {"name": "Codex", "status": "not started", "coverage": "none", "limitations": ["Host agent limit"], "report": ""}
  ],
  "findings": [
    {"key": "stable-causal-key", "path": "src/example.js", "severity": "low", "title": "Verified issue", "evidence": "Trigger, cause, consequence, counterevidence, and proposed correction", "sources": ["Claude"]}
  ]
}
```

Use actual selected reviewer outcomes and exact independent attribution; the example is not a provider selection rule. Status is `completed`, `failed`, `timed out`, or `not started`. Coverage is `complete`, `limited`, `reviewer-attested`, or `none`; non-completed reviewers use `none`. Keep omissions and uncertainty in `limitations`, and preserve each completed report verbatim in `report`. Import only final actionable findings, with repository-relative file paths, stable keys, and canonical severities. An empty findings list is valid. Do not invent a report, fingerprint, brief, source attribution, or completed review to fill the schema.

Create the handoff after the final scope and brief checks:

```sh
node <comprehensive-review>/scripts/review-handoff.mjs --capture /tmp/review/capture.json --brief /tmp/review/brief.json --brief-hash <pinned-hash> --review /tmp/review/review.json --output /tmp/review/handoff.json
```

The helper validates the evidence envelope, rechecks the reviewed scope, and creates a new file outside the checkout without overwriting an existing artifact. It requires at least one completed reviewer, rejects attributed findings from failed reviewers or excluded paths, and bounds the artifact to 4 MiB. Hashes detect accidental changes; they do not authenticate a model's claims or establish review quality. Artifact failure must be reported as unavailable handoff evidence; it does not authorize restarting reviewers or fabricating success.

On “ok address” or equivalent repair authorization, use the sibling review-fix-loop's `init --from-review` entry with the saved artifact and a concrete repair/validation contract. Read its [controller interface](../../review-fix-loop/references/controller.md). An active loop must be resumed, not reinitialized. User-requested one-pass repairs still use the entry point's one-pass section.

The controller checks the original repository, scope, base, exclusions, source, and index, then imports findings as unresolved evidence for local triage. It does not repeat discovery. Committed-only branch evidence must still match a clean checkout; the repair run then pins branch scope including working-tree changes. Imported reports never count toward fresh terminal review quorum or acceptance of the repaired files. Partial reviewer coverage remains partial.

For an older review without an artifact, build one only from the retained frozen reports, brief, and matching scope capture. If those are missing or stale, explain exactly what cannot be reused. Reconcile affected findings and scope explicitly; do not silently launch a fresh full review, edit controller state, or fabricate assignments to bypass admission.
