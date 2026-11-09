"""Run one configured task transition, or inspect its original uncertain result.

Adapters run on the coordinator host (and may use an explicitly configured SSH
command). Request data is JSON on stdin, never interpolated into a shell command.
An adapter owns external gate checks, target identity, and process settlement.
"""
from __future__ import annotations

from contextlib import ExitStack
import copy
import json
import os
from pathlib import Path
import signal
import subprocess
import uuid

from state import Engine, StateError, evidence, execution_guard, nonempty, require, timestamp


def transition(run_dir, caller, task_id, op, action_id, *, execution=None, session=None, workspace_lease=None, **fields):
    """Retry only state-version conflicts, before any external command."""
    for _ in range(5):
        state = Engine.read(run_dir)
        task = state["tasks"][task_id]
        try:
            return Engine.apply(run_dir, {"op": op, "action_id": action_id, "task_id": task_id,
                                         "expected_policy": state["policy_version"],
                                         "expected_task": task["version"], **fields}, caller, execution=execution, session=session,
                                workspace_lease=workspace_lease)
        except StateError as exc:
            if exc.code not in {"stale_policy", "stale_task"}:
                raise
    raise StateError("contention", "task kept changing; resume the same operation")


def invoke(directory, adapter, mode, payload, lock_fd, *, execution=None, launch_dir=None, workspace_lease=None, source_lease=None):
    attempt = uuid.uuid4().hex
    stdout = directory / (attempt + ".stdout")
    stderr = directory / (attempt + ".stderr")
    receipt = {"ref": str(stdout), "stderr_ref": str(stderr), "observed_at": timestamp()}
    command = adapter["argv" if mode == "dispatch" else "inspect_argv"]
    # Enforced commands receive pipes to bounded private logs. Legacy adapters
    # retain their existing file descriptor interface.
    logs, process = None, None
    with ExitStack() as resources:
        if launch_dir is not None:
            from bounded_output import bounded_logs
            logs = resources.enter_context(bounded_logs(stdout, stderr))
            out, err = logs.streams
            receipt["output"] = logs.records
        else:
            out = resources.enter_context(stdout.open("xb"))
            err = resources.enter_context(stderr.open("xb"))
            os.chmod(stdout, 0o600)
            os.chmod(stderr, 0o600)
        try:
            if launch_dir is not None:
                from isolation import launch
                process = launch(launch_dir, command, input=json.dumps({**payload, "mode": mode}).encode(),
                                 stdout=out, stderr=err, execution=execution,
                                 inspection=mode == "inspect",
                                 workspace_lease=workspace_lease, source_lease=source_lease,
                                 timeout=adapter.get("timeout_seconds", 60))
            else:
                process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=out, stderr=err,
                                           start_new_session=True, pass_fds=(lock_fd,))
                process.communicate(json.dumps({**payload, "mode": mode}).encode(),
                                    timeout=adapter.get("timeout_seconds", 60))
        except subprocess.TimeoutExpired:
            if launch_dir is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            return {"status": "unknown", "receipt": receipt}
        except OSError as exc:
            receipt["error"] = str(exc)[:1024]
            not_started = process is None
            if launch_dir is not None:
                # An I/O error may follow the command's real effect, including
                # during settlement. Only the trusted job can prove non-start.
                try:
                    job = Engine.read(directory.parent).get("communication", {}).get("jobs", {}).get(launch_dir.name, {})
                    not_started = job.get("outcome") == "not_started" and job.get("local_settled") is True
                except (OSError, StateError):
                    not_started = False
            if mode == "dispatch" and not_started:
                return {"status": "not_started", "receipt": {**receipt, "all_jobs_settled": True, "no_effects": True}}
            return {"status": "unknown", "receipt": receipt}
    if logs is not None and not logs.complete:
        return {"status": "unknown", "receipt": receipt}
    if process.returncode != 0:
        return {"status": "unknown", "receipt": receipt}
    try:
        with stdout.open(encoding="utf-8") as stream:
            raw = stream.read(1024 * 1024 + 1)
        require(len(raw) <= 1024 * 1024, "adapter", "adapter result exceeds one MiB")
        result = json.loads(raw)
        require(isinstance(result, dict) and result.get("status") in {"succeeded", "failed", "not_started", "unknown"},
                "adapter", "adapter must return a normalized outcome")
        evidence(result.get("receipt"), settled=result["status"] != "unknown")
        if result["status"] == "not_started":
            require(result["receipt"].get("no_effects") is True, "adapter", "not-started requires no-effects evidence")
        return {"status": result["status"], "receipt": {**result["receipt"], "adapter_log": str(stdout),
                **({"output": logs.records} if logs is not None else {})}}
    except (ValueError, TypeError, AttributeError, RecursionError):
        # Malformed output can follow a real effect. Preserve it and inspect on
        # continuation, rather than treating a parser failure as non-execution.
        return {"status": "unknown", "receipt": receipt}


def execute(run_dir, request, caller="coordinator", *, session=None):
    require("caller" not in request and nonempty(request.get("action_id"))
            and nonempty(request.get("task_id")), "invalid", "execution requires action_id and task_id")
    operation_id, task_id = request["action_id"], request["task_id"]
    state = Engine.read(run_dir)
    require(session is not None or state["config"].get("communication", {}).get("mode") != "enforced",
            "unauthenticated", "enforced execution requires an authenticated session")
    if session is not None:
        from channel import check
        principal = check(state, session, operation="execute", task_id=task_id)
        require(principal["actor"] == caller, "forbidden", "session caller mismatch")
    task = state["tasks"].get(task_id)
    require(task is not None, "scope", "execution requires an admitted task")
    Engine._authorize(state, {"op": "prepare"}, caller, task)
    if Engine.action(run_dir, operation_id) is None:
        Engine._prepare_adapter(state, request, task)
        Engine._reservation_gate(state, {**request, "unit": Engine.UNITS.get(request.get("kind"))}, caller, task)
        from runtime_storage import check as check_capacity
        check_capacity(run_dir, state, additional_bytes=2 * 1024 * 1024 + 16384, additional_files=4)
    with execution_guard(run_dir, operation_id) as guard, ExitStack() as resources:
        if guard is None:
            return {"operation_id": operation_id, "status": "busy"}
        directory, fd = guard.directory, guard.fd
        record = Engine.action(run_dir, operation_id)
        completed = Engine.action(run_dir, operation_id + "/complete", runner=True)
        if completed is None and record and record["result"].get("intent", {}).get("execution", {}).get("record_namespace") != "execution-actions":
            # Old completed receipts remain usable, but an unrelated legacy ID
            # collision cannot prevent inspection of the actual pending work.
            legacy = Engine.action(run_dir, operation_id + "/complete")
            original = (legacy or {}).get("request", {})
            if (legacy and legacy["caller"] in {record["caller"], "coordinator"}
                    and original.get("op") == "finish" and original.get("task_id") == task_id
                    and original.get("operation_id") == operation_id and original.get("status") != "unknown"):
                completed = legacy
        if completed:
            original = completed["request"]
            require(record is not None and completed["caller"] in {record["caller"], "coordinator"} and original["op"] == "finish"
                    and original.get("task_id") == task_id and original.get("operation_id") == operation_id
                    and original.get("status") != "unknown", "identity", "completion action belongs to a different operation")
        if record:
            require((record["caller"] == caller or caller == "coordinator") and record["request"]["op"] == "prepare"
                    and record["request"]["task_id"] == task_id, "identity", "operation belongs to a different request")
            for key, value in request.items():
                if key not in {"op", "expected_policy", "expected_task"}:
                    require(record["request"].get(key) == value, "duplicate", "operation input changed; inspect its original result")
        if completed:
            from integration import after_transition
            after_transition(run_dir, {"op": "finish"}, completed["result"])
            return completed["result"]
        # Recheck after acquiring the operation lock, before provisioning any
        # child credentials or launch tree. The locked transitions still own
        # authorization; this read-only preflight prevents repeated refusals
        # from consuming retained runtime capacity.
        state = Engine.read(run_dir)
        task = state["tasks"][task_id]
        Engine._authorize(state, {"op": "prepare"}, caller, task)
        if not record:
            Engine._prepare_adapter(state, request, task)
            Engine._reservation_gate(state, {**request, "unit": Engine.UNITS.get(request.get("kind"))}, caller, task)
        launch_dir, workspace_lease, adapter_hash, controller_manifest = None, None, None, None
        closure_lease = None
        upstream_receipt, controller_fds = None, ()
        if session is not None or state["config"].get("communication", {}).get("mode") == "enforced":
            import channel
            import isolation
            from jobs import lease
            from state import canonical, read_json
            import hashlib
            pending = task["pending_intent"]
            if record:
                require(pending and pending["id"] == operation_id and pending.get("execution"),
                        "uncertain", "operation was reconciled outside the runner; inspect its durable actions")
                selected = pending["execution"]["adapter_binding"]
                inspect = bool(pending["execution"]["dispatched_at"])
                if not inspect:
                    Engine._dispatch_gate(state, {"operation_id": operation_id}, caller, task)
            else:
                selected = state["config"].get("adapters", {}).get(request.get("adapter"))
                require(selected is not None, "adapter", "select a configured adapter")
                inspect = False
            if "controller" in selected:
                import review_controller
                controller_request = record["request"] if record else request
                if "reconcile_upstream" in controller_request:
                    controller_manifest, upstream_receipt, controller_fds = review_controller.prepare_upstream(
                        run_dir, controller_request, selected, task_id, session, guard, resources, recovering=bool(record))
                else:
                    require(selected["kind"] == "review", "controller", "controller validation requires reconcile_upstream")
                    controller_manifest = review_controller.prepare(run_dir, directory, selected, task_id, session,
                                                                     recovering=bool(record), guard=guard)
                    if not record:
                        review_controller.preflight(controller_manifest, fd)
            else:
                require("reconcile_upstream" not in request, "controller", "reconciliation requires the fixed controller")
                profile = copy.deepcopy(selected.get("profile"))
                require(profile is not None, "isolation", "enforced adapters require a launch profile")
                enforced_close = (selected["kind"] == "close"
                                  and state["config"].get("communication", {}).get("mode") == "enforced")
                if (inspect or enforced_close) and profile.get("workspace_access", "write") != "none":
                    profile["workspace_access"] = "read"
                access = profile.get("workspace_access", "write")
                if access != "none":
                    # Match launch preparation's physical source, including
                    # legacy checkout aliases, without changing task bindings.
                    workspace_lease = resources.enter_context(lease(run_dir, str(Path(task["worktree"]).resolve(strict=True)),
                        selected["kind"] == "review" or access == "read"))
                elif enforced_close and not inspect:
                    closure_lease = resources.enter_context(lease(run_dir, task["worktree"], True))
                actor = "adapter-" + uuid.uuid4().hex
                launch_dir = isolation.prepare(run_dir, actor, task_id,
                                               role="reviewer" if selected["kind"] == "review" else "executor",
                                               profile=profile, review_contract=selected.get("review_contract"),
                                               parent_session=session,
                                               expected_binding=channel.task_binding(task))
                resources.callback(channel.revoke, run_dir, actor)
                spec = read_json(launch_dir / "launch.json")
                # Source access is already held before allocating a credential
                # or launch tree. Retain it through dispatch and descendants.
                isolation.command(spec, selected["inspect_argv" if inspect else "argv"],
                                  mounts=spec.get("mounts"), environment=spec.get("environment"))
                if workspace_lease is None:
                    workspace_lease = resources.enter_context(lease(run_dir, spec["workspace"], spec["readonly"]))
                else:
                    require(workspace_lease.workspace == spec["workspace"]
                            and workspace_lease.readonly == spec["readonly"],
                            "session_revoked", "launch source access changed during preparation")
                if enforced_close and not inspect:
                    closure_lease = closure_lease or workspace_lease
            adapter_hash = hashlib.sha256(canonical(selected).encode()).hexdigest()
        if not record:
            from integration import before_stage
            before_stage(run_dir, request, caller)
            preparation = {**request, "op": "prepare"}
            if adapter_hash is not None:
                require(request.get("adapter_hash", adapter_hash) == adapter_hash,
                        "adapter", "selected adapter changed before preparation")
                preparation["adapter_hash"] = adapter_hash
            Engine.apply(run_dir, preparation, caller, session=session, workspace_lease=closure_lease)
        task = Engine.read(run_dir)["tasks"][task_id]
        pending = task["pending_intent"]
        require(pending and pending["id"] == operation_id and pending.get("execution"),
                "uncertain", "operation was reconciled outside the runner; inspect its durable actions")
        execution = pending["execution"]
        mode = "inspect" if execution["dispatched_at"] else "dispatch"
        require(mode == "inspect" or pending["executor"] == caller, "authority",
                "coordinator recovery may inspect issued work; it cannot dispatch another executor's prepared action")
        if mode == "dispatch":
            if record:
                from integration import before_stage
                before_stage(run_dir, execution["request"], caller)
            # This durable transition is the issuance boundary. A crash after
            # it, even before Popen, always resumes with inspection.
            issued = transition(run_dir, caller, task_id, "dispatch", operation_id + "/dispatch", execution=guard,
                                session=session, workspace_lease=closure_lease, operation_id=operation_id)
            pending = issued["dispatch"]
            execution = pending["execution"]
        payload = {"operation_id": operation_id, "task_id": task_id, "kind": pending["kind"],
                   "target": pending["target"], "evidence": pending["evidence"],
                   "gates": execution["request"].get("gates", {}),
                   "task": execution["binding"], "refs": execution["request"].get("refs", {}),
                   "integration": pending.get("integration"), "purpose": pending.get("purpose", "final")}
        # The adapter inherits the lock: parent loss cannot permit inspection
        # while that original local process is still capable of an effect.
        if controller_manifest is not None:
            # The fixed controller resumes its exact journal and owned jobs.
            # Generic uncertain subprocesses still use their read-only inspector.
            result = review_controller.invoke(run_dir, controller_manifest, fd,
                                               execution["adapter_binding"].get("timeout_seconds", 300),
                                               upstream_receipt=upstream_receipt, additional_fds=controller_fds)
        else:
            result = invoke(directory, execution["adapter_binding"], mode, payload, fd, execution=guard,
                            launch_dir=launch_dir, workspace_lease=workspace_lease, source_lease=closure_lease)
        completion_id = operation_id + ("/observe-" + uuid.uuid4().hex if result["status"] == "unknown" else "/complete")
        try:
            finished = transition(run_dir, caller, task_id, "finish", completion_id,
                                  execution=guard, session=session if controller_manifest is not None else None,
                                  operation_id=operation_id, **result)
        except StateError as exc:
            if result["status"] == "unknown" or exc.code in {"stale_policy", "stale_task", "contention", "state_busy"}:
                raise
            # A normalized result can still fail an action-specific receipt
            # check. Preserve that observation without declaring settlement.
            receipt = {"ref": result["receipt"].get("adapter_log", result["receipt"]["ref"]),
                       "observed_at": timestamp(), "rejected_result": result,
                       "rejection": {"code": exc.code, "message": str(exc)}}
            return transition(run_dir, caller, task_id, "finish", operation_id + "/observe-" + uuid.uuid4().hex,
                              execution=guard, operation_id=operation_id, status="unknown", receipt=receipt)
        from integration import after_transition
        after_transition(run_dir, {"op": "finish"}, finished)
        return finished


def reconcile(run_dir, request, caller="coordinator"):
    """Record separately observed settlement when the pinned inspector fails."""
    require(caller == "coordinator", "forbidden", "external reconciliation is coordinator-only")
    require("caller" not in request and nonempty(request.get("action_id"))
            and nonempty(request.get("task_id")), "invalid", "reconciliation requires action_id and task_id")
    require(request.get("status") in {"succeeded", "failed", "not_started"}, "invalid", "reconciliation requires a terminal status")
    evidence(request.get("receipt"), settled=True)
    operation_id, task_id = request["action_id"], request["task_id"]
    with execution_guard(run_dir, operation_id) as guard:
        if guard is None:
            return {"operation_id": operation_id, "status": "busy"}
        record = Engine.action(run_dir, operation_id)
        require(record is not None and record["request"]["op"] == "prepare"
                and record["request"].get("task_id") == task_id, "identity", "reconciliation requires the original prepared operation")
        completed = Engine.action(run_dir, operation_id + "/complete", runner=True)
        if completed:
            original = completed["request"]
            require(original.get("task_id") == task_id and original.get("operation_id") == operation_id
                    and original.get("status") == request["status"] and original.get("receipt") == request["receipt"],
                    "duplicate", "operation already completed with a different receipt")
            from integration import after_transition
            after_transition(run_dir, {"op": "finish"}, completed["result"])
            return completed["result"]
        task = Engine.read(run_dir)["tasks"][task_id]
        pending = task["pending_intent"]
        require(pending and pending["id"] == operation_id and pending.get("execution", {}).get("dispatched_at"),
                "uncertain", "reconciliation requires an issued pending runner operation")
        result = transition(run_dir, caller, task_id, "finish", operation_id + "/complete", execution=guard,
                            operation_id=operation_id, status=request["status"], receipt=request["receipt"])
        from integration import after_transition
        after_transition(run_dir, {"op": "finish"}, result)
        return result
