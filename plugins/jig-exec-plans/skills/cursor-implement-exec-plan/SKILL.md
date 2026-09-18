---
name: cursor-implement-exec-plan
description: Delegate a checked-in ExecPlan to Cursor Agent with Composer 2.5 when the user explicitly requests Cursor implementation. Generic requests to implement a plan do not select a provider.
---

# Cursor Implement ExecPlan

Select for a named invocation or an explicit request to use Cursor, including an established Cursor choice earlier in the conversation. A plan file or a generic request for agent implementation does not authorize selecting Cursor. Follow the requested implementation task without adding delegation when no provider choice has been made.

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
- `--milestone <name>`: complete only the milestone requested by the user. Omit for a whole-plan request; plan size does not narrow the requested scope.
- `--force`: pass `--force` to `cursor-agent`, allowing commands unless Cursor explicitly denies them. Use only when the user asked for unattended, force, yolo, or similar execution.
- `--worktree <name>`: create a new isolated Cursor worktree. Use only when the ExecPlan file is committed or otherwise available from the selected worktree base. On success, the launcher verifies Git's registered checkout and emits a final JSON line containing `cursorWorktree`.
- `--workspace <path>`: set the repository workspace path if running from outside the repo root.
- `--extra-instruction <text>`: append user-specific implementation constraints to Cursor's prompt.
- `--skip-model-check`: skip `cursor-agent --list-models` validation.

## Workflow

1. Inspect the repository state before delegating:
   - `git status --short --untracked-files=all`
   - confirm the ExecPlan path exists and is inside the intended workspace.
2. Pass the requested completion scope and constraints through the bundled script. Whole-plan implementation is the default; use `--milestone` only for a milestone-limited request.
3. Wait for the command to finish, retaining its live session handle. A wait timeout is not a terminal failure: poll that same session, and do not launch a duplicate while it is running. Keep the user informed during long work.
4. Inspect the result:
   - `git status --short --untracked-files=all`
   - read the ExecPlan's progress and acceptance criteria even if Cursor did not change the plan; inspect the resulting code and reported validation evidence.
   - reuse valid validation results; run missing meaningful checks when feasible. Do not infer completion from an exit code or checked box alone.
5. If requested implementation remains and no material blocker exists, continue the same authorized Cursor workflow from the actual workspace, passing the remaining work and verified progress. After an initial `--worktree` run, read the launcher's final `cursorWorktree` JSON value, verify that directory still exists, and invoke the launcher there with that path as `--workspace`; omit `--worktree`, because that option creates a new checkout. The launcher fails a nominally successful worktree run when it cannot uniquely verify the registered checkout; do not guess the path. If only validation or progress records remain, perform those checks and reconcile the records directly; do not launch another implementation run for bookkeeping. If a continuation makes no progress, inspect the cause before retrying rather than repeating the same launch unchanged. Do not switch implementation providers silently.
6. Finish only when the requested scope and validation are complete, the user stops or changes the task, or a concrete blocker requires user input or an unavailable capability. Report completion separately from command status, with exact remaining items when blocked. Do not leave a live Cursor session unowned when handing back a terminal result.

## Guardrails

- Do not pass `--force` unless the user explicitly asked for unattended execution or accepted that Cursor may run commands without interactive approval.
- Do not delegate from a vague chat plan. If the plan is only in chat, first create or ask for a checked-in ExecPlan using `write-exec-plan`.
- Correct stale or missing progress records directly from verified code and validation evidence as part of the authorized implementation. Do not rewrite the user's objectives or mark acceptance complete without evidence.
- Preserve user work. If the current workspace has unrelated dirty files, include that context in the Cursor prompt through `--extra-instruction` or stop and ask if the dirty state makes delegation risky. If using `--worktree`, first confirm the ExecPlan exists in the selected worktree base; untracked or unstaged plan edits in the original checkout will not automatically exist there.
- If `cursor-agent` is missing, not authenticated, or the requested model is unavailable, surface the failure. Do not silently fall back to a different implementation agent.

## Output Expectations

When reporting back, keep it concise:

- Cursor Agent command status: completed, failed, or blocked.
- Files changed.
- Validation commands and pass/fail status.
- Remaining unchecked ExecPlan items or blocker evidence.
- For a `--worktree` launch, the verified `cursorWorktree` path emitted by the launcher.
