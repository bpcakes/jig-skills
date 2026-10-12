# Tracker bindings

Select the repository's configured tracker, not whichever executable or `.beads` export is visible. Support `br` and the compatible `bead` CLI. `bd` needs a separately verified binding. A tool upgrade or migration is not a prerequisite imposed by this skill; the working Python Beadroll implementation is supported.

The coordinator owns new-task tracker transitions. Preserve an adopted task's existing owner until an acknowledged handoff. A supported takeover may recover a definitively stopped owner under existing recovery authority; silence or an expired timer is insufficient. Record the observation and reason. Worker process identities remain distinct from the tracker actor.

For an admitted task, settle active jobs and reconcile pending effects before changing its tracker owner. Use the [runtime ownership-transfer operations](runtime.md) to persist intent before a coordinator-driven native transfer, then record its confirmed published result. An already completed authorized transfer can be recorded through `reconcile_claim`. Both retain the prior ownership receipt and require the canonical task/authority, exact previous owner, successor, and handoff or takeover evidence. Uncertain transfer outcomes keep ownership unchanged and block new assignments until reconciled; a session replacement or worktree handoff alone never changes tracker ownership.

## Beads Rust (`br`)

Use one configured canonical store/authority for cross-host claims and closure. Independent clone databases are not a distributed lock. All participating writers must route through that authority. Verify database redirection/access without inspecting a protected main working tree; `--db` is available in current `br`, but repository policy determines the actual database/export binding.

The installed CLI is authoritative. Relevant discovery is read-only:

```sh
br --version
br capabilities --json
br update --help
br sync --help
```

At admission, perform the repository's supported import/export reconciliation while preserving local records, then re-read requirements, blockers, and owner at the authority. Current `br update <id> --claim --actor <actor> --json` offers an atomic local claim. Read back the durable owner and record the command/result receipt before dispatch. Do not use forced status/assignment changes to turn a conflict into a claim.

`br ready`, a graph tool, or scheduler ranking only selects candidates. Recheck blockers/assignment after claiming. Code fetch/pull alone does not demonstrate tracker freshness.

Current `br sync --flush-only` exports and `--import-only` imports JSONL; `--merge` has its own conflict semantics. Select the mode required by repository policy, inspect conflicts, and preserve unrelated records. Do not force an export/import or hand-edit JSONL to manufacture ownership/status. `br sync` does not Git commit/push the export. Closure requires the separate configured publication step and its receipt; a successful local command is insufficient for cross-machine completion.

## Beadroll (`bead`)

Use the existing workspace and coordination ref; do not add a second distributed claim store. Confirm the installed contract with `bead --version`, `bead --help`, and relevant `bead help <command>`. Compatible commands include:

```sh
bead --json sync
bead --json ready
bead --json show <task-id>
bead --json --actor <run-actor> claim <task-id>
bead --json --actor <run-actor> close <task-id> -r <completion-reason>
```

These are contract examples, not setup probes: `sync`, `claim`, and `close` mutate coordination state and run only within the authorized task lifecycle. Use one recorded stable run actor on its designated machine when appropriate; never copy a machine identity to simulate failover.

`ready`, `show`, and other reads are local; sync before admission and closure reconciliation. Require a confirmed online claim accepted by the coordination remote. An offline provisional claim, ambiguous error, or lost acknowledgement does not admit work. Reconcile using the same claim identity and supported sync/query operations instead of retrying a takeover.

Recheck dependencies and acceptance prerequisites after claim: the inspected Python claim implementation enforces ownership but does not itself check graph blockers. Claims persist until release, close, or supported takeover. Do not assume a lease expired.

Writes can be recorded locally while publication remains pending. Inspect structured results, including `unpublished`, and verify publication before describing a task as globally closed. Preserve/reconcile a pending close instead of emitting it again. Do not use `close --force` to bypass another actor's claim.

Beads JSONL retained after migration is interchange/history, not Beadroll's live store. Never run `br` against that leftover export. Match behavior at runtime; neither the current Rust rewrite nor its completion is required to use a working Python installation.

## Completion and dependencies

Close only after the task's required PRs, final combined behavior, acceptance, and cleanup are satisfied. Preserve an incomplete task after a merge or unpublished close. Reconcile parent epic criteria independently of child statuses. When fresh evidence contradicts acceptance, reopen under the same scope and owner, publish that transition, and preserve historical proof.
