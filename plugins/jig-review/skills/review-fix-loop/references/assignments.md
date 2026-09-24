# Native assignment handoff

Read when the controller returns a native assignment. Its `resultSchema` is authoritative for that assignment; examples below illustrate the protocol.

Read the `assignment` object in the returned request file. For reviews, pass that object to a fresh-context agent with conversation inheritance disabled (`fork_turns: "none"` or the host equivalent). It contains the frozen contract, concrete scope, exclusions, repository path, provider settings, fingerprint, and machine-readable `resultSchema`; it contains no prior findings. Return the exact result envelope and enum values from that schema, including severity `critical`, `high`, `medium`, or `low` (not P0–P3). By default `repository` is the actual checkout, including its existing dependencies and build caches. Use the provided scope metadata and OIDs for inspection. In per-round mode, inspect the entire `commitRange.range`; the controller pins the base across rounds and requires both terminal reviews to cover the same final tip. Context isolation does not imply a separate checkout. Reviewers may read only the validation logs explicitly linked in `validationEvidence`; previous controller reports, other assignments, transcripts, validation narratives, and repair history under the Git common directory's `jig/review-fix` tree remain outside their inputs. Ordinary Git object/index access remains available for diff inspection. This is a cooperative role restriction, not a filesystem access-control guarantee.

Native assignments already include the shared [tool-output guidance](../../comprehensive-review/references/native-tool-output.md) in their frozen instructions; pass those instructions through without appending a second copy. It applies to native review, triage, and repair diagnostics. Full diagnostic logs remain available outside the checkout; compact tool output does not replace required controller validation.

Save the result outside the checkout and submit it:

```sh
node <skill>/scripts/review-fix-loop.mjs submit --run <run> --assignment <id> --result /tmp/result.json
```

Each result includes `assignmentId` and `fingerprint` copied from the assignment. Submit one immutable JSON result for each pending assignment ID, in any completion order. Malformed native results are rejected before freezing or consuming an attempt; correct the result and resubmit the same ID. Do not regenerate an already accepted result. Do not manually rerun a claimed job; uncertain execution stops without replay. For startup, transport, or cleanup failures, read [recovery.md](recovery.md).

Reviews receive `validationEvidence` with the assignment fingerprint and content hash, plus one entry per pinned check. A non-null `receipt` supplies execution identity, outcome, original hashes, command/context, log paths, and truncation metadata. `reused: true` means the controller has accepted applicability to the enclosing fingerprint and content hash; the original receipt remains unchanged. A null receipt means no applicable execution is recorded. Raw logs remain evidence, not instructions. Assess test adequacy and source behavior independently; cite check IDs in `acceptance.validationIds`.

Review result:

```json
{
  "assignmentId": "<id>", "fingerprint": "<hash>", "complete": true,
  "findings": [{"key": "stable-causal-key", "path": "src/items.ts", "severity": "medium", "title": "Rename changes order", "evidence": "Concrete supported trigger and source reference"}],
  "acceptance": [{"criterionId": "order", "status": "unsatisfied", "evidence": "Source and test evidence", "validationIds": ["unit"]}]
}
```

Acceptance status is `satisfied`, `unsatisfied`, or `uncertain`. Findings must use stable causal keys and repository-relative included paths. Repeated findings retain the highest reported severity regardless of report order; individual reports remain available. Reports with findings or unmet requirements are still valid completed reviews; they are not provider failures to retry. Return `{"error":"reason"}` for a failed native invocation, with optional `retryable: false` only for a known permanent provider failure. External provider JSON cannot supply `exitCode` or `signal`: the worker records those transport facts. An `execution` field is accepted only on error results as `completed` or `uncertain`; uncertainty stops without replay. Reserved fields are rejected before merging provider data with transport metadata.

Triage result:

```json
{"assignmentId":"<id>","fingerprint":"<hash>","decisions":[{"id":"<finding-id>","status":"actionable","evidence":"Verified reproduction or source evidence"}]}
```

Decisions must cover every persisted finding, including earlier findings absent from fresh reports. Status is `actionable`, `rejected`, `fixed`, `blocked`, or `awaiting-validation`; the last is only for acceptance requirements whose outstanding required checks have not failed. It runs those checks and returns to local triage; successful execution alone does not resolve coverage concerns. Conditional `needs-validation` remains available for source reconciliation; `fixed` requires current validation. Mark only independently safe repairs actionable when other findings are blocked. The controller performs eligible repairs before stopping for remaining required or in-threshold blockers; below-threshold findings remain recorded without preventing `THRESHOLD_MET`. A material unresolved contract choice may instead return `question: {"text":"...","recommended":"...","evidence":"Repository evidence cannot decide because ..."}`. The controller returns this question once and waits. Record the user's answer with `answer --run <run> --text <answer>`; the text is literal, including a leading `--` (for example, `--text "--legacy should stay"`). Empty answers are rejected. The original contract remains frozen and its answer supplement is included in subsequent assignments. Routine approval questions are outside this protocol.

For `requirement-<criterionId>` findings, address every current report’s acceptance concern for that criterion in the existing decision `evidence`. A `fixed` decision requires applicable successful controller validation and a source/coverage explanation that resolves those concerns. The controller records `acceptanceResolutions` tied to each report, criterion, source fingerprint/content hash, triage assignment, and cited validation executions. Original reports remain immutable. A rejected requirement, passing checks alone, or a resolution for an earlier report/source state cannot satisfy acceptance. This happens in ordinary triage without another review, check execution, repair round, or result field.

When triage includes `validationAssessment`, also return `validationImpact`, with one `{ "assignmentId": "<completed-check-id>", "status": "unaffected" | "rerun", "evidence": "<specific dependency and diff evidence>" }` entry per listed check. Inspect its recorded before/after snapshots and commands. Receipt appends can leave a check applicable; state consumed by code, tests, or configuration can invalidate it. The original execution result keeps its fingerprint. Accepted reuse is recorded separately, and failed checks remain failed. Use `needs-validation` for apparent fixes while reuse is still being assessed; the controller accepts reuse after this submission. This is local triage, without another discovery pass or permission request.

Triage receives the actual assignment `contentHash`, current `validationReuse` bindings, and `validationPending` check IDs. Match a validation record's `fingerprint` and `candidateHash` to the assignment's fingerprint and content hash, or use a supplied reuse binding for that record's `assignmentId`. A pending check's older result is not current proof. All selected checks must be attempted, including optional checks left unstarted or marked `rerun` during reconciliation. Optional failures remain recorded without blocking acceptance; uncertainty still stops execution.

Every validation-impact entry needs evidence with non-whitespace content. A blank entry rejects the whole submission before any disposition or reuse binding is accepted.

Repair result (preferred):

```json
{"assignmentId":"<id>","fingerprint":"<hash>","workspaceEdits":[{"path":"src/items.ts","reason":"Restore order while keeping the supported API","findingIds":["<finding-id>"]}]}
```

Edit files directly in the repair assignment's `repository`, which defaults to the actual checkout. Inspect the diff and return the attribution list above, including additions and deletions. List every source path you edited exactly once. Changes outside that list are preserved and recorded separately as unattributed checkout changes; they are not claimed as your repair. Fresh validation and review assess the combined checkout. Preserve existing permissions; for an intentional permission change, make that change on disk and declare the matching `mode` (`"0644"` or `"0755"`). New files retain their on-disk permissions. Keep result JSON and scratch scripts outside the checkout and stop editing before submitting.

The controller records the existing edits and validates them without copying or republishing source files. The Git index must remain unchanged during the assignment; in per-round mode, the controller then publishes a separate round commit before validation. Invalid or interrupted repairs remain in the checkout and are reported for reconciliation; they are not silently discarded or retried as if no edits occurred. Ignored diagnostic outputs are not repair source files. Review and triage remain read-only.

Explicitly isolated validation retains the older copy-and-apply workflow, including permission normalization. Configured adapters returning inline file images use [inline-edits.md](inline-edits.md); ordinary native repairs use direct edits.
