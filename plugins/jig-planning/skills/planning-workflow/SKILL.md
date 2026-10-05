---
name: planning-workflow
description: >-
  Create or audit evidence-backed implementation plans for complex software changes.
  Use for architecture, migrations, cross-system work, high-risk delivery, or
  dependency-aware parallel execution; skip small local fixes, open-ended research,
  and work already covered by an executable plan.
---

# Planning Workflow

Create the **minimum sufficient plan** that reduces material execution risk. Optimize for decision quality and implementability, not document length.

## Operating priorities

1. Follow the user's explicit scope, constraints, and requested format over this skill.
2. Bias toward action. Inspect available evidence, state reasonable assumptions, and produce the plan rather than stopping at a plan proposal.
3. Ask only when an answer could materially change the goal, an irreversible choice, safety or compliance, cost, or external side effects. Continue independent work while a non-blocking question is open.
4. Keep facts, inferences, decisions, and unknowns distinct.
5. Read only the code and documentation relevant to the decision at hand. Do not load a full repository or every reference by default.
6. Default to the simplest sufficient design and reuse existing components and conventions. Justify new abstractions, task splits, review passes, and verification gates by a stated requirement or concrete risk; hypothetical future flexibility is not sufficient.

## Calibrate plan depth

Choose the lightest profile that covers the real risk:

| Profile | Use for | Required shape |
|---|---|---|
| **Light** | Small cross-file work with known design and low rollback cost | Objective, scope, tasks, verification |
| **Standard** | Multi-component features, new services, integrations, or parallel work | Evidence, design, dependency graph, risks, verification |
| **Critical** | Data or auth migrations, security boundaries, irreversible operations, high blast radius | Alternatives, decision gates, phased rollout, observability, recovery, ownership |

Light plans require only objective, scope, tasks, and verification. Use a short ordered task list with expected results; additional sections, canonical task fields, IDs, dependency graphs, and independent reviews are optional. The workflow below supplies considerations, not extra mandatory deliverables for this profile.

A short reversible spike is valid when it is the cheapest way to resolve a load-bearing unknown. Define its question, output, time or scope boundary, and exit criterion.

## Workflow

### 1. Frame the outcome

Record the user-visible or operational outcome, scope, non-goals, constraints, and completion signals. Convert vague aspirations into observable results. Do not invent adjacent features merely to make the plan look comprehensive.

### 2. Ground the plan

Inspect the relevant repository paths, tests, configuration, history, runtime evidence, and current official documentation. For every load-bearing external or quantitative claim, attach a source, measurement, or explicit validation task.

Use this evidence ledger:

- **Fact** — directly observed, with a source or code pointer.
- **Inference** — conclusion drawn from facts; state uncertainty.
- **Decision** — chosen direction, rationale, and material tradeoff.
- **Unknown** — unresolved item, impact, and how it will be resolved.

Reference stable sources instead of copying whole documents. Inline only the context an executor needs to avoid rediscovery or a dangerous interpretation.

### 3. Resolve architecture at the right level

Describe boundaries, data flow, interfaces, state ownership, failure behavior, compatibility, and operational impact. Compare alternatives only when the choice is still live or the rejected option is likely to recur.

Separate:

- **Reversible choices** an implementer may make locally within stated guardrails.
- **Consequential choices** that require an explicit decision or approval.

Read [plan-contract.md](references/plan-contract.md) when structured tasks or a canonical plan are useful. Light plans do not need that schema.

### 4. Build the execution graph

For Standard and Critical plans, create outcome-oriented tasks with stable IDs. Each task must identify:

- the result it delivers;
- the concrete surfaces it changes;
- prerequisites using `Depends on` edges;
- focused verification and completion criteria;
- recovery or containment where failure has material cost.

Keep tasks independently verifiable without fragmenting cohesive work into bookkeeping. Record only dependency direction once; derive reverse edges and the critical path from the graph. Mark parallel work only when agents will not race on the same state or interface.

### 5. Review to convergence

For Light plans, self-check scope, task order, and whether the proposed checks establish the intended result. For Standard and Critical plans, use the relevant gates in [review-rubric.md](references/review-rubric.md). Review the highest-risk assumptions and interfaces first. Add independent reviewers or subagents only when a concrete risk warrants another perspective and the failure modes are separable; use one integrator if multiple reviewers contribute.

Prefer existing tests and the narrowest check that establishes the result. Verification may also express the done condition without duplicating it. Formal proofs, model checking, exhaustive test matrices, and new test infrastructure require a specific requirement or evidenced risk that ordinary checks cannot adequately cover.

Do not require a fixed number of review rounds. Stop when:

- no blocker or material defect remains;
- remaining uncertainty is explicit and has an owner or resolution path;
- another pass is likely to produce style changes rather than change execution, risk, or outcome.

For plans using the canonical task schema, run:

```bash
python scripts/validate_plan.py path/to/plan.md --profile standard
```

Use the selected profile in the command. The validator checks structure and dependency integrity; it does not prove the design is correct. It applies only to the canonical schema; do not expand a Light plan merely to run or satisfy it.

### 6. Deliver and export

Deliver the plan with material assumptions, open decisions, and the first safe action. Include the critical path when dependencies make it useful. Export tasks to a tracker only when requested or when the repository already uses one. Preserve task IDs, dependency edges, acceptance criteria, and a link to the canonical plan; do not duplicate the entire plan into every issue.

Read [tracker-export.md](references/tracker-export.md) before converting to Beads or another issue system. If the repository uses task-local ExecPlans, create them during execution for tasks that need them rather than adding meta-planning tasks by default.

## Completion gate

A plan is ready when an executor can begin the first safe task without rediscovering the architecture, and when all of these are true:

- scope and non-goals are explicit;
- load-bearing claims are grounded or scheduled for validation;
- consequential decisions and assumptions are visible;
- task IDs and dependency edges, when used, are valid and acyclic;
- each task has proportionate verification and a testable done condition;
- rollout, observability, and recovery match the blast radius;
- no unresolved item silently blocks the critical path.

Update the plan during execution only when evidence changes a material assumption, decision, dependency, scope boundary, or recovery strategy. Record the change; do not rewrite history silently.

## Conditional references

- Read [prompts.md](references/prompts.md) for creation, audit, integration, and focused-review prompts.
- Read [astra-calibration.md](references/astra-calibration.md) when using GPT-6 Astra or configuring an Astra-class API workflow.
- Read [tracker-export.md](references/tracker-export.md) only when converting the plan into issues or coordinating multiple executors.
