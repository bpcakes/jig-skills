"""Fixed trusted adapter for the installed review-fix controller.

The host pins inputs and runtime bytes before reserving an attempt. Recovery
resumes the same controller journal; it never substitutes an arbitrary host
command or creates a second review run for an uncertain operation.
"""
from __future__ import annotations

import hashlib
import copy
import os
from pathlib import Path
import shutil
import signal
import subprocess
import uuid

import channel
import isolation
from profiles import validate
from state import Engine, StateError, canonical, execution_guard, locked, read_json, require, timestamp, write_atomic


def validate_adapter(adapter):
    value = adapter.get("controller")
    require(adapter.get("kind") in {"review", "validate"} and isinstance(value, dict)
            and set(value) == {"task_id", "node", "skill_root", "options", "config", "contract", "profiles"},
            "controller", "controller adapter requires pinned task, runtime, options, config, contract and profiles")
    require(not any(key in adapter for key in ("argv", "inspect_argv", "profile")),
            "controller", "controller adapters cannot supply arbitrary host commands")
    for key in ("node", "skill_root"):
        require(isinstance(value[key], str) and Path(value[key]).is_absolute(),
                "controller", "controller runtime paths must be absolute")
    require(isinstance(value["task_id"], str) and value["task_id"]
            and isinstance(value["options"], list) and all(isinstance(arg, str) and "\0" not in arg for arg in value["options"]),
            "controller", "controller task and option arguments must be explicit")
    config = value["config"]
    require(isinstance(config, dict) and not any(key in config for key in ("executionBoundary", "orchestrationBinding")),
            "controller", "runtime owns controller boundary and operation binding")
    require(isinstance(value["contract"], dict) and isinstance(value["profiles"], dict),
            "controller", "controller contract and profiles must be objects")
    reviewers = config.get("reviewers")
    require(isinstance(reviewers, list) and reviewers
            and all(isinstance(item, dict) and isinstance(item.get("id"), str) and item.get("command") for item in reviewers)
            and config.get("triageCommand") and config.get("repairCommand"),
            "controller", "enforced controller requires command-backed reviewers, triage and repair")
    for key in {"triage", "repair", "validate", *(item["id"] for item in reviewers)}:
        profile = validate(value["profiles"].get(key))
        require(not profile.get("argv"), "controller", "controller profiles preserve the selected command")
    environment = {**value["profiles"]["validate"].get("environment", {}), "CI": "1", "GIT_OPTIONAL_LOCKS": "0"}
    for check in [*value["contract"].get("requiredValidation", []), *value["contract"].get("prerequisites", [])]:
        require(isinstance(check, dict), "controller", "validation contract entries must be objects")
        required = check.get("requiredEnvironment", [])
        require(isinstance(required, list) and all(isinstance(name, str) and environment.get(name) for name in required),
                "controller", "required validation environment is absent from its pinned profile")
    return value


def file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def copy_runtime(source, destination):
    """Copy both matching skills; assignments also read their frozen references."""
    temporary = destination.with_name(destination.name + "-" + uuid.uuid4().hex)
    digest = hashlib.sha256()
    try:
        for name, root in (("review-fix-loop", source), ("panel-review", source.parent / "panel-review")):
            require(root.is_dir(), "controller", "matching review-fix and panel skill roots are required")
            for file in sorted(root.rglob("*")):
                require(not file.is_symlink(), "controller", "controller runtime must not contain symlinks")
                if not file.is_file() or "__pycache__" in file.parts:
                    continue
                relative = Path(name) / file.relative_to(root)
                contents = file.read_bytes()
                digest.update(str(relative).encode() + b"\0" + contents)
                target = temporary / relative
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                target.write_bytes(contents)
                target.chmod(0o400)
        require((temporary / "review-fix-loop/scripts/orchestration-adapter.mjs").is_file(),
                "controller", "selected controller does not support orchestration execution")
        temporary.rename(destination)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return digest.hexdigest()


def adopt(run_dir, manifest_path, session, guard, *, upstream_receipt=None):
    """Transfer only a fenced controller's authority, preserving its journal."""
    from jobs import lease, settle_old
    require(guard is not None and guard.active and guard.directory == manifest_path.parent,
            "controller", "controller adoption requires its exclusive execution guard")
    original = read_json(manifest_path)
    candidate_path = manifest_path.parent / "controller-adopting.json"
    candidate = read_json(candidate_path) if candidate_path.exists() else original
    task_id = original["binding"]["task_id"]
    with lease(run_dir, original["workspace"], False):
        with locked(run_dir) as path:
            state = read_json(path / "state.json")
            principal = channel.check(state, session, operation="execute", task_id=task_id)
            task = state["tasks"][task_id]
            Engine._delegated(state, task, principal["actor"], "review")
            owner = state["communication"]["sessions"][original["binding"]["owner_session"]]
            require(principal["actor"] in {"coordinator", owner["actor"]},
                    "authority", "only the original executor or coordinator can adopt a controller")
            try:
                channel.authorizing_session(state, original["binding"]["owner_session"], task_id)
            except StateError as error:
                require(error.code == "session_revoked", "controller", "previous controller authority is uncertain")
            else:
                require(False, "controller", "the original controller owner is still authorized")
            current = channel.task_binding(task)
            previous = original["binding"]["task_binding"]
            require(all(current[key] == previous[key] for key in previous if key != "identity"),
                    "controller", "controller adoption cannot relocate or reassign its original task")
            identities = [previous["identity"], candidate["binding"]["task_binding"]["identity"]]
            require(current["identity"] in identities
                    or task.get("last_session_recovery", {}).get("previous_identity") in identities,
                    "controller", "task identity change requires recorded host session recovery")
            settle_old(state, original["workspace"], False)
            write_atomic(path / "state.json", state)
    if candidate["binding"]["owner_session"] != session.id or candidate["binding"]["task_binding"] != current:
        history = candidate.get("adoption", {}).get("previous", [])
        history = [*history, {"binding": candidate["binding"], "boundary": candidate["config"]["executionBoundary"]}]
        candidate = copy.deepcopy(original)
        candidate["adoption"] = {"previous": history}
        candidate["binding"] = {**original["binding"], "owner_session": session.id, "task_binding": current}
        boundary = list(original["config"]["executionBoundary"])
        policy_index = boundary.index("--policy") + 1
        digest_index = boundary.index("--policy-sha256") + 1
        policy = read_json(Path(boundary[policy_index]))
        policy.update(owner_session=session.id, task_binding=current)
        digest = hashlib.sha256(canonical(policy).encode()).hexdigest()
        policy_path = manifest_path.parent / ("controller-policy-" + digest + ".json")
        write_atomic(policy_path, policy)
        boundary[policy_index], boundary[digest_index] = str(policy_path), file_hash(policy_path)
        candidate["config"] = {**original["config"], "executionBoundary": boundary,
                               "orchestrationBinding": candidate["binding"]}
    if upstream_receipt is None:
        candidate.get("adoption", {}).pop("upstream_receipt", None)
    else:
        candidate["adoption"]["upstream_receipt"] = copy.deepcopy(upstream_receipt)
    write_atomic(candidate_path, candidate)
    result, receipt = run(candidate_path, "adopt", guard.fd, 60)
    require(result and result.get("adopted"), "controller", "controller adoption has not settled; inspect " + receipt["stderr_ref"])
    # If interrupted after the controller saves, the same candidate is retried;
    # Node accepts its already-applied binding without adding another event.
    write_atomic(manifest_path, candidate)
    return manifest_path


def prepare(run_dir, directory, adapter, task_id, session, *, recovering=False, guard=None, upstream_receipt=None):
    value = validate_adapter(adapter)
    state = Engine.read(run_dir)
    require(state["config"].get("communication", {}).get("mode") == "enforced",
            "controller", "trusted controller adapter requires enforced communication")
    channel.check(state, session, operation="execute", task_id=task_id)
    require(value["task_id"] == task_id, "controller", "controller belongs to another task")
    task = state["tasks"][task_id]
    workspace = Path(task["worktree"]).resolve(strict=True)
    import capabilities
    from profiles import exposure
    capabilities.check(run_dir, state, task["host"])
    capabilities.checkout(state, task["host"], task["worktree"], run_dir, excluding=task_id)
    for profile in value["profiles"].values():
        exposure(profile, run_dir, state)
    require((workspace / ".git").is_dir() and not (workspace / ".git").is_symlink(),
            "controller", "controller requires the admitted checkout's private Git directory")
    manifest_path = directory / "controller-manifest.json"
    if manifest_path.exists():
        manifest = read_json(manifest_path)
        require(manifest["binding"]["adapter_sha256"] == hashlib.sha256(canonical(adapter).encode()).hexdigest(),
                "controller", "controller operation inputs changed")
        from review_boundary import policy_state
        boundary = manifest["config"]["executionBoundary"]
        try:
            policy_state(read_json(Path(boundary[boundary.index("--policy") + 1])))
        except StateError as error:
            if error.code != "session_revoked":
                raise
            return adopt(run_dir, manifest_path, session, guard, upstream_receipt=upstream_receipt)
        return manifest_path
    require(not recovering, "uncertain", "issued controller manifest is missing; preserve the operation for recovery")
    node, skill = Path(value["node"]).resolve(strict=True), Path(value["skill_root"]).resolve(strict=True)
    require(node.is_file() and os.access(node, os.X_OK)
            and workspace not in node.parents and workspace not in skill.parents and skill != workspace,
            "controller", "trusted controller runtime must be executable and outside task source")
    runtime = directory / "controller-runtime"
    if runtime.exists():
        # No manifest or issued action exists yet; this is an interrupted copy.
        shutil.rmtree(runtime)
    from runtime_storage import allocation, footprint, settings
    limits = settings(state["config"])
    extra_bytes, extra_files = footprint([skill, skill.parent / "panel-review", Path(isolation.__file__).parent],
                                         max_bytes=limits["max_bytes"], max_files=limits["max_files"])
    with allocation(run_dir, additional_bytes=extra_bytes + 65536, additional_files=extra_files + 16):
        runtime_hash = copy_runtime(skill, runtime)
        python_runtime = isolation.snapshot(run_dir)
    policy = {"schema": 2, "run_dir": str(Path(run_dir).resolve()), "task_id": task_id,
              "owner_session": session.id, "task_binding": channel.task_binding(task), "profiles": value["profiles"]}
    policy_path = directory / "controller-policy.json"
    write_atomic(policy_path, policy)
    boundary = ["/usr/bin/python3", "-B", str(python_runtime / "review_boundary.py"),
                "--policy", str(policy_path), "--policy-sha256", file_hash(policy_path)]
    identifier = str(uuid.UUID(hex=hashlib.sha256(str(directory).encode()).hexdigest()[:32]))
    binding = {"operation_directory": str(directory), "task_id": task_id, "owner_session": session.id,
               "task_binding": channel.task_binding(task), "runtime_sha256": runtime_hash,
               "adapter_sha256": hashlib.sha256(canonical(adapter).encode()).hexdigest()}
    manifest = {"schema": 1, "id": identifier, "workspace": str(workspace), "node": str(node),
                "directory": str(workspace / ".git/jig/review-fix" / identifier),
                "entry": str(runtime / "review-fix-loop/scripts/orchestration-adapter.mjs"),
                "progress": str(directory / "controller-progress.json"), "binding": binding,
                "options": value["options"], "contract": value["contract"],
                "config": {**value["config"], "executionBoundary": boundary, "orchestrationBinding": binding}}
    write_atomic(manifest_path, manifest)
    return manifest_path


def run(manifest_path, mode, lock_fd, timeout, *, input_data=None, additional_fds=(), source_lease=False):
    manifest = read_json(manifest_path)
    prefix = manifest_path.parent / ("controller-" + mode + "-" + uuid.uuid4().hex)
    out_path, err_path = prefix.with_suffix(".stdout"), prefix.with_suffix(".stderr")
    from bounded_output import bounded_logs
    timed_out = False
    with bounded_logs(out_path, err_path) as logs:
        out, err = logs.streams
        process = subprocess.Popen([manifest["node"], manifest["entry"], str(manifest_path), file_hash(manifest_path), mode,
                                    *([str(lock_fd)] if source_lease else [])],
                                   stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL,
                                   stdout=out, stderr=err, pass_fds=(lock_fd, *additional_fds), start_new_session=True)
        write_atomic(manifest_path.parent / "controller-process.json",
                     {"pid": process.pid, "mode": mode, "manifest_sha256": file_hash(manifest_path),
                      "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
                      "start_ticks": Path(f"/proc/{process.pid}/stat").read_text().rsplit(")", 1)[1].split()[19]})
        try:
            process.communicate(input_data, timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            timed_out = True
    receipt = {"ref": str(out_path), "stderr_ref": str(err_path), "observed_at": timestamp(),
               "controller_id": manifest["id"], "controller_directory": manifest["directory"],
               "runtime_sha256": manifest["binding"]["runtime_sha256"], "output": logs.records}
    if timed_out:
        receipt["timed_out"] = True
    if timed_out or process.returncode or not logs.complete:
        return None, receipt
    require(out_path.stat().st_size <= 1024 * 1024, "controller", "controller response exceeds one MiB")
    return read_json(out_path), receipt


def preflight(manifest_path, lock_fd):
    result, receipt = run(manifest_path, "preflight", lock_fd, 60)
    require(result and result.get("preflight") is True, "controller",
            "controller preflight failed; inspect " + receipt["stderr_ref"])


def invoke(run_dir, manifest_path, lock_fd, timeout, *, upstream_receipt=None, additional_fds=()):
    result, receipt = run(manifest_path, "reconcile-upstream" if upstream_receipt is not None else "run", lock_fd, timeout,
                          input_data=canonical(upstream_receipt).encode() if upstream_receipt is not None else None,
                          additional_fds=additional_fds)
    if result is None:
        return {"status": "unknown", "receipt": receipt}
    from jobs import cancel_requested
    cancel_requested(run_dir)
    manifest = read_json(manifest_path)
    state = Engine.read(run_dir)
    settled = not any(job["workspace"] == manifest["workspace"] and not job.get("local_settled")
                      for job in state.get("communication", {}).get("jobs", {}).values())
    terminal = result["phase"] in {"CONVERGED", "THRESHOLD_MET", "ROUND_LIMIT", "RECOVERY_REQUIRED", "BLOCKED",
                                   "VALIDATION_FAILED", "REVIEW_INCOMPLETE", "SCOPE_CHANGED"}
    settled = settled and terminal and not any(result.get(key) for key in ("waiting", "cleanupBlocked", "applicationRecovery"))
    status = ("succeeded" if result["phase"] == "CONVERGED" else "failed") if settled else "unknown"
    return {"status": status, "receipt": {**receipt, "all_jobs_settled": settled, "controller": result}}


def completed_controller(run_dir, operation_id, task_id, actor, *, successful=False):
    """Resolve an original controller only through its immutable action records."""
    original = Engine.action(run_dir, operation_id)
    complete = Engine.action(run_dir, operation_id + "/complete", runner=True)
    require(original is not None and complete is not None, "controller", "a completed controller operation is required")
    request, outcome = original["request"], complete["request"]
    require(request["op"] == "prepare" and request.get("kind") == "review" and request.get("task_id") == task_id
            and outcome["op"] == "finish" and outcome.get("task_id") == task_id
            and outcome.get("operation_id") == operation_id and outcome.get("status") != "unknown"
            and complete["caller"] in {original["caller"], "coordinator"},
            "controller", "operation does not identify a settled original review controller")
    require(actor in {original["caller"], "coordinator"}, "forbidden", "only the original executor or coordinator may recover a controller")
    require(not successful or outcome["status"] == "succeeded", "controller", "upstream reconciliation requires a successful review")
    adapter = original.get("result", {}).get("intent", {}).get("execution", {}).get("adapter_binding")
    require(isinstance(adapter, dict) and "controller" in adapter, "controller", "operation did not use the fixed controller")
    return adapter


def prepare_upstream(run_dir, request, adapter, task_id, session, guard, resources, *, recovering=False):
    value = request.get("reconcile_upstream")
    require(isinstance(value, dict) and set(value) == {"operation_id", "receipt"}
            and isinstance(value["operation_id"], str) and value["operation_id"]
            and value["operation_id"] != guard.operation_id and isinstance(value["receipt"], dict)
            and len(canonical(value).encode()) <= 16384,
            "controller", "reconcile_upstream requires the original review operation and a bounded receipt")
    state = Engine.read(run_dir)
    principal = channel.check(state, session, operation="execute", task_id=task_id)
    Engine._delegated(state, state["tasks"][task_id], principal["actor"], "review")
    original = completed_controller(run_dir, value["operation_id"], task_id, principal["actor"], successful=True)
    require(adapter["kind"] == "validate" and adapter.get("controller") == original["controller"]
            and adapter["host"] == original["host"],
            "controller", "reconciliation needs a validation adapter with the original controller configuration")
    previous = resources.enter_context(execution_guard(run_dir, value["operation_id"]))
    require(previous is not None, "controller_busy", "the original controller is still executing")
    manifest = prepare(run_dir, previous.directory, original, task_id, session, recovering=True, guard=previous,
                       upstream_receipt=value["receipt"])
    if not recovering:
        result, receipt = run(manifest, "upstream-preflight", guard.fd, 60,
                              input_data=canonical(value["receipt"]).encode(), additional_fds=(previous.fd,))
        require(result and result.get("preflight") is True, "controller",
                "upstream reconciliation preflight failed; inspect " + receipt["stderr_ref"])
    return manifest, value["receipt"], (previous.fd,)


def release_controller(run_dir, session, request):
    require(set(request) == {"op", "task_id", "operation_id", "action_id"}
            and all(isinstance(value, str) and value for value in request.values())
            and len(request["action_id"].encode()) <= 256,
            "controller", "review_release requires task, original operation and action ID")
    task_id = request["task_id"]
    principal = channel.check(Engine.read(run_dir), session, operation="review_release", task_id=task_id)
    adapter = completed_controller(run_dir, request["operation_id"], task_id, principal["actor"])
    with execution_guard(run_dir, request["operation_id"]) as guard:
        if guard is None:
            return {"status": "busy", "operation_id": request["operation_id"]}
        state = Engine.read(run_dir)
        principal = channel.check(state, session, operation="review_release", task_id=task_id)
        task = state["tasks"][task_id]
        Engine._delegated(state, task, principal["actor"], "review")
        record_path = guard.directory / ("controller-release-" + hashlib.sha256(request["action_id"].encode()).hexdigest() + ".json")
        record = read_json(record_path) if record_path.exists() else None
        if record is not None:
            require(record["request"] == request and record["actor"] == principal["actor"],
                    "duplicate", "release action was already used with different input or caller")
            if record.get("result"):
                return record["result"]
        require(not task["pending_intent"] and not task["reservations"], "unsettled", "settle task operations before releasing its controller")
        if record is None:
            from runtime_storage import check as check_capacity
            check_capacity(run_dir, state, additional_bytes=2 * 1024 * 1024 + 16384, additional_files=5,
                           control=principal["role"] == "coordinator")
        manifest = prepare(run_dir, guard.directory, adapter, task_id, session, recovering=True, guard=guard)
        if record is None:
            write_atomic(record_path, {"request": request, "actor": principal["actor"], "result": None})
        result, receipt = run(manifest, "release", guard.fd, 30)
        require(result and result.get("phase") == "RELEASED", "controller", "controller release failed; inspect " + receipt["stderr_ref"])
        write_atomic(record_path, {"request": request, "actor": principal["actor"], "result": result})
        return result


def answer(run_dir, session, request):
    require(set(request) == {"op", "task_id", "operation_id", "action_id", "question_id", "answer"}
            and all(isinstance(request[key], str) and request[key] for key in request),
            "controller", "review_answer requires task, operation, action, question and answer")
    require(len(request["answer"].encode()) <= 4096 and len(request["action_id"]) <= 200,
            "size", "controller answers are limited to 4096 bytes")
    task_id = request["task_id"]
    with execution_guard(run_dir, request["operation_id"]) as guard:
        if guard is None:
            return {"status": "busy", "operation_id": request["operation_id"]}
        state = Engine.read(run_dir)
        principal = channel.check(state, session, operation="review_answer", task_id=task_id)
        task = state["tasks"][task_id]
        Engine._delegated(state, task, principal["actor"], "review")
        record_path = guard.directory / ("controller-answer-" + hashlib.sha256(request["action_id"].encode()).hexdigest() + ".json")
        record = read_json(record_path) if record_path.exists() else None
        if record is not None:
            require(record["request"] == request and record["actor"] == principal["actor"],
                    "duplicate", "answer action was already used with different input or caller")
            # The controller may have advanced before a lost reply is retried.
            # Retrieving its receipt is not another answer or a new invocation.
            if record.get("result"):
                return record["result"]
        pending = task["pending_intent"]
        require(pending and pending["id"] == request["operation_id"] and pending.get("execution")
                and "controller" in pending["execution"]["adapter_binding"],
                "controller", "answer must name the pending controller operation")
        require(principal["actor"] in {"coordinator", pending["executor"]}, "forbidden", "only the executor or coordinator may answer")
        manifest = prepare(run_dir, guard.directory, pending["execution"]["adapter_binding"], task_id, session,
                           recovering=True, guard=guard)
        if record is None:
            write_atomic(record_path, {"request": request, "actor": principal["actor"], "result": None})
        result, receipt = run(manifest, "answer", guard.fd, 30, input_data=canonical(request).encode())
        require(result and result.get("accepted"), "controller", "controller answer failed; inspect " + receipt["stderr_ref"])
        write_atomic(record_path, {"request": request, "actor": principal["actor"], "result": result})
        return result
