# Claude Code host

Read this when the parent agent is Claude Code. It replaces only the Codex-specific mechanics: native Codex subagents, forwarder children, and yielded tool-cell handles. Reviewer selection, the task brief, scope capture, read-only rules, merging, and the review-fix controller protocol are unchanged.

## Options

Pass `--host claude` to `review-options.mjs`, to `loop-options.mjs`, and to the review-fix controller's `init`. Claude Code has no native Codex subagent, so Codex always reviews through the `codex-review.mjs` CLI adapter: `codex.runtime` is `cli`, and `--codex-runtime native` is rejected. Defaults on this host:

- comprehensive review: Claude plus Codex;
- review-fix loop, balanced policy: two independent Claude reviews;
- review-fix loop, strict policy: Claude plus Codex.

Every reviewer is an independent CLI process started by a bundled adapter; none runs as a subagent of this session. Without `--claude-config-dir` or `--claude-launcher`, the Claude reviewer uses the same Claude account as this session. The Codex reviewer needs the prerequisites in [external reviewers](external-reviewers.md).

The adapters need network access, their provider's home, and the temporary directory. If Claude Code's command sandbox blocks an adapter, request the host's approval to run that command outside the sandbox; do not substitute another provider.

## Comprehensive review

Prepare the brief, scope capture, and each selected adapter command exactly as [parallel-review-runtime.md](parallel-review-runtime.md) and [external-reviewers.md](external-reviewers.md) describe, then start the adapters yourself instead of spawning forwarder children:

1. Create one private artifact directory outside the checkout.
2. In a single response, start every selected adapter as its own Bash call with `run_in_background: true`, redirecting stdout to `<artifacts>/<provider>.report` and stderr to `<artifacts>/<provider>.log`. Background execution is required: a foreground Bash call is limited to 10 minutes, below the adapters' 28-minute deadline.
3. Wait for each command's completion notification. Do not poll with `sleep`, rerun a command, start another reviewer, or edit the checkout while any reviewer runs.
4. A reviewer completed only when its notification reports exit code 0 and its report file is non-empty. Otherwise mark it failed with a sanitized excerpt of its log that omits home paths. A command without a completion notification is still running; never start a duplicate.
5. To cancel a reviewer, stop its background task. The adapter receives `SIGTERM`, terminates its provider process group, and removes its private files.

Then collect, verify, and merge the reports as usual.

## Review-fix loop

Run `plan-validation`, `init`, `submit`, `answer`, and `status` in the foreground. Start each `run` with `run_in_background: true`, redirecting its stdout to a file outside the checkout, and read the result after its completion notification; do not start `advance`, `status`, or another `run` while it is active. The controller runs every reviewer through its bundled bridges, so no review assignment needs an agent from this session. `run` returns at a terminal outcome, a contract question, or a triage or repair assignment: complete that assignment in this session as [assignments.md](../../review-fix-loop/references/assignments.md) describes, `submit` the result, and start `run` again in the background.

Stopping a background `run` leaves its reviewer and validation jobs owned by the run. Resume with `run --run <same path>`; do not start a new run.
