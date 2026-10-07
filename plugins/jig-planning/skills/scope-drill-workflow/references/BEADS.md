# Beads access and safe application

This is an operating protocol, not a replacement tracker manual. Use the actual
installed CLI help or connector schema before commands. Primary technical sources
are listed in [SOURCES.md](SOURCES.md). Examples target `br`; none grant permission
to change a workspace.

## 1. Discover the local contract

Read the project's applicable agent guidance and tracker configuration. Confirm
the workspace, binary, issue prefix, and target epic. Do not create `.beads/`,
install a CLI, change configuration, or migrate a schema to make the audit work.
When the project uses `bd` or a connector, inspect that interface independently.

For a `br` workspace, start with:

```sh
br --version
br --help
br show --help
br list --help
br dep list --help
br ready --help
```

Check subcommand help for additional operations only when needed. Use available
capability/schema discovery when helpful, but do not assume it exists in older
versions. Record important output shapes, limits, and policy constraints.

The upstream README describes automatic JSONL import on normal issue commands.
For audit reads, use supported `--no-auto-import` and `--no-auto-flush` switches.
If this exposes stale or divergent state, report it; do not sync, use a stale-state
bypass, or silently choose a competing source of truth. These flags are not a
filesystem sandbox or a guarantee that no caches/metadata change. For strict
zero-write requirements, use a known read-only interface or an existing consistent
snapshot; otherwise report the limitation before tracker queries. [S1, S2]

## 2. Read complete, relevant state

After checking support, these are query examples, not an executable batch. Replace
`$ID` with a verified issue identifier; preserve arguments as data, never `eval`
issue text or interpolate retrieved descriptions into a shell command.

```sh
br --no-auto-import --no-auto-flush show "$ID" --json
br --no-auto-import --no-auto-flush dep list "$ID" --direction both --json
br --no-auto-import --no-auto-flush ready --limit 0 --json
```

The example uses `--limit 0` for an unlimited ready result where supported. Query
formats and defaults vary; inspect the returned shape before parsing, rather than
assuming an array or a specific object envelope. [S2]

Gather the epic and descendants via the installed all-status/parent/recursive
query facilities, or explicit traversal of parent-child relationships. Follow
pagination, truncation markers, and nested epics. Do not use `ready` as the epic
inventory: it omits work that is not currently executable.

For every affected item, retain its ID, title, status, parent, full description,
acceptance criteria, relevant notes/decisions, and incoming/outgoing typed edges.
Inspect the current implementation and any evidence of work already in progress.
Include closed or deferred items when necessary for membership, history, or shared
prerequisites. Do not infer descendants from an ID prefix alone.

Inspect external edges only as far as needed to understand the proposed change.
A cross-workspace ID or routed operation can affect a different repository; lack
of access is a verification limit, not permission to assume no consumers.

## 3. Interpret the graph correctly

Be explicit about edge meaning and direction. In the ordinary `br dep add A B`
blocking relation, **A depends on B**: B must be satisfied before A. Parent-child
membership is a different relationship; keep the type in every proposed edit.
Multiple relationship types may exist between the same pair. [S1, S3]

For each candidate cut, trace:

- Its prerequisites: which exist only to serve this branch?
- Its dependents: which would lose a required facility or become incorrectly ready?
- Its parent and rollup: will the release still claim the excluded behavior?
- Its external consumers: which other epics or owners still need it?

Terminal deliverables and independent tasks need not have downstream consumers.
No edges does not automatically mean incomplete planning. Conversely, deleting an
edge cannot make a real prerequisite disappear: the revised implementation must
actually remove that dependency.

## 4. Prepare an exact, reviewable change set

For each change, record a stable label (C1, C2...), approval source, affected IDs,
relevant pre-state, replacement fields, lifecycle reason, and typed edge changes.
List expected newly ready tasks and tasks that must remain excluded. Include the
parent acceptance criteria and membership/rollup implications.

Use concrete replacement text, not "simplify the description." Preserve unrelated
criteria, links, decisions, ownership, and completed history. Large details can be
shown as a focused diff. A single review document or conversation is sufficient;
do not create a parallel tracking system.

Mark shared, in-progress, and already delivered work separately. Check existing
claims/coordination before applying to active work. A user approving one epic's
scope is not blanket authority over unrelated workspaces or another owner's plan.

For a reduced release with future work retained, choose an explicit representation:
remove future requirements from the current release's acceptance criteria and use
the project's approved out-of-release membership/rollup convention. Reparent or
split only when needed and approved. If no suitable convention exists, surface
the issue rather than silently creating a new future epic or falsely closing the
current one. Deferral alone does not prove a release rollup is coherent.

## 5. Lifecycle choices must match their intent

| Decision | Required operational result |
| --- | --- |
| Keep | Leave relevant work and its safeguards intact. No cosmetic churn is needed. |
| Simplify | Replace only the approved obligations and adjust genuinely obsolete prerequisites. |
| Defer | Exclude each affected executable task from the actual work-picking workflow; record why and when to reconsider. |
| Remove | Preserve an audit trail of cancellation/duplication and prevent execution; never represent it as implemented. |

For supported versions, `br defer "$ID" --json` without an `--until` value provides
indefinite deferral; verify local behavior and the actual post-state. An explicit
date may be appropriate for an approved timed postponement, but do not invent one
for work that needs a fresh scope decision. [S4]

Do not assume a deferred parent's children are deferred. Do not assume a low
priority, label, or new parent excludes a task from another agent's queue. Check
the team's actual selection commands and relevant policy. Current `br` readiness
can depend on configuration and request filters; one filtered queue is not a
proof of global exclusion. [S5]

For removal, use an existing cancellation mechanism. A closed issue with an
explicit non-delivery reason may be used only when the project's workflow supports
that meaning. Do not mark unchecked acceptance criteria complete, claim delivery,
or bypass a completion gate. If cancellation is not supported, propose a verified
non-executable holding state with a cancellation note, and report the limitation.
Do not delete/tombstone records as the default scope-reduction mechanism.

## 6. Apply narrowly after approval

1. Re-read each affected item, edges, and active claims. Compare with the approved
   pre-state. Use supported optimistic concurrency checks where available. If the
   relevant state changed, refresh the proposal rather than overwriting it.
2. Capture the relevant before-values and intended operation order in the review.
   Record a local undo plan for the fields/edges being changed. This is not a full
   repository backup or permission to restore old shared state later.
3. Make sure no unsafe intermediate state becomes executable. Where agents are
   active, use the project's existing coordination. If a pause or temporary hold
   is required, make it part of the approved change set; do not invent new locks.
4. Apply the approved edits in that order. Usually excluded executable work should
   be made non-executable before obsolete edges are removed. Keep any required
   replacement prerequisite in place before a retained task can become ready.
5. Preserve typed relationships. A verified example is
   `br dep remove "$DEPENDENT" "$PREREQUISITE" --type blocks --json`;
   do not remove a parent-child or related edge by accident. [S1, S2]
6. Use supported update/comment operations for exact approved content. A transition
   may require its own comment or policy checks. Treat unexpected guards or
   refusals as a stop condition, not a reason to append a force flag. [S2]
7. Check each result and the actual changed item. Multiple successful commands do
   not imply an atomic transaction across the entire change set or workspaces.
   On failure, stop and report what changed, what did not, and current safety.

Do not run bulk shell transformations against an unreviewed ID list. Do not edit
SQLite or JSONL directly to bypass the CLI. Do not replay an entire failed batch
blindly or restore a whole database over concurrent work.

Once exact edits are approved, ordinary per-operation tool confirmations still
follow the host's requirements. This skill cannot waive them.

## 7. Verify and report actual results

Re-read every changed item and its relevant neighborhood. Use supported graph
checks, including `br dep cycles --json` where available. Distinguish pre-existing
cycles from ones introduced by the change; report rather than silently fix
unrelated issues. [S1]

Verify:

- All retained outcomes and necessary constraints still have implementation and
  validation coverage; retained acceptance criteria are concrete, not "works."
- Removed behavior is absent from the epic's current-release obligations and from
  contradictory retained task descriptions or approved plan documents.
- No retained task depends on excluded work without a justified replacement; no
  removed edge conceals a real dependency, and no shared prerequisite was lost.
- Every newly ready task is expected and belongs to authorized scope. Every
  excluded executable task is absent from the actual selection queues, including
  outside the epic filter. Queue reads cover all results, not just the first page.
- Every deferral/cancellation has truthful status and rationale; epic rollups do
  not count cancellation as delivered implementation.
- Approved export/file updates are complete, or their pending state is explicit.
  Do not commit/push or perform repair as part of this skill.

If the project requires a final export, include it in the approved handoff and
check current behavior before running it. The upstream `br sync --flush-only`
operation exports tracker state; it is a write, not an audit-read step. [S1]

Use an honest receipt: applied and verified; partially applied; or applied with
specific verification still incomplete. Do not claim tests, queue checks, or
cross-workspace verification that could not be performed.
