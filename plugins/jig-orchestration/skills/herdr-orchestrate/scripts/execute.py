"""Run one configured task transition, or inspect its original uncertain result.

Adapters run on the coordinator host (and may use an explicitly configured SSH
command). Request data is JSON on stdin, never interpolated into a shell command.
An adapter owns external gate checks, target identity, and process settlement.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import uuid

from state import Engine, StateError, evidence, execution_guard, nonempty, require, timestamp


def transition(run_dir, caller, task_id, op, action_id, *, execution=None, **fields):
    """Retry only state-version conflicts, before any external command."""
    for _ in range(5):
        state = Engine.read(run_dir)
        task = state["tasks"][task_id]
        try:
            return Engine.apply(run_dir, {"op": op, "action_id": action_id, "task_id": task_id,
                                         "expected_policy": state["policy_version"],
                                         "expected_task": task["version"], **fields}, caller, execution=execution)
        except StateError as exc:
            if exc.code not in {"stale_policy", "stale_task"}:
                raise
    raise StateError("contention", "task kept changing; resume the same operation")


def invoke(directory, adapter, mode, payload, lock_fd):
    attempt = uuid.uuid4().hex
    stdout = directory / (attempt + ".stdout")
    stderr = directory / (attempt + ".stderr")
    receipt = {"ref": str(stdout), "stderr_ref": str(stderr), "observed_at": timestamp()}
    command = adapter["argv" if mode == "dispatch" else "inspect_argv"]
    # File-backed output survives parent loss and keeps command output out of
    # model context. The protocol itself is bounded to one MiB.
    with stdout.open("xb") as out, stderr.open("xb") as err:
        os.chmod(stdout, 0o600)
        os.chmod(stderr, 0o600)
        try:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=out, stderr=err,
                                       start_new_session=True, pass_fds=(lock_fd,))
        except OSError as exc:
            err.write(str(exc).encode())
            return {"status": "not_started" if mode == "dispatch" else "unknown",
                    "receipt": {**receipt, "all_jobs_settled": mode == "dispatch", "no_effects": mode == "dispatch"}}
        try:
            process.communicate(json.dumps({**payload, "mode": mode}).encode(),
                                timeout=adapter.get("timeout_seconds", 60))
        except subprocess.TimeoutExpired:
            # Local termination is not proof that an external effect or remote
            # descendant stopped. Keep ownership until inspection proves it.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
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
        return {"status": result["status"], "receipt": {**result["receipt"], "adapter_log": str(stdout)}}
    except (ValueError, TypeError, AttributeError, RecursionError):
        # Malformed output can follow a real effect. Preserve it and inspect on
        # continuation, rather than treating a parser failure as non-execution.
        return {"status": "unknown", "receipt": receipt}


def execute(run_dir, request, caller="coordinator"):
    require("caller" not in request and nonempty(request.get("action_id"))
            and nonempty(request.get("task_id")), "invalid", "execution requires action_id and task_id")
    operation_id, task_id = request["action_id"], request["task_id"]
    state = Engine.read(run_dir)
    task = state["tasks"].get(task_id)
    require(task is not None, "scope", "execution requires an admitted task")
    Engine._authorize(state, {"op": "prepare"}, caller, task)
    with execution_guard(run_dir, operation_id) as guard:
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
        else:
            Engine.apply(run_dir, {**request, "op": "prepare"}, caller)
        if completed:
            return completed["result"]
        task = Engine.read(run_dir)["tasks"][task_id]
        pending = task["pending_intent"]
        require(pending and pending["id"] == operation_id and pending.get("execution"),
                "uncertain", "operation was reconciled outside the runner; inspect its durable actions")
        execution = pending["execution"]
        mode = "inspect" if execution["dispatched_at"] else "dispatch"
        require(mode == "inspect" or pending["executor"] == caller, "authority",
                "coordinator recovery may inspect issued work; it cannot dispatch another executor's prepared action")
        if mode == "dispatch":
            # This durable transition is the issuance boundary. A crash after
            # it, even before Popen, always resumes with inspection.
            transition(run_dir, caller, task_id, "dispatch", operation_id + "/dispatch", execution=guard, operation_id=operation_id)
        payload = {"operation_id": operation_id, "task_id": task_id, "kind": pending["kind"],
                   "target": pending["target"], "evidence": pending["evidence"],
                   "gates": execution["request"].get("gates", {}),
                   "task": execution["binding"], "refs": execution["request"].get("refs", {})}
        # The adapter inherits the lock: parent loss cannot permit inspection
        # while that original local process is still capable of an effect.
        result = invoke(directory, execution["adapter_binding"], mode, payload, fd)
        completion_id = operation_id + ("/observe-" + uuid.uuid4().hex if result["status"] == "unknown" else "/complete")
        try:
            return transition(run_dir, caller, task_id, "finish", completion_id,
                              execution=guard, operation_id=operation_id, **result)
        except StateError as exc:
            if result["status"] == "unknown" or exc.code not in {"evidence", "closure", "identity", "invalid", "uncertain"}:
                raise
            # A normalized result can still fail an action-specific receipt
            # check. Preserve that observation without declaring settlement.
            receipt = {"ref": result["receipt"].get("adapter_log", result["receipt"]["ref"]),
                       "observed_at": timestamp(), "rejected_result": result,
                       "rejection": {"code": exc.code, "message": str(exc)}}
            return transition(run_dir, caller, task_id, "finish", operation_id + "/observe-" + uuid.uuid4().hex,
                              execution=guard, operation_id=operation_id, status="unknown", receipt=receipt)


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
            return completed["result"]
        task = Engine.read(run_dir)["tasks"][task_id]
        pending = task["pending_intent"]
        require(pending and pending["id"] == operation_id and pending.get("execution", {}).get("dispatched_at"),
                "uncertain", "reconciliation requires an issued pending runner operation")
        return transition(run_dir, caller, task_id, "finish", operation_id + "/complete", execution=guard,
                          operation_id=operation_id, status=request["status"], receipt=request["receipt"])
