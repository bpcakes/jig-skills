"""Authenticated, launch-scoped access to the existing orchestration engine.

Only the trusted host issues credentials. A credential is intentionally useless
for choosing a caller, changing launch policy, or escaping an assigned task.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import json
from pathlib import Path
import secrets

from state import Engine, StateError, canonical, locked, private, read_json, require, timestamp, write_atomic


@dataclass(frozen=True)
class Session:
    id: str
    digest: str


# These remain host administration, including changes to executable adapters.
ADMIN_OPERATIONS = {"configure", "scheduler", "recover_session", "handoff"}
REVIEW_OPERATIONS = {"context", "query", "artifact_read", "artifact_put", "inbox", "ack", "watch", "result", "egress"}
EXECUTOR_OPERATIONS = REVIEW_OPERATIONS | {"message", "message_read", "view_read"}


def public(value):
    """Launch policy can contain credentials; expose its identity, not its body."""
    if isinstance(value, list):
        return [public(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {}
    for key, item in value.items():
        if key == "adapter_binding" and isinstance(item, dict):
            result[key] = (dict(item) if set(item) == {"kind", "host", "sha256"}
                           else {"kind": item.get("kind"), "host": item.get("host"),
                                 "sha256": hashlib.sha256(canonical(item).encode()).hexdigest()})
        else:
            result[key] = public(item)
    return result


def task_binding(task):
    return {key: task.get(key) for key in ("driver", "host", "identity", "worktree", "branch")}


def data(state):
    return state.setdefault("communication", {"sessions": {}, "active": {}, "generations": {}})


def contract(run_dir, principal):
    """Resolve trusted immutable evidence; old inline sessions remain readable."""
    digest = principal.get("review_contract_sha256")
    if digest is None:
        return principal.get("review_contract")
    require(isinstance(digest, str) and len(digest) == 64
            and all(char in "0123456789abcdef" for char in digest), "session", "invalid contract digest")
    directory = Path(run_dir) / "review-contracts"
    private(directory, directory=True)
    source = directory / (digest + ".json")
    private(source)
    raw = source.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == digest, "session", "retained review contract changed")
    return json.loads(raw)


def issue(run_dir, actor, *, role=None, task_ids=None, review_contract=None, egress_hosts=None,
          parent_session=None, expected_bindings=None, endpoint=None, transport_from=None):
    """Host-only provisioning. Return the secret once; never include it in views."""
    from egress import destination
    egress_hosts = [] if egress_hosts is None else egress_hosts
    require(isinstance(egress_hosts, list), "egress", "provider destinations must be a list")
    egress_hosts = sorted({destination(host) for host in egress_hosts})
    token = secrets.token_urlsafe(32)
    session_id = secrets.token_hex(16)
    credential = session_id + "." + token
    digest = hashlib.sha256(credential.encode()).hexdigest()
    with locked(run_dir) as path:
        state = read_json(path / "state.json")
        enforced = state["config"].get("communication", {}).get("mode") == "enforced"
        if actor == "coordinator":
            require(role in {None, "coordinator"}, "session", "invalid coordinator role")
            role = "coordinator"
            tasks = list(state["config"]["scope"]["task_ids"])
        elif role in {"reviewer", "executor"}:
            require(actor not in state["config"].get("actors", {}) and actor != "coordinator",
                    "session", "reviewer identity must be distinct from drivers")
            require(isinstance(task_ids, list) and len(task_ids) == 1, "session", "reviewer needs one task")
            tasks = task_ids
        else:
            binding = state["config"].get("actors", {}).get(actor)
            require(binding and role in {None, "driver"} and binding.get("helper_route") is True,
                    "session", "driver needs a verified registered route")
            role = "driver"
            tasks = list(binding["task_ids"])
            if task_ids is not None:
                require(set(task_ids) <= set(tasks) and task_ids, "session", "task scope cannot expand")
                tasks = list(task_ids)
        bindings = {}
        for task_id in tasks:
            task = state["tasks"].get(task_id)
            if role != "coordinator":
                require(task is not None, "session", "admit the task before launching its agent")
                require(role in {"reviewer", "executor"} or task["driver"] == actor, "session", "actor does not drive task")
                bindings[task_id] = task_binding(task)
        if expected_bindings is not None:
            require(all(state["tasks"].get(task_id) is not None
                        and task_binding(state["tasks"][task_id]) == binding
                        for task_id, binding in expected_bindings.items()),
                    "session_revoked", "task binding changed during launch preparation")
        if role in {"reviewer", "executor"}:
            require(parent_session is not None or not enforced,
                    "session", "enforced child sessions require an authorizing session")
            if parent_session is not None:
                require(isinstance(parent_session, Session), "session", "invalid authorizing session")
                for task_id in tasks:
                    parent = check(state, parent_session, operation="execute", task_id=task_id)
                    require(parent["role"] in {"coordinator", "driver"} and not parent.get("parent_session"),
                            "session", "only a root coordinator or driver can authorize child sessions")
        else:
            require(parent_session is None, "session", "root agents cannot inherit child authority")
        from protocol import data as protocol_data
        communication = protocol_data(state)
        if transport_from is not None:
            require(not enforced and isinstance(transport_from, Session), "session", "invalid transport renewal")
            previous = communication["sessions"].get(transport_from.id, {})
            require(communication["active"].get(actor) == transport_from.id
                    and previous.get("digest") == transport_from.digest,
                    "session_revoked", "transport session changed during renewal")
            retained = set(previous.get("bindings", {})) & set(bindings)
            if (not previous.get("revoked") and previous.get("role") == role
                    and (role == "coordinator" or retained)
                    and all(previous["bindings"][task_id] == bindings[task_id] for task_id in retained)):
                # Dropping a task does not replace the agent driving the rest.
                # Compare retained bindings inside the issuance transaction.
                endpoint = previous.get("endpoint")
        generation = communication["generations"].get(actor, 0) + 1
        communication["generations"][actor] = generation
        communication["active"][actor] = session_id
        record = communication["sessions"][session_id] = {
            "actor": actor, "role": role, "generation": generation, "digest": digest,
            "task_ids": tasks, "bindings": bindings, "issued_at": timestamp(), "revoked": False,
            "review_contract": review_contract,
            "egress_hosts": egress_hosts,
            "parent_session": parent_session.id if parent_session is not None else None,
        }
        if endpoint is not None:
            record["endpoint"] = endpoint
        from storage import ensure, reserve
        ensure(path, state["config"])
        reservations = {}
        contract_path = None
        if enforced and review_contract is not None:
            require(isinstance(review_contract, dict), "session", "review contract must be an object")
            raw = (canonical(review_contract) + "\n").encode()
            contract_digest = hashlib.sha256(raw).hexdigest()
            record["review_contract_sha256"] = contract_digest
            record["review_contract"] = {key: review_contract[key] for key in ("artifact_ids", "provider", "id")
                                         if key in review_contract}
            contract_path = path / "review-contracts" / (contract_digest + ".json")
            reservations[str(contract_path.relative_to(path))] = len(raw)
        reservations["state.json"] = len(canonical(state).encode()) + 1
        reserve(path, reservations,
                recovery=role in {"coordinator", "driver"}, control=role == "coordinator" and generation > 1)
        if contract_path is not None:
            contract_path.parent.mkdir(mode=0o700, exist_ok=True)
            private(contract_path.parent, directory=True)
            if contract_path.exists():
                contract(path, record)  # Never overwrite damaged retained evidence.
            else:
                write_atomic(contract_path, review_contract)
        write_atomic(path / "state.json", state)
    return credential


def transport_session(run_dir, actor):
    """Session for a caller whose transport already identified it.

    An unconfined run knows its coordinator by the local command and a driver
    by its SSH forced command. Both get the gateway's session record, so scope,
    task bindings, cursors and hints follow one set of rules. The secret never
    leaves this function: the transport is the credential, not this record.
    """
    state = Engine.read(run_dir)
    require(state["config"].get("communication", {}).get("mode") != "enforced",
            "authenticated_channel_required", "enforced agents must use the authenticated gateway")
    requested = None  # A coordinator's record always covers the run's current scope.
    if actor != "coordinator":
        binding = state["config"].get("actors", {}).get(actor) or {}
        requested = [task_id for task_id in binding.get("task_ids", [])
                     if state["tasks"].get(task_id, {}).get("driver") == actor]
        require(requested, "wrong_task", "no admitted task is assigned to this caller")
    communication = state.get("communication", {})
    identifier = communication.get("active", {}).get(actor)
    previous = communication.get("sessions", {}).get(identifier, {})
    session = None
    if previous.get("role") in {"coordinator", "driver"}:
        session = Session(identifier, previous["digest"])
        try:
            check(state, session)
        except StateError as error:
            # Renew the task scope; issue rechecks whether the same agent's
            # endpoint can be retained for the remaining tasks.
            if error.code != "session_revoked":
                raise
        else:
            if requested is None or previous["task_ids"] == requested:
                return session
    return parse_credential(issue(run_dir, actor, task_ids=requested, transport_from=session))


def revoke(run_dir, actor):
    with locked(run_dir) as path:
        state = read_json(path / "state.json")
        communication = data(state)
        current = communication["active"].pop(actor, None)
        if current:
            communication["sessions"][current]["revoked"] = True
        write_atomic(path / "state.json", state)


def parse_credential(credential):
    require(isinstance(credential, str) and len(credential) < 256 and "." in credential,
            "unauthenticated", "a launch credential is required")
    return Session(credential.split(".", 1)[0], hashlib.sha256(credential.encode()).hexdigest())


def authorizing_session(state, identifier, task_id):
    """Resolve a host-pinned owner, never accepting a caller-selected identity."""
    require(isinstance(identifier, str), "session_revoked", "missing authorizing session")
    record = state.get("communication", {}).get("sessions", {}).get(identifier)
    require(record is not None and record["role"] in {"coordinator", "driver"}
            and not record.get("parent_session"), "session_revoked", "invalid authorizing session")
    session = Session(identifier, record["digest"])
    check(state, session, operation="execute", task_id=task_id)
    return session


def check(state, session, *, operation=None, task_id=None):
    """Recheck inside the mutation lock; a prior socket handshake is insufficient."""
    require(isinstance(session, Session), "unauthenticated", "invalid session")
    communication = state.get("communication", {})
    record = communication.get("sessions", {}).get(session.id)
    require(record is not None and hmac.compare_digest(record["digest"], session.digest),
            "unauthenticated", "invalid launch credential")
    require(not record["revoked"] and communication.get("active", {}).get(record["actor"]) == session.id,
            "session_revoked", "session was revoked or replaced")
    if (state["config"].get("communication", {}).get("mode") == "enforced"
            and record["role"] in {"reviewer", "executor"}):
        require(isinstance(record.get("parent_session"), str) and record["parent_session"],
                "incompatible", "child session lacks its authorizing parent; issue a bound replacement through the trusted host")
    if record.get("parent_session") is not None:
        for bound_id in record["task_ids"]:
            authorizing_session(state, record["parent_session"], bound_id)
    configured = state["config"]["scope"]["task_ids"]
    if record["role"] == "coordinator":
        # The coordinator answers for the whole run, and only host
        # administration changes that scope. A task added or split after its
        # launch reaches it without a relaunch that would discard its context.
        record = {**record, "task_ids": list(configured)}
    scope = set(record["task_ids"]) & set(configured)
    if task_id is not None:
        require(isinstance(task_id, str), "invalid", "task id must be a string")
        require(task_id in scope, "wrong_task", "session cannot access this task")
    for bound_id, binding in record["bindings"].items():
        task = state["tasks"].get(bound_id)
        require(task is not None and task_binding(task) == binding,
                "session_revoked", "task ownership or session binding changed")
    if record["role"] == "driver":
        actor = state["config"].get("actors", {}).get(record["actor"], {})
        require(actor.get("helper_route") is True and scope <= set(actor.get("task_ids", [])),
                "session_revoked", "driver route or scope was revoked")
    if operation is not None:
        require(isinstance(operation, str), "invalid", "operation must be a string")
        require(operation not in ADMIN_OPERATIONS, "forbidden", "operation requires trusted host administration")
        if record["role"] != "coordinator":
            require(task_id is not None, "wrong_task", "requests must name the assigned task")
        if record["role"] == "reviewer":
            require(operation in REVIEW_OPERATIONS, "forbidden", "reviewers cannot drive lifecycle operations")
        if record["role"] == "executor":
            require(operation in EXECUTOR_OPERATIONS, "forbidden", "executors cannot drive lifecycle operations")
    return record


def caller(run_dir, session, operation, task_id=None):
    return check(Engine.read(run_dir), session, operation=operation, task_id=task_id)["actor"]


def apply(run_dir, session, request):
    require("caller" not in request and "session" not in request, "forbidden", "identity comes from the connection")
    actor = caller(run_dir, session, request.get("op"), request.get("task_id"))
    from supervise import apply_request
    return apply_request(run_dir, request, actor, session=session)
