# Parallel review runtime

The parent owns selection, scope, orchestration, and merging. Use the parsed `reviewers` array as the only spawn list; never probe or spend tokens on an unselected provider. Resolve scope with [scope.md](scope.md) before using this runtime.

## Shared task context

Prepare the brief described in SKILL.md before spawning. Run `node "<skill-root>/scripts/review-brief.mjs" <brief.json>` and retain its exact hash and guidance. For native Codex, embed the returned `guidance` verbatim in the assignment. For external adapters, append `--task-brief <absolute-brief.json> --task-brief-hash <hash>`; they verify the bytes before any provider starts and embed the same guidance. The file is read by the adapter, not exposed as a provider filesystem dependency. Do not hand different summaries to different reviewers. After collection, validate the brief again with `node "<skill-root>/scripts/review-brief.mjs" <brief.json> <hash>`; a mismatch invalidates the same-task review.

The guidance requires evidence for requirement coverage, causal ownership, and counterevidence. Native and external reports should include a compact `Requirement coverage` list, with each supplied ID marked satisfied, unmet, or uncertain. No brief is required for adapters called by other workflows; those callers retain their own task-contract protocol.

## Spawn every selected child

Attempt one transient, context-free child for each selected reviewer before waiting for any result. Use the host option that disables conversation inheritance (`fork_context: false`, `fork_turns: "none"`, or its exact runtime equivalent). Continue spawn attempts after any earlier failure. Never run a selected reviewer in the parent context and never start a reviewer sequentially after showing it another report.

- When Codex is selected, read [native-reviewer.md](native-reviewer.md) and construct its self-contained assignment.
- When Claude or Cursor is selected, read [external-reviewers.md](external-reviewers.md) for the selected provider and give its forwarder the resolved command and polling recipe.

## Collect and merge

Wait only after all selected spawn attempts, following the shared [waiting policy](waiting.md). Unless the user supplied a different deadline, allow each child up to 30 minutes from launch. Each external adapter enforces a 28-minute deadline so its CLI exits before the parent deadline. On timeout, stop or interrupt that child when the host supports it, record a sanitized failure, and continue with other reports. A spawn failure, timeout, empty child response, or response produced before a yielded adapter reached terminal exit is never a successful report.

Never retry an external reviewer merely because its forwarder returned empty or lost its process handle. First establish that the original adapter and provider process group reached terminal exit, or cancel the original forwarder/adapter and wait for its bounded cleanup. If the original invocation cannot be accounted for, mark that reviewer failed and do not risk a duplicate billable provider run.

Keep completed reports immutable. If a child returns prose around a valid report, strip only obvious transport chatter; do not ask it to revise findings after it has seen another report.

When an authorized review-fix loop owns an assignment, its [controller](../../review-fix-loop/references/controller.md) accounts for provider attempts, fallback, and terminal decisions. Return the frozen result to that assignment; do not independently launch a replacement. One-pass reviews retain their invocation limits.

Before merging, stop on any child that returned `CAPTURE_INCOMPLETE` or `SCOPE_CHANGED`. Rerun the fingerprint helper with the same concrete arguments and every explicit exclusion, using the first capture's `baseOid` rather than a moving base name. Require complete matching captures; report incomplete evidence or drift instead of merging. Validate the pinned brief again. Then use [the output contract](review-output.md), including conditional staging advice and evidence-coverage limits.

The parent may discard a demonstrably unsupported finding, but must not turn post-hoc validation into independent discovery. Source attribution comes only from matching root causes across the completed frozen reports. Use the exact matching subset in canonical order (`Claude`, `Codex`, `Cursor`); never use `Both` or `All`.

## Failure handling

- Start and consume tokens only for selected reviewers. Do not require or probe an unselected external CLI.
- If some selected reviewers fail, continue with completed reports. Call the output merged only when at least two reports completed.
- If no selected reviewer completes, report each failure and do not claim that a review completed.
- If a child cannot be started, mark it `not started`; if it exceeds the runtime deadline, stop it when the host supports cancellation and mark it `timed out`.
- Treat an empty external-forwarder response as a transport failure, not a completed review. Do not retry until the original adapter invocation is known to have exited or has been cancelled and cleaned up; otherwise a retry can duplicate billable provider work.
- When review-fix-loop owns an assignment, its executable controller accounts for attempts, fallback, and terminal decisions. Return the result to that assignment; do not independently retry a provider. One-pass reviews retain their existing invocation limits.
- An incomplete fingerprint stops the workflow, including when discovered after a reviewer exits. Report its issues without claiming scope drift or retrying another provider. Evidence-page omissions with a complete fingerprint remain explicitly limited coverage; they are not fingerprint failures.
- Large external reviews use paged patch evidence. Retain each adapter's `Evidence coverage` summary and missing-page/capture limitations in review notes. `reviewer-attested` means the reviewer supplied valid page receipts and claimed to review those pages; it does not prove review quality. A `limited` report remains limited even with an unchanged fingerprint. An inline preview truncated while complete evidence pages are available is not itself a capture omission.
- If line numbers are unavailable, use the narrowest stable file or symbol reference available.
