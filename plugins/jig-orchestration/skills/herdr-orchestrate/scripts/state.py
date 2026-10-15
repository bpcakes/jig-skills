"""Private, single-host orchestration state. This module never executes a command.

The caller argument is an authenticated transport identity, not request data. Receipts
are evidence references supplied by the authorized observer; this engine does not
authenticate GitHub, tracker, controller, or process observations itself.
"""

from __future__ import annotations

import copy
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import posixpath
import stat
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone


class StateError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def require(condition, code, message):
    if not condition:
        raise StateError(code, message)


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def instant(value):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(result.tzinfo is not None, "invalid", "timestamps require a timezone")
        return result
    except (AttributeError, TypeError, ValueError) as exc:
        raise StateError("invalid", "invalid timezone-aware timestamp") from exc


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def host_roles(info):
    """Validate host/profile role lists without changing profile inheritance."""
    profiles = info.get("profiles", [])
    require(isinstance(profiles, list), "invalid", "host profiles must be a list")
    for binding in [info, *profiles]:
        require(isinstance(binding, dict), "invalid", "host profiles must contain objects")
        roles = binding.get("roles", [])
        require(isinstance(roles, list) and all(nonempty(role) for role in roles),
                "invalid", "host and profile roles must be lists of nonempty strings")
    return info.get("roles", [])


def scheduler_deadline(at, seconds):
    try:
        return at + timedelta(seconds=seconds)
    except OverflowError as exc:
        raise StateError("invalid", "scheduler duration exceeds the supported timestamp range") from exc


def scheduler_seconds(value, name):
    require(type(value) in {int, float} and value > 0, "invalid", f"{name} must be positive finite seconds")
    try:
        require(math.isfinite(value), "invalid", f"{name} must be positive finite seconds")
    except OverflowError as exc:
        raise StateError("invalid", f"{name} exceeds the supported timestamp range") from exc
    # Health's progress deadline includes a grace period of two more intervals.
    multiplier = 1 if name == "busy_timeout_seconds" else 3
    scheduler_deadline(datetime.now(timezone.utc), value * multiplier)
    return value


def git_worktree(path):
    marker = path / ".git"
    return marker.is_file() or marker.is_dir() and (marker / "HEAD").is_file()


def host_path(value):
    """Normalize POSIX host paths lexically, never resolve remote symlinks here."""
    require(nonempty(value) and value.startswith("/") and "\0" not in value,
            "location", "host paths must be absolute POSIX paths")
    return "/" + posixpath.normpath(value).lstrip("/")


def unadmitted_claims(state):
    return {task_id for task_id, claim in state["claims"].items()
            if task_id not in state["tasks"] and claim["status"] not in {"failed", "released"}}


def task_complete(task):
    return task.get("phase") == "closed" and (task.get("pending_intent") or {}).get("kind") != "reopen"


def unfinished(state, excluding_claim=None):
    tasks = sum(not task_complete(t) for t in state["tasks"].values())
    return tasks + len(unadmitted_claims(state) - {excluding_claim})


def evidence(value, settled=False):
    require(isinstance(value, dict) and nonempty(value.get("ref")), "evidence", "evidence.ref is required")
    instant(value.get("observed_at"))
    if settled:
        require(value.get("all_jobs_settled") is True, "unsettled", "all owned jobs must be observed settled")


def scheduler_identity(settings):
    """Validate the identity whenever scheduling is effectively enabled."""
    if not settings.get("enabled", False):
        return
    for field in ("session", "control_pane_id"):
        value = settings.get(field)
        require(nonempty(value) and not value.startswith("-"), "invalid", f"scheduler.{field} is required")
    agent = settings.get("agent")
    require(isinstance(agent, dict), "invalid", "scheduler.agent is required")
    for field in ("name", "agent", "pane_id", "terminal_id"):
        value = agent.get(field)
        require(nonempty(value) and not value.startswith("-"), "invalid", f"scheduler.agent.{field} is required")
    native = agent.get("agent_session")
    require(isinstance(native, dict) and all(nonempty(native.get(k)) for k in ("agent", "kind", "value")),
            "invalid", "Register the coordinator's native agent_session identity")
    require(agent["pane_id"] != settings["control_pane_id"], "invalid",
            "Scheduler control pane must differ from coordinator pane")


def private(path, directory=False):
    info = path.lstat()
    require(not stat.S_ISLNK(info.st_mode), "permissions", "state paths must not be symlinks")
    require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
            "permissions", "state must be owned by this user and inaccessible to group/others")
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode),
            "permissions", "unexpected state path type")


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_atomic(path, value):
    fd, name = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(canonical(value) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read_json(path):
    private(path)
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


@contextmanager
def locked(run_dir, create=False):
    path = Path(run_dir).absolute()
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(path.is_dir(), "missing", "run directory does not exist")
    private(path, directory=True)
    if (path / "actions").exists():
        private(path / "actions", directory=True)
    lock = path / "lock"
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        private(lock)
        fcntl.flock(fd, fcntl.LOCK_EX)
        if (path / "transaction.json").exists():
            transaction = read_json(path / "transaction.json")
            write_atomic(path / "state.json", transaction["state"])
            write_atomic(path / "actions" / transaction["filename"], transaction["record"])
            (path / "transaction.json").unlink()
            sync_directory(path)
        yield path
    finally:
        os.close(fd)


class Engine:
    """All methods are short locked transactions; no lock crosses external work."""

    ACTIONS = {"implement", "review", "validate", "repair", "push", "pr", "merge", "deploy", "close", "split"}
    UNITS = {"implement": "implementation", "repair": "source_repair", "review": "review",
             "validate": "validation", "push": "push", "pr": "pr", "merge": "merge",
             "deploy": "deployment", "close": "closure", "split": "task_split"}
    SCHEDULER_FIELDS = {
        "enabled", "heartbeat_at", "last_attempt_at", "last_delivered_at", "last_completed_at",
        "next_due_at", "pending_action_id", "delivery_status", "failure", "alerted_failure_id",
        "last_completed_action_id", "wake_requested_at", "wake_reason",
        "last_alert", "busy_since_at", "last_dispatched_action_id", "last_dispatched_at",
        "last_delivered_action_id",
        "last_completed_wake_id", "health_alerts",
    }

    @staticmethod
    def initialize(run_dir, config):
        config = copy.deepcopy(config)
        Engine._validate_config(run_dir, config)
        with locked(run_dir, create=True) as path:
            require(not (path / "state.json").exists(), "exists", "run is already initialized")
            (path / "actions").mkdir(mode=0o700, exist_ok=True)
            private(path / "actions", directory=True)
            state = {"schema": 1, "version": 0, "policy_version": 1, "config": config,
                     "created_at": timestamp(), "updated_at": timestamp(), "tasks": {},
                     "controls": {"admission": "open", "frozen_tasks": [], "paused": False,
                                  "cancel_requested": False, "holds": {}},
                     "counters": {}, "claims": {}, "staging": {"owner": None, "generation": 0},
                     "scheduler": {"version": 0, "enabled": config.get("scheduler", {}).get("enabled", False)}}
            write_atomic(path / "state.json", state)
            return state

    @staticmethod
    def _validate_config(run_dir, config):
        require(isinstance(config, dict), "invalid", "config must be an object")
        repo = config.get("repository", {})
        require(nonempty(repo.get("path")) and Path(repo["path"]).is_absolute()
                and nonempty(repo.get("target")), "invalid", "repository requires absolute path and target")
        repo["path"] = host_path(repo["path"])
        source = Path(repo["path"]).resolve()
        state_path = Path(run_dir).resolve()
        require(state_path != source and source not in state_path.parents,
                "location", "run directory must be outside the repository")
        require(not any(git_worktree(parent) for parent in (state_path, *state_path.parents)),
                "location", "run directory must be outside source control")
        ids = config.get("scope", {}).get("task_ids")
        require(isinstance(ids, list) and ids and all(nonempty(i) for i in ids)
                and len(ids) == len(set(ids)), "invalid", "scope.task_ids must name unique authorized tasks")
        tracker = config.get("tracker", {})
        require(tracker.get("kind") in {"br", "bead"} and nonempty(tracker.get("authority")),
                "invalid", "select a verified br or bead authority")
        hosts = config.get("hosts")
        require(isinstance(hosts, dict) and hosts, "invalid", "hosts are required")
        for host, info in hosts.items():
            require(nonempty(host) and type(info.get("slots")) is int and info["slots"] > 0,
                    "invalid", "each host needs a positive execution slot count")
            require(nonempty(info.get("worktree_root")) and Path(info["worktree_root"]).is_absolute(),
                    "invalid", "host worktree_root must be absolute")
            info["worktree_root"] = host_path(info["worktree_root"])
            require(isinstance(info.get("endpoint"), dict) and info["endpoint"],
                    "invalid", "each host needs a registered endpoint")
            host_roles(info)
            if "repository_path" in info:
                require(nonempty(info["repository_path"]) and Path(info["repository_path"]).is_absolute(),
                        "invalid", "host repository_path must be absolute")
                info["repository_path"] = host_path(info["repository_path"])
        if "host" in repo:
            require(repo["host"] in hosts, "invalid", "repository.host must name a registered host")
        cap = config.get("unfinished_task_cap")
        require(cap is None or type(cap) is int and cap > 0, "invalid", "unfinished_task_cap must be positive or null")
        authority = config.get("authority", [])
        require(isinstance(authority, list) and set(authority) <= Engine.ACTIONS,
                "invalid", "unsupported authority")
        for actor, binding in config.get("actors", {}).items():
            require(actor != "coordinator" and nonempty(actor) and binding.get("role") == "driver"
                    and binding.get("host") in hosts and isinstance(binding.get("task_ids"), list)
                    and set(binding["task_ids"]) <= set(ids), "invalid", "invalid registered actor")
        limits = config.get("limits", [])
        require(isinstance(limits, list), "invalid", "limits must be a list")
        seen = set()
        for limit in limits:
            require(nonempty(limit.get("id")) and limit["id"] not in seen and nonempty(limit.get("unit"))
                    and limit.get("scope") in {"task", "run"} and type(limit.get("max")) is int
                    and limit["max"] >= 0 and limit.get("enforced") is True,
                    "unsupported", "hard limits require a unique ID, counted unit, task/run scope, max and verified enforcement")
            require(limit["unit"] not in {"usd", "dollars", "cost", "tokens"},
                    "unsupported", "hard provider spending/token caps are unsupported")
            require(limit["unit"] in Engine.UNITS.values(), "unsupported", "limit unit has no enforced assignment boundary")
            seen.add(limit["id"])
        if config.get("launch_cutoff"):
            instant(config["launch_cutoff"])
        require("hard_spending_cap" not in config, "unsupported", "hard spending caps are unsupported")
        settings = config.get("scheduler", {})
        require(isinstance(settings, dict), "invalid", "scheduler configuration must be an object")
        require(type(settings.get("enabled", False)) is bool, "invalid", "scheduler.enabled must be boolean")
        scheduler_identity(settings)
        for key in ("cadence_seconds", "minimum_cadence_seconds", "busy_timeout_seconds"):
            if key in settings:
                scheduler_seconds(settings[key], key)
        if settings.get("notifier_argv") is not None:
            argv = settings["notifier_argv"]
            require(settings.get("notification_authorized") is True and isinstance(argv, list) and argv
                    and all(nonempty(arg) and "\0" not in arg for arg in argv) and Path(argv[0]).is_absolute(),
                    "invalid", "notification requires explicit authorization and an absolute argument-array executable")

    @staticmethod
    def read(run_dir):
        with locked(run_dir) as path:
            state = read_json(path / "state.json")
            if (path / "heartbeat.json").exists():
                state["scheduler"]["heartbeat_at"] = read_json(path / "heartbeat.json")["heartbeat_at"]
            return state

    @staticmethod
    def heartbeat(run_dir, at):
        """Replace liveness evidence without an action record or state-version change."""
        instant(at)
        with locked(run_dir) as path:
            require((path / "state.json").exists(), "missing", "run is not initialized")
            write_atomic(path / "heartbeat.json", {"heartbeat_at": at})

    @staticmethod
    def action(run_dir, action_id):
        require(nonempty(action_id), "invalid", "action_id must be a nonempty string")
        with locked(run_dir) as path:
            filename = hashlib.sha256(action_id.encode()).hexdigest() + ".json"
            record = path / "actions" / filename
            return read_json(record) if record.exists() else None

    @staticmethod
    def apply(run_dir, request, caller="coordinator"):
        require(isinstance(request, dict) and "caller" not in request, "invalid", "caller is transport identity, not request data")
        require(nonempty(request.get("action_id")) and nonempty(request.get("op")), "invalid", "action_id and op are required")
        digest = hashlib.sha256(canonical({"caller": caller, "request": request}).encode()).hexdigest()
        filename = hashlib.sha256(request["action_id"].encode()).hexdigest() + ".json"
        with locked(run_dir) as path:
            record_path = path / "actions" / filename
            if record_path.exists():
                record = read_json(record_path)
                require(record["digest"] == digest, "duplicate", "action ID was already used with different input or caller")
                return record["result"]
            state = read_json(path / "state.json")
            require(request.get("expected_policy") == state["policy_version"], "stale_policy", "current policy revision is required")
            task = state["tasks"].get(request.get("task_id"))
            if task is not None:
                require(request.get("expected_task") == task["version"], "stale_task", "current task version is required")
            Engine._authorize(state, request, caller, task)
            details = Engine._transition(state, request, caller, task, path)
            state["version"] += 1
            state["updated_at"] = timestamp()
            task = state["tasks"].get(request.get("task_id"))
            if task is not None:
                task["version"] += 1
            result = {"action_id": request["action_id"], "version": state["version"],
                      "policy_version": state["policy_version"], "task_version": task["version"] if task else None,
                      **(details or {})}
            record = {"digest": digest, "caller": caller, "request": request, "result": result,
                      "recorded_at": state["updated_at"]}
            # Recovery completes both durable writes; a crash never makes the action replayable.
            write_atomic(path / "transaction.json", {"state": state, "record": record, "filename": filename})
            write_atomic(path / "state.json", state)
            write_atomic(record_path, record)
            (path / "transaction.json").unlink()
            sync_directory(path)
            return result

    @staticmethod
    def _authorize(state, req, caller, task):
        if caller == "coordinator":
            return
        actor = state["config"].get("actors", {}).get(caller)
        require(actor is not None and actor.get("helper_route") is True,
                "forbidden", "caller has no verified helper route")
        require(task is not None and task["id"] in actor["task_ids"] and task["driver"] == caller
                and task["host"] == actor["host"], "forbidden", "caller does not drive this task")
        require(req["op"] in {"reserve", "settle", "park", "observe", "intent", "outcome", "staging"},
                "forbidden", "operation is coordinator-only")

    @staticmethod
    def _active(state, task, kind, launching=False, allow_closed=False, reconciling=False):
        require(allow_closed or task["phase"] != "closed", "closed", "task is closed")
        if launching and task.get("recovery_open"):
            require(kind == "split" and task["recovery"]["route"] == "split",
                    "recovery", "resolve or route the parked recovery before launching more work")
        elif launching and not allow_closed:
            # Recheck ordinary launches; tracker reopening and ownership reconciliation remain available.
            Engine._dependencies_complete(state, task)
        if launching and state["controls"]["admission"] == "finish_current":
            require(task["id"] in state["controls"]["frozen_tasks"],
                    "admission", "new work must belong to the frozen unfinished batch")
        if not reconciling:
            require(not state["controls"]["paused"] and not task["paused"], "paused", "new work is paused")
            require(not state["controls"]["cancel_requested"] and not task["cancel_requested"],
                    "cancelled", "cancellation must be reconciled before resume")
        holds = list(state["controls"]["holds"].values()) + list(task["holds"].values())
        require(not any("*" in h["actions"] or kind in h["actions"] for h in holds), "held", "an applicable hold prevents this action")
        require(kind in state["config"]["authority"], "authority", "action lacks current run authority")
        if launching and state["config"].get("launch_cutoff"):
            require(datetime.now(timezone.utc) < instant(state["config"]["launch_cutoff"]),
                    "deadline", "launch cutoff reached")

    @staticmethod
    def _delegated(state, task, caller, kind):
        if caller != "coordinator":
            delegation = task["delegation"] or {}
            require(delegation.get("executor") == caller and kind in delegation.get("actions", [])
                    and delegation.get("policy_version") == state["policy_version"],
                    "authority", "current delegated action authority is required")

    @staticmethod
    def _claim_transfer(state, task, target, proof):
        require(isinstance(target, dict) and target.get("authority") == state["config"]["tracker"]["authority"]
                and target.get("task_id") == task["id"] and target.get("previous_owner") == task["claim"]["owner"]
                and nonempty(target.get("owner")) and target["owner"] != target["previous_owner"],
                "identity", "claim transfer must name the canonical task, current owner and distinct successor")
        evidence(proof)
        require(proof.get("authorized") is True and (proof.get("handoff_acknowledged") is True
                or (proof.get("previous_owner_stopped") is True and proof.get("takeover_supported") is True)),
                "authority", "claim transfer needs authorized acknowledged handoff or supported stopped-owner takeover evidence")

    @staticmethod
    def _record_claim_transfer(state, task, target, proof, receipt):
        Engine._claim_transfer(state, task, target, proof)
        evidence(receipt)
        require(all(receipt.get(key) == target[key] for key in ("authority", "task_id", "owner"))
                and receipt.get("confirmed") is True and receipt.get("unpublished") is False,
                "claim", "claim transfer requires a confirmed published successor ownership receipt")
        task.setdefault("claim_history", []).append({"previous_claim": task["claim"], "target": target,
                                                     "evidence": proof, "receipt": receipt})
        task["claim"] = copy.deepcopy(receipt)
        task["delegation"] = None

    @staticmethod
    def _slot(state, task):
        if task["slot"] is not None:
            return
        occupied = sum(t["host"] == task["host"] and t["slot"] is not None for t in state["tasks"].values())
        require(occupied < state["config"]["hosts"][task["host"]]["slots"], "capacity", "host execution slots are occupied")
        task["slot"] = {"host": task["host"], "reserved_at": timestamp()}
        task["parked"] = False

    @staticmethod
    def _worktree(state, host, value, excluding=None):
        worktree = Path(host_path(value))
        root = Path(state["config"]["hosts"][host]["worktree_root"])
        require(root in worktree.parents, "location", "worktree must be a child of the registered worktree root")
        config = state["config"]
        repository_host = config["repository"].get("host")
        if repository_host is None:
            coordinators = [name for name, info in config["hosts"].items() if "coordinator" in info.get("roles", [])]
            repository_host = (coordinators[0] if len(coordinators) == 1 else
                               "local" if "local" in config["hosts"] else
                               next(iter(config["hosts"])) if len(config["hosts"]) == 1 else None)
        # Unknown legacy ownership retains the conservative protection until
        # the coordinator host is identified. Never infer it from path equality.
        protected = [Path(config["repository"]["path"])] if repository_host in {None, host} else []
        host_repository = config["hosts"][host].get("repository_path")
        if host_repository:
            protected.append(Path(host_repository))
        protected.extend(Path(t["worktree"]) for t in state["tasks"].values()
                         if t["host"] == host and t["id"] != excluding)
        require(not any(worktree == path or worktree in path.parents or path in worktree.parents
                        for path in protected), "ownership", "checkout overlaps a protected or owned checkout")
        return str(worktree)

    @staticmethod
    def _transition(state, req, caller, task, run_dir):
        op = req["op"]
        config = state["config"]
        if op == "configure":
            fields = req.get("fields", {})
            allowed = {"authority", "unfinished_task_cap", "limits", "launch_cutoff", "scope", "hosts", "actors", "scheduler"}
            require(isinstance(fields, dict) and fields and set(fields) <= allowed,
                    "invalid", "unsupported configuration fields")
            evidence(req.get("evidence"))
            candidate = {**config, **copy.deepcopy(fields)}
            if "scheduler" in fields and isinstance(candidate["scheduler"], dict):
                candidate["scheduler"].setdefault("enabled", state["scheduler"]["enabled"])
            Engine._validate_config(run_dir, candidate)
            require(set(state["tasks"]) <= set(candidate["scope"]["task_ids"]),
                    "ownership", "configuration must preserve all admitted tasks")
            unresolved_claims = unadmitted_claims(state)
            require(unresolved_claims <= set(candidate["scope"]["task_ids"]),
                    "ownership", "reconcile unresolved tracker claims before removing their tasks")
            cap = candidate.get("unfinished_task_cap")
            require(cap is None or cap >= unfinished(state), "capacity", "new unfinished-task cap is below current occupancy")
            for existing in state["tasks"].values():
                host = existing["host"]
                require(host in candidate["hosts"], "ownership", "configuration cannot drop an admitted task's host")
                if "hosts" in fields:
                    Engine._worktree({**state, "config": candidate}, host, existing["worktree"], excluding=existing["id"])
                driver = existing["driver"]
                if driver != "coordinator":
                    binding = candidate.get("actors", {}).get(driver, {})
                    require(existing["id"] in binding.get("task_ids", []) and binding.get("host") == host,
                            "ownership", "configuration must preserve registered task drivers")
                active = existing["slot"] is not None or existing["reservations"] or existing["pending_intent"]
                if active:
                    old_host = {k: v for k, v in config["hosts"][host].items() if k != "slots"}
                    new_host = {k: v for k, v in candidate["hosts"][host].items() if k != "slots"}
                    require(old_host == new_host, "unsettled", "park host tasks before changing endpoint/runtime binding")
                    if driver != "coordinator":
                        require(config["actors"][driver] == candidate["actors"][driver],
                                "unsettled", "settle registered actor work before changing its binding")
            for host, binding in candidate["hosts"].items():
                occupied = sum(t["host"] == host and t["slot"] is not None for t in state["tasks"].values())
                require(binding["slots"] >= occupied, "capacity", "new host slot limit is below current occupancy")
            if "scheduler" in fields and state["scheduler"].get("enabled"):
                old_identity = {k: v for k, v in config.get("scheduler", {}).items()
                                if k not in {"cadence_seconds", "minimum_cadence_seconds", "busy_timeout_seconds", "notifier_argv", "notification_authorized", "enabled"}}
                new_identity = {k: v for k, v in candidate["scheduler"].items()
                                if k not in {"cadence_seconds", "minimum_cadence_seconds", "busy_timeout_seconds", "notifier_argv", "notification_authorized", "enabled"}}
                require(old_identity == new_identity, "unsettled", "stop scheduler before rebinding its endpoint")
            if "scheduler" in fields:
                settings = candidate["scheduler"]
                if any(settings.get(key) != config.get("scheduler", {}).get(key)
                       for key in ("cadence_seconds", "minimum_cadence_seconds")):
                    cadence = settings.get("cadence_seconds", 1200)
                    interval = max(cadence, settings.get("minimum_cadence_seconds", cadence))
                    previous = [instant(state["scheduler"][key]) for key in ("last_attempt_at", "last_completed_at")
                                if state["scheduler"].get(key)]
                    state["scheduler"]["next_due_at"] = (
                        scheduler_deadline(max(previous), interval).isoformat() if previous else None)
                state["scheduler"]["enabled"] = candidate["scheduler"]["enabled"]
                state["scheduler"]["version"] += 1
            state["config"] = candidate
            state["policy_version"] += 1
            return {"configured": sorted(fields)}
        if op in {"claim_intent", "claim_outcome", "claim_release_intent", "claim_release_outcome"}:
            task_id = req.get("task_id")
            require(task_id in config["scope"]["task_ids"] and task is None,
                    "scope", "claim action requires an authorized, not-yet-admitted task")
            previous = state["claims"].get(task_id)
            if op == "claim_intent":
                require(state["controls"]["admission"] == "open" and not state["controls"]["paused"],
                        "admission", "new claims are stopped")
                require(previous is None or previous["status"] in {"failed", "released"},
                        "uncertain", "reconcile the prior claim; do not claim it again")
                cap = config.get("unfinished_task_cap")
                require(cap is None or unfinished(state) < cap, "wip", "unfinished-task cap reached before claim")
                target = req.get("target", {})
                require(target.get("authority") == config["tracker"]["authority"] and nonempty(target.get("owner")),
                        "identity", "claim must name the canonical authority and claimant")
                evidence(req.get("evidence"))
                state["claims"][task_id] = {"id": req["action_id"], "target": target, "status": "pending",
                                            "evidence": req["evidence"]}
                return {"claim_intent": state["claims"][task_id]}
            if op == "claim_release_intent":
                require(previous is not None and previous["status"] == "confirmed",
                        "uncertain", "reconcile the claim before releasing its ownership")
                release = previous.get("release")
                require(release is None or release["status"] == "failed",
                        "uncertain", "reconcile the existing release; do not repeat it")
                require(req.get("claim_id") == previous["id"] and req.get("target") == previous["target"],
                        "identity", "release must name the confirmed claim and owner")
                evidence(req.get("evidence"))
                previous["release"] = {"id": req["action_id"], "status": "pending", "evidence": req["evidence"]}
                return {"claim_release_intent": previous["release"]}
            if op == "claim_release_outcome":
                release = (previous or {}).get("release")
                require(release is not None and req.get("intent_id") == release["id"]
                        and req.get("target") == previous["target"], "identity", "release outcome must match its action and owner")
                require(release["status"] in {"pending", "unknown"}, "settled", "release is already reconciled")
                status, receipt = req.get("status"), req.get("receipt", {})
                require(status in {"succeeded", "failed", "unknown"}, "invalid", "invalid release outcome")
                evidence(receipt)
                if status == "succeeded":
                    require(receipt.get("authority") == previous["target"]["authority"]
                            and receipt.get("owner") == previous["target"]["owner"] and receipt.get("task_id") == task_id
                            and receipt.get("released") is True and receipt.get("unpublished") is False,
                            "claim", "release requires published evidence that the recorded owner released the claim")
                    previous["status"] = "released"
                release.update(status=status, receipt=receipt)
                return {"claim_release_outcome": status}
            require(previous is not None and req.get("intent_id") == previous["id"],
                    "identity", "claim outcome must name the recorded action")
            require(previous["status"] in {"pending", "unknown"}, "settled", "claim action is already reconciled")
            status = req.get("status")
            require(status in {"confirmed", "failed", "unknown"}, "invalid", "invalid claim outcome")
            receipt = req.get("receipt", {})
            evidence(receipt)
            if status == "confirmed":
                require(receipt.get("authority") == previous["target"]["authority"]
                        and receipt.get("owner") == previous["target"]["owner"] and receipt.get("task_id") == task_id
                        and receipt.get("confirmed") is True and receipt.get("unpublished") is False,
                        "claim", "claim confirmation must be a published canonical ownership receipt")
            previous.update(status=status, receipt=receipt)
            return {"claim_outcome": status}
        if op == "admit":
            require(task is None, "ownership", "task is already admitted")
            require(req.get("task_id") in config["scope"]["task_ids"], "scope", "task is outside authorized scope")
            require(state["controls"]["admission"] == "open" and not state["controls"]["paused"],
                    "admission", "new admission is stopped")
            cap = config.get("unfinished_task_cap")
            require(cap is None or unfinished(state, excluding_claim=req.get("task_id")) < cap,
                    "wip", "unfinished-task cap reached")
            host = req.get("host")
            require(host in config["hosts"], "invalid", "unregistered host")
            worktree = Engine._worktree(state, host, req.get("worktree", ""))
            claim = req.get("claim", {})
            evidence(claim)
            require(claim.get("authority") == config["tracker"]["authority"]
                    and claim.get("task_id") == req["task_id"] and nonempty(claim.get("owner"))
                    and claim.get("confirmed") is True and claim.get("ready") is True
                    and claim.get("unpublished") is False, "claim", "confirmed, published, ready canonical claim is required")
            prior_claim = state["claims"].get(req["task_id"])
            if prior_claim is not None:
                require(prior_claim["status"] == "confirmed" and prior_claim["target"]["owner"] == claim["owner"]
                        and (prior_claim.get("release") or {}).get("status", "failed") == "failed",
                        "uncertain", "reconcile the recorded claim and owner before admission")
            driver = req.get("driver", "coordinator")
            if driver != "coordinator":
                actor = config.get("actors", {}).get(driver, {})
                require(req["task_id"] in actor.get("task_ids", []) and actor.get("host") == host,
                        "forbidden", "driver is not registered for task/host")
            require(nonempty(req.get("branch")), "invalid", "task branch is required")
            state["tasks"][req["task_id"]] = {
                "id": req["task_id"], "version": 0, "host": host, "driver": driver,
                "worktree": worktree, "branch": req["branch"], "claim": claim,
                "identity": copy.deepcopy(req.get("identity", {})), "phase": "admitted", "parked": True,
                "slot": None, "paused": False, "cancel_requested": False, "holds": {},
                "refs": {}, "counters": {}, "reservations": {}, "pending_intent": None,
                "delegation": None, "findings": [], "blocker": None, "next_action": None,
                "merged_prs": {},
                "budget_root": state.get("task_links", {}).get(req["task_id"], {}).get("budget_root", req["task_id"]),
            }
            return {"admitted": req["task_id"]}
        if op == "control":
            control = req.get("control")
            target = task if req.get("task_id") else state["controls"]
            require(target is not None, "missing", "task is not admitted")
            if control == "finish_current":
                require(task is None, "invalid", "finish_current is a run admission policy")
                if target["admission"] != "finish_current":
                    target["frozen_tasks"] = [t["id"] for t in state["tasks"].values()
                                              if t["phase"] != "closed"
                                              or (t["pending_intent"] or {}).get("kind") == "reopen"]
                target["admission"] = "finish_current"
            elif control == "reopen_admission":
                require(task is None, "invalid", "reopen_admission is a run admission policy")
                evidence(req.get("evidence"))
                target["admission"] = "open"
                target["frozen_tasks"] = []
            elif control in {"pause", "cancel"}:
                target["paused"] = True
                if control == "cancel":
                    target["cancel_requested"] = True
            elif control == "resume":
                affected = [task] if task else list(state["tasks"].values())
                if target["cancel_requested"]:
                    require(all(not t["reservations"] and not t["pending_intent"] for t in affected),
                            "unsettled", "reconcile cancelled executions and uncertain outcomes before resume")
                target["paused"] = False
                target["cancel_requested"] = False
            elif control == "hold":
                require(nonempty(req.get("hold_id")) and nonempty(req.get("reason")), "invalid", "hold_id and reason are required")
                actions = req.get("actions", ["*"])
                require(isinstance(actions, list) and actions and set(actions) <= Engine.ACTIONS | {"*"}, "invalid", "invalid hold actions")
                target["holds"][req["hold_id"]] = {"reason": req["reason"], "actions": actions}
            elif control == "unhold":
                require(req.get("hold_id") in target["holds"], "missing", "hold not found")
                del target["holds"][req["hold_id"]]
            else:
                raise StateError("invalid", "unknown work control")
            state["policy_version"] += 1
            return {"control": control}
        if op == "scheduler":
            require(req.get("expected_scheduler") == state["scheduler"]["version"],
                    "stale_scheduler", "current scheduler version is required")
            if "expected_heartbeat" in req:
                # Heartbeats deliberately avoid journal/version churn. Compare
                # their separate evidence under the same lock as the claim.
                heartbeat_path = run_dir / "heartbeat.json"
                heartbeat = (read_json(heartbeat_path).get("heartbeat_at")
                             if heartbeat_path.exists() else state["scheduler"].get("heartbeat_at"))
                require(req["expected_heartbeat"] == heartbeat,
                        "stale_heartbeat", "heartbeat changed before the scheduler update")
            changes = req.get("fields", {})
            require(isinstance(changes, dict) and changes and set(changes) <= Engine.SCHEDULER_FIELDS,
                    "invalid", "unsupported scheduler fields")
            for field, value in changes.items():
                if field.endswith("_at") and value is not None:
                    instant(value)
                elif field == "enabled":
                    require(type(value) is bool, "invalid", "scheduler.enabled must be boolean")
                elif field in {"failure", "last_alert"}:
                    require(value is None or isinstance(value, dict), "invalid", "scheduler failure/alert must be an object or null")
                    if field == "failure" and value is not None:
                        require(nonempty(value.get("id")), "invalid", "scheduler failure.id must be a nonempty string")
                elif field == "health_alerts":
                    require(isinstance(value, dict) and all(nonempty(key) and isinstance(alert, dict)
                            for key, alert in value.items()), "invalid", "health alerts must map incident IDs to receipts")
                else:
                    require(value is None or isinstance(value, str), "invalid", "scheduler reference/status must be a string or null")
            if "enabled" in changes:
                settings = {**config.get("scheduler", {}), "enabled": changes["enabled"]}
                scheduler_identity(settings)
                config["scheduler"] = settings
            state["scheduler"].update(changes)
            state["scheduler"]["version"] += 1
            return {"scheduler": state["scheduler"]}
        require(task is not None, "missing", "task is not admitted")
        if op in {"claim_transfer_intent", "reconcile_claim"}:
            Engine._active(state, task, "close", allow_closed=True, launching=op == "claim_transfer_intent",
                           reconciling=op == "reconcile_claim")
            require(not task["reservations"] and not task["pending_intent"],
                    "unsettled", "settle executions and reconcile uncertain effects before tracker ownership transfer")
            target, proof = req.get("target"), req.get("evidence")
            Engine._claim_transfer(state, task, target, proof)
            if op == "reconcile_claim":
                Engine._record_claim_transfer(state, task, target, proof, req.get("receipt", {}))
                return {"reconciled_claim": task["claim"]}
            task["pending_intent"] = {"id": req["action_id"], "kind": "claim_transfer", "executor": caller,
                                      "target": target, "evidence": proof, "status": "pending",
                                      "policy_version": state["policy_version"]}
            return {"intent": task["pending_intent"]}
        if op == "claim_transfer_outcome":
            pending = task["pending_intent"]
            require(pending is not None and pending["kind"] == "claim_transfer"
                    and pending["id"] == req.get("intent_id") and pending["target"] == req.get("target"),
                    "identity", "claim transfer outcome must match its recorded action and target")
            status, receipt = req.get("status"), req.get("receipt", {})
            require(status in {"unknown", "succeeded", "failed"}, "invalid", "invalid claim transfer outcome")
            evidence(receipt)
            if status == "unknown":
                pending.update(status=status, receipt=receipt)
            else:
                if status == "succeeded":
                    Engine._record_claim_transfer(state, task, pending["target"], pending["evidence"], receipt)
                task["last_outcome"] = {**pending, "status": status, "receipt": receipt}
                task["pending_intent"] = None
            return {"claim_transfer_outcome": status}
        if op == "recover_session":
            require(req.get("previous_identity") == task["identity"], "identity", "recovery must name the current session identity")
            identity = req.get("identity")
            require(isinstance(identity, dict) and identity and identity != task["identity"],
                    "identity", "recovery requires a distinct observed replacement identity")
            proof = req.get("evidence", {})
            evidence(proof)
            require(proof.get("previous_session_stopped") is True and proof.get("replacement_verified") is True
                    and proof.get("host") == task["host"] and proof.get("worktree") == task["worktree"],
                    "identity", "verify the stopped model and replacement at the existing host and worktree")
            task["last_session_recovery"] = {"previous_identity": task["identity"], "evidence": proof}
            task["identity"] = copy.deepcopy(identity)
            task["delegation"] = None
            return {"recovered_session": identity}
        if op == "handoff":
            require(task["phase"] != "closed" and task["slot"] is None
                    and not task["reservations"] and not task["pending_intent"],
                    "unsettled", "park and settle all task executions before handoff")
            evidence(req.get("evidence"), settled=True)
            source = req.get("source", {})
            evidence(source)
            require(source.get("published") is True and nonempty(source.get("revision")),
                    "evidence", "handoff requires the verified published source revision")
            host, driver = req.get("host"), req.get("driver")
            require(host in config["hosts"], "identity", "handoff host is not registered")
            worktree = Engine._worktree(state, host, req.get("worktree", ""), excluding=task["id"])
            if driver != "coordinator":
                actor = config.get("actors", {}).get(driver, {})
                require(actor.get("host") == host and task["id"] in actor.get("task_ids", []),
                        "forbidden", "destination driver must be registered for this task and host")
            require(nonempty(req.get("branch")) and isinstance(req.get("identity"), dict) and req["identity"],
                    "identity", "handoff requires exact destination identity and source branch")
            task["last_handoff"] = {"previous": {key: task[key] for key in ("host", "driver", "worktree", "branch", "identity", "refs")},
                                    "source": source, "evidence": req["evidence"]}
            for key in ("host", "driver", "worktree", "branch", "identity"):
                task[key] = req[key]
            task["worktree"] = worktree
            task["delegation"] = None
            return {"handoff": {"host": host, "driver": driver, "worktree": worktree}}
        if op == "reopen_intent":
            require(task["phase"] == "closed" and task["pending_intent"] is None,
                    "uncertain", "reopen requires a closed task with no pending action")
            Engine._active(state, task, "close", launching=True, allow_closed=True)
            cap = config.get("unfinished_task_cap")
            require(cap is None or unfinished(state) < cap, "wip", "unfinished-task cap prevents reopening")
            target = req.get("target", {})
            require(target.get("authority") == config["tracker"]["authority"]
                    and target.get("owner") == task["claim"]["owner"], "identity", "reopen must retain canonical tracker owner")
            evidence(req.get("evidence"))
            task["pending_intent"] = {"id": req["action_id"], "kind": "reopen", "executor": caller,
                                      "target": target, "evidence": req["evidence"],
                                      "policy_version": state["policy_version"], "status": "pending"}
            return {"intent": task["pending_intent"]}
        if op == "reopen_outcome":
            pending = task["pending_intent"]
            require(pending is not None and pending["kind"] == "reopen" and pending["id"] == req.get("intent_id")
                    and pending["target"] == req.get("target"), "identity", "reopen outcome must match its action and target")
            status, receipt = req.get("status"), req.get("receipt", {})
            require(status in {"unknown", "succeeded", "failed"}, "invalid", "invalid reopen outcome")
            evidence(receipt)
            if status == "unknown":
                pending.update(status=status, receipt=receipt)
            else:
                if status == "succeeded":
                    require(receipt.get("authority") == config["tracker"]["authority"]
                            and receipt.get("owner") == task["claim"]["owner"] and receipt.get("task_id") == task["id"]
                            and receipt.get("status") == "open" and receipt.get("unpublished") is False,
                            "closure", "reopen requires a published canonical open receipt")
                    task.setdefault("closure_history", []).append(task.pop("closure"))
                    task["phase"] = "admitted"
                    task["acceptance"] = None
                task["last_outcome"] = {**pending, "status": status, "receipt": receipt}
                task["pending_intent"] = None
            return {"reopen_outcome": status}
        if op == "reserve":
            kind = req.get("kind")
            Engine._active(state, task, kind, launching=True)
            Engine._delegated(state, task, caller, kind)
            require(not task["reservations"] and not task["pending_intent"], "unsettled", "settle the previous task execution before another assignment")
            require(nonempty(req.get("unit")), "invalid", "counted assignment unit is required")
            require(req["unit"] == Engine.UNITS.get(kind), "budget", "assignment kind requires its canonical counted unit")
            refs = req.get("refs", {})
            require(isinstance(refs, dict), "invalid", "refs must be an object")
            for key, value in refs.items():
                require(nonempty(value) and (key not in task["refs"] or task["refs"][key] == value),
                        "identity", "reservation references do not match the registered run")
            for limit in config.get("limits", []):
                if limit["unit"] == req["unit"]:
                    counters = Engine._family_counters(state, task) if limit["scope"] == "task" else state["counters"]
                    require(counters.get(req["unit"], 0) < limit["max"], "budget", "cumulative attempt limit exhausted")
            Engine._slot(state, task)
            for counters in (task["counters"], state["counters"]):
                counters[req["unit"]] = counters.get(req["unit"], 0) + 1
            task["reservations"][req["action_id"]] = {"kind": kind, "unit": req["unit"], "refs": refs,
                                                         "reserved_at": timestamp(), "status": "reserved"}
            task["phase"] = kind
            return {"reservation_id": req["action_id"], "slot": task["slot"]}
        if op == "settle":
            rid = req.get("reservation_id")
            require(rid in task["reservations"], "missing", "reservation does not exist")
            require(req.get("refs") == task["reservations"][rid]["refs"], "identity", "settlement requires the exact registered execution references")
            evidence(req.get("evidence"), settled=True)
            require(task["pending_intent"] is None, "uncertain", "reconcile pending external intent before settlement")
            task["last_settlement"] = req["evidence"]
            del task["reservations"][rid]
            return {"settled": rid}
        if op == "park":
            require(not task["reservations"] and not task["pending_intent"], "unsettled", "active or uncertain work retains the slot")
            evidence(req.get("evidence"), settled=True)
            task["slot"] = None
            task["parked"] = True
            task["last_settlement"] = req["evidence"]
            return {"parked": True}
        if op == "recover":
            require(task["phase"] != "closed", "closed", "a completed task must be reopened before recovery")
            require(not task["reservations"] and not task["pending_intent"], "unsettled", "settle all executions before routing recovery or releasing its slot")
            evidence(req.get("evidence"), settled=True)
            decision = req.get("decision", {})
            require(isinstance(decision, dict) and all(nonempty(decision.get(k)) for k in
                    ("id", "runId", "diagnosis", "route", "evidence", "nextAction", "fingerprint")),
                    "invalid", "recovery needs the controller decision, diagnosis, evidence and next action")
            require(decision["runId"] == task["refs"].get("run_id"), "identity", "recovery must name the registered controller run")
            require(decision["route"] in {"park", "split", "adjudicate", "reimplement", "repair", "follow-up", "resolved"},
                    "invalid", "unsupported recovery route")
            require(nonempty(req.get("acceptance_ref")), "evidence", "retain the original task acceptance contract")
            records = task.setdefault("recoveries", {})
            record = {"decision": decision, "acceptance_ref": req["acceptance_ref"], "evidence": req["evidence"]}
            if decision["id"] in records:
                previous = records[decision["id"]]
                require(previous["decision"] == decision and previous["acceptance_ref"] == req["acceptance_ref"],
                        "identity", "a recovery decision is immutable")
                return {"recovery_id": decision["id"], "replayed": True}
            require(not task.get("recovery_open"), "recovery", "resolve the existing recovery before replacing it")
            if task.get("recovery_acceptance_ref"):
                require(task["recovery_acceptance_ref"] == req["acceptance_ref"], "identity", "successors must retain the original acceptance contract")
            records[decision["id"]] = record
            task.update(recovery=decision, recovery_acceptance_ref=req["acceptance_ref"],
                        recovery_open=decision["route"] not in {"resolved", "follow-up"},
                        next_action=decision["nextAction"], slot=None, parked=True, last_settlement=req["evidence"])
            if task["recovery_open"]:
                task["blocker"] = decision
            return {"recovery_id": decision["id"], "parked": True}
        if op == "resolve_recovery":
            require(task.get("recovery_open") and req.get("recovery_id") == task["recovery"]["id"],
                    "identity", "resolution must name the open recovery")
            require(not task["reservations"] and not task["pending_intent"], "unsettled", "settle recovery work first")
            evidence(req.get("evidence"), settled=True)
            require(nonempty(req.get("resolution")), "evidence", "record the decision or changed evidence enabling continuation")
            Engine._dependencies_complete(state, task)
            task["recoveries"][task["recovery"]["id"]]["resolution"] = {
                "text": req["resolution"], "evidence": req["evidence"]}
            task.update(recovery_open=False, blocker=None, next_action=req["resolution"])
            return {"resolved": req["recovery_id"]}
        if op == "observe":
            fields = req.get("fields", {})
            allowed = {"blocker", "next_action", "findings", "refs", "pr", "acceptance", "usage", "identity"}
            require(isinstance(fields, dict) and fields and set(fields) <= allowed, "invalid", "unsupported observation fields")
            evidence(req.get("evidence"))
            if "refs" in fields:
                require(isinstance(fields["refs"], dict), "invalid", "refs must be an object")
                changed = any(k in task["refs"] and task["refs"][k] != v for k, v in fields["refs"].items())
                if changed:
                    require(not task["reservations"] and not task["pending_intent"], "unsettled", "settle the old execution before rebinding")
                    successor = req.get("successor", {})
                    require(successor.get("previous_refs") == task["refs"], "identity", "explicit successor must name all previous references")
                    evidence(successor.get("evidence"), settled=True)
                require(all(nonempty(v) for v in fields["refs"].values()), "identity", "reference values must be explicit identifiers")
                fields = copy.deepcopy(fields)
                fields["refs"] = {**task["refs"], **fields["refs"]}
            if "identity" in fields:
                require(caller == "coordinator" and not task["reservations"] and not task["pending_intent"],
                        "unsettled", "only coordinator may rebind a settled session identity")
            task.update(fields)
            task["last_observation"] = req["evidence"]
            return {"observed": sorted(fields)}
        if op == "delegate":
            executor = req.get("executor")
            require(executor in {"coordinator", task["driver"]}, "forbidden", "executor must be the registered driver or coordinator")
            actions = req.get("actions", [])
            require(isinstance(actions, list) and actions and set(actions) <= set(config["authority"]), "authority", "delegation exceeds run authority")
            require(task["pending_intent"] is None, "uncertain", "reconcile the pending executor before replacing delegation")
            task["delegation"] = {"executor": executor, "actions": actions, "policy_version": state["policy_version"]}
            return {"delegation": task["delegation"]}
        if op == "intent":
            kind = req.get("kind")
            Engine._active(state, task, kind, launching=True)
            require(task["slot"] is not None, "capacity", "action requires an execution slot")
            require(task["pending_intent"] is None, "uncertain", "inspect and reconcile the existing pending action")
            Engine._delegated(state, task, caller, kind)
            require(isinstance(req.get("target"), dict) and req["target"], "identity", "explicit side-effect target is required")
            evidence(req.get("evidence"))
            if kind == "split":
                require(caller == "coordinator", "forbidden", "only the coordinator creates dependency tasks")
                target = req["target"]
                require(task.get("recovery_open") and task["recovery"]["route"] == "split"
                        and target.get("recovery_id") == task["recovery"]["id"]
                        and target.get("authority") == config["tracker"]["authority"]
                        and target.get("parent_task") == task["id"]
                        and target.get("acceptance_ref") == task["recovery_acceptance_ref"],
                        "identity", "split must retain the registered recovery, parent, authority and acceptance")
                children = target.get("children", [])
                require(isinstance(children, list) and children and all(isinstance(c, dict) and
                        all(nonempty(c.get(k)) for k in ("key", "title", "acceptance")) for c in children),
                        "invalid", "each prerequisite needs a stable causal key, title and acceptance criteria")
                keys = [c["key"] for c in children]
                recorded = set(task.get("created_tasks", {})) | set(task.get("reused_tasks", {}))
                require(len(keys) == len(set(keys)) and not set(keys) & recorded,
                        "duplicate", "reconcile the recorded dependency for a previously associated causal key")
                reused = [c["existing_task"] for c in children if "existing_task" in c]
                require(all(nonempty(child) and child in config["scope"]["task_ids"] for child in reused),
                        "identity", "existing prerequisites must name registered canonical task IDs")
                require(len(reused) == len(set(reused)), "duplicate", "associate each existing prerequisite once")
                Engine._acyclic_dependencies(state, task["id"], reused)
            counted = any(limit["unit"] == Engine.UNITS[kind] for limit in config.get("limits", []))
            reservation = task["reservations"].get(req.get("reservation_id"))
            reserved = any(r["kind"] == kind for r in task["reservations"].values())
            if kind in {"implement", "repair", "review", "validate"} or counted or reserved or "reservation_id" in req:
                require(reservation and reservation["kind"] == kind and not reservation.get("intent_id"),
                        "budget", "action requires an unconsumed counted reservation")
                for limit in config.get("limits", []):
                    if limit["unit"] == reservation["unit"]:
                        counters = Engine._family_counters(state, task) if limit["scope"] == "task" else state["counters"]
                        require(counters.get(reservation["unit"], 0) <= limit["max"],
                                "budget", "current cumulative limit no longer permits this reserved assignment")
                reservation["intent_id"] = req["action_id"]
                reservation["status"] = "issued"
            else:
                # Consequential actions without a configured cap are still counted,
                # so introducing a later cap cannot erase already-attempted work.
                for counters in (task["counters"], state["counters"]):
                    counters[Engine.UNITS[kind]] = counters.get(Engine.UNITS[kind], 0) + 1
            if kind == "merge":
                require(all(r["kind"] == "merge" for r in task["reservations"].values()),
                        "unsettled", "settle source and review executions before merging")
                Engine._merge_gate(state, task, req)
            if kind == "close":
                Engine._close_gate(state, task, req)
            if kind == "deploy":
                require(req["target"].get("environment") == "shared-staging", "identity",
                        "v1 deployment target must name the managed shared-staging environment")
                require(state["staging"]["owner"] == task["id"]
                        and type(req["target"].get("staging_generation")) is int
                        and req["target"]["staging_generation"] == state["staging"]["generation"],
                        "ownership", "deployment requires current authoritative staging ownership and generation")
            task["pending_intent"] = {"id": req["action_id"], "executor": caller, "kind": kind,
                                      "target": req["target"], "evidence": req["evidence"],
                                      "policy_version": state["policy_version"], "status": "pending"}
            return {"intent": task["pending_intent"]}
        if op == "outcome":
            pending = task["pending_intent"]
            require(pending is not None and pending["id"] == req.get("intent_id"), "identity", "outcome must match the pending action")
            require(pending["kind"] in Engine.ACTIONS, "invalid", "use the dedicated tracker outcome operation")
            require(caller in {"coordinator", pending["executor"]}, "forbidden", "only pending executor or coordinator may record outcome")
            require(req.get("target") == pending["target"], "identity", "outcome target differs from pending action")
            status = req.get("status")
            require(status in {"unknown", "succeeded", "failed", "not_started"}, "invalid", "invalid external outcome")
            evidence(req.get("receipt"))
            if pending["kind"] == "split" and status in {"failed", "not_started"}:
                require(req["receipt"].get("no_effects") is True, "uncertain",
                        "failed creation can be retried only after proving no tasks or dependency edges were created; otherwise reconcile as unknown")
            if status == "unknown":
                pending["status"] = "unknown"
                pending["receipt"] = req["receipt"]
            else:
                task["last_outcome"] = {**pending, "status": status, "receipt": req["receipt"]}
                task["pending_intent"] = None
                if status == "succeeded" and pending["kind"] == "split":
                    target, receipt = pending["target"], req["receipt"]
                    children = receipt.get("children", {})
                    planned_reuse = {c["key"]: c["existing_task"] for c in target["children"] if "existing_task" in c}
                    reused = receipt.get("reused", {})
                    require(isinstance(reused, dict) and reused == planned_reuse,
                            "identity", "reuse receipt must confirm the exact planned canonical prerequisites")
                    require(isinstance(children, dict) and set(children) == {c["key"] for c in target["children"] if "existing_task" not in c}
                            and all(nonempty(child) and child != task["id"] for child in children.values())
                            and len(set(children.values()) | set(reused.values())) == len(children) + len(reused),
                            "identity", "split receipt must bind every causal key to a unique tracker task")
                    dependencies = set(task.get("recovery_dependencies", [])) | set(children.values()) | set(reused.values())
                    edges = receipt.get("blocked_by")
                    require(receipt.get("authority") == target["authority"] and receipt.get("parent_task") == task["id"]
                            and receipt.get("unpublished") is False
                            and isinstance(edges, list) and all(nonempty(child) for child in edges)
                            and len(edges) == len(set(edges)) and set(edges) == dependencies,
                            "dependency", "split needs published canonical tasks and real parent dependency edges")
                    links = state.setdefault("task_links", {})
                    existing = set(state["tasks"]) | set(links) | set(state["claims"])
                    existing.update(child for t in state["tasks"].values() for child in t.get("reused_tasks", {}).values())
                    require(not set(children.values()) & existing,
                            "duplicate", "a created task is already admitted or bound to another recovery")
                    Engine._acyclic_dependencies(state, task["id"], dependencies)
                    for key, child in children.items():
                        links[child] = {"parent": task["id"], "budget_root": task.get("budget_root", task["id"]),
                                        "acceptance_ref": target["acceptance_ref"], "key": key}
                    task.setdefault("created_tasks", {}).update(children)
                    task.setdefault("reused_tasks", {}).update(reused)
                    task["recovery_dependencies"] = sorted(dependencies)
                    task["next_action"] = "Complete the recorded prerequisites, then resume the original acceptance contract."
                if status == "succeeded" and pending["kind"] == "merge":
                    require(req["receipt"].get("head") == pending["target"].get("head")
                            and nonempty(req["receipt"].get("merge_commit")), "evidence", "merge receipt needs exact merged head and merge commit")
                    task["phase"] = "merged"
                    task["merged_prs"][str(pending["target"]["pr"])] = {
                        "head": pending["target"]["head"], "merge_commit": req["receipt"]["merge_commit"],
                        "receipt": req["receipt"], "intent_id": pending["id"], "outcome_action_id": req["action_id"],
                    }
            return {"outcome": status}
        if op == "close":
            last = task.get("last_outcome", {})
            reconciled_close = (last.get("kind") == "close" and last.get("status") == "succeeded"
                                and req.get("receipt") == last.get("receipt"))
            Engine._active(state, task, "close", reconciling=reconciled_close)
            require(not task.get("recovery_open"), "recovery", "parked recovery is incomplete, not completed acceptance")
            Engine._dependencies_complete(state, task)
            require(not task["reservations"] and not task["pending_intent"] and state["staging"]["owner"] != task["id"],
                    "unsettled", "settle executions and release staging before closure")
            receipt = req.get("receipt", {})
            evidence(receipt)
            if any(limit["unit"] == "closure" for limit in config.get("limits", [])):
                last = task.get("last_outcome", {})
                require(last.get("kind") == "close" and last.get("status") == "succeeded",
                        "budget", "counted closure requires the successful reserved tracker action")
            require(receipt.get("authority") == config["tracker"]["authority"]
                    and receipt.get("task_id") == task["id"] and receipt.get("owner") == task["claim"]["owner"]
                    and receipt.get("status") == "closed" and receipt.get("unpublished") is False
                    and receipt.get("criteria_met") is True and nonempty(receipt.get("acceptance_ref")),
                    "closure", "canonical published closure and required acceptance evidence are required")
            task["phase"] = "closed"
            task["closure"] = receipt
            task["slot"] = None
            task["parked"] = True
            return {"closed": task["id"]}
        if op == "staging":
            current = state["staging"]
            require(req.get("expected_owner") == current["owner"] and req.get("expected_generation") == current["generation"],
                    "ownership", "staging owner/generation changed")
            new_owner = req.get("to_task")
            require(new_owner is None or new_owner in state["tasks"], "scope", "staging successor must be an admitted task")
            require(caller == "coordinator" or current["owner"] == task["id"]
                    or current["owner"] is None and new_owner == task["id"], "forbidden", "only owner may hand off staging")
            evidence(req.get("evidence"), settled=current["owner"] is not None)
            if current["owner"] is not None:
                old = state["tasks"][current["owner"]]
                require(not old["reservations"] and not old["pending_intent"], "unsettled", "prior staging owner has outstanding work")
            if new_owner is not None:
                if current["owner"] is not None:
                    Engine._active(state, old, "deploy")
                successor = state["tasks"][new_owner]
                Engine._active(state, successor, "deploy")
                if caller != "coordinator":
                    delegation = task["delegation"] or {}
                    require(delegation.get("executor") == caller and "deploy" in delegation.get("actions", [])
                            and delegation.get("policy_version") == state["policy_version"],
                            "authority", "staging grants require current delegated deployment authority")
                require(nonempty(req.get("purpose")) and nonempty(req.get("release_condition")), "invalid", "staging grant needs purpose and release condition")
            state["staging"] = {"owner": new_owner, "generation": current["generation"] + 1,
                                "purpose": req.get("purpose"), "release_condition": req.get("release_condition"),
                                "revision": req.get("revision"), "configuration": req.get("configuration"),
                                "evidence": req["evidence"]}
            return {"staging": state["staging"]}
        raise StateError("invalid", "unknown operation")

    @staticmethod
    def summary(state):
        return {
            "done": [t["id"] for t in state["tasks"].values() if task_complete(t)],
            "parked": [{"task_id": t["id"], "blocker": t.get("blocker"), "next_action": t.get("next_action")}
                       for t in state["tasks"].values() if not task_complete(t) and t["parked"]],
            "created": [{"task_id": child, **link} for child, link in state.get("task_links", {}).items()],
        }

    @staticmethod
    def _family_counters(state, task):
        root = task.get("budget_root", task["id"])
        counts = {}
        for member in state["tasks"].values():
            if member.get("budget_root", member["id"]) == root:
                for unit, count in member["counters"].items():
                    counts[unit] = counts.get(unit, 0) + count
        return counts

    @staticmethod
    def _acyclic_dependencies(state, parent, children):
        pending, visited = list(children), set()
        while pending:
            child = pending.pop()
            require(child != parent, "dependency", "a prerequisite cannot create a dependency cycle")
            if child in visited:
                continue
            visited.add(child)
            task = state["tasks"].get(child, {})
            pending.extend(task.get("recovery_dependencies", []))
            intent = task.get("pending_intent") or {}
            if intent.get("kind") == "split":
                pending.extend(c["existing_task"] for c in intent["target"]["children"] if "existing_task" in c)

    @staticmethod
    def _dependencies_complete(state, task):
        require(all(task_complete(state["tasks"].get(child, {})) for child in task.get("recovery_dependencies", [])),
                "dependency", "all recorded prerequisites must complete before the parent resumes, merges or closes")

    @staticmethod
    def _close_gate(state, task, req):
        require(not task.get("recovery_open"), "recovery", "resolve parked recovery before closure")
        Engine._dependencies_complete(state, task)
        target, proof = req["target"], req["evidence"]
        require(target.get("authority") == state["config"]["tracker"]["authority"]
                and target.get("task_id") == task["id"] and target.get("owner") == task["claim"]["owner"],
                "identity", "closure target must name the canonical task, authority and current owner")
        require(all(key == req.get("reservation_id") and reservation["kind"] == "close"
                    for key, reservation in task["reservations"].items())
                and state["staging"]["owner"] != task["id"],
                "unsettled", "settle other executions and release staging before authorizing closure")
        evidence(proof, settled=True)
        require(proof.get("criteria_met") is True and nonempty(proof.get("acceptance_ref")),
                "closure", "closure authorization requires completed acceptance evidence")

    @staticmethod
    def _merge_gate(state, task, req):
        require(not task.get("recovery_open"), "recovery", "resolve parked recovery before merge")
        Engine._dependencies_complete(state, task)
        target = req["target"]
        gates = req.get("gates", {})
        require(target.get("repository") == state["config"]["repository"]["path"]
                and target.get("base") == state["config"]["repository"]["target"]
                and type(target.get("pr")) is int and nonempty(target.get("head")),
                "identity", "merge target must name this repository, target, PR and exact head")
        required = {"complete", "validation", "checks", "feedback", "findings", "target_current", "clean"}
        require(all(gates.get(key) is True for key in required), "gate", "merge gate is incomplete")
        require(all(gates.get(key) == target["head"] for key in ("review_head", "checkout_head", "pr_head")),
                "gate", "review, checkout and live PR must certify the candidate head")
        require(nonempty(gates.get("controller_id")) and nonempty(gates.get("run_id"))
                and all(gates.get(k) == task["refs"].get(k) for k in ("controller_id", "run_id"))
                and nonempty(gates.get("review_base")), "identity", "merge evidence must use registered exact controller/run and base")
        require(all(nonempty(task["refs"].get(key)) and gates.get(key) == task["refs"][key]
                    for key in ("review_base", "review_head")),
                "identity", "merge base and head must match the registered certified review range")
        require(gates.get("commit_mode") == "per-round" or gates.get("commit_mode") == "none"
                and gates.get("source_mapping_applicable") is True,
                "gate", "adopted none mode needs explicit source and Git-aware validation applicability")
