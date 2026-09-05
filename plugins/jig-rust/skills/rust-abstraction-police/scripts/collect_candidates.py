#!/usr/bin/env python3
"""Collect Rust leaky-abstraction *candidates* without executing repository code.

This helper is intentionally heuristic. It inventories syntactic signals for the
rust-abstraction-police skill; it does not determine effective reachability,
architectural intent, caller consequence, or whether a signal is a real leak.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Iterator, Sequence

try:
    import tomllib
except ModuleNotFoundError as exc:  # pragma: no cover - Python < 3.11
    raise SystemExit("Python 3.11+ is required (tomllib is unavailable).") from exc


DEFAULT_EXCLUDED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".cargo",
    ".idea",
    ".vscode",
    "target",
    "vendor",
    "node_modules",
    "dist",
    "build",
    "coverage",
}

PUBLIC_ITEM_RE = re.compile(
    r"^\s*pub(?:\s*\((?P<vis>[^)]*)\))?\s+"
    r"(?P<prefix>(?:(?:async|const|unsafe|extern(?:\s*\"[^\"]*\")?)\s+)*)"
    r"(?P<kind>fn|struct|enum|union|trait|type|mod|use|const|static)\b"
)
MACRO_RULES_RE = re.compile(r"^\s*macro_rules!\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)")
PUBLIC_FIELD_RE = re.compile(
    r"^\s*pub(?:\s*\([^)]*\))?\s+(?:r#)?[A-Za-z_][A-Za-z0-9_]*\s*:"
)
DEREF_IMPL_RE = re.compile(
    r"^\s*impl(?:\s*<[^>{;]*>)?\s+(?:(?:std|core)::ops::)?"
    r"(?P<trait>DerefMut|Deref)\s+for\s+(?P<type>[^\s{]+)"
)

REPRESENTATION_PATTERNS = re.compile(
    r"\b(?:Vec|VecDeque|LinkedList|HashMap|HashSet|BTreeMap|BTreeSet|BinaryHeap|"
    r"IndexMap|IndexSet|SmallVec|ArrayVec|Slab)\s*<"
)
OWNERSHIP_RUNTIME_PATTERNS = re.compile(
    r"\b(?:Arc|Rc|Weak|Box|Pin|Cow|Cell|RefCell|UnsafeCell|Mutex|RwLock|OnceLock|"
    r"LazyLock|Semaphore|JoinHandle|Receiver|Sender|Permit|MutexGuard|RwLockReadGuard|"
    r"RwLockWriteGuard|Transaction)\b"
)
RAW_RESOURCE_PATTERNS = re.compile(
    r"(?:\*\s*(?:mut|const)\b|\bNonNull\s*<|\bRawFd\b|\bOwnedFd\b|\bBorrowedFd\b|"
    r"\bRawHandle\b|\bOwnedHandle\b|\bBorrowedHandle\b|\bRawSocket\b|\bc_void\b|"
    r"extern\s*\"C\")"
)
CONCRETE_ITERATOR_PATTERNS = re.compile(
    r"(?:::|\b)(?:Iter|IterMut|IntoIter|Drain|DrainFilter|Splice)\s*<|"
    r"\b(?:hash_map|hash_set|btree_map|btree_set|vec|slice)::(?:Iter|IterMut|IntoIter|Drain)\b"
)
ESCAPE_METHOD_RE = re.compile(
    r"^(?:inner|as_inner|into_inner|into_parts|as_raw(?:_[A-Za-z0-9_]+)?|"
    r"into_raw(?:_[A-Za-z0-9_]+)?|from_raw(?:_[A-Za-z0-9_]+)?|"
    r"raw(?:_[A-Za-z0-9_]+)+|get_unchecked(?:_mut)?|get_mut_unchecked)$"
)
CALLSITE_ESCAPE_RE = re.compile(
    r"\.(?P<method>as_inner|into_inner|as_raw(?:_[A-Za-z0-9_]+)?|"
    r"into_raw(?:_[A-Za-z0-9_]+)?|downcast_ref|downcast_mut)"
    r"\s*(?:::\s*<[^()\n]+>)?\s*\("
)


RULES: dict[str, tuple[str, str]] = {
    "APC001": ("public field or tuple field", "high"),
    "APC002": ("representation-bearing public type alias", "medium"),
    "APC003": ("dependency type in boundary-facing API", "high"),
    "APC004": ("ownership, synchronization, runtime, or transaction mechanism", "medium"),
    "APC005": ("inner/raw escape hatch", "high"),
    "APC006": ("Serde schema tied to a public type", "medium"),
    "APC007": ("layout commitment on a public type", "medium"),
    "APC008": ("feature- or target-shaped public API", "medium"),
    "APC009": ("public unsafe obligation", "high"),
    "APC010": ("generic parameter contagion signal", "low"),
    "APC011": ("doc-hidden but public surface", "medium"),
    "APC012": ("exported macro boundary", "medium"),
    "APC013": ("raw pointer or OS/FFI resource", "high"),
    "APC014": ("foreign error in public surface", "high"),
    "APC015": ("concrete iterator type in public surface", "medium"),
    "APC016": ("consumer reaches through or downcasts", "medium"),
    "APC017": ("Deref exposes an inner method surface", "medium"),
}


@dataclass(frozen=True)
class Candidate:
    rule: str
    title: str
    review_priority: str
    path: str
    line: int
    message: str
    excerpt: str


@dataclass(frozen=True)
class PublicItem:
    start: int
    header_end: int
    block_end: int | None
    kind: str
    name: str
    visibility: str
    header: str
    attributes: str


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Collect source-level candidates for a Rust leaky-abstraction review. "
            "The output requires semantic validation."
        )
    )
    parser.add_argument("root", type=Path, help="Rust repository, workspace, crate, or source directory")
    parser.add_argument(
        "--format",
        choices=("markdown", "json"),
        default="markdown",
        dest="output_format",
    )
    parser.add_argument(
        "--max-candidates",
        type=int,
        default=500,
        help="maximum candidates to emit after deterministic sorting (default: 500)",
    )
    parser.add_argument(
        "--allow-crate",
        action="append",
        default=[],
        metavar="CRATE",
        help="dependency crate path to ignore in public signatures; repeatable",
    )
    parser.add_argument(
        "--exclude-dir",
        action="append",
        default=[],
        metavar="NAME",
        help="additional directory name to skip; repeatable",
    )
    parser.add_argument(
        "--no-consumer-signals",
        action="store_true",
        help="omit call-site inner/raw/downcast signals",
    )
    return parser.parse_args(argv)


def normalize_crate_name(name: str) -> str:
    return name.replace("-", "_")


def iter_files(root: Path, suffix: str, excluded_dirs: set[str]) -> Iterator[Path]:
    if root.is_file():
        if root.suffix == suffix:
            yield root
        return

    for path in root.rglob(f"*{suffix}"):
        if any(part in excluded_dirs for part in path.parts):
            continue
        if path.is_file():
            yield path


def iter_manifests(root: Path, excluded_dirs: set[str]) -> Iterator[Path]:
    if root.is_file():
        start = root.parent
    else:
        start = root
    for path in start.rglob("Cargo.toml"):
        if any(part in excluded_dirs for part in path.parts):
            continue
        yield path


def collect_dependency_names(root: Path, excluded_dirs: set[str]) -> set[str]:
    names: set[str] = set()

    def visit(node: object, key_path: tuple[str, ...] = ()) -> None:
        if not isinstance(node, dict):
            return
        for key, value in node.items():
            next_path = key_path + (str(key),)
            if key == "dependencies" and isinstance(value, dict):
                # Ignore dev/build dependency tables. Target-specific normal dependencies remain included.
                if not any(part in {"dev-dependencies", "build-dependencies"} for part in key_path):
                    names.update(normalize_crate_name(str(dep)) for dep in value)
            visit(value, next_path)

    for manifest in iter_manifests(root, excluded_dirs):
        try:
            with manifest.open("rb") as handle:
                data = tomllib.load(handle)
        except (OSError, tomllib.TOMLDecodeError):
            continue
        visit(data)

    return names


def mask_comments(text: str) -> str:
    """Mask Rust line and nested block comments while preserving offsets/newlines."""
    chars = list(text)
    out = chars.copy()
    index = 0
    block_depth = 0
    in_string = False
    in_char = False
    escaped = False

    while index < len(chars):
        ch = chars[index]
        nxt = chars[index + 1] if index + 1 < len(chars) else ""

        if block_depth:
            if ch == "/" and nxt == "*":
                out[index] = out[index + 1] = " "
                block_depth += 1
                index += 2
                continue
            if ch == "*" and nxt == "/":
                out[index] = out[index + 1] = " "
                block_depth -= 1
                index += 2
                continue
            if ch != "\n":
                out[index] = " "
            index += 1
            continue

        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            index += 1
            continue

        if in_char:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == "'":
                in_char = False
            index += 1
            continue

        if ch == "/" and nxt == "/":
            out[index] = out[index + 1] = " "
            index += 2
            while index < len(chars) and chars[index] != "\n":
                out[index] = " "
                index += 1
            continue

        if ch == "/" and nxt == "*":
            out[index] = out[index + 1] = " "
            block_depth = 1
            index += 2
            continue

        if ch == '"':
            in_string = True
        elif ch == "'":
            # This intentionally treats lifetimes as possible chars only when a closing quote follows soon.
            lookahead = text[index + 1 : index + 5]
            if "'" in lookahead:
                in_char = True
        index += 1

    return "".join(out)


def collapse(lines: Sequence[str]) -> str:
    return " ".join(part.strip() for part in lines if part.strip())


def item_name(kind: str, header: str) -> str:
    if kind == "use":
        return "use"
    pattern = re.compile(rf"\b{re.escape(kind)}\s+(?:r#)?([A-Za-z_][A-Za-z0-9_]*)")
    match = pattern.search(header)
    return match.group(1) if match else kind


def find_header_end(masked_lines: Sequence[str], start: int, limit: int = 60) -> int:
    paren = bracket = angle = 0
    for index in range(start, min(len(masked_lines), start + limit)):
        line = masked_lines[index]
        for ch in line:
            if ch == "(":
                paren += 1
            elif ch == ")" and paren:
                paren -= 1
            elif ch == "[":
                bracket += 1
            elif ch == "]" and bracket:
                bracket -= 1
            elif ch == "<":
                angle += 1
            elif ch == ">" and angle:
                angle -= 1
            elif ch in "{;" and paren == 0 and bracket == 0:
                return index
    return min(len(masked_lines) - 1, start + limit - 1)


def find_block_end(masked_lines: Sequence[str], start: int, header_end: int) -> int | None:
    depth = 0
    seen_open = False
    for index in range(start, len(masked_lines)):
        for ch in masked_lines[index]:
            if ch == "{":
                depth += 1
                seen_open = True
            elif ch == "}" and seen_open:
                depth -= 1
                if depth == 0:
                    return index
        if index == header_end and not seen_open and ";" in masked_lines[index]:
            return None
        if index - start > 4000:
            return None
    return None


def count_generic_params(header: str, kind: str, name: str) -> int:
    marker = re.search(rf"\b{re.escape(kind)}\s+(?:r#)?{re.escape(name)}\s*<", header)
    if not marker:
        return 0
    start = marker.end() - 1
    depth = 0
    content: list[str] = []
    for ch in header[start:]:
        if ch == "<":
            depth += 1
            if depth == 1:
                continue
        elif ch == ">":
            depth -= 1
            if depth == 0:
                break
        if depth >= 1:
            content.append(ch)
    if depth != 0:
        return 0
    text = "".join(content).strip()
    if not text:
        return 0
    nested = 0
    count = 1
    for ch in text:
        if ch in "<([{":
            nested += 1
        elif ch in ">)]}" and nested:
            nested -= 1
        elif ch == "," and nested == 0:
            count += 1
    return count


def parse_public_items(original_lines: Sequence[str], masked_lines: Sequence[str]) -> list[PublicItem]:
    items: list[PublicItem] = []
    pending_attrs: list[str] = []
    index = 0

    while index < len(masked_lines):
        stripped = masked_lines[index].strip()

        if stripped.startswith("#["):
            attr_lines = [original_lines[index]]
            balance = masked_lines[index].count("[") - masked_lines[index].count("]")
            index += 1
            while balance > 0 and index < len(masked_lines):
                attr_lines.append(original_lines[index])
                balance += masked_lines[index].count("[") - masked_lines[index].count("]")
                index += 1
            pending_attrs.extend(attr_lines)
            continue

        match = PUBLIC_ITEM_RE.match(masked_lines[index])
        macro_match = MACRO_RULES_RE.match(masked_lines[index])
        has_macro_export = "macro_export" in "\n".join(pending_attrs)

        if match:
            kind = match.group("kind")
            header_end = find_header_end(masked_lines, index)
            header = collapse(masked_lines[index : header_end + 1])
            name = item_name(kind, header)
            vis = match.group("vis")
            visibility = "pub" if vis is None else f"pub({vis.strip()})"
            block_end = find_block_end(masked_lines, index, header_end)
            items.append(
                PublicItem(
                    start=index,
                    header_end=header_end,
                    block_end=block_end,
                    kind=kind,
                    name=name,
                    visibility=visibility,
                    header=header,
                    attributes="\n".join(pending_attrs),
                )
            )
            pending_attrs = []
            index = header_end + 1
            continue

        if macro_match and has_macro_export:
            header_end = index
            block_end = find_block_end(masked_lines, index, header_end)
            items.append(
                PublicItem(
                    start=index,
                    header_end=header_end,
                    block_end=block_end,
                    kind="macro",
                    name=macro_match.group("name"),
                    visibility="exported",
                    header=masked_lines[index].strip(),
                    attributes="\n".join(pending_attrs),
                )
            )
            pending_attrs = []
            index += 1
            continue

        # Whitespace and masked comments may separate attributes from an item.
        if stripped:
            pending_attrs = []
        index += 1

    return items


def dependency_hits(text: str, dependencies: set[str]) -> list[str]:
    hits = []
    for dependency in dependencies:
        if re.search(rf"(?<![A-Za-z0-9_]){re.escape(dependency)}\s*::", text):
            hits.append(dependency)
    return sorted(hits)


def foreign_error_hits(text: str, dependencies: set[str]) -> list[str]:
    hits = []
    for dependency in dependencies:
        if re.search(
            rf"(?<![A-Za-z0-9_]){re.escape(dependency)}\s*::(?:[A-Za-z0-9_]+::)*[A-Za-z0-9_]*Error\b",
            text,
        ):
            hits.append(dependency)
    return sorted(hits)


def clean_excerpt(line: str, limit: int = 220) -> str:
    value = line.strip().replace("\t", " ")
    return value if len(value) <= limit else value[: limit - 1] + "…"


def candidate(rule: str, relative: str, line: int, message: str, excerpt: str) -> Candidate:
    title, priority = RULES[rule]
    return Candidate(
        rule=rule,
        title=title,
        review_priority=priority,
        path=relative,
        line=line,
        message=message,
        excerpt=clean_excerpt(excerpt),
    )



def analyze_file(
    path: Path,
    root: Path,
    dependencies: set[str],
    include_consumer_signals: bool,
) -> list[Candidate]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []

    masked = mask_comments(text)
    original_lines = text.splitlines()
    masked_lines = masked.splitlines()
    if len(masked_lines) < len(original_lines):
        masked_lines.extend([""] * (len(original_lines) - len(masked_lines)))

    try:
        relative = str(path.relative_to(root if root.is_dir() else root.parent))
    except ValueError:
        relative = str(path)

    found: list[Candidate] = []
    public_items = parse_public_items(original_lines, masked_lines)
    public_type_names = {
        item.name for item in public_items if item.kind in {"struct", "enum", "union", "type", "trait"}
    }

    for item in public_items:
        attrs = item.attributes
        item_end = item.block_end if item.block_end is not None else item.header_end
        body_text = collapse(masked_lines[item.start : item_end + 1])
        source_line = original_lines[item.start] if item.start < len(original_lines) else item.header
        location = item.start + 1
        public_field_lines: list[int] = []

        if item.kind == "macro":
            details = []
            if "crate::" in body_text:
                details.append("expansion contains `crate::`; verify whether `$crate` is required")
            dep_hits = dependency_hits(body_text, dependencies)
            if dep_hits:
                details.append(f"expansion names dependency path(s): {', '.join(dep_hits)}")
            suffix = f" ({'; '.join(details)})" if details else ""
            found.append(
                candidate(
                    "APC012",
                    relative,
                    location,
                    f"exported macro `{item.name}` creates a downstream expansion boundary{suffix}",
                    source_line,
                )
            )
            continue

        if item.kind == "struct":
            # Named public fields.
            if item.block_end is not None:
                for line_index in range(item.start, item.block_end + 1):
                    if PUBLIC_FIELD_RE.match(masked_lines[line_index]):
                        public_field_lines.append(line_index)
                        found.append(
                            candidate(
                                "APC001",
                                relative,
                                line_index + 1,
                                f"{item.visibility} struct `{item.name}` exposes field mutation or representation",
                                original_lines[line_index],
                            )
                        )
            # Tuple-struct public fields live in the header.
            tuple_field_match = re.search(r"\(\s*pub(?:\s*\([^)]*\))?\s+", item.header)
            if tuple_field_match:
                found.append(
                    candidate(
                        "APC001",
                        relative,
                        location,
                        f"{item.visibility} tuple struct `{item.name}` exposes its inner representation",
                        source_line,
                    )
                )

        # Only syntax that is itself boundary-facing is used for exposure rules.
        # Function bodies and private struct fields are implementation, not direct API.
        if item.kind in {"enum", "union", "trait"}:
            surface_indices = list(range(item.start, item_end + 1))
        elif item.kind == "struct":
            surface_indices = list(range(item.start, item.header_end + 1)) + public_field_lines
        else:
            surface_indices = list(range(item.start, item.header_end + 1))
        surface_indices = sorted(set(surface_indices))
        surface_text = collapse([masked_lines[index] for index in surface_indices])

        if item.kind == "type" and REPRESENTATION_PATTERNS.search(item.header):
            found.append(
                candidate(
                    "APC002",
                    relative,
                    location,
                    f"public type alias `{item.name}` commits consumers to a concrete collection representation",
                    source_line,
                )
            )

        dep_hits = dependency_hits(surface_text, dependencies)
        if dep_hits:
            line_index = item.start
            for index in surface_indices:
                if dependency_hits(masked_lines[index], set(dep_hits)):
                    line_index = index
                    break
            found.append(
                candidate(
                    "APC003",
                    relative,
                    line_index + 1,
                    f"`{item.name}` exposes dependency path(s): {', '.join(dep_hits)}; verify boundary intent",
                    original_lines[line_index],
                )
            )

        if OWNERSHIP_RUNTIME_PATTERNS.search(surface_text):
            line_index = next(
                (index for index in surface_indices if OWNERSHIP_RUNTIME_PATTERNS.search(masked_lines[index])),
                item.start,
            )
            found.append(
                candidate(
                    "APC004",
                    relative,
                    line_index + 1,
                    f"`{item.name}` exposes an ownership, synchronization, runtime, guard, or transaction mechanism",
                    original_lines[line_index],
                )
            )

        if item.kind == "fn":
            name_match = re.search(r"\bfn\s+(?:r#)?([A-Za-z_][A-Za-z0-9_]*)", item.header)
            fn_name = name_match.group(1) if name_match else item.name
            if ESCAPE_METHOD_RE.match(fn_name):
                found.append(
                    candidate(
                        "APC005",
                        relative,
                        location,
                        f"public method `{fn_name}` may let consumers bypass the wrapper or take raw ownership",
                        source_line,
                    )
                )

        if item.kind in {"struct", "enum"} and (
            re.search(r"derive\s*\([^)]*\b(?:Serialize|Deserialize)\b", attrs, re.DOTALL)
            or "#[serde" in attrs
        ):
            found.append(
                candidate(
                    "APC006",
                    relative,
                    location,
                    f"public `{item.kind}` `{item.name}` has a Serde-driven external representation",
                    source_line,
                )
            )

        if item.kind in {"struct", "enum", "union"} and "#[repr" in attrs:
            found.append(
                candidate(
                    "APC007",
                    relative,
                    location,
                    f"public `{item.kind}` `{item.name}` commits to an explicit layout; verify ABI intent",
                    source_line,
                )
            )

        if "#[cfg" in attrs and re.search(r"\b(?:feature|target_|unix|windows)\b", attrs):
            found.append(
                candidate(
                    "APC008",
                    relative,
                    location,
                    f"public item `{item.name}` changes with a Cargo feature or target configuration",
                    source_line,
                )
            )

        if re.search(r"\bunsafe\s+(?:fn|trait)\b", item.header):
            found.append(
                candidate(
                    "APC009",
                    relative,
                    location,
                    f"public item `{item.name}` delegates an unsafe contract to consumers",
                    source_line,
                )
            )

        if item.kind in {"struct", "enum", "union", "trait", "type", "fn"}:
            generic_count = count_generic_params(item.header, item.kind, item.name)
            if generic_count >= 3:
                found.append(
                    candidate(
                        "APC010",
                        relative,
                        location,
                        f"`{item.name}` exposes {generic_count} generic parameters; verify they are caller-selected policy rather than implementation plumbing",
                        source_line,
                    )
                )

        if "doc(hidden)" in re.sub(r"\s+", "", attrs):
            found.append(
                candidate(
                    "APC011",
                    relative,
                    location,
                    f"`{item.name}` is public despite being hidden from generated documentation",
                    source_line,
                )
            )

        if RAW_RESOURCE_PATTERNS.search(surface_text):
            line_index = next(
                (index for index in surface_indices if RAW_RESOURCE_PATTERNS.search(masked_lines[index])),
                item.start,
            )
            found.append(
                candidate(
                    "APC013",
                    relative,
                    line_index + 1,
                    f"`{item.name}` exposes a raw pointer, ABI, or OS resource contract",
                    original_lines[line_index],
                )
            )

        error_hits = foreign_error_hits(surface_text, dependencies)
        if error_hits:
            line_index = item.start
            for index in surface_indices:
                if foreign_error_hits(masked_lines[index], set(error_hits)):
                    line_index = index
                    break
            found.append(
                candidate(
                    "APC014",
                    relative,
                    line_index + 1,
                    f"`{item.name}` exposes foreign error type(s) from: {', '.join(error_hits)}",
                    original_lines[line_index],
                )
            )

        if CONCRETE_ITERATOR_PATTERNS.search(surface_text):
            line_index = next(
                (index for index in surface_indices if CONCRETE_ITERATOR_PATTERNS.search(masked_lines[index])),
                item.start,
            )
            found.append(
                candidate(
                    "APC015",
                    relative,
                    line_index + 1,
                    f"`{item.name}` exposes a concrete iterator tied to an internal collection",
                    original_lines[line_index],
                )
            )

    # Deref impls are not public items themselves. Restrict to locally declared public-ish type names when possible.
    for line_index, line in enumerate(masked_lines):
        match = DEREF_IMPL_RE.match(line)
        if not match:
            continue
        target = match.group("type").split("<", 1)[0].split("::")[-1]
        if public_type_names and target not in public_type_names:
            continue
        found.append(
            candidate(
                "APC017",
                relative,
                line_index + 1,
                f"`{match.group('trait')}` for `{target}` exposes the inner type's method surface",
                original_lines[line_index],
            )
        )

    if include_consumer_signals:
        definition_lines = {item.start for item in public_items if item.kind == "fn"}
        for line_index, line in enumerate(masked_lines):
            if line_index in definition_lines:
                continue
            for match in CALLSITE_ESCAPE_RE.finditer(line):
                found.append(
                    candidate(
                        "APC016",
                        relative,
                        line_index + 1,
                        f"consumer calls `{match.group('method')}`; trace whether it depends on hidden representation or error causes",
                        original_lines[line_index],
                    )
                )

    return found


def deduplicate(candidates: Iterable[Candidate]) -> list[Candidate]:
    seen: set[tuple[str, str, int, str]] = set()
    result: list[Candidate] = []
    for item in candidates:
        key = (item.rule, item.path, item.line, item.message)
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    priority_order = {"high": 0, "medium": 1, "low": 2}
    result.sort(key=lambda item: (priority_order[item.review_priority], item.path, item.line, item.rule))
    return result


def render_markdown(root: Path, dependencies: set[str], candidates: Sequence[Candidate], truncated: bool) -> str:
    counts = Counter(item.rule for item in candidates)
    lines = [
        "# Rust Abstraction Candidate Inventory",
        "",
        "> These are syntactic leads, not confirmed leaky abstractions. Validate boundary intent, effective reachability, consumer consequence, and counterevidence.",
        "",
        f"- Root: `{root}`",
        f"- Rust dependency paths considered: {len(dependencies)}",
        f"- Candidates emitted: {len(candidates)}" + (" (truncated)" if truncated else ""),
        "",
    ]

    if counts:
        lines.extend(["## Counts by Rule", ""])
        for rule in sorted(counts):
            lines.append(f"- `{rule}` — {RULES[rule][0]}: {counts[rule]}")
        lines.append("")

    lines.extend(["## Candidates", ""])
    if not candidates:
        lines.append("No syntactic candidates found. This does not prove that the abstractions are sound.")
    else:
        for item in candidates:
            lines.append(
                f"- **{item.rule} / {item.review_priority} review priority** — "
                f"`{item.path}:{item.line}` — {item.message}  "
            )
            if item.excerpt:
                lines.append(f"  `{item.excerpt.replace('`', 'ˋ')}`")

    return "\n".join(lines) + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    root = args.root.expanduser().resolve()
    if not root.exists():
        print(f"error: root does not exist: {root}", file=sys.stderr)
        return 2
    if args.max_candidates < 1:
        print("error: --max-candidates must be positive", file=sys.stderr)
        return 2

    excluded_dirs = DEFAULT_EXCLUDED_DIRS | set(args.exclude_dir)
    dependencies = collect_dependency_names(root, excluded_dirs)
    dependencies -= {normalize_crate_name(value) for value in args.allow_crate}
    dependencies -= {"std", "core", "alloc", "self", "super", "crate"}

    all_candidates: list[Candidate] = []
    for rust_file in iter_files(root, ".rs", excluded_dirs):
        all_candidates.extend(
            analyze_file(
                rust_file,
                root,
                dependencies,
                include_consumer_signals=not args.no_consumer_signals,
            )
        )

    ordered = deduplicate(all_candidates)
    truncated = len(ordered) > args.max_candidates
    emitted = ordered[: args.max_candidates]

    if args.output_format == "json":
        payload = {
            "root": str(root),
            "disclaimer": "Syntactic candidates only; semantic validation is required.",
            "dependency_paths_considered": sorted(dependencies),
            "candidate_count": len(emitted),
            "truncated": truncated,
            "candidates": [asdict(item) for item in emitted],
        }
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(render_markdown(root, dependencies, emitted, truncated), end="")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
