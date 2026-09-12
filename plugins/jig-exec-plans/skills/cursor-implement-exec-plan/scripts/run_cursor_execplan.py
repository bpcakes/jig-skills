#!/usr/bin/env python3
"""Run Cursor Agent against a checked-in ExecPlan."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run cursor-agent with a stable ExecPlan implementation prompt."
    )
    parser.add_argument("plan", help="Path to the ExecPlan Markdown file.")
    parser.add_argument(
        "--milestone",
        help="Implement only this named milestone. Omit to complete the whole plan.",
    )
    parser.add_argument(
        "--model",
        default="composer-2.5",
        help="Cursor model id to use. Defaults to composer-2.5.",
    )
    parser.add_argument(
        "--workspace",
        default=".",
        help="Workspace directory for cursor-agent. Defaults to the current directory.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Pass --force to cursor-agent for unattended command approval.",
    )
    parser.add_argument(
        "--worktree",
        help="Run cursor-agent in an isolated Cursor worktree with this name.",
    )
    parser.add_argument(
        "--extra-instruction",
        action="append",
        default=[],
        help="Additional instruction to append to Cursor's prompt. May be repeated.",
    )
    parser.add_argument(
        "--skip-model-check",
        action="store_true",
        help="Skip cursor-agent --list-models validation.",
    )
    args = parser.parse_args()
    if args.milestone is not None and not args.milestone.strip():
        parser.error("--milestone must name a nonblank milestone")
    if args.worktree is not None and (
        not args.worktree.strip()
        or args.worktree in {".", ".."}
        or Path(args.worktree).name != args.worktree
        or "\\" in args.worktree
    ):
        parser.error("--worktree must be a nonblank name, not a path")
    return args


def resolve_paths(plan_arg: str, workspace_arg: str) -> tuple[Path, Path]:
    workspace = Path(workspace_arg).expanduser().resolve()
    plan = Path(plan_arg).expanduser()
    if not plan.is_absolute():
        plan = (workspace / plan).resolve()
    else:
        plan = plan.resolve()

    if not workspace.exists() or not workspace.is_dir():
        raise SystemExit(f"Workspace does not exist or is not a directory: {workspace}")
    if not plan.exists() or not plan.is_file():
        raise SystemExit(f"ExecPlan file does not exist: {plan}")

    try:
        plan.relative_to(workspace)
    except ValueError as exc:
        raise SystemExit(
            f"ExecPlan must be inside the Cursor workspace.\n"
            f"Workspace: {workspace}\n"
            f"Plan: {plan}"
        ) from exc

    return workspace, plan


def ensure_cursor_agent(model: str, skip_model_check: bool) -> None:
    if shutil.which("cursor-agent") is None:
        raise SystemExit("cursor-agent was not found on PATH.")

    if skip_model_check:
        return

    result = subprocess.run(
        ["cursor-agent", "--list-models"],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        stderr = result.stderr.strip()
        stdout = result.stdout.strip()
        detail = stderr or stdout or f"exit code {result.returncode}"
        raise SystemExit(f"Could not list Cursor models: {detail}")

    available = set()
    for line in result.stdout.splitlines():
        if " - " in line:
            available.add(line.split(" - ", 1)[0].strip())

    if model not in available:
        raise SystemExit(
            f"Cursor model is not available: {model}\n"
            "Run `cursor-agent --list-models` to choose an available model."
        )


def build_prompt(
    workspace: Path,
    plan: Path,
    extra_instructions: list[str],
    worktree: str | None,
    milestone: str | None = None,
) -> str:
    rel_plan = plan.relative_to(workspace)
    utc_now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%MZ")

    worktree_note = ""
    if worktree:
        worktree_note = (
            "\nCursor was launched with --worktree. Use the actual worktree root "
            "provided by Cursor as your working directory; treat the ExecPlan path "
            "above as repository-relative inside that worktree."
        )

    extra = ""
    if extra_instructions:
        rendered = "\n".join(f"- {item}" for item in extra_instructions)
        extra = f"\n\nAdditional user instructions:\n{rendered}"

    completion = (
        f"Complete only the milestone named {milestone!r}, including its acceptance criteria and required validation. "
        "Do not implement later milestones. If this name does not identify one milestone, report the ambiguity."
        if milestone else
        "Complete the whole ExecPlan, including every applicable milestone, acceptance criterion, and required validation. "
        "Plan size or completing one milestone is not a stopping condition."
    )

    return f"""You are Cursor Agent implementing a checked-in ExecPlan.

Workspace root: {workspace}
ExecPlan path: {rel_plan}
Current UTC time for plan updates: {utc_now}
{worktree_note}

Read the entire ExecPlan before editing code, then inspect the relevant repository files. Use the plan as the implementation specification within the user's requested scope and applicable host instructions.

Requested completion: {completion}
Continue through that scope without asking for renewed approval for routine already-authorized work. A successful command exit is not proof that the task is complete. Verify the requested acceptance criteria against the resulting code and test evidence before marking Progress complete. If interrupted or blocked, leave accurate completed and remaining items so the parent can continue from the same workspace.

Maintain the ExecPlan as a living document while you work:
- update Progress with completed and remaining items, using UTC timestamps;
- record surprising repository behavior or validation evidence in Surprises & Discoveries;
- record implementation decisions and rationale in Decision Log;
- update Outcomes & Retrospective when a milestone or the whole plan is complete.

Preserve unrelated user work:
- inspect git status before edits;
- do not run git reset, git checkout --, git clean, or destructive equivalents;
- do not revert files or hunks unrelated to the ExecPlan;
- if existing dirty files affect the plan, work with them and explain the interaction.

Implementation expectations:
- prefer the repository's existing patterns and toolchain;
- keep changes scoped to the ExecPlan;
- run the validation commands named by the ExecPlan when feasible;
- if validation cannot run, capture the exact blocker and command attempted;
- resolve routine ambiguity from repository evidence; stop for a material unresolved product/scope decision, missing authority, unsafe action, or unavailable capability, and report the exact blocker;
- preserve newer user constraints and do not expand permission for external actions.

Final response format:
- changed files;
- validation commands run and results;
- remaining ExecPlan work or blockers;
- any plan sections updated.{extra}
"""


def git_worktrees(workspace: Path) -> set[Path]:
    """Return Git's registered worktree roots without guessing from process output."""
    try:
        output = subprocess.check_output(
            ["git", "worktree", "list", "--porcelain"],
            cwd=workspace,
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        return set()
    return {
        Path(line.removeprefix("worktree ")).resolve()
        for line in output.splitlines()
        if line.startswith("worktree ")
    }


def discover_cursor_worktree(workspace: Path, name: str, before: set[Path]) -> Path | None:
    """Resolve and verify the named checkout Cursor registered with Git."""
    after = git_worktrees(workspace)
    documented = (Path.home() / ".cursor" / "worktrees" / workspace.name / name).resolve()
    if documented in after and documented.is_dir():
        return documented

    matching = {candidate for candidate in after if candidate != workspace and candidate.name == name and candidate.is_dir()}
    new_matching = matching - before
    if len(new_matching) == 1:
        return new_matching.pop()
    if len(matching) == 1:
        return matching.pop()
    return None


def main() -> int:
    args = parse_args()
    workspace, plan = resolve_paths(args.plan, args.workspace)
    ensure_cursor_agent(args.model, args.skip_model_check)

    worktrees_before = git_worktrees(workspace) if args.worktree else set()
    command = [
        "cursor-agent",
        "--print",
        "--trust",
        "--workspace",
        str(workspace),
        "--model",
        args.model,
    ]
    if args.force:
        command.append("--force")
    if args.worktree:
        command.extend(["--worktree", args.worktree])

    command.append(build_prompt(workspace, plan, args.extra_instruction, args.worktree, args.milestone))
    result = subprocess.run(command, cwd=workspace, check=False)
    if result.returncode == 0 and args.worktree:
        actual_worktree = discover_cursor_worktree(workspace, args.worktree, worktrees_before)
        if actual_worktree is None:
            print(
                f"Cursor completed, but the registered worktree named {args.worktree!r} could not be uniquely verified.",
                file=sys.stderr,
            )
            return 1
        print(json.dumps({"cursorWorktree": str(actual_worktree)}))
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
