#!/usr/bin/env python3
"""Validate the structure and dependency graph of a planning-workflow plan.

This is intentionally a structural validator. It cannot determine whether an
architecture is correct or whether cited evidence is trustworthy.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable


HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
TASK_HEADING_RE = re.compile(
    r"^###\s+(?P<id>(?:T|TASK)[-_ ]?\d+)\s*(?:[—–:-]\s*|\s+)(?P<title>.+?)\s*$",
    re.IGNORECASE,
)
FIELD_RE = re.compile(
    r"^\s*[-*]\s*(?P<emphasis>\*{1,2}|_{1,2})?"
    r"(?P<name>[A-Za-z][A-Za-z /-]*?)"
    r"(?:(?P=emphasis)\s*:|\s*:(?(emphasis)(?P=emphasis)))\s*(?P<value>.*)$"
)
TASK_REF_RE = re.compile(r"\b(?:T|TASK)[-_ ]?\d+\b", re.IGNORECASE)
TASK_ID = r"(?:T|TASK)[-_ ]?\d+"
DEPENDENCY_ITEM = rf"(?:{TASK_ID}|`{TASK_ID}`)"
DEPENDENCY_LIST_RE = re.compile(
    rf"{DEPENDENCY_ITEM}(?:\s*,\s*{DEPENDENCY_ITEM})*", re.IGNORECASE
)
PLACEHOLDER_RE = re.compile(
    r"(?i:\b(?:TBD|TODO|FIXME|TK)\b)|\?\?+|(?<![\w>:])<[A-Za-z][A-Za-z0-9 _-]*>"
)
INLINE_CODE_RE = re.compile(r"(?<!`)(`+)(?!`)(.*?)(?<!`)\1(?!`)", re.DOTALL)
AUTOLINK_RE = re.compile(
    r"<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*|[^<>\s@]+@[^<>\s@]+)>"
)
FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
LINK_START_RE = re.compile(
    r"(?P<inline>\]\()[ \t\n]*"
    r"|^ {0,3}\[(?:\\.|[^\]\\])+\]:[ \t]*(?:\n[ \t]*)?", re.MULTILINE
)
LINK_TITLE = r'''(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))'''
LINK_END_RE = re.compile(rf"(?:\s+{LINK_TITLE})?\s*\)")
REFERENCE_END_RE = re.compile(rf"(?:[ \t]+{LINK_TITLE})?[ \t]*(?:\n|$)")


SECTION_ALIASES: dict[str, tuple[str, ...]] = {
    "outcome": ("outcome", "objective", "goal", "goals", "success"),
    "scope": ("scope", "non-goals", "constraints", "boundaries"),
    "evidence": (
        "current-state evidence",
        "current state",
        "evidence",
        "facts",
        "discovery",
        "context",
    ),
    "design": ("decisions and design", "design", "architecture", "approach"),
    "tasks": ("execution graph", "work breakdown", "tasks", "implementation plan"),
    "verification": (
        "verification",
        "validation",
        "acceptance",
        "completion criteria",
        "testing",
    ),
    "rollout": ("rollout and recovery", "rollout", "migration", "deployment", "recovery"),
    "risks": ("risks and open decisions", "risks", "risk register", "open decisions"),
}

REQUIRED_SECTIONS: dict[str, tuple[str, ...]] = {
    "light": ("outcome", "scope", "tasks", "verification"),
    "standard": ("outcome", "scope", "evidence", "design", "tasks", "verification", "risks"),
    "critical": (
        "outcome",
        "scope",
        "evidence",
        "design",
        "tasks",
        "verification",
        "rollout",
        "risks",
    ),
}

FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "outcome": ("outcome", "result"),
    "changes": ("changes", "surfaces", "touches"),
    "depends": ("depends on", "dependencies", "blocked by"),
    "verify": ("verify", "verification", "validate", "tests"),
    "recovery": ("recovery", "rollback", "containment"),
    "done": ("done when", "completion", "acceptance criteria", "complete when"),
}

REQUIRED_FIELDS: dict[str, tuple[str, ...]] = {
    "light": ("outcome", "changes", "depends", "verify", "done"),
    "standard": ("outcome", "changes", "depends", "verify", "done"),
    "critical": ("outcome", "changes", "depends", "verify", "recovery", "done"),
}


@dataclass
class Finding:
    severity: str
    code: str
    message: str
    line: int | None = None

    def as_dict(self) -> dict[str, object]:
        result: dict[str, object] = {
            "severity": self.severity,
            "code": self.code,
            "message": self.message,
        }
        if self.line is not None:
            result["line"] = self.line
        return result


@dataclass
class Task:
    task_id: str
    title: str
    line: int
    fields: dict[str, str] = field(default_factory=dict)
    field_lines: dict[str, int] = field(default_factory=dict)
    dependencies: list[str] = field(default_factory=list)


@dataclass
class Report:
    path: str
    profile: str
    findings: list[Finding] = field(default_factory=list)
    sections_found: list[str] = field(default_factory=list)
    task_count: int = 0
    dependencies: dict[str, list[str]] = field(default_factory=dict)

    @property
    def errors(self) -> list[Finding]:
        return [item for item in self.findings if item.severity == "error"]

    @property
    def warnings(self) -> list[Finding]:
        return [item for item in self.findings if item.severity == "warning"]

    def as_dict(self) -> dict[str, object]:
        return {
            "path": self.path,
            "profile": self.profile,
            "valid": not self.errors,
            "summary": {
                "errors": len(self.errors),
                "warnings": len(self.warnings),
                "tasks": self.task_count,
                "sections_found": self.sections_found,
            },
            "dependencies": self.dependencies,
            "findings": [item.as_dict() for item in self.findings],
        }


def normalize_text(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[`*_]", "", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def normalize_task_id(value: str) -> str:
    digits = re.search(r"\d+", value)
    if not digits:
        return value.upper().replace("_", "-").replace(" ", "-")
    number = int(digits.group())
    return f"T-{number:02d}"


def canonical_field(name: str) -> str | None:
    normalized = normalize_text(name)
    for canonical, aliases in FIELD_ALIASES.items():
        if normalized in {normalize_text(alias) for alias in aliases}:
            return canonical
    return None


def without_code_blocks(lines: list[str]) -> list[str]:
    """Keep line numbers while excluding literal examples from plan content."""
    fence = ""
    indented = False
    previous_blank = True
    result = []
    for line in lines:
        match = FENCE_RE.match(line)
        code_indent = line.startswith(("    ", "\t"))
        if fence:
            if (match and match[1][0] == fence[0]
                    and len(match[1]) >= len(fence) and not match[2].strip()):
                fence = ""
            result.append("")
        elif (indented and not line.strip()) or (code_indent and (indented or previous_blank)):
            indented = True
            result.append("")
        elif match:
            indented = False
            fence = match[1]
            result.append("")
        else:
            indented = False
            result.append(line)
        previous_blank = not line.strip()
    return result


def has_link_label(prefix: str) -> bool:
    """Check the closing bracket against visible, unescaped opening brackets."""
    prefix = INLINE_CODE_RE.sub(lambda match: " " * len(match[0]), prefix)
    depth = 0
    for match in re.finditer(r"\\.|[\[\]]", prefix):
        if match[0] == "[":
            depth += 1
        elif match[0] == "]":
            if match.end() == len(prefix):
                return depth > 0
            depth = max(0, depth - 1)
    return False


def mask_link_destinations(prose: str) -> str:
    """Leave link labels and titles visible; mask only literal destinations."""
    masked = list(prose)
    for match in LINK_START_RE.finditer(prose):
        if match["inline"] and not has_link_label(prose[:match.start() + 1]):
            continue
        start = end = match.end()
        if start == len(prose):
            continue
        if prose[start] == "<":
            end = start + 1
            while end < len(prose) and prose[end] not in "<>\n":
                end += 2 if prose[end] == "\\" else 1
            if end >= len(prose) or prose[end] != ">":
                continue
            end += 1
        else:
            depth = 0
            while end < len(prose) and not prose[end].isspace():
                char = prose[end]
                if char == "\\" and end + 1 < len(prose):
                    end += 2
                    continue
                if char == "(":
                    depth += 1
                elif char == ")":
                    if depth == 0:
                        break
                    depth -= 1
                elif char == "<":
                    break
                end += 1
            if depth:
                continue
        if match["inline"] and not LINK_END_RE.match(prose, end):
            continue
        if not match["inline"] and not REFERENCE_END_RE.match(prose, end):
            continue
        masked[start:end] = ["\n" if char == "\n" else " " for char in prose[start:end]]
    return "".join(masked)


def placeholder_prose(lines: list[str]) -> list[str]:
    """Mask literal spans once, retaining newlines for field and document checks."""
    def mask(match: re.Match[str]) -> str:
        return re.sub(r"[^\n]", " ", match[0])

    # Inline spans can cross lines, but cannot cross paragraph boundaries.
    paragraphs = re.split(r"(\n[ \t]*\n)", "\n".join(lines))
    prose = "".join(INLINE_CODE_RE.sub(mask, AUTOLINK_RE.sub(mask, mask_link_destinations(part)))
                    for part in paragraphs)
    return prose.split("\n")


def find_sections(lines: list[str]) -> dict[str, int]:
    found: dict[str, int] = {}
    for line_no, line in enumerate(lines, start=1):
        match = HEADING_RE.match(line)
        if not match:
            continue
        title = normalize_text(match.group(2))
        # Accept common numbered headings such as "## 3. Current-state evidence".
        title = re.sub(r"^(?:\d+|[ivxlcdm]+)\s+", "", title)
        for canonical, aliases in SECTION_ALIASES.items():
            if canonical in found:
                continue
            normalized_aliases = [normalize_text(alias) for alias in aliases]
            if any(title == alias or title.startswith(f"{alias} ") for alias in normalized_aliases):
                found[canonical] = line_no
    return found


def parse_tasks(lines: list[str], findings: list[Finding]) -> dict[str, Task]:
    starts: list[tuple[int, re.Match[str]]] = []
    for index, line in enumerate(lines):
        match = TASK_HEADING_RE.match(line)
        if match:
            starts.append((index, match))

    tasks: dict[str, Task] = {}
    for position, (start, match) in enumerate(starts):
        end = starts[position + 1][0] if position + 1 < len(starts) else len(lines)
        task_id = normalize_task_id(match.group("id"))
        if task_id in tasks:
            findings.append(
                Finding("error", "duplicate-task", f"Duplicate task ID {task_id}.", start + 1)
            )
            continue

        task = Task(task_id=task_id, title=match.group("title").strip(), line=start + 1)
        for body_index in range(start + 1, end):
            body_line = lines[body_index]
            if HEADING_RE.match(body_line):
                break
            field_match = FIELD_RE.match(body_line)
            if not field_match:
                continue
            field_name = canonical_field(field_match.group("name"))
            if field_name and field_name not in task.fields:
                task.fields[field_name] = field_match.group("value").strip()
                task.field_lines[field_name] = body_index

        dependency_value = task.fields.get("depends", "")
        absence_value = dependency_value
        if absence_value.startswith("`") and absence_value.endswith("`"):
            absence_value = absence_value[1:-1]
        if dependency_value and absence_value.lower() not in {
            "none",
            "n/a",
            "n a",
            "not applicable",
            "no dependencies",
        }:
            if not DEPENDENCY_LIST_RE.fullmatch(dependency_value):
                findings.append(
                    Finding(
                        "error", "invalid-dependency",
                        f"{task_id} has invalid dependency syntax: {dependency_value!r}; "
                        "use 'none' or a comma-separated list of task IDs.",
                        task.line,
                    )
                )
            task.dependencies = [
                normalize_task_id(reference) for reference in TASK_REF_RE.findall(dependency_value)
            ]
            task.dependencies = list(dict.fromkeys(task.dependencies))
        tasks[task_id] = task

    return tasks


def check_cycles(graph: dict[str, list[str]]) -> list[list[str]]:
    state: dict[str, int] = {node: 0 for node in graph}
    stack: list[str] = []
    cycles: list[list[str]] = []
    seen_cycles: set[tuple[str, ...]] = set()

    def canonical_cycle(cycle: list[str]) -> tuple[str, ...]:
        core = cycle[:-1]
        rotations = [tuple(core[index:] + core[:index]) for index in range(len(core))]
        return min(rotations)

    def visit(node: str) -> None:
        state[node] = 1
        stack.append(node)
        for dependency in graph.get(node, []):
            if dependency not in graph:
                continue
            if state[dependency] == 0:
                visit(dependency)
            elif state[dependency] == 1:
                start = stack.index(dependency)
                cycle = stack[start:] + [dependency]
                signature = canonical_cycle(cycle)
                if signature not in seen_cycles:
                    seen_cycles.add(signature)
                    cycles.append(cycle)
        stack.pop()
        state[node] = 2

    for node in graph:
        if state[node] == 0:
            visit(node)
    return cycles


def validate(path: Path, profile: str) -> Report:
    report = Report(path=str(path), profile=profile)
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        report.findings.append(Finding("error", "read-failed", str(exc)))
        return report

    lines = without_code_blocks(text.splitlines())
    prose_lines = placeholder_prose(lines)
    sections = find_sections(lines)
    report.sections_found = sorted(sections)

    for section in REQUIRED_SECTIONS[profile]:
        if section not in sections:
            aliases = ", ".join(SECTION_ALIASES[section][:3])
            report.findings.append(
                Finding(
                    "error",
                    "missing-section",
                    f"Missing {section!r} section (recognized headings include: {aliases}).",
                )
            )

    tasks = parse_tasks(lines, report.findings)
    report.task_count = len(tasks)
    if not tasks:
        report.findings.append(
            Finding(
                "error",
                "no-tasks",
                "No canonical task headings found; use headings such as '### T-01 — Outcome'.",
            )
        )
        return report

    for task in tasks.values():
        for field_name in REQUIRED_FIELDS[profile]:
            value = task.fields.get(field_name, "").strip()
            if not value:
                report.findings.append(
                    Finding(
                        "error",
                        "missing-task-field",
                        f"{task.task_id} is missing the {field_name!r} field.",
                        task.line,
                    )
                )
            elif PLACEHOLDER_RE.search(prose_lines[task.field_lines[field_name]]):
                report.findings.append(
                    Finding(
                        "warning",
                        "task-placeholder",
                        f"{task.task_id} has a placeholder in {field_name!r}: {value!r}.",
                        task.line,
                    )
                )

        if task.task_id in task.dependencies:
            report.findings.append(
                Finding(
                    "error",
                    "self-dependency",
                    f"{task.task_id} depends on itself.",
                    task.line,
                )
            )

        for dependency in task.dependencies:
            if dependency not in tasks:
                report.findings.append(
                    Finding(
                        "error",
                        "unknown-dependency",
                        f"{task.task_id} depends on unknown task {dependency}.",
                        task.line,
                    )
                )

    graph = {task_id: task.dependencies for task_id, task in tasks.items()}
    report.dependencies = graph
    for cycle in check_cycles(graph):
        report.findings.append(
            Finding(
                "error",
                "dependency-cycle",
                f"Dependency cycle: {' -> '.join(cycle)}.",
            )
        )

    if len(tasks) > 1:
        consumers: dict[str, int] = {task_id: 0 for task_id in tasks}
        for dependencies in graph.values():
            for dependency in dependencies:
                if dependency in consumers:
                    consumers[dependency] += 1
        isolated = [
            task_id
            for task_id, dependencies in graph.items()
            if not dependencies and consumers[task_id] == 0
        ]
        for task_id in isolated:
            report.findings.append(
                Finding(
                    "warning",
                    "isolated-task",
                    f"{task_id} has no dependency relationship. Confirm that it is intentionally independent.",
                    tasks[task_id].line,
                )
            )

    for line_no, line in enumerate(prose_lines, start=1):
        if PLACEHOLDER_RE.search(line):
            report.findings.append(
                Finding(
                    "warning",
                    "document-placeholder",
                    f"Possible unresolved placeholder: {lines[line_no - 1].strip()[:120]}",
                    line_no,
                )
            )

    # Remove exact duplicate findings, which can happen when a task field placeholder
    # is also caught by the document-wide placeholder scan.
    unique: list[Finding] = []
    seen: set[tuple[str, str, str, int | None]] = set()
    for finding in report.findings:
        signature = (finding.severity, finding.code, finding.message, finding.line)
        if signature not in seen:
            seen.add(signature)
            unique.append(finding)
    report.findings = unique
    return report


def render_text(report: Report) -> str:
    status = "VALID" if not report.errors else "INVALID"
    output = [
        f"{status}: {report.path}",
        f"Profile: {report.profile}",
        f"Tasks: {report.task_count}",
        f"Errors: {len(report.errors)}; warnings: {len(report.warnings)}",
    ]
    for finding in report.findings:
        location = f" line {finding.line}" if finding.line is not None else ""
        output.append(
            f"- {finding.severity.upper()} {finding.code}{location}: {finding.message}"
        )
    return "\n".join(output)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate planning-workflow plan structure and dependencies."
    )
    parser.add_argument("plan", type=Path, help="Markdown plan to validate")
    parser.add_argument(
        "--profile",
        choices=sorted(REQUIRED_SECTIONS),
        default="standard",
        help="Required section and task depth (default: standard)",
    )
    parser.add_argument("--json", action="store_true", help="Emit a JSON report")
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Return a non-zero exit code when warnings are present",
    )
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    report = validate(args.plan, args.profile)
    if args.json:
        print(json.dumps(report.as_dict(), indent=2, sort_keys=True))
    else:
        print(render_text(report))
    if report.errors:
        return 1
    if args.strict and report.warnings:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
