"""Current-source authorization for new enforced closure, outside the state lock."""
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
import hashlib
from pathlib import Path

from state import Engine, canonical, read_json, require


def requires_source(state, task, request):
    from capabilities import enforced
    if not enforced(state) or task is None:
        return False
    if request["op"] == "close":
        return not Engine._reconciled_close(state, task, request)
    if request["op"] == "dispatch":
        return (task.get("pending_intent") or {}).get("kind") == "close"
    return request["op"] in {"intent", "prepare"} and request.get("kind") == "close"


@dataclass(frozen=True)
class ClosureSource:
    task_id: str
    binding: dict
    certification: str
    checked: object
    head: str

    def validate(self, run_dir, state):
        from channel import task_binding
        task = state["tasks"][self.task_id]
        require(task_binding(task) == self.binding
                and canonical(task.get("certified_review")) == self.certification,
                "review_evidence", "closure ownership or certification changed during source inspection")
        self.checked.validate(run_dir, state, task["host"], task["worktree"], excluding=task["id"])
        Engine._review_gate(state, task, self.head)


@contextmanager
def closure_check(run_dir, request, caller, session, workspace_lease=None):
    op = request["op"]
    if (op not in {"close", "intent", "prepare", "dispatch"}
            or op in {"intent", "prepare"} and request.get("kind") != "close"):
        yield None
        return
    state = Engine.read(run_dir)
    task = state["tasks"].get(request.get("task_id"))
    from capabilities import prepare_check
    if (not requires_source(state, task, request)
            or Engine.action(run_dir, request["action_id"], runner=op == "dispatch") is not None):
        yield None
        return
    if session is not None:
        from channel import check
        principal = check(state, session, operation=op, task_id=task["id"])
        require(principal["actor"] == caller, "forbidden", "session caller mismatch")
    Engine._authorize(state, request, caller, task)
    Engine._review_gate(state, task)
    Engine._findings_gate(state, task)
    from channel import task_binding
    from jobs import WorkspaceLease, lease
    from review_controller import run
    proof = task["certified_review"]
    controller_operation = proof.get("controller_operation_id", proof["operation_id"])
    directory = Path(run_dir) / ("execution-" + hashlib.sha256(controller_operation.encode()).hexdigest())
    manifest_path = directory / "controller-manifest.json"
    manifest = read_json(manifest_path)
    require(manifest["id"] == proof["controller_id"] and manifest["workspace"] == task["worktree"]
            and manifest["binding"]["runtime_sha256"] == proof["runtime_sha256"],
            "review_evidence", "certification requires its original pinned controller runtime")
    require(workspace_lease is None or isinstance(workspace_lease, WorkspaceLease)
            and workspace_lease.active and workspace_lease.run_dir == Path(run_dir).resolve()
            and workspace_lease.workspace == task["worktree"],
            "unsettled", "closure requires the actual task checkout lease")
    with (nullcontext(workspace_lease) if workspace_lease is not None
          else lease(run_dir, task["worktree"], True)) as held:
        checked = prepare_check(run_dir, state, task["host"], task["worktree"], lease=held, excluding=task["id"])
        current, receipt = run(manifest_path, "source", held.fd, 60, source_lease=True)
        require(current and current.get("clean") is True and current.get("head") == proof["candidate"]["head"],
                "review_evidence", "current checkout differs from its certified review; inspect " + receipt["stderr_ref"])
        yield ClosureSource(task["id"], task_binding(task), canonical(proof), checked, current["head"])
