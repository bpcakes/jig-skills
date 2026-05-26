---
name: cursor-implement-exec-plan
description: Run Cursor Agent with the Composer 2.5 model to implement a checked-in ExecPlan. Use when the user asks Cursor, cursor-agent, Composer, or another implementation agent to execute an ExecPlan, continue an implementation plan, or delegate code changes from a plan file.
---

# Cursor Implement ExecPlan

Use this skill when the user wants Cursor Agent to implement code from an ExecPlan.

This is an implementation skill, not a review skill. It may edit files, run commands, and update the ExecPlan's living sections while Cursor works.

## Scope

Require a concrete ExecPlan file path. If the user does not name one, look for likely plan files such as `.agent/*.md`, `plans/*.md`, or files matching `*plan*.md`. If exactly one plausible ExecPlan exists, use it. If there are multiple plausible files or none, ask one concise question for the plan path.

Use the current repository root as the workspace unless the user explicitly asks to run Cursor in an isolated worktree.

## Default Command

Resolve the bundled launcher relative to this `SKILL.md` file, then run it from the target repository root. Do not assume the target repository has a `plugins/jig-exec-plans` directory.

```sh
python3 /absolute/path/to/cursor-implement-exec-plan/scripts/run_cursor_execplan.py path/to/plan.md
```

The launcher defaults to:

- `cursor-agent --print`
- `--model composer-2.5`
- `--trust`
- current working directory as the Cursor workspace

Supported launcher options:

- `--model <model>`: override `composer-2.5`.
- `--force`: pass `--force` to `cursor-agent`, allowing commands unless Cursor explicitly denies them. Use only when the user asked for unattended, force, yolo, or similar execution.
- `--worktree <name>`: pass `--worktree <name>` so Cursor works in an isolated Cursor worktree. Use only when the ExecPlan file is committed or otherwise available from the selected worktree base.
- `--workspace <path>`: set the repository workspace path if running from outside the repo root.
- `--extra-instruction <text>`: append user-specific implementation constraints to Cursor's prompt.
- `--skip-model-check`: skip `cursor-agent --list-models` validation.

## Workflow

1. Inspect the repository state before delegating:
   - `git status --short --untracked-files=all`
   - confirm the ExecPlan path exists and is inside the intended workspace.
2. Launch Cursor Agent through the bundled script.
3. Wait for the command to finish. Do not leave a `cursor-agent` session running when ending the turn.
4. Inspect the result:
   - `git status --short --untracked-files=all`
   - read the ExecPlan `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` sections if Cursor changed the plan.
   - run or review the validation commands Cursor reports when feasible.
5. Summarize what Cursor changed, what validation ran, and any remaining work or blockers.

## Guardrails

- Do not pass `--force` unless the user explicitly asked for unattended execution or accepted that Cursor may run commands without interactive approval.
- Do not delegate from a vague chat plan. If the plan is only in chat, first create or ask for a checked-in ExecPlan using `write-exec-plan`.
- Do not rewrite the ExecPlan yourself after Cursor finishes unless the user asks you to fix the plan. Report stale or missing plan updates as a finding.
- Preserve user work. If the current workspace has unrelated dirty files, include that context in the Cursor prompt through `--extra-instruction` or stop and ask if the dirty state makes delegation risky. If using `--worktree`, first confirm the ExecPlan exists in the selected worktree base; untracked or unstaged plan edits in the original checkout will not automatically exist there.
- If `cursor-agent` is missing, not authenticated, or the requested model is unavailable, surface the failure. Do not silently fall back to a different implementation agent.

## Output Expectations

When reporting back, keep it concise:

- Cursor Agent command status: completed, failed, or blocked.
- Files changed.
- Validation commands and pass/fail status.
- Remaining unchecked ExecPlan items or blocker evidence.
