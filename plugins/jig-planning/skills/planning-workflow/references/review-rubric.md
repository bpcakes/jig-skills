# Review Rubric

Review for execution risk, not for maximum prose. A reviewer should identify defects, not invent scope.

Light plans need only a self-check of scope, task order, and verification. Apply the gates below where relevant to Standard and Critical plans; a gate table or separate review artifact is not required unless requested. Additional review passes must address a concrete unresolved risk or material change.

## Severity

- **Blocker** — The plan cannot be executed safely or the proposed direction may fail the stated outcome.
- **Material** — Likely to cause significant rework, ambiguity, coordination failure, or unverifiable delivery.
- **Polish** — Improves clarity without changing architecture, risk, sequence, or acceptance.

Integrate blocker and material findings. Apply polish only when it improves use without bloating the artifact.

## Quality gates

### G1. Intent and scope

Pass when:

- the intended outcome and completion signals are observable;
- scope, non-goals, and constraints do not conflict;
- the plan does not add unrelated features;
- open questions are limited to choices that could materially change the result.

### G2. Evidence and assumptions

Pass when:

- repository claims have code, history, test, configuration, or runtime pointers;
- external dependencies and versions are checked against current official sources;
- quantitative claims are sourced, measured, or converted into validation tasks;
- facts, inferences, decisions, and unknowns are distinguishable;
- no critical-path task depends on an unnamed assumption.

### G3. Architecture and boundaries

Pass when:

- responsibilities, state ownership, data flow, and interfaces are coherent;
- failure behavior and compatibility are addressed where relevant;
- consequential choices have rationale and realistic tradeoffs;
- reversible details are not over-specified;
- the design fits the existing system rather than an imagined greenfield replacement.
- new abstractions and infrastructure have a concrete requirement or evidenced risk that existing components cannot adequately address.

### G4. Execution graph

Pass when:

- tasks deliver outcomes and have stable unique IDs;
- dependencies reference valid tasks and form an acyclic graph;
- the first safe tasks and critical path are clear;
- tasks are neither coordination-fragmented nor too broad to verify;
- proposed parallel work will not race on shared state or unstable interfaces.

### G5. Verification and operations

Pass when:

- every task has a focused falsifiable check and a testable done condition;
- end-to-end acceptance covers the stated outcome;
- test breadth matches the change's risk rather than a ritual checklist;
- high-impact work includes observability, rollout gates, and recovery or containment;
- ownership is explicit for consequential deployment or migration decisions.

### G6. Usability and consistency

Pass when:

- an executor can act without reconstructing hidden rationale;
- references are stable and task-local context is sufficient;
- terms, IDs, interfaces, and decisions are consistent throughout;
- the plan is concise enough to scan and detailed enough to execute;
- tracker copies, if any, point back to one canonical plan and cannot silently diverge.

## Convergence loop

1. Run a self-review against all gates.
2. Select focused review modes for the highest-risk areas; do not ask every reviewer to rewrite the entire plan.
3. Require each finding to cite a plan section or missing evidence, describe impact, and propose the smallest effective change.
4. Use one integrator to accept, reject, or reconcile findings against the user's goal and evidence.
5. Revalidate the dependency graph and any sections affected by accepted changes.
6. Stop when no blocker or material finding remains, or when a remaining item is an explicit decision gate with an owner and safe default.

A large diff does not prove improvement. A small diff does not prove convergence. Judge whether the change alters execution, risk, or outcome.

## Focused review modes

Use only the modes relevant to the plan.

### Architecture adversary

Look for mismatched boundaries, hidden coupling, ownership ambiguity, invalid assumptions about the existing system, and failure modes that invalidate the design.

### Data and migration reviewer

Check invariants, compatibility windows, backfill and reconciliation, cutover gates, observability, recovery, and irreversible steps.

### Security and abuse reviewer

Check trust boundaries, authorization, secret handling, input and output exposure, auditability, misuse paths, and safe failure behavior.

### Execution-graph reviewer

Check task outcomes, dependency direction, cycles, missing prerequisites, false parallelism, critical-path blockers, and verification gaps.

### Operations reviewer

Check deployment sequence, capacity assumptions, telemetry, alerts, ownership, stop conditions, rollback or roll-forward, and incident handling.

### Evidence reviewer

Check whether citations support the claims made, versions are current, estimates are labeled, and unknowns have concrete resolution paths.

## Fresh-executor test

Use this optional test when complex or high-risk work has a concrete handoff or interpretation risk that self-review cannot adequately resolve. Skip it for ordinary Light plans. Sample the highest-risk task and, if distinct and useful, one task from the critical path. Give each task, its referenced decisions, and its stated sources to an executor that did not write the plan. Ask it to return only:

- blockers to starting;
- assumptions it would otherwise invent;
- ambiguous done conditions;
- dependencies or risks missing from the task.

Patch material gaps. Do not expand the task merely because the executor would prefer a different coding style.

## Multi-agent use

Parallelize reviews only when their evidence and failure modes are independent. Assign one integrator. Use specialization when an agent has different domain knowledge, tool access, or accountability; avoid role labels that add no capability.

Do not blend multiple complete plans by default. Independent full-plan generation is expensive and often produces scope inflation and consensus theater. Use it only when the core architecture is genuinely uncertain, then compare explicit decision criteria rather than prose volume.
