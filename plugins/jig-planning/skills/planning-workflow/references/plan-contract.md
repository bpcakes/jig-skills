# Plan Contract

Use this contract as a shape, not a quota. Omit sections that do not change execution; expand sections whose omission would create material risk.

## Canonical document structure

```markdown
# <Plan title>

## 1. Outcome
- Intended user or operational result
- Completion signals

## 2. Scope
- In scope
- Non-goals
- Constraints

## 3. Current-state evidence
- Facts with code, runtime, or documentation pointers
- Inferences and confidence
- Unknowns and resolution paths

## 4. Decisions and design
- Proposed architecture and boundaries
- Data and control flow
- Interfaces and compatibility
- Consequential decisions and rationale
- Rejected alternatives, only where useful

## 5. Execution graph
- Task table or task sections
- Dependency summary and critical path
- Parallelization constraints

## 6. Verification
- Task-level checks
- End-to-end acceptance
- Performance, security, data, or compatibility checks as relevant

## 7. Rollout and recovery
- Deployment or migration phases
- Observability and decision gates
- Rollback, roll-forward, or containment

## 8. Risks and open decisions
- Risk, likelihood or trigger, impact, mitigation, owner
- Open decision, deadline or gate, default assumption
```

For a **Light** plan, use only objective, scope, tasks, and verification; an ordered task list with expected results is sufficient. The eight-section structure, task schema, and validator are optional. For a **Critical** plan, keep evidence, design, rollout, and risks explicit.

## Evidence rules

A plan should be portable, not encyclopedic.

- Cite repository evidence as `path:line`, symbol names, commands, test names, or commit references.
- Cite external choices to current official documentation and record the version or access date when it matters.
- Label estimates as estimates and state the basis.
- Replace unsupported performance or scale promises with a benchmark plan.
- Do not copy large source documents into the plan. Link them and quote only the execution-critical fragment.
- Treat generated architecture as a hypothesis until checked against the repository and runtime constraints.

## Decision record

Use a compact record for consequential choices:

```markdown
### D-01 — <decision>
- Status: proposed | accepted | deferred
- Context: <facts and constraint>
- Choice: <selected direction>
- Why: <material benefits and tradeoffs>
- Alternatives: <only serious alternatives>
- Revisit when: <evidence or threshold that invalidates the choice>
```

Do not create decision records for routine implementation details.

## Canonical task schema

Use this schema when structured tasks are useful, with stable IDs such as `T-01`, `T-02`, and so on. It is not required for Light plans.

```markdown
### T-01 — <outcome-oriented title>
- Outcome: <observable result this task delivers>
- Context: <only the evidence or decision an executor needs>
- Changes: <files, components, interfaces, data, or operational surfaces>
- Depends on: none | T-00, T-02
- Parallel with: none | T-03
- Verify: <focused commands, tests, measurements, or review evidence>
- Recovery: <rollback, roll-forward, containment, or "not needed" with reason>
- Done when: <testable completion condition>
```

### Field guidance

- **Outcome** states the delivered capability, not the activity. Prefer “Requests are authenticated with rotated keys” over “Implement auth changes.”
- **Context** contains local rationale and pointers, not a copy of the whole plan.
- **Changes** names affected boundaries. File paths are useful when known, but do not fabricate paths before inspecting the repository.
- **Depends on** contains true prerequisites only. Use `none` or a comma-separated list of task IDs (optionally in backticks); malformed entries fail structural validation. Shared sequence preference is not automatically a dependency.
- **Parallel with** is optional. Confirm the tasks do not edit the same source of truth, schema, generated artifact, or unstable interface.
- **Verify** is proportionate to risk. Prefer the narrowest check that can falsify the task's result, then add broader checks only when justified.
- **Recovery** is mandatory when the task can corrupt data, lock out users, break compatibility, or create difficult-to-reverse state.
- **Done when** is observable and binary enough for another executor to judge.

In free-form tasks, combine verification and completion criteria when one statement expresses both. If using the canonical schema and validator, keep both fields concise; the done condition can refer to the verification result. Omit optional fields that add no useful information.

Do not repeat `Unblocks` lists. Reverse edges become stale and can be derived from `Depends on`.

## Task sizing

Split a task when any of these is true:

- it has multiple independently shippable outcomes;
- it crosses ownership or security boundaries;
- it needs separate rollout or recovery;
- it cannot be verified with one coherent evidence set;
- parallel execution would materially reduce elapsed time without creating coordination races.

Keep a task whole when splitting would only create handoffs, duplicate setup, or divide one invariant across multiple owners.

## Discovery and prototype tasks

Use a research or spike task only when its output is required to choose or safely execute later work.

```markdown
### T-00 — Resolve <unknown>
- Outcome: <decision is made or uncertainty is bounded enough to proceed>
- Question: <load-bearing uncertainty>
- Method: <inspection, experiment, benchmark, or prototype>
- Boundary: <time, data, environment, or scope cap>
- Output: <decision record, measured result, interface proof, or rejected path>
- Changes: <experiment or prototype surfaces; state "no production changes" when true>
- Depends on: none
- Verify: <how the result can be reproduced>
- Recovery: <discard/reset the experiment, or "not needed" with reason>
- Done when: <exit criterion and downstream decision are explicit>
```

A prototype is evidence, not automatically production code. State whether it will be discarded, hardened, or used as a compatibility fixture.

## Critical-plan additions

Add only the dimensions relevant to the system:

- data migration invariants, rehearsal, dual-read or dual-write period, reconciliation, and cutover gates;
- authentication and authorization boundaries, secret rotation, auditability, and abuse cases;
- backwards and forwards compatibility, client skew, protocol or schema versioning;
- capacity assumptions, load test, saturation indicators, and degradation behavior;
- phased rollout, canary cohort, feature flags, stop conditions, and ownership;
- incident response, recovery time and recovery point expectations, and irreversible steps;
- legal, privacy, compliance, or retention constraints.

## Controlled replanning

Treat the plan as a versioned decision artifact. Update it when implementation evidence changes:

- a load-bearing fact or assumption;
- an architectural decision;
- task dependencies or the critical path;
- scope or acceptance criteria;
- rollout, observability, or recovery.

Record what changed and why. Do not churn the plan for code-level details already visible in the implementation.
