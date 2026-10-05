# Tracker Export

The plan is the canonical decision artifact. A tracker is the execution index. Export only after the plan's task graph is coherent.

## Adapter-first workflow

1. Inspect repository instructions and existing tracker data.
2. Detect the installed CLI, connector, or API and read its current help or skill.
3. Map the tracker fields and dependency semantics before creating anything.
4. Create or update tasks idempotently using the canonical plan IDs.
5. Re-read the exported graph and compare it with the plan.

Do not assume a command from the tool name. For example, Beads ecosystems may expose `bd`, `br`, `bv`, or another compatible implementation with different JSON envelopes and subcommands. Detect what exists:

```bash
command -v bd || true
command -v br || true
command -v bv || true
```

Then inspect `--help`, repository instructions, or the relevant tool skill before issuing writes.

## Field mapping

Preserve at least:

| Plan | Tracker |
|---|---|
| Task ID | Stable external ID, label, or title prefix |
| Outcome title | Issue title |
| Context and changes | Task-local description |
| `Depends on` | Native blocker edges or explicit dependency field |
| Verify and Done when | Acceptance criteria |
| Recovery | Rollback or containment field/section |
| Plan location | Link to canonical plan and section anchor |

Do not paste the entire plan into each task. Duplication creates drift and consumes agent context. Include enough local context to execute the task plus stable pointers to shared decisions.

## Issue boundaries

Create issues for independently verifiable delivery outcomes. Do not create issues whose only output is:

- writing the plan;
- running another generic review round;
- polishing plan prose;
- converting the plan into issues;
- writing a task-local ExecPlan, unless that document is itself the user's requested deliverable.

Research or decision issues are valid when a concrete result is required to unblock later work. Give them a question, method, output, boundary, and exit criterion.

## ExecPlans

When a repository uses ExecPlans, keep ownership clear:

- the project plan owns cross-task architecture, decisions, and dependency graph;
- the tracker issue owns one delivery outcome, status, dependencies, and acceptance;
- the task-local ExecPlan, when needed, owns discoveries, detailed execution, progress, validation evidence, and recovery for that issue.

Do not force every issue to have an ExecPlan. Use one when the task is long-running, high-risk, or likely to require material replanning during execution.

## Graph validation

After export, verify:

- every plan task maps to exactly one intended tracker item;
- all dependency targets exist;
- edge direction matches `Depends on`;
- no cycle was introduced;
- no critical-path task lost its acceptance or recovery criteria;
- closed or pre-existing work is represented accurately;
- ready-work queries return the expected roots.

If the tracker lacks native dependencies, preserve the canonical graph in the plan and use an explicit machine-readable field or consistent task section rather than relying on prose ordering.

## Multi-agent coordination

A dependency graph is not a concurrency lock. Before assigning parallel tasks, also check:

- shared files, schemas, generated outputs, environments, and deployment targets;
- interface stability between producer and consumer tasks;
- ownership and merge strategy;
- whether the tracker supports atomic claim or reservation semantics.

Use the tracker to expose state, not to pretend all agents are interchangeable. Match work to actual permissions, tools, domain knowledge, and risk ownership.
