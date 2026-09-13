# Supporting-Work Closure

Use only after a complete comprehensive review of the current state leaves no outstanding substantive defect or material question, and every remaining eligible finding is a verified supporting obligation with a safe correction. An incomplete review cannot establish this baseline. The ordinary scope, exclusions, index preservation, validation-output rules, severity threshold, and user constraints still apply.

## Eligibility and Budget

Closure completes established requirements without changing substantive behavior or redefining a contract. Examples include correcting a stale explanation or link, adding a missing regression through the public entry point, strengthening an assertion, regenerating documentation from an unchanged source, or supplying a required changelog entry. File names and small diffs do not establish eligibility. Executable skill instructions, public types, schemas, build/dependency changes, and changes that weaken test discovery or assertions require substantive assessment under the runtime.

Allow one closure batch per loop, including after `maxRounds` ordinary rounds or before any ordinary repair. Mark it consumed before its first repository mutation. Batch all known eligible obligations. Allow one further supporting correction batch across both validation and focused verification; it may address newly established material supporting gaps. That correction gets its own validation and focused verification. Mechanical corrections in closure use this same single allowance, not the ordinary round's two mechanical passes. There are at most two closure edit batches and two focused verification passes. A failed or unavailable required check after the allowance is exhausted is `validation failed`; unresolved material supporting work after completed verification is `closure incomplete`.

Do not replenish closure by calling it a new round, regrouping obligations, or resuming the same loop. If closure exposes a substantive defect and a later ordinary round repairs it, genuinely new supporting obligations caused by that repair may consume remaining ordinary rounds, each followed by validation and full review. Record the creating substantive repair and new requirement; keep original obligation IDs and closure usage. This permits neither ordinary retries of unresolved closure work nor extra supporting work unrelated to the later substantive repair. New supporting-only rounds add no substantive attempts; at the ordinary cap they yield `round limit reached`. Record usage in the handoff. Optional new suggestions do not create obligations. Newly demonstrated material gaps remain outstanding if the correction allowance cannot close them. An explicit user limit on total edits, reviews, or time overrides this allowance; if it prevents necessary closure, disclose that constraint and report `closure incomplete`.

## Capture and Repair

1. Preserve the complete preceding review and its fingerprint as the comprehensive baseline. Record each obligation's stable ID, established requirement, concrete gap, affected paths, and any linked substantive finding. Do not reopen a validated substantive fix solely to add supporting evidence.
2. Before edits, save the reviewed contents and file inventory needed to construct an exact cumulative closure patch, including additions, deletions, modes, and affected submodules, in a private temporary directory outside the repository. Recheck the full-scope fingerprint before mutation. Preserve pinned commits, exclusions, and index.
3. Apply the batch, validate the obligations, and recheck affected earlier evidence. Tests must distinguish the claimed regression from alternative success paths; for an `epics()` own-field case, descendants must not supply the match. When useful, check a deliberately broken implementation in an external temporary copy to establish the oracle. Do not weaken assertions, bless an unverified snapshot, or add runtime changes to make a new test pass.
4. Reconcile every actual repository change against the saved baseline and recorded operations. Capture the current full-scope fingerprint. Prepare the complete cumulative patch from that baseline, not merely the last correction. New or generated paths must be included. If complete closure evidence cannot be constructed, stop as `review incomplete` rather than claim verification of omitted changes.

If a test or verifier exposes a substantive defect or invalidates the original proof, retain or reopen the original substantive finding and its history. Stop supporting edits and verify the defect against the established contract; a failing test or reviewer claim alone does not establish that the implementation is wrong. When the defect and safe correction are established and ordinary rounds remain, count an ordinary repair round and correct it directly, without an intervening full review. Require the complete preceding comprehensive baseline, fully accounted-for retained closure edits, a rechecked current fingerprint, and recurrence/reassessment of the proposed repair. Validate the cumulative change and affected earlier fixes, then obtain a fresh full-scope comprehensive review. This transition grants no substantive edits under closure's allowance and cannot establish convergence through focused verification alone.

Retain closure usage and original obligations across the transition. Any unused correction remains limited to supporting work under the same closure allowance; if resumed after an ordinary repair and complete review, save a new comprehensive baseline and verify all subsequent closure edits without resetting batch or verification counts. When required validation failed, direct repair is allowed only if that failure is specifically explained by the verified substantive defect; unresolved unrelated failures must independently qualify for the runtime's counted recovery. At the cap, report `round limit reached` with the defect evidence. A required test failure without an established substantive cause follows `validation failed`; a contradicted test expectation may instead be corrected against the established contract within the remaining supporting allowance. Unknown contracts block dependent edits. Never weaken a valid assertion or label a failing behavioral test as a harmless coverage gap.

## Focused Verification

Use the same selected reviewers and provider settings as the comprehensive baseline, with fresh isolated contexts. Give each reviewer the current full-scope evidence, the cumulative closure patch, and neutral statements of requirements and gaps. Do not supply prior reviewer conclusions, repair narratives, or desired verdicts. This is an explicit exception to ordinary comprehensive assignments: verify the closure delta and relevant contracts, rather than restart unrestricted discovery of optional improvements. Reviewers must inspect all closure edits for substantive changes, collateral effects, weakened tests, and unfulfilled requirements; they may report any concrete substantive defect encountered.

Both external adapters accept the internal `--closure-context <absolute-json-path>` argument. This is not a public loop or comprehensive-review control and is absent from ordinary review invocations. Write one mode-0600 JSON file outside the repository and pass the same bytes to every reviewer:

```json
{
  "version": 1,
  "reviewedFingerprint": "<64 hex characters: comprehensive baseline>",
  "currentFingerprint": "<64 hex characters: current full scope>",
  "obligations": [
    {
      "id": "T1",
      "requirement": "An epic can match solely through its own fields.",
      "gap": "Existing tests also match descendants.",
      "paths": ["crates/studio/src/scope/tests/search.rs"]
    }
  ],
  "patch": "<complete cumulative closure patch from saved baseline>"
}
```

The helper accepts bounded regular UTF-8 JSON up to 256 KiB, validates its shape and current fingerprint, and puts the untrusted JSON in fragmented evidence pages. A separate nonce-delimited block identifies exactly those closure page IDs; other repository pages cannot supply closure metadata. Both adapters require coverage receipts for every closure page and repository page. Missing receipts remain limited coverage, and incomplete closure capture fails before provider launch. It does not prove that the claimed prior review ran or that the supplied patch is complete; the parent must establish both from the saved review, snapshots, and actual changes. Do not truncate to fit. If the evidence exceeds the bound, report `review incomplete` or use an ordinary full review within the remaining budget; a transport fallback grants no further closure edits. Never put excluded content in the closure file or include it in the patch.

For native Codex, use the same assignment and JSON data in its self-contained prompt, with the full-scope fingerprint helper commands from the parallel runtime. External forwarders still invoke their adapter once and only forward its frozen result. All reviewers retain ordinary read-only restrictions, timeouts, coverage reporting, and pre/post full-scope fingerprint checks. Supplying a closure patch does not excuse missing full-scope evidence pages. Inspect every reviewer's obligation verdicts; omission is not success. Apply [reviewer recovery](reviewer-recovery.md) to eligible operational failures before reporting `review incomplete`. A replacement stays within the same focused pass and grants no further edits or verification passes.

Report each obligation as satisfied, unsatisfied, or uncertain with evidence, and distinguish supporting findings, substantive findings, and optional suggestions. A substantive finding follows the return-to-ordinary-triage rule above, even if every named obligation passed. Any substantive edits already made invalidate the focused-only exception and require a fresh comprehensive review; they cannot be retroactively authorized by a successful test. A supporting correction uses the one remaining correction batch, then repeats verification over the entire cumulative closure delta. No second correction or third focused pass is allowed.

## Completion

Convergence requires successful required validation, all material obligations resolved, no outstanding substantive finding, a complete comprehensive baseline, complete verification by every selected reviewer of every subsequent change, and a verified unchanged terminal fingerprint. Confirm no edits occurred after that verification. Retain the comprehensive baseline fingerprint separately from the final closure fingerprint. Report ordinary rounds, comprehensive reviews, closure edit/correction usage, and focused verification passes separately. Never call the combined evidence a comprehensive review of the final state.

If closure removes the entire included scope, the runtime's verified-empty-scope exception may establish completion instead; record the skipped verification honestly. Otherwise review silence or a passing test alone is insufficient.
