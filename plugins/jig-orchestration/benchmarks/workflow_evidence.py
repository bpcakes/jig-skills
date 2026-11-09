"""Retain controller diagnostics and verify supplied reviewer-log retrieval."""
import copy
import hashlib
import json
from pathlib import Path


def retain_controller(result, *, run, workspace, destination):
    """Copy settled fixture diagnostics before cleanup, without administrative state.

    Retention describes the bytes copied, not whether the original capture or
    controller succeeded. I/O errors propagate so callers keep the fixture.
    """
    run, workspace, destination = Path(run).resolve(), Path(workspace).resolve(), Path(destination)
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    reported_receipt = result.get("receipt") or {}
    rejected = reported_receipt.get("rejected_result") or {}
    nested = rejected.get("receipt")
    receipt = nested if isinstance(nested, dict) else reported_receipt
    output = receipt.get("output") or {}
    manifest = {"schema": 1, "outcome": result.get("outcome"),
                "source_receipt": "receipt.rejected_result.receipt" if isinstance(nested, dict) else "receipt",
                "rejection": copy.deepcopy(reported_receipt.get("rejection")),
                "rejected_status": rejected.get("status"),
                "output": copy.deepcopy(receipt.get("output")), "files": []}

    def status(source, root):
        if not source:
            return "missing-reference"
        path = Path(source)
        if not path.is_absolute() or not path.is_relative_to(root) or path.resolve() != path:
            return "refused"
        return "present" if path.exists() else "missing"

    def retain(source, relative, root, *, allowed=True):
        row = {"source": source, "target": str(relative), "retained": None,
               "status": status(source, root) if allowed else "refused"}
        manifest["files"].append(row)
        if row["status"] != "present":
            return
        path = Path(source)
        if not path.is_file():
            row["status"] = "refused"
            return
        target = destination / relative
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        digest, size = hashlib.sha256(), 0
        with path.open("rb") as reader, target.open("xb") as writer:
            while chunk := reader.read(65536):
                writer.write(chunk)
                digest.update(chunk)
                size += len(chunk)
        row.update(status="copied", retained=str(relative), bytes=size, sha256=digest.hexdigest())

    for stream, reference in (("stdout", "ref"), ("stderr", "stderr_ref")):
        source = (output.get(stream) or {}).get("path") or receipt.get(reference)
        path = Path(source) if source else None
        allowed = path is None or (path.parent.parent == run and path.parent.name.startswith("execution-")
                                    and path.name.startswith("controller-") and path.suffix == "." + stream)
        retain(source, Path("host." + stream), run, allowed=allowed)

    directory = (receipt.get("controller") or {}).get("directory") or receipt.get("controller_directory")
    root = workspace / ".git/jig/review-fix"
    controller = {"source": directory, "status": status(directory, root)}
    manifest["controller_directory"] = controller
    if controller["status"] == "present":
        path = Path(directory)
        if path.parent != root or not path.is_dir():
            controller["status"] = "refused"
        else:
            assignments = path / "assignments"
            controller["assignments_status"] = status(str(assignments), path)
            if controller["assignments_status"] == "present":
                if not assignments.is_dir():
                    controller["assignments_status"] = "refused"
                else:
                    controller["assignments"] = 0
                    for assignment in sorted(assignments.iterdir()):
                        if assignment.is_dir():
                            controller["assignments"] += 1
                            for name in ("request.json", "result.json", "stdout.log", "stderr.json"):
                                retain(str(assignment / name), Path("assignments") / assignment.name / name, path)
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def live_access_complete(probe, runtime):
    """A successful empty review cannot substitute for current live log reads."""
    if not isinstance(probe, dict) or not runtime:
        return False
    reads = probe.get("validation_log_reads")
    return (probe.get("outcome") == "succeeded" and probe.get("phase") == "CONVERGED"
            and probe.get("runtime_sha256") == runtime and isinstance(reads, dict)
            and all(type(reads.get(provider)) is int and reads[provider] > 0
                    for provider in ("claude", "codex")))


def retrieved(part, rows):
    pages = {}
    for row in rows:
        request, response = row["request"], row["response"]
        if (request.get("op") != "artifact_read" or request.get("artifact_id") != part["artifact_id"]
                or response.get("artifact_id") != part["artifact_id"]
                or response.get("sha256") != part["sha256"] or response.get("error")):
            continue
        offset, content = response.get("offset"), response.get("content")
        if type(offset) is int and offset >= 0 and isinstance(content, str):
            previous = pages.get(offset, "")
            if content.startswith(previous):
                pages[offset] = content
            elif not previous.startswith(content):
                return False
    if not pages or 0 not in pages:
        return False
    text = ""
    for offset, content in sorted(pages.items()):
        if offset > len(text):
            return False
        overlap = min(len(text) - offset, len(content))
        if text[offset:offset + overlap] != content[:overlap]:
            return False
        text += content[overlap:]
    raw = text.encode("utf-8")
    return len(raw) == part["bytes"] and hashlib.sha256(raw).hexdigest() == part["sha256"]


def summarize(sessions, trace, tasks=("A", "B"), providers=("claude", "codex")):
    summary = {task: {provider: {"assignments": 0, "supplied_logs": 0, "retrieved_logs": 0}
                      for provider in providers} for task in tasks}
    assignments = []
    for session_id, session in sessions.items():
        contract = session.get("review_contract") or {}
        task_ids = session.get("task_ids", [])
        task = task_ids[0] if len(task_ids) == 1 else None
        provider = contract.get("provider")
        if session.get("role") != "reviewer" or task not in summary or provider not in summary[task]:
            continue
        rows = [row for row in trace if row.get("session_id") == session_id
                and row.get("provider") == provider and row["request"].get("task_id") == task]
        logs = []
        for check in (contract.get("validationEvidence") or {}).get("checks", []):
            receipt = check.get("receipt") or {}
            for key in ("logArtifact", "stderrLogArtifact"):
                if key not in receipt:
                    continue
                log = receipt[key]
                parts = log.get("parts", [])
                logs.append({"check_id": check["checkId"], "kind": key,
                             "retained_log_complete": log.get("retained_log_complete"),
                             "retrieved": bool(parts) and all(retrieved(part, rows) for part in parts)})
        counts = summary[task][provider]
        counts["assignments"] += 1
        counts["supplied_logs"] += len(logs)
        counts["retrieved_logs"] += sum(log["retrieved"] for log in logs)
        assignments.append({"task": task, "provider": provider, "assignment_id": contract.get("id"),
                            "session_id": session_id, "logs": logs})
    for by_provider in summary.values():
        for counts in by_provider.values():
            counts["status"] = ("not_exercised" if not counts["supplied_logs"] else
                                "passed" if counts["supplied_logs"] == counts["retrieved_logs"] else "failed")
    return {"by_task": summary, "assignments": assignments,
            "all_selected_reviewers_present": all(summary[task][provider]["assignments"]
                for task in tasks for provider in providers),
            "all_supplied_logs_retrieved": all(log["retrieved"] for assignment in assignments for log in assignment["logs"]),
            "all_selected_providers_exercised": all(any(summary[task][provider]["supplied_logs"]
                for task in tasks) for provider in providers)}
