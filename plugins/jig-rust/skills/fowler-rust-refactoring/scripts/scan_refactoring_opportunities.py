#!/usr/bin/env python3
"""Heuristic, read-only scanner for Rust refactoring opportunities.

The scanner intentionally reports candidates rather than verdicts. It uses only the
Python standard library so it can run before a Rust toolchain is available. Semantic
validation still belongs to the reviewer, rustc, Clippy, and the project test suite.
"""

from __future__ import annotations

import argparse
import bisect
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable, Iterator, Sequence

DEFAULT_SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".vscode",
    "target",
    "node_modules",
    "vendor",
}

IDENT = r"(?:r#)?[A-Za-z_][A-Za-z0-9_]*"
FUNCTION_RE = re.compile(
    rf"(?m)^[ \t]*(?P<vis>pub(?:\s*\([^)]*\))?\s+)?"
    rf"(?:(?:default|const|async|unsafe)\s+)*"
    rf"(?:extern\s+(?:\"[^\"]*\"\s+)?)?fn\s+(?P<name>{IDENT})\b"
)
STRUCT_RE = re.compile(
    rf"(?m)^[ \t]*(?P<vis>pub(?:\s*\([^)]*\))?\s+)?struct\s+(?P<name>{IDENT})\b"
)
TRAIT_RE = re.compile(
    rf"(?m)^[ \t]*(?P<vis>pub(?:\s*\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+(?P<name>{IDENT})\b"
)


@dataclass(frozen=True)
class Thresholds:
    long_function_lines: int = 60
    many_parameters: int = 5
    large_struct_fields: int = 12
    option_heavy_fields: int = 5
    large_file_lines: int = 600
    deep_nesting: int = 5
    large_match_arms: int = 10
    duplicate_window: int = 7
    repeated_unwraps: int = 3
    clone_burst: int = 4


@dataclass
class Finding:
    id: str
    smell: str
    category: str
    path: str
    line_start: int
    line_end: int
    confidence: str
    message: str
    evidence: dict[str, object] = field(default_factory=dict)
    fowler_moves: list[str] = field(default_factory=list)
    rust_guardrail: str = ""

    def sort_key(self) -> tuple[str, int, int, str]:
        return (self.path, self.line_start, self.line_end, self.id)


@dataclass
class SourceFile:
    path: Path
    display_path: str
    text: str
    code: str
    line_offsets: list[int]

    def line_of(self, index: int) -> int:
        return bisect.bisect_right(self.line_offsets, index)

    @property
    def line_count(self) -> int:
        return self.text.count("\n") + 1


@dataclass
class FunctionInfo:
    name: str
    visibility: str
    start: int
    body_open: int
    body_close: int
    params_open: int
    params_close: int
    line_start: int
    line_end: int
    parameters: list[str]


@dataclass
class StructField:
    name: str
    type_text: str
    is_public: bool


@dataclass
class StructInfo:
    name: str
    visibility: str
    start: int
    body_open: int
    body_close: int
    line_start: int
    line_end: int
    fields: list[StructField]


@dataclass(frozen=True)
class NormalizedLine:
    text: str
    original_line: int


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Scan Rust source for heuristic Fowler-style refactoring opportunities. "
            "The command never edits files."
        )
    )
    parser.add_argument("path", nargs="?", default=".", help="Rust file or project directory")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument(
        "--git-diff",
        metavar="REF",
        help="scan tracked Rust files changed relative to REF (for example origin/main)",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="GLOB",
        help="exclude a path glob; may be repeated",
    )
    parser.add_argument(
        "--exclude-tests",
        action="store_true",
        help="exclude tests/, benches/, examples/, and *_test.rs files",
    )
    parser.add_argument("--max-findings", type=int, default=200)
    parser.add_argument("--long-function-lines", type=int, default=60)
    parser.add_argument("--many-parameters", type=int, default=5)
    parser.add_argument("--large-struct-fields", type=int, default=12)
    parser.add_argument("--option-heavy-fields", type=int, default=5)
    parser.add_argument("--large-file-lines", type=int, default=600)
    parser.add_argument("--deep-nesting", type=int, default=5)
    parser.add_argument("--large-match-arms", type=int, default=10)
    parser.add_argument("--duplicate-window", type=int, default=7)
    parser.add_argument("--repeated-unwraps", type=int, default=3)
    parser.add_argument("--clone-burst", type=int, default=4)
    return parser.parse_args(argv)


def run_git(root: Path, args: Sequence[str]) -> list[str] | None:
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), *args],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None
    return [line for line in completed.stdout.splitlines() if line]


def find_git_root(path: Path) -> Path | None:
    probe = path if path.is_dir() else path.parent
    result = run_git(probe, ["rev-parse", "--show-toplevel"])
    return Path(result[0]).resolve() if result else None


def is_test_path(relative: str) -> bool:
    parts = Path(relative).parts
    return (
        any(part in {"tests", "benches", "examples"} for part in parts)
        or relative.endswith("_test.rs")
        or relative.endswith("/test.rs")
        or relative == "test.rs"
    )


def path_excluded(relative: str, patterns: Sequence[str], exclude_tests: bool) -> bool:
    normalized = relative.replace(os.sep, "/")
    if exclude_tests and is_test_path(normalized):
        return True
    return any(
        fnmatch.fnmatch(normalized, pattern)
        or fnmatch.fnmatch(Path(normalized).name, pattern)
        for pattern in patterns
    )


def collect_rust_files(
    target: Path,
    git_diff: str | None,
    exclude: Sequence[str],
    exclude_tests: bool,
) -> tuple[Path, list[Path]]:
    target = target.resolve()
    if target.is_file():
        if target.suffix != ".rs":
            raise ValueError(f"not a Rust source file: {target}")
        return target.parent, [target]
    if not target.exists():
        raise ValueError(f"path does not exist: {target}")

    git_root = find_git_root(target)
    root = git_root or target
    candidates: list[Path] = []

    if git_diff:
        if not git_root:
            raise ValueError("--git-diff requires a Git working tree")
        names = run_git(
            git_root,
            ["diff", "--name-only", "--diff-filter=ACMR", git_diff, "--", "*.rs"],
        )
        if names is None:
            raise ValueError(f"unable to read Git diff for reference {git_diff!r}")
        candidates = [(git_root / name).resolve() for name in names]
    elif git_root:
        names = run_git(git_root, ["ls-files", "-co", "--exclude-standard", "--", "*.rs"])
        if names is not None:
            candidates = [(git_root / name).resolve() for name in names]
    if not candidates:
        candidates = [
            path
            for path in target.rglob("*.rs")
            if not any(part in DEFAULT_SKIP_DIRS for part in path.parts)
        ]

    selected: list[Path] = []
    for path in candidates:
        if not path.is_file() or path.suffix != ".rs":
            continue
        try:
            path.relative_to(target)
        except ValueError:
            if target != root:
                continue
        relative = str(path.relative_to(root))
        if path_excluded(relative, exclude, exclude_tests):
            continue
        selected.append(path)

    return root, sorted(set(selected))


def line_offsets(text: str) -> list[int]:
    offsets = [-1]
    offsets.extend(index for index, char in enumerate(text) if char == "\n")
    return offsets


def _raw_string_prefix(text: str, index: int) -> tuple[int, int] | None:
    """Return (content_start, hash_count) for a Rust raw string at index."""
    i = index
    if text.startswith("br", i) or text.startswith("cr", i):
        i += 2
    elif text.startswith("r", i):
        i += 1
    else:
        return None
    hashes = 0
    while i < len(text) and text[i] == "#":
        hashes += 1
        i += 1
    if i < len(text) and text[i] == '"':
        return i + 1, hashes
    return None


def _char_literal_end(text: str, index: int) -> int | None:
    i = index + 1
    escaped = False
    limit = min(len(text), index + 16)
    while i < limit and text[i] != "\n":
        char = text[i]
        if escaped:
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == "'":
            return i + 1
        elif char.isspace() and i > index + 2:
            return None
        i += 1
    return None


def mask_non_code(text: str) -> str:
    """Mask comments and literals with spaces while preserving newlines and indices."""
    out = list(text)
    n = len(text)
    i = 0

    def mask(start: int, end: int) -> None:
        for j in range(start, min(end, n)):
            if out[j] != "\n":
                out[j] = " "

    while i < n:
        if text.startswith("//", i):
            end = text.find("\n", i + 2)
            end = n if end == -1 else end
            mask(i, end)
            i = end
            continue
        if text.startswith("/*", i):
            depth = 1
            j = i + 2
            while j < n and depth:
                if text.startswith("/*", j):
                    depth += 1
                    j += 2
                elif text.startswith("*/", j):
                    depth -= 1
                    j += 2
                else:
                    j += 1
            mask(i, j)
            i = j
            continue

        raw = _raw_string_prefix(text, i)
        if raw is not None:
            content_start, hashes = raw
            terminator = '"' + ("#" * hashes)
            end = text.find(terminator, content_start)
            end = n if end == -1 else end + len(terminator)
            mask(i, end)
            i = end
            continue

        prefix_len = 0
        if text.startswith(('b"', 'c"'), i):
            prefix_len = 1
        if text[i] == '"' or prefix_len:
            quote = i + prefix_len
            j = quote + 1
            escaped = False
            while j < n:
                char = text[j]
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    j += 1
                    break
                j += 1
            mask(i, j)
            i = j
            continue

        char_start = i + 1 if text.startswith("b'", i) else i
        if char_start < n and text[char_start] == "'":
            end = _char_literal_end(text, char_start)
            if end is not None:
                mask(i, end)
                i = end
                continue

        i += 1
    return "".join(out)


def find_matching(text: str, open_index: int, opener: str, closer: str) -> int | None:
    depth = 0
    for index in range(open_index, len(text)):
        char = text[index]
        if char == opener:
            depth += 1
        elif char == closer:
            depth -= 1
            if depth == 0:
                return index
    return None


def find_signature_body(code: str, start: int) -> tuple[int, int, int] | None:
    params_open = code.find("(", start)
    if params_open == -1:
        return None
    params_close = find_matching(code, params_open, "(", ")")
    if params_close is None:
        return None

    paren = bracket = angle = 0
    i = params_close + 1
    while i < len(code):
        char = code[i]
        if char == ";" and paren == bracket == angle == 0:
            return None
        if char == "(" :
            paren += 1
        elif char == ")" and paren:
            paren -= 1
        elif char == "[":
            bracket += 1
        elif char == "]" and bracket:
            bracket -= 1
        elif char == "<":
            angle += 1
        elif char == ">" and angle:
            angle -= 1
        elif char == "{" and paren == bracket == angle == 0:
            return params_open, params_close, i
        i += 1
    return None


def split_top_level(text: str, delimiter: str = ",") -> list[str]:
    parts: list[str] = []
    start = 0
    paren = bracket = brace = angle = 0
    for index, char in enumerate(text):
        if char == "(":
            paren += 1
        elif char == ")" and paren:
            paren -= 1
        elif char == "[":
            bracket += 1
        elif char == "]" and bracket:
            bracket -= 1
        elif char == "{":
            brace += 1
        elif char == "}" and brace:
            brace -= 1
        elif char == "<":
            angle += 1
        elif char == ">" and angle:
            angle -= 1
        elif char == delimiter and paren == bracket == brace == angle == 0:
            parts.append(text[start:index].strip())
            start = index + 1
    tail = text[start:].strip()
    if tail:
        parts.append(tail)
    return [part for part in parts if part]


def parse_functions(source: SourceFile) -> list[FunctionInfo]:
    functions: list[FunctionInfo] = []
    for match in FUNCTION_RE.finditer(source.code):
        signature = find_signature_body(source.code, match.end())
        if signature is None:
            continue
        params_open, params_close, body_open = signature
        body_close = find_matching(source.code, body_open, "{", "}")
        if body_close is None:
            continue
        params = split_top_level(source.code[params_open + 1 : params_close])
        functions.append(
            FunctionInfo(
                name=match.group("name"),
                visibility=(match.group("vis") or "").strip(),
                start=match.start(),
                body_open=body_open,
                body_close=body_close,
                params_open=params_open,
                params_close=params_close,
                line_start=source.line_of(match.start()),
                line_end=source.line_of(body_close),
                parameters=params,
            )
        )
    return functions


def parse_struct_fields(body: str) -> list[StructField]:
    fields: list[StructField] = []
    for segment in split_top_level(body):
        cleaned = re.sub(r"(?m)^\s*#\s*\[[^\]]*\]\s*", "", segment).strip()
        match = re.match(
            rf"(?s)^(?P<vis>pub(?:\s*\([^)]*\))?\s+)?(?P<name>{IDENT})\s*:\s*(?P<ty>.+)$",
            cleaned,
        )
        if not match:
            continue
        fields.append(
            StructField(
                name=match.group("name"),
                type_text=re.sub(r"\s+", " ", match.group("ty").strip()),
                is_public=bool(match.group("vis")),
            )
        )
    return fields


def parse_structs(source: SourceFile) -> list[StructInfo]:
    structs: list[StructInfo] = []
    for match in STRUCT_RE.finditer(source.code):
        brace = source.code.find("{", match.end())
        semicolon = source.code.find(";", match.end())
        if brace == -1 or (semicolon != -1 and semicolon < brace):
            continue
        body_close = find_matching(source.code, brace, "{", "}")
        if body_close is None:
            continue
        structs.append(
            StructInfo(
                name=match.group("name"),
                visibility=(match.group("vis") or "").strip(),
                start=match.start(),
                body_open=brace,
                body_close=body_close,
                line_start=source.line_of(match.start()),
                line_end=source.line_of(body_close),
                fields=parse_struct_fields(source.code[brace + 1 : body_close]),
            )
        )
    return structs


def code_line_count(code: str) -> int:
    count = 0
    for line in code.splitlines():
        stripped = line.strip()
        if stripped and stripped not in {"{", "}", "};", "},"}:
            count += 1
    return count


def max_brace_depth(code: str) -> int:
    depth = maximum = 0
    for char in code:
        if char == "{":
            depth += 1
            maximum = max(maximum, depth)
        elif char == "}" and depth:
            depth -= 1
    return maximum


def parameter_type(parameter: str) -> str:
    if ":" not in parameter:
        return ""
    return parameter.split(":", 1)[1].strip()


def is_self_parameter(parameter: str) -> bool:
    head = parameter.split(":", 1)[0]
    return bool(re.search(r"\bself\b", head))


def count_match_arms(code: str, match_index: int) -> tuple[int, int, int] | None:
    brace = code.find("{", match_index)
    if brace == -1:
        return None
    close = find_matching(code, brace, "{", "}")
    if close is None:
        return None
    depth = 0
    arms = 0
    i = brace + 1
    while i < close - 1:
        char = code[i]
        if char == "{":
            depth += 1
        elif char == "}" and depth:
            depth -= 1
        elif char == "=" and i + 1 < close and code[i + 1] == ">" and depth == 0:
            arms += 1
            i += 1
        i += 1
    return arms, brace, close


def make_id(prefix: str, source: SourceFile, line: int, detail: str = "") -> str:
    raw = f"{prefix}|{source.display_path}|{line}|{detail}".encode()
    return f"{prefix}-{hashlib.sha1(raw).hexdigest()[:8]}"


def analyze_functions(
    source: SourceFile,
    functions: Sequence[FunctionInfo],
    thresholds: Thresholds,
) -> list[Finding]:
    findings: list[Finding] = []
    for function in functions:
        body = source.code[function.body_open + 1 : function.body_close]
        body_original = source.text[function.body_open + 1 : function.body_close]
        logical_lines = code_line_count(body)
        non_self_params = [p for p in function.parameters if not is_self_parameter(p)]
        bool_params = [p for p in non_self_params if re.search(r":\s*bool\b", p)]
        mut_params = [p for p in non_self_params if "&mut" in p]
        unwraps = len(re.findall(r"\.(?:unwrap|expect)\s*\(", body))
        clones = len(re.findall(r"\.clone\s*\(", body))
        nesting = max_brace_depth(body)

        if logical_lines > thresholds.long_function_lines:
            findings.append(
                Finding(
                    id=make_id("long-fn", source, function.line_start, function.name),
                    smell="Long Function",
                    category="function-design",
                    path=source.display_path,
                    line_start=function.line_start,
                    line_end=function.line_end,
                    confidence="medium",
                    message=f"`{function.name}` contains about {logical_lines} nonblank code lines.",
                    evidence={"logical_code_lines": logical_lines},
                    fowler_moves=["Extract Function", "Split Phase", "Replace Temp with Query"],
                    rust_guardrail=(
                        "Extract around a coherent responsibility or ownership boundary; do not add clones "
                        "or interior mutability merely to satisfy the borrow checker."
                    ),
                )
            )

        if len(non_self_params) > thresholds.many_parameters:
            findings.append(
                Finding(
                    id=make_id("many-params", source, function.line_start, function.name),
                    smell="Long Parameter List / Data Clumps",
                    category="api-design",
                    path=source.display_path,
                    line_start=function.line_start,
                    line_end=function.line_start,
                    confidence="medium",
                    message=f"`{function.name}` has {len(non_self_params)} non-receiver parameters.",
                    evidence={"parameter_count": len(non_self_params), "parameters": non_self_params},
                    fowler_moves=["Introduce Parameter Object", "Preserve Whole Object", "Change Function Declaration"],
                    rust_guardrail=(
                        "Prefer a domain struct or validated newtype only when the values travel and change together; "
                        "do not create a generic context bag."
                    ),
                )
            )

        if bool_params:
            findings.append(
                Finding(
                    id=make_id("bool-param", source, function.line_start, function.name),
                    smell="Flag Argument / Primitive Obsession",
                    category="type-design",
                    path=source.display_path,
                    line_start=function.line_start,
                    line_end=function.line_start,
                    confidence="medium",
                    message=f"`{function.name}` accepts boolean mode parameters whose call-site meaning may be opaque.",
                    evidence={"boolean_parameters": bool_params},
                    fowler_moves=["Remove Flag Argument", "Replace Primitive with Object", "Change Function Declaration"],
                    rust_guardrail=(
                        "Use a small enum or explicit methods when the boolean selects behavior. Keep `bool` when it is "
                        "genuinely a fact and the name remains visible and unambiguous."
                    ),
                )
            )

        ptr_args = [
            p
            for p in non_self_params
            if re.search(r":\s*&(?:\s*'\w+\s+)?(?:mut\s+)?(?:Vec\s*<|String\b)", p)
        ]
        if ptr_args:
            findings.append(
                Finding(
                    id=make_id("borrowed-container", source, function.line_start, function.name),
                    smell="Over-specific API",
                    category="api-design",
                    path=source.display_path,
                    line_start=function.line_start,
                    line_end=function.line_start,
                    confidence="high",
                    message=f"`{function.name}` borrows `Vec` or `String` directly instead of their slice forms.",
                    evidence={"parameters": ptr_args},
                    fowler_moves=["Change Function Declaration", "Encapsulate Collection"],
                    rust_guardrail=(
                        "Consider `&[T]`, `&mut [T]`, or `&str` when only slice/string behavior is required. "
                        "Changing a public signature can be semver-breaking."
                    ),
                )
            )

        unit_error = bool(
            re.search(r"->\s*Result\s*<(?:(?!\{).)*,\s*\(\s*\)\s*>", source.code[function.params_close:function.body_open], re.S)
        )
        if unit_error:
            findings.append(
                Finding(
                    id=make_id("unit-error", source, function.line_start, function.name),
                    smell="Error Code / Primitive Obsession",
                    category="error-design",
                    path=source.display_path,
                    line_start=function.line_start,
                    line_end=function.line_start,
                    confidence="high",
                    message=f"`{function.name}` returns `Result<_, ()>`, losing failure meaning and context.",
                    evidence={"return_type": "Result<_, ()>"},
                    fowler_moves=["Replace Error Code with Exception", "Replace Primitive with Object"],
                    rust_guardrail=(
                        "In Rust, adapt this as a meaningful `Result<T, E>` error type; do not introduce exceptions or "
                        "panic-based control flow."
                    ),
                )
            )

        if unwraps >= thresholds.repeated_unwraps:
            findings.append(
                Finding(
                    id=make_id("unwrap-cluster", source, function.line_start, function.name),
                    smell="Scattered Error Handling (Rust signal)",
                    category="error-design",
                    path=source.display_path,
                    line_start=function.line_start,
                    line_end=function.line_end,
                    confidence="low",
                    message=f"`{function.name}` contains {unwraps} `unwrap`/`expect` calls.",
                    evidence={"unwrap_or_expect_calls": unwraps},
                    fowler_moves=["Extract Function", "Split Phase", "Introduce Assertion"],
                    rust_guardrail=(
                        "Panics can be correct for proven internal invariants and tests. At recoverable boundaries, "
                        "prefer typed errors and `?`; document intentional panic contracts."
                    ),
                )
            )

        if clones >= thresholds.clone_burst:
            findings.append(
                Finding(
                    id=make_id("clone-burst", source, function.line_start, function.name),
                    smell="Mutable Data / Data Flow Friction (Rust signal)",
                    category="ownership-design",
                    path=source.display_path,
                    line_start=function.line_start,
                    line_end=function.line_end,
                    confidence="low",
                    message=f"`{function.name}` contains {clones} explicit clones.",
                    evidence={"clone_calls": clones},
                    fowler_moves=["Split Phase", "Move Function", "Change Function Declaration"],
                    rust_guardrail=(
                        "Cloning may be intentional and cheap. Verify ownership flow and data size before changing it; "
                        "do not replace clear ownership with complex lifetimes solely to eliminate clones."
                    ),
                )
            )

        if len(mut_params) >= 2:
            findings.append(
                Finding(
                    id=make_id("mut-params", source, function.line_start, function.name),
                    smell="Mutable Data",
                    category="data-flow",
                    path=source.display_path,
                    line_start=function.line_start,
                    line_end=function.line_start,
                    confidence="low",
                    message=f"`{function.name}` coordinates {len(mut_params)} mutable input parameters.",
                    evidence={"mutable_parameters": mut_params},
                    fowler_moves=["Return Modified Value", "Split Phase", "Introduce Parameter Object"],
                    rust_guardrail=(
                        "Consider returning a value or concentrating mutation in one owner. Multiple `&mut` parameters "
                        "are not inherently wrong, especially in low-level or performance-sensitive code."
                    ),
                )
            )

        if nesting > thresholds.deep_nesting:
            findings.append(
                Finding(
                    id=make_id("deep-nesting", source, function.line_start, function.name),
                    smell="Nested Conditional / Long Function",
                    category="control-flow",
                    path=source.display_path,
                    line_start=function.line_start,
                    line_end=function.line_end,
                    confidence="low",
                    message=f"`{function.name}` reaches an approximate block nesting depth of {nesting}.",
                    evidence={"approximate_block_depth": nesting},
                    fowler_moves=["Replace Nested Conditional with Guard Clauses", "Extract Function", "Decompose Conditional"],
                    rust_guardrail=(
                        "The metric also counts closures, struct literals, and macro blocks. Confirm that cognitive "
                        "nesting—not syntax alone—is the real problem."
                    ),
                )
            )

        for match_token in re.finditer(r"\bmatch\b", body):
            absolute = function.body_open + 1 + match_token.start()
            result = count_match_arms(source.code, absolute)
            if result is None:
                continue
            arms, _brace, close = result
            if arms <= thresholds.large_match_arms:
                continue
            line = source.line_of(absolute)
            findings.append(
                Finding(
                    id=make_id("large-match", source, line, function.name),
                    smell="Repeated Switches / Complex Conditional candidate",
                    category="control-flow",
                    path=source.display_path,
                    line_start=line,
                    line_end=source.line_of(close),
                    confidence="low",
                    message=f"A `match` in `{function.name}` has about {arms} arms.",
                    evidence={"match_arms": arms},
                    fowler_moves=["Extract Function", "Replace Conditional with Polymorphism", "Move Function"],
                    rust_guardrail=(
                        "An exhaustive `match` over a closed enum is a core Rust idiom. First try moving behavior into "
                        "the enum's `impl`; use traits only when the variant set is genuinely open."
                    ),
                )
            )

        # Retain the variable to make accidental use of masked versus original source explicit.
        _ = body_original

    return findings


def stringly_field(field: StructField) -> bool:
    name = field.name.removeprefix("r#")
    string_names = {
        "status",
        "kind",
        "type",
        "mode",
        "state",
        "role",
        "currency",
        "unit",
        "format",
        "strategy",
        "policy",
    }
    if name in string_names and re.fullmatch(r"(?:String|&\s*(?:'\w+\s+)?str)", field.type_text):
        return True
    if name.endswith("_id") and re.fullmatch(r"(?:u|i)(?:8|16|32|64|128|size)", field.type_text):
        return True
    return False


def analyze_structs(
    source: SourceFile,
    structs: Sequence[StructInfo],
    thresholds: Thresholds,
) -> list[Finding]:
    findings: list[Finding] = []
    for struct in structs:
        field_count = len(struct.fields)
        if field_count > thresholds.large_struct_fields:
            findings.append(
                Finding(
                    id=make_id("large-struct", source, struct.line_start, struct.name),
                    smell="Large Class / Data Clumps candidate",
                    category="type-design",
                    path=source.display_path,
                    line_start=struct.line_start,
                    line_end=struct.line_end,
                    confidence="low",
                    message=f"`{struct.name}` has {field_count} named fields.",
                    evidence={"field_count": field_count},
                    fowler_moves=["Extract Class", "Move Function", "Introduce Parameter Object"],
                    rust_guardrail=(
                        "Large data-transfer and serialization structs may be appropriate. Split only along invariants, "
                        "lifetimes, ownership, or independent reasons to change."
                    ),
                )
            )

        option_fields = [field.name for field in struct.fields if re.search(r"\bOption\s*<", field.type_text)]
        if (
            len(option_fields) >= thresholds.option_heavy_fields
            and field_count
            and len(option_fields) / field_count >= 0.4
        ):
            findings.append(
                Finding(
                    id=make_id("option-heavy", source, struct.line_start, struct.name),
                    smell="Temporary Field / Invalid State candidate",
                    category="type-design",
                    path=source.display_path,
                    line_start=struct.line_start,
                    line_end=struct.line_end,
                    confidence="low",
                    message=f"`{struct.name}` has {len(option_fields)} optional fields out of {field_count}.",
                    evidence={"option_fields": option_fields, "field_count": field_count},
                    fowler_moves=["Replace Type Code with Subclasses", "Extract Class", "Introduce Special Case"],
                    rust_guardrail=(
                        "In Rust, consider enum variants, staged validated types, or separate request/state structs when "
                        "field presence is correlated. Sparse DTOs and patch objects are legitimate counterexamples."
                    ),
                )
            )

        suspicious = [field.name for field in struct.fields if stringly_field(field)]
        if suspicious:
            findings.append(
                Finding(
                    id=make_id("primitive-fields", source, struct.line_start, struct.name),
                    smell="Primitive Obsession candidate",
                    category="type-design",
                    path=source.display_path,
                    line_start=struct.line_start,
                    line_end=struct.line_end,
                    confidence="low",
                    message=f"`{struct.name}` uses primitive fields for names that may encode domain concepts.",
                    evidence={"candidate_fields": suspicious},
                    fowler_moves=["Replace Primitive with Object", "Replace Type Code with Subclasses"],
                    rust_guardrail=(
                        "Consider a newtype or enum only when it centralizes validation, units, formatting, or allowed "
                        "states. Avoid wrapper types that add no semantic distinction."
                    ),
                )
            )

        public_fields = [field.name for field in struct.fields if field.is_public]
        if struct.visibility.startswith("pub") and public_fields:
            findings.append(
                Finding(
                    id=make_id("public-fields", source, struct.line_start, struct.name),
                    smell="Unencapsulated Record candidate",
                    category="api-design",
                    path=source.display_path,
                    line_start=struct.line_start,
                    line_end=struct.line_end,
                    confidence="low",
                    message=f"Public struct `{struct.name}` exposes {len(public_fields)} public fields.",
                    evidence={"public_fields": public_fields},
                    fowler_moves=["Encapsulate Record", "Encapsulate Variable", "Remove Setting Method"],
                    rust_guardrail=(
                        "Public fields are normal for transparent DTOs. Encapsulate only when invariants, evolution, or "
                        "construction rules justify the API cost; changing them is semver-breaking."
                    ),
                )
            )
    return findings


def analyze_file_level(source: SourceFile, thresholds: Thresholds) -> list[Finding]:
    findings: list[Finding] = []
    if source.line_count > thresholds.large_file_lines:
        findings.append(
            Finding(
                id=make_id("large-file", source, 1, str(source.line_count)),
                smell="Large Class / Divergent Change candidate",
                category="module-design",
                path=source.display_path,
                line_start=1,
                line_end=source.line_count,
                confidence="low",
                message=f"The module contains {source.line_count} physical lines.",
                evidence={"physical_lines": source.line_count},
                fowler_moves=["Extract Class", "Move Function", "Split Phase"],
                rust_guardrail=(
                    "File length alone is not design evidence. Prefer module boundaries that reduce reasons to change, "
                    "visibility, and dependency direction—not arbitrary line targets."
                ),
            )
        )

    for match in re.finditer(r"\bstatic\s+mut\b", source.code):
        line = source.line_of(match.start())
        findings.append(
            Finding(
                id=make_id("static-mut", source, line),
                smell="Global Data / Mutable Data",
                category="state-management",
                path=source.display_path,
                line_start=line,
                line_end=line,
                confidence="high",
                message="Mutable global state requires manually maintained safety and coupling invariants.",
                evidence={"construct": "static mut"},
                fowler_moves=["Encapsulate Variable", "Change Reference to Value", "Move Function"],
                rust_guardrail=(
                    "Prefer passing state explicitly or a safe synchronization/initialization primitive. Preserve any "
                    "FFI, signal-handler, no_std, or performance constraints and document remaining unsafe invariants."
                ),
            )
        )

    shared_patterns = {
        r"\bRc\s*<\s*RefCell\s*<": "Rc<RefCell<_>>",
        r"\bArc\s*<\s*Mutex\s*<": "Arc<Mutex<_>>",
        r"\bArc\s*<\s*RwLock\s*<": "Arc<RwLock<_>>",
    }
    for pattern, label in shared_patterns.items():
        for match in re.finditer(pattern, source.code):
            line = source.line_of(match.start())
            findings.append(
                Finding(
                    id=make_id("shared-mutable", source, line, label),
                    smell="Mutable Data / Global Data candidate",
                    category="state-management",
                    path=source.display_path,
                    line_start=line,
                    line_end=line,
                    confidence="low",
                    message=f"Shared mutable ownership uses `{label}`.",
                    evidence={"construct": label},
                    fowler_moves=["Encapsulate Variable", "Move Function", "Change Reference to Value"],
                    rust_guardrail=(
                        "This construct may be exactly right. Review lock/borrow scope, ownership, contention, and "
                        "invariants; do not replace it merely to satisfy a style preference."
                    ),
                )
            )
    return findings


def normalized_lines(source: SourceFile) -> list[NormalizedLine]:
    lines: list[NormalizedLine] = []
    for number, raw in enumerate(source.code.splitlines(), start=1):
        text = re.sub(r"\s+", " ", raw.strip())
        if not text or text in {"{", "}", "};", "},", ");"}:
            continue
        if text.startswith(("use ", "mod ", "#[", "#![")):
            continue
        if len(text) < 12:
            continue
        lines.append(NormalizedLine(text=text, original_line=number))
    return lines


def duplicate_findings(
    sources: Sequence[SourceFile], thresholds: Thresholds, max_groups: int = 30
) -> list[Finding]:
    window = thresholds.duplicate_window
    if window < 3:
        return []
    sequences: dict[tuple[str, ...], list[tuple[SourceFile, int, int]]] = defaultdict(list)
    for source in sources:
        lines = normalized_lines(source)
        for index in range(0, len(lines) - window + 1):
            chunk = lines[index : index + window]
            if sum(len(line.text) for line in chunk) < 140:
                continue
            key = tuple(line.text for line in chunk)
            sequences[key].append((source, chunk[0].original_line, chunk[-1].original_line))

    candidates = [
        (key, occurrences)
        for key, occurrences in sequences.items()
        if len({(occ[0].display_path, occ[1]) for occ in occurrences}) >= 2
    ]
    candidates.sort(key=lambda item: (len(item[1]), sum(map(len, item[0]))), reverse=True)

    occupied: dict[str, list[tuple[int, int]]] = defaultdict(list)
    findings: list[Finding] = []

    def overlaps(path: str, start: int, end: int) -> bool:
        return any(start <= existing_end and end >= existing_start for existing_start, existing_end in occupied[path])

    for key, occurrences in candidates:
        unique: list[tuple[SourceFile, int, int]] = []
        seen = set()
        for occurrence in occurrences:
            marker = (occurrence[0].display_path, occurrence[1], occurrence[2])
            if marker not in seen:
                seen.add(marker)
                unique.append(occurrence)
        if len(unique) < 2:
            continue
        chosen = [occ for occ in unique if not overlaps(occ[0].display_path, occ[1], occ[2])]
        if len(chosen) < 2:
            continue
        chosen = chosen[:5]
        first = chosen[0]
        locations = [
            {"path": occ[0].display_path, "line_start": occ[1], "line_end": occ[2]}
            for occ in chosen
        ]
        findings.append(
            Finding(
                id=make_id("duplicate", first[0], first[1], key[0]),
                smell="Duplicated Code",
                category="duplication",
                path=first[0].display_path,
                line_start=first[1],
                line_end=first[2],
                confidence="high",
                message=f"An exact normalized {window}-line code window appears in {len(unique)} locations.",
                evidence={"locations": locations, "window_lines": window, "sample": list(key[:3])},
                fowler_moves=["Extract Function", "Move Function", "Parameterize Function", "Combine Functions into Transform"],
                rust_guardrail=(
                    "Confirm the duplicated fragments represent the same concept and change together. Similar-looking "
                    "code with different domain rules should remain separate."
                ),
            )
        )
        for source, start, end in chosen:
            occupied[source.display_path].append((start, end))
        if len(findings) >= max_groups:
            break
    return findings


def trait_summary(sources: Sequence[SourceFile]) -> list[Finding]:
    definitions: list[tuple[SourceFile, re.Match[str]]] = []
    all_code = "\n".join(source.code for source in sources)
    for source in sources:
        definitions.extend((source, match) for match in TRAIT_RE.finditer(source.code))

    findings: list[Finding] = []
    for source, match in definitions:
        if match.group("vis"):
            continue
        name = match.group("name")
        plain_name = name.removeprefix("r#")
        impl_re = re.compile(rf"\bimpl(?:\s*<[^{{}};]*>)?\s+{re.escape(plain_name)}(?:\s*<[^{{}};]*>)?\s+for\b")
        impl_count = len(impl_re.findall(all_code))
        if impl_count != 1:
            continue
        line = source.line_of(match.start())
        findings.append(
            Finding(
                id=make_id("single-impl-trait", source, line, name),
                smell="Speculative Generality / Lazy Element candidate",
                category="abstraction-design",
                path=source.display_path,
                line_start=line,
                line_end=line,
                confidence="low",
                message=f"Private trait `{name}` has one detected implementation.",
                evidence={"detected_implementations": impl_count},
                fowler_moves=["Inline Class", "Collapse Hierarchy", "Remove Middle Man"],
                rust_guardrail=(
                    "One implementation is not proof of a useless trait: it may define a test seam, capability boundary, "
                    "plugin point, or unsafe contract. Keep it only when that boundary earns its complexity."
                ),
            )
        )
    return findings


def load_sources(root: Path, files: Sequence[Path]) -> tuple[list[SourceFile], list[str]]:
    sources: list[SourceFile] = []
    errors: list[str] = []
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            errors.append(f"{path}: {exc}")
            continue
        try:
            display = str(path.relative_to(root))
        except ValueError:
            display = str(path)
        sources.append(
            SourceFile(
                path=path,
                display_path=display.replace(os.sep, "/"),
                text=text,
                code=mask_non_code(text),
                line_offsets=line_offsets(text),
            )
        )
    return sources, errors


def analyze(sources: Sequence[SourceFile], thresholds: Thresholds) -> list[Finding]:
    findings: list[Finding] = []
    for source in sources:
        functions = parse_functions(source)
        structs = parse_structs(source)
        findings.extend(analyze_file_level(source, thresholds))
        findings.extend(analyze_functions(source, functions, thresholds))
        findings.extend(analyze_structs(source, structs, thresholds))
    findings.extend(duplicate_findings(sources, thresholds))
    findings.extend(trait_summary(sources))
    findings.sort(key=Finding.sort_key)
    return findings


def render_text(
    root: Path,
    sources: Sequence[SourceFile],
    findings: Sequence[Finding],
    errors: Sequence[str],
) -> str:
    counts = Counter(finding.smell for finding in findings)
    lines = [
        "Rust refactoring opportunity scan",
        f"root: {root}",
        f"files scanned: {len(sources)}",
        f"candidates: {len(findings)}",
        "note: heuristic candidates are not refactoring verdicts; validate against behavior, change pressure, and Rust semantics.",
    ]
    if errors:
        lines.append(f"read errors: {len(errors)}")
    if counts:
        lines.append("candidate counts: " + ", ".join(f"{name}={count}" for name, count in counts.most_common()))
    lines.append("")

    for finding in findings:
        location = f"{finding.path}:{finding.line_start}"
        if finding.line_end != finding.line_start:
            location += f"-{finding.line_end}"
        lines.extend(
            [
                f"[{finding.confidence.upper()}] {finding.smell} — {location}",
                f"  {finding.message}",
                f"  Fowler moves: {', '.join(finding.fowler_moves)}",
                f"  Rust guardrail: {finding.rust_guardrail}",
                f"  id: {finding.id}",
                "",
            ]
        )
    if not findings:
        lines.append("No candidates crossed the configured thresholds.")
    if errors:
        lines.append("Read errors:")
        lines.extend(f"  - {error}" for error in errors)
    return "\n".join(lines).rstrip() + "\n"


def render_json(
    root: Path,
    sources: Sequence[SourceFile],
    findings: Sequence[Finding],
    errors: Sequence[str],
    truncated: bool,
) -> str:
    payload = {
        "schema_version": 1,
        "root": str(root),
        "files_scanned": len(sources),
        "candidate_count": len(findings),
        "truncated": truncated,
        "read_errors": list(errors),
        "disclaimer": (
            "Heuristic candidates are not refactoring verdicts. Validate against behavior, change pressure, "
            "project constraints, and Rust semantics."
        ),
        "findings": [asdict(finding) for finding in findings],
    }
    return json.dumps(payload, indent=2, sort_keys=False) + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    thresholds = Thresholds(
        long_function_lines=args.long_function_lines,
        many_parameters=args.many_parameters,
        large_struct_fields=args.large_struct_fields,
        option_heavy_fields=args.option_heavy_fields,
        large_file_lines=args.large_file_lines,
        deep_nesting=args.deep_nesting,
        large_match_arms=args.large_match_arms,
        duplicate_window=args.duplicate_window,
        repeated_unwraps=args.repeated_unwraps,
        clone_burst=args.clone_burst,
    )
    try:
        root, files = collect_rust_files(
            Path(args.path), args.git_diff, args.exclude, args.exclude_tests
        )
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    sources, errors = load_sources(root, files)
    findings = analyze(sources, thresholds)
    truncated = len(findings) > args.max_findings
    findings = findings[: args.max_findings]

    if args.format == "json":
        sys.stdout.write(render_json(root, sources, findings, errors, truncated))
    else:
        sys.stdout.write(render_text(root, sources, findings, errors))
        if truncated:
            sys.stdout.write(f"Output truncated at --max-findings={args.max_findings}.\n")
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
