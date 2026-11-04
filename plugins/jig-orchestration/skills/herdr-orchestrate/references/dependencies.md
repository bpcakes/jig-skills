# Prepare together, land in dependency order

Do not block downstream implementation, integration or validation solely because a prerequisite PR is unmerged. When its exact published source is stable and focused checks pass, integrate that commit at a settled writer boundary and overlap useful downstream work within existing authority, slots, ownership and budgets. Prefer the downstream branch and worktree with one writer. Keep the prerequisite independently reviewable, publish the combined candidate promptly, and land the prerequisite first. Do not repeatedly restack on every upstream update, add an omnibus PR by default, or substitute combined checks for either task's acceptance criteria.

## Classify the dependency

Use the coordinator-only `dependency` operation with ordinary action/task/policy versions:

```json
{
  "op": "dependency",
  "task_id": "B",
  "dependency": {"task_id": "A", "kind": "source", "pr": 415, "head": "<full published OID>"},
  "reason": "B needs A's fixture fix; A's remaining publication acceptance can continue independently",
  "evidence": {
    "ref": "/evidence/source-ready.json", "observed_at": "<UTC timestamp>",
    "all_jobs_settled": true, "pr": 415, "head": "<same OID>",
    "published": true, "focused_checks": true
  }
}
```

Both tasks must be admitted. The downstream writer and intents must be settled. Evidence follows the helper's existing receipt trust boundary: the coordinator verifies publication and checks at their source; the helper checks bindings, not GitHub authenticity. The task's `dependencies` and append-only `dependency_history` retain the pin and classification rationale.

| Kind | Required pin | Enforcement |
| --- | --- | --- |
| `source` | PR, exact published head, focused checks | Allows useful downstream work immediately; merge, deployment and closure await that exact PR head's recorded landing. |
| `merge` | PR and exact head | Defers landing, deployment and closure without blocking implementation or validation. |
| `acceptance` | Prerequisite task | Allows implementation and merge; deployment and closure require prerequisite acceptance/closure. |

Keys are `<task_id>:<kind>`; a source edge and an acceptance edge to the same task can coexist. Adding a source pin never removes an acceptance edge. A new pin requires another settled boundary and evidence; it cannot overwrite a running assignment. Cycles across typed and recovery edges are rejected. Unclassified recovery edges keep their original completion-before-launch behavior. Classify them only after inspecting the actual dependency; do not relabel a genuine acceptance requirement to obtain source readiness. Classification does not resolve an open recovery automatically: use `resolve_recovery` with changed evidence, preserving its original contract and budgets.

Before merging B, record `gates.dependency_incorporation`, keyed by dependency ID. Each source/merge entry needs ordinary `ref`/`observed_at` evidence plus `head` (pinned A head), `merge_commit` (A's recorded landing), `candidate_head` (exact B head), `target` (configured target branch), `source_incorporated:true` and `target_incorporated:true`. Inspect the actual objects and live target. Squash/rebase landing requires an explicit content comparison; ancestor checks alone cannot establish equivalence. A changed prerequisite head does not satisfy the old pin. Reconcile it deliberately at the next writer boundary. Normal final-stage integration checks and live PR protections still apply.

## Preserve applicable review evidence

When A lands, first check whether B's candidate actually changed. Preserve the exact-head review if it did not. For a different commit with identical reviewed content and unchanged scope/contract, use the review controller's [upstream reconciliation operation](../../../../jig-review/skills/review-fix-loop/references/upstream.md). The controller records applicability and reruns checks; never rewrite report fingerprints or certify old reports as new reviews. A standalone discovery report remains discovery evidence.

If source, generated output, exclusions, comparison base or review policy changed, use the existing source/successor reconciliation workflow and review the change and its interactions. Carry findings and cumulative budgets. Preserve a user-pinned fixed base. An unsupported reconciliation is a concrete limitation, not authorization to bypass the controller.

## Bind CI to the combined candidate

Inspect CI's actual checkout commit and tree, PR head, target/test-merge commit, workflow/tool versions, environment and generated-input provenance. Record those in the delivery evidence. Reuse results only when the repository implements a supported mechanism that binds all relevant inputs. Never copy A's green status onto B, or infer that an unchanged application tree makes migration/history checks reusable. This plugin supplies no cross-PR CI cache; the initial controller operation reruns all configured checks, including prerequisites.

GitHub may require the test merge commit's checks when that commit has a status; otherwise it uses the latest head's checks. Verify the live PR's required context and any merge queue. See [required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks). Retargeting may alter the comparison and make comments outdated; it is not a preservation mechanism. See [changing a PR base](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/changing-the-base-branch-of-a-pull-request).

Measure stable-source-to-accepted-delivery time, with discarded CI/review work and contention as countermetrics. The workflow enables overlap; it does not establish a measured time saving.
