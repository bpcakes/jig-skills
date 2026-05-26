#!/usr/bin/env python3
"""Run Cursor Agent against a checked-in ExecPlan."""

from __future__ import annotations

import argparse
import datetime as dt
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
    return parser.parse_args()


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


def build_prompt(workspace: Path, plan: Path, extra_instructions: list[str]) -> str:
    rel_plan = plan.relative_to(workspace)
    utc_now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%MZ")

    extra = ""
    if extra_instructions:
        rendered = "\n".join(f"- {item}" for item in extra_instructions)
        extra = f"\n\nAdditional user instructions:\n{rendered}"

    return f"""You are Cursor Agent implementing a checked-in ExecPlan.

Workspace root: {workspace}
ExecPlan path: {rel_plan}
Current UTC time for plan updates: {utc_now}

Read the entire ExecPlan before editing code. Treat it as the source of truth for the work. Then inspect the relevant repository files and implement the next incomplete milestone or the full plan if the plan is small enough to complete safely in one run.

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
- stop and report clearly if the plan is ambiguous, unsafe, or impossible from repository evidence.

Final response format:
- changed files;
- validation commands run and results;
- remaining ExecPlan work or blockers;
- any plan sections updated.{extra}
"""


def main() -> int:
    args = parse_args()
    workspace, plan = resolve_paths(args.plan, args.workspace)
    ensure_cursor_agent(args.model, args.skip_model_check)

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

    command.append(build_prompt(workspace, plan, args.extra_instruction))
    result = subprocess.run(command, cwd=workspace, check=False)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
