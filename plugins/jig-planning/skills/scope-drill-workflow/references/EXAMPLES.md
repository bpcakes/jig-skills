# Worked examples

All IDs, paths, requirements, and observations below are fictional fixtures. They
illustrate behavior; never cite them as evidence about a user's repository.

## Example 1: Feature creep and unnecessary architecture

### Fixture

The user's approved request is: "Let an administrator manually export the current
filtered records as CSV." Project requirements also demand tenant isolation and
correct CSV encoding. Only this format is required. In this fixture, inspection
confirms the existing request path supports the agreed bounded dataset; that fact
must be verified separately in a real repository.

The current epic `ex-export` has gained these items:

| ID | Current obligation | Relevant relation |
| --- | --- | --- |
| `ex-manual` | Manual export endpoint using a new generic provider API | Depends on `ex-provider` and `ex-tenant`. |
| `ex-provider` | Pluggable multi-format export framework | Only `ex-manual` currently needs it. |
| `ex-tenant` | Enforce tenant isolation | Required for manual export. |
| `ex-csv-tests` | Verify retained CSV behavior and isolation | Validates retained behavior. |
| `ex-schedule` | Configure recurring exports | Depends on `ex-worker` and `ex-jobstore`. |
| `ex-worker` | Run dedicated scheduled-export jobs | Used only by scheduling. |
| `ex-jobstore` | Store scheduled-export job state | Used only by scheduling. |
| `ex-schedule-tests` | Validate recurring delivery | Used only by scheduling. |

The epic's acceptance criteria currently claim both manual and scheduled export.
No fixture task is in progress or completed; there are no external consumers.
The project's fixture convention keeps deferred members visible under the epic
but excludes them from the current-release rollup. A real audit must verify the
local convention or propose approved membership changes instead.

### First question: breadth

> Scheduling and its three supporting tasks are not part of the approved manual
> export outcome. I recommend excluding that branch from this release. You would
> lose automatic delivery, but manual export stays intact. Is scheduling required
> now, excluded for now, or still unresolved?

User: "Exclude it for now."

Record D1 and stop asking scheduling-design questions. This settles scope, not yet
the precise tracker edits.

### Second question: implementation

> Only CSV is required, and the existing request path meets this fixture's agreed
> workload. A focused CSV implementation avoids the provider framework. Another
> format would need a later change. Should we take the direct implementation or
> keep the framework as an explicit investment for this release?

User: "Use the direct implementation."

### Exact proposed changes

**C1 — Defer scheduling.** Remove the scheduled-export acceptance condition from
`ex-export`; add it to the release's excluded scope. Indefinitely defer
`ex-schedule`, `ex-worker`, `ex-jobstore`, and `ex-schedule-tests`, each with the
reason "Outside this release; reconsider when scheduled delivery is approved."
Keep the scheduling branch's internal prerequisite relationships. Apply the
fixture's existing release-rollup convention; do not create a new roadmap epic.

**C2 — Simplify manual export.** In `ex-manual`, replace the requirement to use a
provider API with "Implement manual CSV export through the existing authorized
request path; honor the current filter and preserve isolation and CSV encoding."
Keep the retained tests and concrete acceptance checks. Cancel `ex-provider` with
the non-delivery reason "Generic provider framework not required for the approved
single-format implementation." Remove only the blocking edge from `ex-manual` to
`ex-provider`. Preserve `ex-manual`'s dependency on `ex-tenant` and all hierarchy
relations.

**Keep unchanged:** tenant isolation and all validation of the retained CSV path.

Question: "Apply C1-C2 as described, revise them, or leave this as an audit?"
After approval, re-read the current state before applying. Changes that invalidate
the fixture assumptions require a revised proposal.

### Honest completion

Report actual post-state only. Verify that the four deferred tasks are excluded
from real selection queues, that `ex-provider` is recorded as cancelled rather
than delivered, and that `ex-manual` is not incorrectly ready before isolation is
satisfied. Re-read release criteria and rollup.

The real reduction is recurring delivery plus the dedicated worker/job-state
obligations, and the generic provider API. It is not the decrease in ticket count.
Do not claim an estimated number of saved days without supporting estimates.

## Example 2: The proposed complexity is necessary

### Fixture

An approved import must handle files too large for the configured request path
and must resume after interruption. Repository evidence confirms both the limit
and the need for durable progress. The epic includes a worker, persistent job
state, and retry/recovery tests.

### Expected review

Keep those capabilities: removing them breaks approved acceptance conditions.
Still test whether an existing worker system can be reused rather than deploying
another, but do not assume such a system exists.

A useful question might be whether an unrelated multi-provider adapter framework
is required. It is not useful to ask the user to remove resumability purely to
produce a smaller epic. Report "No supported infrastructure cut found" if the
existing design is already the simplest adequate one.

## Example 3: A shared prerequisite survives a branch cut

### Fixture

Scheduling-only work `ex-scheduled-report` depends on `ex-common-worker`.
Another epic's required import also depends on `ex-common-worker`, and that worker
is already implemented.

### Expected review

Deferring scheduled reports does not authorize cancelling the common worker or
removing its code. Preserve the shared component and the import's edges. Remove
only obligations proven to be exclusive to the excluded branch and explicitly
approved. Report the shared dependency rather than asking for a broad redesign.

## Example 4: Missing intent and no live tracker

### Fixture

The user provides an epic export with no original request and says: "Audit only;
no questions." The export lacks external dependency data.

### Expected review

State that the release boundary is provisional. Recommend conditionally: "If
manual export is the entire required outcome, scheduled delivery is a candidate
for deferral." Do not assume its presence in the epic proves it was user-approved,
or that its absence from the original request is established when that request
was not provided.

Mark external-consumer checks unavailable. Produce a useful review, not an apply
receipt. Do not invent tool calls, create fake IDs, ask the prohibited questions,
or claim that deferred work has been removed from a live queue.

## Example 5: The user authorizes a broader release

### Fixture

The reviewer proposes deferring a second integration. The user states that both
integrations are contractual requirements for this release and provides the
relevant specification.

### Expected review

Update the release boundary, keep both integrations, and stop pushing the cut.
Review whether they need the proposed generalized plugin marketplace, not whether
the user should abandon the approved second integration. Scope control preserves
user intent; it is not an instruction to minimize the product at any cost.
