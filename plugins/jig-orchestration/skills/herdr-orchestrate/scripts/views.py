"""Bounded task views with immutable, session-scoped full evidence snapshots."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

import channel
from state import Engine, canonical, private, read_json, require, unresolved_finding, write_atomic

MAX_VIEW_BYTES = 32768


def complete(full):
    return {**full, "view_schema": 1, "mode": "full", "complete": True}


def save_snapshot(run_dir, identifier, snapshot):
    directory = Path(run_dir) / "view-snapshots"
    directory.mkdir(mode=0o700, exist_ok=True)
    private(directory, directory=True)
    path = directory / identifier
    if not path.exists():
        write_atomic(path, snapshot)


def overview(run_dir, session, full, *, adaptive=True):
    """Bound the coordinator's aggregate too, with an immutable detail route."""
    if adaptive and len(canonical(complete(full)).encode()) <= 4096:
        return complete(full)
    snapshot = {"session_id": session.id, "task_id": None, "view": full}
    identifier = hashlib.sha256(canonical(snapshot).encode()).hexdigest()
    omitted, budget = [], [4096]
    result = {key: full[key] for key in ("version", "policy_version", "change_token", "blocking_summary")}
    for key in ("controls", "summary", "tasks"):
        result[key] = preview(full[key], [key], omitted, budget=budget)
    result.update(view_schema=1, mode="compact", complete=not omitted, snapshot=identifier,
                  omitted_paths=omitted[:32], omitted_path_count=len(omitted),
                  detail_request={"op": "view_read", "snapshot": identifier})
    for key in ("tasks", "summary", "controls", "omitted_paths"):
        if len(canonical(result).encode()) <= MAX_VIEW_BYTES:
            break
        result[key] = [] if key == "omitted_paths" else {"omitted": True}
        result["complete"] = False
    save_snapshot(run_dir, identifier, snapshot)
    return result


def preview(value, path, omitted, depth=0, budget=None):
    budget = [2048] if budget is None else budget
    if budget[0] <= 32:
        omitted.append(path)
        return {"omitted": True}
    budget[0] -= 32
    if isinstance(value, str) and len(value) > 256:
        omitted.append(path)
        budget[0] -= 256
        return value[:256] + "…"
    if isinstance(value, str):
        budget[0] -= len(value)
    if isinstance(value, (dict, list)):
        if depth >= 4:
            omitted.append(path)
            return {"type": type(value).__name__, "count": len(value)}
        keys = sorted(value) if isinstance(value, dict) else list(range(len(value)))
        limit = 12 if isinstance(value, dict) else 8
        if len(keys) > limit:
            omitted.append(path)
        selected = {}
        for key in keys[:limit]:
            if isinstance(key, str) and len(key) > 128:
                omitted.append(path)
                continue
            budget[0] -= len(str(key))
            selected[key] = preview(value[key], [*path, key], omitted, depth + 1, budget)
        return selected if isinstance(value, dict) else list(selected.values())
    return value


def compact(run_dir, session, task_id, full, *, adaptive=False):
    # The filename binds the actual content and session, not a mutable revision
    # label. Authorization is rechecked whenever any selected detail is read.
    snapshot = {"session_id": session.id, "task_id": task_id, "view": full}
    identifier = hashlib.sha256(canonical(snapshot).encode()).hexdigest()
    task = full["task"]
    fields = ("id", "version", "phase", "driver", "host", "worktree", "branch", "parked", "slot",
              "paused", "cancel_requested", "blocker", "next_action", "acceptance_ref", "refs",
              "holds", "findings", "pending_intent", "reservations", "delegation", "counters")
    omitted = [["task", key] if len(key) <= 128 else ["task"] for key in sorted(task) if key not in fields]
    budget = [4096]
    selected = {key: preview(task[key], ["task", key], omitted, budget=budget) for key in fields if key in task}
    controls = preview(full["controls"], ["controls"], omitted, budget=budget)
    findings = task.get("findings", [])
    findings_unknown = not isinstance(findings, list)
    findings = findings if not findings_unknown else []
    unresolved_indices = [index for index, item in enumerate(findings)
                          if unresolved_finding(item)]
    candidates = full.get("integration", {}).get("candidates", {})
    result = {"view_schema": 1, "mode": "compact", "task": selected, "controls": controls,
              "policy_version": full["policy_version"], "change_token": full["change_token"],
              "blocking_summary": {"paused": bool(task["paused"] or full["controls"]["paused"]),
                                   "cancel_requested": bool(task["cancel_requested"] or full["controls"]["cancel_requested"]),
                                   "run_holds": len(full["controls"].get("holds", {})),
                                   "task_holds": len(task.get("holds", {})), "has_blocker": bool(task.get("blocker")),
                                   "findings": len(findings), "unresolved_findings": len(unresolved_indices),
                                   "unresolved_finding_indices": unresolved_indices[:16],
                                   "findings_unknown": findings_unknown,
                                   "unsettled_effect": task.get("pending_intent") is not None,
                                   "unknown_integration_candidates": sum(
                                       item.get("status", "unknown") not in ("clean", "conflicted")
                                       for item in candidates.values()),
                                   "pending_integration_candidates": sum(
                                       (item.get("waiting") or {}).get("status") == "pending"
                                       for item in candidates.values())},
              "snapshot": identifier}
    for key in ("staging", "conditions", "integration"):
        if key in full:
            result[key] = preview(full[key], [key], omitted, budget=budget)
    result.update(complete=not omitted, omitted_paths=omitted[:32], omitted_path_count=len(omitted),
                  detail_request={"op": "view_read", "task_id": task_id, "snapshot": identifier})
    # The byte cap is an output safety limit, not a token measurement. Include
    # JSON escaping, keys and metadata; a character preview budget alone is not
    # sufficient to enforce it.
    for key in ("integration", "conditions", "staging", "task", "controls"):
        if len(canonical(result).encode()) <= MAX_VIEW_BYTES:
            break
        result[key] = {"omitted": True}
        result["complete"] = False
        result["omitted_path_count"] += 1
        if len(result["omitted_paths"]) < 32:
            result["omitted_paths"].append([key])
    while len(canonical(result).encode()) > MAX_VIEW_BYTES and result["omitted_paths"]:
        result["omitted_paths"].pop()
    if adaptive:
        full_view = complete(full)
        if len(canonical(full_view).encode()) <= min(MAX_VIEW_BYTES, len(canonical(result).encode())):
            return full_view
    save_snapshot(run_dir, identifier, snapshot)
    return result


def read(run_dir, session, request):
    task_id = request.get("task_id")
    principal = channel.check(Engine.read(run_dir), session, operation="view_read", task_id=task_id)
    require((task_id in principal["task_ids"] or task_id is None and principal["role"] == "coordinator")
            and principal["role"] != "reviewer",
            "scope", "full task views are unavailable to reviewers")
    identifier = request.get("snapshot")
    require(isinstance(identifier, str) and re.fullmatch(r"[0-9a-f]{64}", identifier), "snapshot", "invalid view snapshot")
    path = Path(run_dir) / "view-snapshots" / identifier
    require(path.is_file(), "snapshot", "view snapshot is unavailable")
    snapshot = read_json(path)
    require(snapshot["session_id"] == session.id and snapshot["task_id"] == task_id
            and hashlib.sha256(canonical(snapshot).encode()).hexdigest() == identifier,
            "snapshot", "view snapshot is unavailable or its integrity check failed")
    selectors = request.get("path", [])
    require(isinstance(selectors, list) and len(selectors) <= 16
            and all(type(key) in {str, int} for key in selectors), "snapshot", "path must be a bounded key/index list")
    selected = channel.public(snapshot["view"])
    try:
        for key in selectors:
            if isinstance(selected, list):
                require(type(key) is int and 0 <= key < len(selected), "snapshot", "invalid array index")
            else:
                require(isinstance(selected, dict) and isinstance(key, str), "snapshot", "invalid object key")
            selected = selected[key]
    except (KeyError, IndexError):
        require(False, "snapshot", "selected detail does not exist")
    selection = request.get("select")
    require(selection is None or selection == "unresolved_findings" and selectors == ["task", "findings"],
            "snapshot", "unresolved_findings selection requires the task findings path")
    if selection is not None:
        require(isinstance(selected, list), "snapshot", "findings are not a structured list; retrieve full evidence")
        selected = [{"index": index, "finding": item} for index, item in enumerate(selected) if unresolved_finding(item)]
    text = canonical(selected)
    offset, limit = request.get("offset", 0), request.get("limit", 16384)
    require(type(offset) is int and 0 <= offset <= len(text) and type(limit) is int and 1 <= limit <= 65536,
            "snapshot", "invalid detail offset or limit")
    end = min(offset + limit, len(text))
    return {"snapshot": identifier, "path": selectors, "select": selection, "offset": offset, "next_offset": end,
            "total_characters": len(text), "complete": end == len(text), "content": text[offset:end],
            "task_version": snapshot["view"].get("task", {}).get("version"),
            "version": snapshot["view"].get("version"), "change_token": snapshot["view"]["change_token"]}
