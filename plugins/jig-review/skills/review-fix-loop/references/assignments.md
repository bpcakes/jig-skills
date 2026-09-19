# Native assignment handoff

Read when the controller returns a native assignment. Its `resultSchema` is authoritative for that assignment; examples below illustrate the protocol.

Read the `assignment` object in the returned request file. For reviews, pass that object to a fresh isolated agent with conversation inheritance disabled (`fork_turns: "none"` or the host equivalent). It contains the frozen contract, concrete scope, exclusions, repository copy, provider settings, fingerprint, and machine-readable `resultSchema`; it contains no prior findings. Return the exact result envelope and enum values from that schema, including severity `critical`, `high`, `medium`, or `low` (not P0–P3). The repository copy has source contents, index state, pinned HEAD, and initialized submodule contents. Use the provided scope metadata and OIDs for inspection; the copy does not reproduce source branch names or remotes.

Save the result outside the checkout and submit it:

```sh
node <skill>/scripts/review-fix-loop.mjs submit --run <run> --assignment <id> --result /tmp/result.json
```

Each result includes `assignmentId` and `fingerprint` copied from the assignment. Save one immutable JSON result for the current assignment. Do not manually rerun a claimed job; uncertain execution stops without replay. For startup, transport, or cleanup failures, read [recovery.md](recovery.md).

Review result:

```json
{
  "assignmentId": "<id>", "fingerprint": "<hash>", "complete": true,
  "findings": [{"key": "stable-causal-key", "path": "src/items.ts", "severity": "medium", "title": "Rename changes order", "evidence": "Concrete supported trigger and source reference"}],
  "acceptance": [{"criterionId": "order", "status": "unsatisfied", "evidence": "Source and test evidence", "validationIds": ["unit"]}]
}
```

Acceptance status is `satisfied`, `unsatisfied`, or `uncertain`. Findings must use stable causal keys and repository-relative included paths. Repeated findings retain the highest reported severity regardless of report order; individual reports remain available. Reports with findings or unmet requirements are still valid completed reviews; they are not provider failures to retry. Return `{"error":"reason"}` for a failed native invocation. External provider JSON cannot supply `exitCode` or `signal`: the worker records those transport facts. An `execution` field is accepted only on error results as `completed` or `uncertain`; uncertainty stops without replay. Reserved fields are rejected before merging provider data with transport metadata.

Triage result:

```json
{"assignmentId":"<id>","fingerprint":"<hash>","decisions":[{"id":"<finding-id>","status":"actionable","evidence":"Verified reproduction or source evidence"}]}
```

Decisions must cover every persisted finding, including earlier findings absent from fresh reports. Status is `actionable`, `rejected`, `fixed`, or `blocked`; `fixed` requires current validation. Mark only independently safe repairs actionable when other findings are blocked. The controller performs eligible repairs before stopping for remaining required or in-threshold blockers; below-threshold findings remain recorded without preventing `THRESHOLD_MET`. A material unresolved contract choice may instead return `question: {"text":"...","recommended":"...","evidence":"Repository evidence cannot decide because ..."}`. The controller returns this question once and waits. Record the user's answer with `answer --run <run> --text <answer>`; the text is literal, including a leading `--` (for example, `--text "--legacy should stay"`). Empty answers are rejected. The original contract remains frozen and its answer supplement is included in subsequent assignments. Routine approval questions are outside this protocol.

Repair result (preferred):

```json
{"assignmentId":"<id>","fingerprint":"<hash>","workspaceEdits":[{"path":"src/items.ts","reason":"Restore order while keeping the supported API","findingIds":["<finding-id>"]}]}
```

Edit files directly under the repair assignment's `repository` using the normal editing tool (`apply_patch` when available). Inspect the resulting diff, then return the attribution list above. Include additions and deletions; request intentional permission changes with an optional `mode` of `"0644"` or `"0755"` on the workspace edit. Every changed source path must be listed exactly once, and every listed path must have changed or request a mode different from its original mode. Attribution errors record both changed-but-unlisted and listed-but-unchanged paths. Keep result JSON and scratch scripts outside the copy and stop editing before submitting. Do not create replacement-building scripts or serialize whole source files for ordinary repairs. The controller captures the candidate when it consumes the result and preserves it in the blob store before cleaning up the copy. Review and triage assignments remain read-only.

For workspace repairs without an explicit `mode`, new files are normalized to `0755` if any executable bit is set, otherwise `0644`, regardless of the editor's umask. Existing files keep all their original permissions, so an editor's temporary replacement cannot widen read permissions or remove executable bits. An explicit workspace `mode` overrides these defaults for existing or new regular files, and can request a permission-only change without modifying the copy. Modes on deletions are rejected. Special permission bits in the copy are rejected. The controller also rejects unattributed changes, symlinks, ignored/unmanaged paths, exclusions, and changes to the Git index or pinned repository state before publication. Ignored diagnostic outputs are not part of the candidate.

Configured adapters that return file images use [inline-edits.md](inline-edits.md). Do not load that legacy protocol for ordinary workspace repairs.
