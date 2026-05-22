#!/usr/bin/env python3
"""Lightweight async Rust review scanner.

This script finds code locations that deserve manual review. It does not prove
that a finding exists. It intentionally favors recall over precision.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


EXCLUDE_DIRS = {
    ".git",
    "target",
    ".direnv",
    ".idea",
    ".vscode",
    "node_modules",
    "vendor",
}


@dataclass(frozen=True)
class Pattern:
    name: str
    regex: re.Pattern[str]
    why: str
    noisy: bool = False


PATTERNS: list[Pattern] = [
    # Bare spawn is limited to inline async blocks to avoid std::thread::spawn and Command::spawn noise.
    Pattern("tokio_or_inline_spawn", re.compile(r"\btokio::spawn\s*\(|\b(tokio::)?task::spawn\s*\(|(?<![A-Za-z_:.])spawn\s*\(\s*async\b"), "Tokio or inline async spawn lead; non-Tokio executors can match, so inspect ownership, cancellation, join/error handling, and tracing."),
    Pattern("spawn_method", re.compile(r"\.spawn\s*\("), "Receiver-agnostic .spawn lead for JoinSet, TaskTracker, runtimes, and executors; inspect the receiver before reporting.", noisy=True),
    Pattern("spawn_blocking", re.compile(r"\bspawn_blocking\s*\("), "Check blocking work is bounded and shutdown-safe; started blocking tasks cannot be aborted."),
    Pattern("spawn_local/local", re.compile(r"\b(spawn_local|LocalSet)\b|flavor\s*=\s*\"current_thread\""), "Check !Send/local executor assumptions and hidden lock/borrow hazards."),
    Pattern("joinset/tasktracker", re.compile(r"\b(JoinSet|TaskTracker|join_next|track_future)\b"), "Check spawned tasks are drained and shutdown waits are bounded."),
    Pattern("joinhandle", re.compile(r"\bJoinHandle\b"), "Check stored handles are awaited, aborted intentionally, transferred to an owner, or drained during shutdown."),
    Pattern("cancellation_token", re.compile(r"\bCancellationToken\b|\.cancelled\s*\("), "Check cooperative cancellation is paired with a wait/join phase."),
    # The alternatives are mutually exclusive: bare select! matches imported tokio::select!, but not futures::select!.
    Pattern("select", re.compile(r"\btokio::select!|(?<!::)\bselect!"), "Check cancellation safety of losing branches and fairness of biased branches; bare imported select! may be non-Tokio, so inspect semantics."),
    Pattern("known_cancel_unsafe_io", re.compile(r"\.(read_exact|read_to_end|read_to_string|write_all)\s*\("), "Dangerous inside select loops; can lose partial progress on cancellation."),
    Pattern("unbounded_channel", re.compile(r"\bunbounded_channel\s*\(|\bUnbounded(Sender|Receiver)\b"), "Requires explicit backpressure/boundedness justification."),
    Pattern("lock_acquire", re.compile(r"\.((blocking_)?lock|read_owned|write_owned)\s*\("), "Receiver-agnostic .lock lead; inspect context for guards held across await and contention risk.", noisy=True),
    Pattern("lock_type", re.compile(r"\b(std::sync|parking_lot|tokio::sync)::(Mutex|RwLock)\s*(<|::(new|default)\b)"), "Check known lock fields and constructors for guard lifetimes, contention, and whether sync locks enter async code."),
    Pattern("semaphore", re.compile(r"\bSemaphore\b|\.acquire(_owned)?\s*\("), "Check cancellation/fairness and whether fanout is bounded."),
    Pattern("blocking_std", re.compile(r"\bstd::(fs|thread::sleep|process::Command)\b|\breqwest::blocking\b|\bblocking_(send|recv)\s*\("), "Check blocking work is not on async runtime workers."),
    Pattern("timeout", re.compile(r"\b(tokio::time::|time::)timeout\s*\("), "Check external I/O deadlines, timeout scope, and non-yielding future caveat."),
    Pattern("sleep", re.compile(r"\b(tokio::time::|time::)sleep\s*\("), "Check sleeps in select loops are pinned/recreated intentionally and not masking missing deadlines."),
    Pattern("rc_refcell", re.compile(r"\b(Rc|RefCell)\s*<|(?<![A-Za-z_])Cell\s*<"), "Check !Send assumptions and borrows across await."),
    Pattern("tracing", re.compile(r"#\[tracing::instrument(?:\(|\])|\b(info_span|debug_span|warn_span|error_span|trace_span)!|\.instrument\s*\(|\.in_current_span\s*\("), "Check spans propagate across task boundaries with useful fields."),
]


@dataclass(frozen=True)
class Hit:
    path: Path
    line_no: int
    pattern: Pattern
    line: str


def iter_rust_files(root: Path) -> Iterable[Path]:
    if root.is_file():
        if root.suffix == ".rs":
            yield root
        return

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        dirnames.sort()
        for filename in sorted(filenames):
            path = Path(dirpath) / filename
            if path.suffix == ".rs":
                yield path


def scan_file(path: Path, patterns: list[Pattern]) -> Iterable[Hit]:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        text = path.read_text(errors="replace")

    for line_no, line in enumerate(text.splitlines(), start=1):
        for pattern in patterns:
            if pattern.regex.search(line):
                yield Hit(path, line_no, pattern, line.strip())


def main() -> int:
    parser = argparse.ArgumentParser(description="Find async Rust review leads.")
    parser.add_argument("root", nargs="?", default=".", help="Repository root or Rust file to scan")
    parser.add_argument("--limit", type=int, default=500, help="Maximum hits to print")
    parser.add_argument("--per-pattern-limit", type=int, default=50, help="Maximum hits to print for each pattern")
    parser.add_argument("--include-noisy", action="store_true", help="Include broad receiver-agnostic patterns such as .lock() and .spawn()")
    args = parser.parse_args()
    if args.limit <= 0:
        print("error: --limit must be greater than zero", file=sys.stderr)
        return 2
    if args.per_pattern_limit <= 0:
        print("error: --per-pattern-limit must be greater than zero", file=sys.stderr)
        return 2

    root = Path(args.root).resolve()
    if not root.exists():
        print(f"error: path does not exist: {root}", file=sys.stderr)
        return 2

    active_patterns = [pattern for pattern in PATTERNS if args.include_noisy or not pattern.noisy]

    hits: list[Hit] = []
    for rust_file in iter_rust_files(root):
        for hit in scan_file(rust_file, active_patterns):
            hits.append(hit)

    if not hits:
        print("No async Rust review leads found.")
        return 0

    print("# Async Rust review leads")
    print()
    print("Scanner hits are leads only. Inspect code before reporting findings.")
    print()

    hits_by_pattern: dict[str, list[Hit]] = defaultdict(list)
    for hit in hits:
        hits_by_pattern[hit.pattern.name].append(hit)

    printed = 0
    omitted_by_limit = 0
    omitted_by_per_pattern = 0
    for pattern in active_patterns:
        pattern_hits = hits_by_pattern.get(pattern.name, [])
        printable_for_pattern = min(len(pattern_hits), args.per_pattern_limit)
        over_per_pattern = max(0, len(pattern_hits) - args.per_pattern_limit)
        if not pattern_hits or printed >= args.limit:
            omitted_by_limit += printable_for_pattern
            omitted_by_per_pattern += over_per_pattern
            continue

        print(f"\n## {pattern.name}")
        print(f"{pattern.why}\n")
        stopped_at_limit = False
        for idx, hit in enumerate(pattern_hits[:args.per_pattern_limit]):
            if printed >= args.limit:
                omitted_by_limit += printable_for_pattern - idx
                omitted_by_per_pattern += over_per_pattern
                stopped_at_limit = True
                break
            rel = hit.path.relative_to(root) if root.is_dir() else hit.path.name
            print(f"- `{rel}:{hit.line_no}`: `{hit.line}`")
            printed += 1

        if not stopped_at_limit and over_per_pattern:
            omitted_by_per_pattern += over_per_pattern
            print(f"- ... {over_per_pattern} more {pattern.name} hits omitted by --per-pattern-limit")

    if omitted_by_limit or omitted_by_per_pattern:
        parts = []
        if omitted_by_limit:
            parts.append(f"{omitted_by_limit} by --limit")
        if omitted_by_per_pattern:
            parts.append(f"{omitted_by_per_pattern} by --per-pattern-limit")
        print(f"\nOmitted {', '.join(parts)}. Narrow the scan or raise the relevant limit if needed.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
