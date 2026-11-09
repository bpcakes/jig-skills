#!/usr/bin/env python3
"""Host adapter for the review-fix controller's pinned execution boundary.

The controller stays on the trusted host. Every model and validation command
gets a separate scoped launch; no source lease spans the controller's wait.
"""
from __future__ import annotations

import argparse
import base64
import copy
from contextlib import contextmanager
import hashlib
import fcntl
import json
import os
from pathlib import Path
import sys
import threading
import uuid

import channel
import communicate
import isolation
from profiles import validate
from state import Engine, canonical, private, read_json, require, write_atomic


@contextmanager
def captured_report():
    """Drain both pipes while retaining bounded bytes, without file growth."""
    streams, workers, contents, truncated = [], [], [bytearray(), bytearray()], [False, False]
    for index, limit in enumerate((512 * 1024, 32 * 1024)):
        reader, writer = os.pipe()
        streams.append(os.fdopen(writer, "wb"))

        def drain(reader=reader, index=index, limit=limit):
            with os.fdopen(reader, "rb") as stream:
                while chunk := stream.read(65536):
                    room = max(0, limit - len(contents[index]))
                    contents[index].extend(chunk[:room])
                    truncated[index] |= len(chunk) > room

        worker = threading.Thread(target=drain, daemon=True)
        workers.append(worker)
        worker.start()
    try:
        yield streams, contents, truncated
    finally:
        for stream in streams:
            stream.close()
        for worker in workers:
            worker.join(5)
        require(not any(worker.is_alive() for worker in workers), "boundary", "model report streams did not settle")


def read_policy(path, digest):
    path = Path(path).resolve(strict=True)
    private(path)
    raw = path.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == digest, "boundary", "execution boundary policy changed")
    policy = json.loads(raw)
    require(isinstance(policy, dict) and policy.get("schema") == 2
            and set(policy) == {"schema", "run_dir", "task_id", "profiles", "owner_session", "task_binding"},
            "boundary", "invalid execution boundary policy")
    require(isinstance(policy["profiles"], dict), "boundary", "boundary profiles must be an object")
    return policy


def policy_state(policy):
    state = Engine.read(policy["run_dir"])
    require(state["config"].get("communication", {}).get("mode") == "enforced",
            "boundary", "review execution boundary requires an enforced orchestration run")
    task = state["tasks"].get(policy["task_id"])
    require(task is not None and channel.task_binding(task) == policy["task_binding"],
            "session_revoked", "review boundary task binding changed")
    owner = channel.authorizing_session(state, policy["owner_session"], policy["task_id"])
    return state, task, owner


def mapped_command(argv, profile):
    require(isinstance(argv, list) and argv and all(isinstance(arg, str) and "\0" not in arg for arg in argv),
            "boundary", "controller command must be an argument array")
    mappings = sorted(((Path(mount["source"]).resolve(strict=True), Path(mount["target"]))
                       for mount in profile.get("mounts", [])), key=lambda pair: len(pair[0].parts), reverse=True)
    result = []
    for arg in argv:
        rewritten = arg
        if Path(arg).is_absolute():
            candidate = Path(arg).resolve()
            for source, target in mappings:
                if candidate == source or source in candidate.parents:
                    rewritten = str(target / candidate.relative_to(source))
                    break
        result.append(rewritten)
    return result


def validation_artifacts(policy, assignment, request_path):
    """Expose only the controller's explicitly assigned validation logs."""
    assignment = copy.deepcopy(assignment)
    selected = []
    evidence = assignment.get("validationEvidence")
    if evidence:
        require(evidence.get("fingerprint") == assignment["fingerprint"], "boundary", "validation evidence scope changed")
        selected.extend(check["receipt"] for check in evidence.get("checks", []) if check.get("receipt"))
    selected.extend(assignment.get("validation", []))
    if not selected:
        return assignment
    _, task, owner = policy_state(policy)
    workspace = Path(task["worktree"]).resolve(strict=True)
    require(request_path is not None, "boundary", "validation logs need a pinned controller request")
    request_path = Path(request_path).resolve(strict=True)
    controller = request_path.parents[2]
    require(controller.parent == workspace / ".git/jig/review-fix"
            and request_path == controller / "assignments" / assignment["id"] / "request.json",
            "boundary", "validation logs must belong to this controller assignment")
    principal = channel.check(Engine.read(policy["run_dir"]), owner, task_id=policy["task_id"])
    identifiers = set(assignment.get("artifact_ids", []))
    for receipt in selected:
        if not receipt.get("log") and not receipt.get("stderrLog"):
            continue
        identifier = receipt.get("assignmentId")
        require(isinstance(identifier, str) and Path(identifier).name == identifier and identifier not in {".", ".."},
                "boundary", "invalid validation assignment identity")
        for key, name in (("log", "stdout.log"), ("stderrLog", "stderr.json")):
            if not receipt.get(key):
                continue
            source = controller / "assignments" / identifier / name
            require(Path(receipt[key]) == source and source.resolve(strict=True) == source,
                    "boundary", "validation log is outside its approved assignment")
            private(source)
            require(source.stat().st_size <= 8 * 1024 * 1024, "size", "validation log exceeds supported retained size")
            raw = source.read_bytes()
            retained = raw
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError as error:
                # A failed disk write or an older runner can leave a partial
                # sequence. Publish the valid prefix and retain its provenance.
                retained = raw[:error.start]
                text = retained.decode("utf-8")
            decoding_loss = retained != raw
            digest = hashlib.sha256(retained).hexdigest()
            parts = []
            for offset in range(0, max(1, len(text)), 128 * 1024):
                action = "validation-" + hashlib.sha256(canonical([str(controller), identifier, key, digest, offset]).encode()).hexdigest()
                result = Engine.apply(policy["run_dir"], {"op": "artifact_put", "task_id": policy["task_id"],
                    "action_id": action, "content": text[offset:offset + 128 * 1024],
                    "readers": sorted({principal["actor"], "coordinator"})}, principal["actor"], session=owner)
                part = result["artifact"]
                identifiers.add(part["id"])
                parts.append({"artifact_id": part["id"], "sha256": part["sha256"], "bytes": part["bytes"]})
            receipt.pop(key)
            receipt[key + "Artifact"] = {"sha256": digest, "bytes": len(retained), "parts": parts,
                                            "retained_decoding_loss": decoding_loss,
                                            "retained_log_complete": (receipt.get("logTruncated" if key == "log" else "stderrTruncated") is False
                                                and receipt.get("stdoutDecodingLoss" if key == "log" else "stderrDecodingLoss") is False
                                                and not decoding_loss)}
            if decoding_loss:
                receipt[key + "Artifact"].update(retained_source_sha256=hashlib.sha256(raw).hexdigest(),
                                                 retained_source_bytes=len(raw))
    assignment["artifact_ids"] = sorted(identifiers)
    assignment["instructions"] = assignment.get("instructions", "") + (
        " Approved validation logs are supplied as logArtifact/stderrLogArtifact references. "
        "Read their ordered parts through the authenticated communicate.py artifact_read operation "
        "using this task ID and each artifact_id. Fetch all pages when needed. Original controller "
        "paths remain private; log truncation and original receipt/source bindings remain authoritative.")
    return assignment


def execute(policy, request, *, request_path=None):
    role = request.get("role")
    require(role in {"review", "adjudicate", "triage", "repair", "validate"}, "boundary", "unsupported controller role")
    assignment = request.get("assignment")
    require(isinstance(assignment, dict) and assignment.get("role") == role,
            "boundary", "controller assignment role mismatch")
    key = assignment.get("provider") if role in {"review", "adjudicate"} else role
    profile = validate(policy["profiles"].get(key))
    require(not profile.get("argv"), "boundary", "boundary profiles must preserve the controller's selected command")
    profile["environment"] = {**profile.get("environment", {}), "CI": "1", "GIT_OPTIONAL_LOCKS": "0"}
    require(not request.get("environment"), "boundary", "select command environment through the pinned profile")
    require(all(profile["environment"].get(name) for name in request.get("requiredEnvironment", [])),
            "boundary", "required validation environment is absent from its pinned profile")
    run_dir, task_id = Path(policy["run_dir"]).resolve(strict=True), policy["task_id"]
    state, task, owner = policy_state(policy)
    from jobs import check_new_work, lease
    check_new_work(state, task)
    workspace = Path(task["worktree"]).resolve(strict=True)
    cwd = Path(request["cwd"]).resolve(strict=True)
    require(cwd == workspace or workspace in cwd.parents, "boundary", "controller command escaped the selected checkout")
    if role != "validate":
        require(Path(assignment["repository"]).resolve(strict=True) == workspace,
                "boundary", "controller assignment changed the selected checkout")
    if role == "review":
        require(not any(name in assignment for name in ("findings", "reports", "priorReview")),
                "boundary", "independent reviewer assignment contains prior reports")
    require(profile.get("workspace_access", "write") != "none",
            "boundary", "controller source work requires an explicit checkout-capable profile")
    if role in {"review", "adjudicate", "triage"}:
        profile["workspace_access"] = "read"
    command = mapped_command(request["command"], profile)
    if cwd != workspace:
        # Preserve validation's selected subdirectory inside the same lease.
        command = ["/usr/bin/env", "-C", str(cwd), *command]
    # A controller step may still be finishing after it schedules a child.
    # Wait outside the state lock, before allocating artifacts or credentials;
    # the controller does not wait for this job while holding its own lease.
    with lease(run_dir, str(workspace), profile.get("workspace_access", "write") == "read", wait_seconds=5) as held:
        state, task, owner = policy_state(policy)
        check_new_work(state, task)
        if role != "validate":
            assignment = validation_artifacts(policy, assignment, request_path)
        actor = "review-loop-" + uuid.uuid4().hex
        directory = isolation.prepare(run_dir, actor, task_id, role="reviewer" if role == "review" else "executor",
                                      profile=profile, review_contract=assignment if role == "review" or assignment.get("artifact_ids") else None,
                                      parent_session=owner, expected_binding=policy["task_binding"])
        try:
            spec = read_json(directory / "launch.json")
            require(held.workspace == spec["workspace"] and held.readonly == spec["readonly"],
                    "session_revoked", "launch source access changed during preparation")
            return execute_child(run_dir, actor, assignment, request, directory, command, held)
        finally:
            channel.revoke(run_dir, actor)


def execute_child(run_dir, actor, assignment, request, directory, command, held):
    role = request["role"]
    # Validation output is already bounded/spooled by the controller. Model
    # reports are bounded by that same controller and retained in the channel.
    if role == "validate":
        return isolation.launch(directory, command, workspace_lease=held,
                                timeout=request.get("timeoutMs", 300000) / 1000).returncode
    with captured_report() as (streams, contents, truncated):
        completed = isolation.launch(directory, command, input=canonical(assignment).encode(),
                                     stdout=streams[0], stderr=streams[1],
                                     workspace_lease=held,
                                     timeout=request.get("timeoutMs", 300000) / 1000)
    stdout, stderr = (bytes(content) for content in contents)
    # This private record preserves late or malformed output for host recovery.
    # It does not confer acceptance: only the authenticated artifact publication
    # below can return a usable result to the controller.
    write_atomic(directory / "report.json", {"assignment_id": assignment["id"],
                 "returncode": completed.returncode, "truncated": truncated,
                 "stdout_base64": base64.b64encode(stdout).decode(),
                 "stderr_base64": base64.b64encode(stderr).decode()})
    sys.stderr.buffer.write(stderr)
    if truncated[1]:
        sys.stderr.buffer.write(b"\n[model stderr truncated at 32 KiB]\n")
    if completed.returncode:
        sys.stdout.buffer.write(stdout)
        return completed.returncode
    require(not truncated[0], "boundary", "model report exceeds channel artifact limit")
    spec = read_json(directory / "launch.json")
    credential = Path(spec["credential"]).read_text().strip()
    result = communicate.request({"op": "artifact_put", "task_id": spec["task_id"],
                                  "action_id": actor + "-" + assignment["id"],
                                  "content": stdout.decode("utf-8")},
                                 socket_path=str(run_dir / "endpoint" / "gateway.sock"), credential=credential)
    require("error" not in result, "boundary", "review report was not durably published to the channel")
    sys.stdout.buffer.write(stdout)
    return 0

def publication_lease(policy, workspace, acquire=False):
    """Lock an fd opened by Node: both processes share its open-file description.

    Exiting this helper retains the lock in Node and its explicit Git children.
    The descriptor is never given to model commands.
    """
    from jobs import lease_path
    state, task, _ = policy_state(policy)
    require(task is not None and Path(task["worktree"]).resolve(strict=True) == Path(workspace).resolve(strict=True),
            "boundary", "controller lease must use the admitted checkout")
    path = lease_path(policy["run_dir"], str(Path(workspace).resolve()))
    if not acquire:
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        private(path)
        return {"path": str(path)}
    private(path)
    expected, inherited = path.stat(), os.fstat(3)
    require((expected.st_dev, expected.st_ino) == (inherited.st_dev, inherited.st_ino),
            "boundary", "inherited descriptor is not the registered source lease")
    fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
    state, task, _ = policy_state(policy)
    # Writers can change metadata after admission. Check it again while no
    # writer can run, before trusted Git follows any worker-created links.
    import capabilities
    capabilities.checkout(state, task["host"], task["worktree"], policy["run_dir"], excluding=task["id"])
    state, task, _ = policy_state(policy)
    return {"paused": bool(state["controls"]["paused"] or task["paused"]),
            "cancel_requested": bool(state["controls"]["cancel_requested"] or task["cancel_requested"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--policy-sha256", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--request")
    mode.add_argument("--lease-path")
    mode.add_argument("--lock-publication")
    args = parser.parse_args()
    policy = read_policy(args.policy, args.policy_sha256)
    if args.lease_path or args.lock_publication:
        try:
            result = publication_lease(policy, args.lease_path or args.lock_publication, bool(args.lock_publication))
        except BlockingIOError:
            return 75
        print(json.dumps(result))
        return 0
    request_path = Path(args.request).resolve(strict=True)
    request = read_json(request_path)
    # The existing command runner also sends the assignment on stdin. Drain it
    # before launching so a large assignment cannot deadlock its parent writer.
    if request.get("role") != "validate":
        require(len(sys.stdin.buffer.read(4 * 1024 * 1024 + 1)) <= 4 * 1024 * 1024,
                "boundary", "controller assignment input is too large")
    return execute(policy, request, request_path=request_path)


if __name__ == "__main__":
    raise SystemExit(main())
