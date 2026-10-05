# Planning Prompts

Adapt these prompts to the task. Preserve the user's constraints and the repository's conventions.

## Create a plan

```text
Create the minimum sufficient implementation plan for the requested outcome.

Bias toward action: inspect the relevant code, configuration, tests, history, runtime evidence, and current official documentation available to you. Make reasonable assumptions and label them. Ask only when an answer could materially change the outcome, an irreversible choice, safety or compliance, cost, or external side effects; continue all independent work first.

Do not add adjacent features or generic best practices unless they address a stated goal or evidenced risk. Keep facts, inferences, decisions, and unknowns distinct.

Prefer the simplest sufficient design using existing components. Justify each new abstraction, task split, review pass, or verification gate by a concrete requirement or risk.

Choose Light, Standard, or Critical depth based on blast radius and reversibility. For Light plans, include only objective, scope, an ordered task list with expected results, and focused verification; additional schema and independent reviews are optional. For Standard and Critical plans, include the relevant items below:
- outcome, completion signals, scope, non-goals, and constraints;
- current-state evidence with stable pointers;
- proposed architecture, interfaces, data flow, failure behavior, and consequential decisions;
- outcome-oriented tasks with stable IDs, Depends on edges, focused verification, recovery where needed, and testable done conditions;
- critical path, safe parallelism, risks, open decisions, rollout, and recovery in proportion to the work.

Finish with a proportionate self-review; use the relevant planning quality gates for Standard and Critical plans. Return the completed plan, not a proposal to write one.
```

## Audit an existing plan

```text
Audit this plan against the stated outcome and available evidence. Do not reward length and do not invent scope.

Classify findings as Blocker, Material, or Polish. For each Blocker or Material finding:
1. cite the exact plan section or missing evidence;
2. explain the concrete execution, reliability, security, migration, or coordination impact;
3. identify the assumption or decision involved;
4. propose the smallest effective patch;
5. note any task or dependency edges that must change.

Check intent and scope, evidence, architecture, interfaces, failure behavior, dependency integrity, false parallelism, verification, rollout, observability, and recovery. Distinguish a factual defect from a reasonable alternative design.

End with a concise readiness conclusion: READY, READY WITH EXPLICIT DECISION GATES, or NOT READY. Add a gate table only when it helps explain material findings or the user requests one. Do not rewrite the plan unless asked.
```

## Integrate review findings

```text
Integrate the accepted review findings into the canonical plan.

Preserve the user's scope and all still-valid decisions. Reject suggestions that add unsupported features, duplicate existing content, or optimize prose without changing execution. When findings conflict, resolve them against repository evidence, constraints, reversibility, and the stated outcome; record a decision gate if evidence is insufficient.

After editing, revalidate task IDs, dependency edges, critical path, cross-references, verification, rollout, and recovery. Return the revised plan and a compact change log containing only material changes and explicitly rejected material findings.
```

## Architecture-focused review

```text
Review only the architecture and system boundaries in this plan. Look for invalid current-state assumptions, hidden coupling, unclear state ownership, incompatible interfaces, missing failure behavior, migration hazards, and decisions that are over-specified or not specified enough.

Use repository and official-document evidence. Return Blocker and Material findings only, each with impact and the smallest corrective patch. Do not propose new product features.
```

## Execution-graph review

```text
Review only the execution graph. Validate task outcomes, IDs, Depends on edges, cycles, missing prerequisites, false dependencies, false parallelism, critical-path blockers, task sizing, verification, and done conditions.

Return:
- invalid or missing edges;
- tasks that should merge or split, with a concrete reason;
- unsafe parallel groups;
- tasks that cannot be judged complete;
- the corrected critical path.

Do not redesign the product unless the graph exposes an architectural contradiction.
```

## Critical migration review

```text
Review this migration plan as a production cutover reviewer. Check invariants, compatibility windows, rehearsal, backfill, reconciliation, dual-read or dual-write behavior, observability, stop conditions, ownership, rollback or roll-forward, and irreversible steps.

For every proposed gate, state the evidence that permits progression and the signal that forces a stop. Identify any step whose recovery story is not credible. Return Blocker and Material findings only.
```

## Convert to tracker tasks

```text
Convert the canonical plan's delivery tasks into the repository's existing tracker format.

First inspect the tracker contract and installed CLI or connector; do not assume command names. Preserve canonical task IDs, titles, Depends on edges, task-local context, verification, recovery, and done conditions. Link each issue to the canonical plan instead of duplicating the full document.

Do not create issues for writing, reviewing, polishing, or converting the plan unless the planning artifact itself is the requested deliverable. Validate the exported graph for missing IDs and cycles before finishing.
```
