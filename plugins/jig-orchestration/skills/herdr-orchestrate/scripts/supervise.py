#!/usr/bin/env python3
"""Local orchestration state commands and a guarded Herdr wake-up process.

No command installs software, launches task workers, or executes a merge. The
state helper records authority and evidence; the skill's driver performs gates.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import signal
import subprocess
import sys
import time
import uuid

from state import Engine, StateError, host_roles, scheduler_deadline, scheduler_identity, scheduler_seconds

MAX_INPUT = 1024 * 1024
MAX_JSON_DEPTH = 64
HEALTH_ALERT_MAX_ATTEMPTS = 3
HEALTH_ALERT_RETRY_SECONDS = 60
# Agent CLIs a profile can name; a profile without one is a Codex home.
PROFILE_AGENTS = ("codex", "claude")


class RuntimeErrorDetail(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def timestamp(value=None):
    return (value or datetime.now(timezone.utc)).isoformat()


def parse_time(value):
    if value is None:
        return None
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise RuntimeErrorDetail("invalid_timestamp", "Timestamps require a timezone")
    return result


def read_json(source):
    if source == "-":
        raw = sys.stdin.read(MAX_INPUT + 1)
    else:
        with open(source, encoding="utf-8") as stream:
            raw = stream.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise RuntimeErrorDetail("input_too_large", "JSON input exceeds 1 MiB")
    try:
        value = json.loads(raw)
    except RecursionError as error:
        raise RuntimeErrorDetail("invalid_input", "JSON input is nested too deeply") from error
    if not isinstance(value, dict):
        raise RuntimeErrorDetail("invalid_input", "Expected a JSON object")
    # Parsing may tolerate more nesting than later copying and serialization.
    pending = [(value, 1)]
    while pending:
        container, depth = pending.pop()
        if depth > MAX_JSON_DEPTH:
            raise RuntimeErrorDetail("invalid_input", "JSON input is nested too deeply")
        children = container.values() if isinstance(container, dict) else container
        pending.extend((child, depth + 1) for child in children if isinstance(child, (dict, list)))
    return value


def output(value):
    print(json.dumps(value, ensure_ascii=True, sort_keys=True), flush=True)


def positive_seconds(value, name):
    try:
        return scheduler_seconds(value, name)
    except StateError as exc:
        raise RuntimeErrorDetail("invalid_config", str(exc)) from exc


def scheduler_config(config, schedule=None):
    settings = config.get("scheduler", {})
    if not isinstance(settings, dict):
        raise RuntimeErrorDetail("invalid_config", "scheduler must be an object")
    if schedule is not None:
        # Existing runs may have a runtime stop/resume newer than their config.
        settings = {**settings, "enabled": schedule.get("enabled", settings.get("enabled", False))}
    if not settings:
        return {"enabled": False, "cadence_seconds": 1200, "minimum_cadence_seconds": 1200}
    cadence = positive_seconds(settings.get("cadence_seconds", 1200), "cadence_seconds")
    minimum = positive_seconds(settings.get("minimum_cadence_seconds", cadence), "minimum_cadence_seconds")
    busy_timeout = positive_seconds(settings.get("busy_timeout_seconds", 3 * max(cadence, minimum)), "busy_timeout_seconds")
    try:
        scheduler_identity(settings)
    except StateError as exc:
        raise RuntimeErrorDetail("invalid_config", str(exc)) from exc
    notifier = settings.get("notifier_argv")
    if notifier is not None:
        if settings.get("notification_authorized") is not True:
            raise RuntimeErrorDetail("notification_unauthorized", "Configure a notifier only with explicit destination authorization")
        if not isinstance(notifier, list) or not notifier or not all(isinstance(x, str) and x and "\0" not in x for x in notifier):
            raise RuntimeErrorDetail("invalid_config", "notifier_argv must be a nonempty argument array")
        if not Path(notifier[0]).is_absolute():
            raise RuntimeErrorDetail("invalid_config", "Use an absolute notifier executable path")
    return {**settings, "cadence_seconds": cadence, "minimum_cadence_seconds": minimum,
            "busy_timeout_seconds": busy_timeout}


def scheduler_patch(run_dir, build, check_heartbeat=False):
    """Recompute the update on a version race; never replay an external effect."""
    for _ in range(5):
        current = Engine.read(run_dir)
        fields = build(current)
        if fields is None:
            return current
        request = {
            "op": "scheduler", "action_id": "schedule-" + uuid.uuid4().hex,
            "expected_policy": current["policy_version"],
            "expected_scheduler": current["scheduler"].get("version", 0), "fields": fields,
        }
        if check_heartbeat:
            request["expected_heartbeat"] = current["scheduler"].get("heartbeat_at")
        try:
            Engine.apply(run_dir, request, caller="coordinator")
            return Engine.read(run_dir)
        except StateError as exc:
            if exc.code not in {"stale_scheduler", "stale_policy", "stale_heartbeat"}:
                raise
    raise RuntimeErrorDetail("concurrent_update", "Scheduler state changed repeatedly; retry the state operation")


@contextmanager
def exclusive(run_dir, name):
    # Engine validates directory ownership and permissions before any lock open.
    Engine.read(run_dir)
    path = Path(run_dir) / name
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeErrorDetail("already_running", f"Another process owns {name}") from None
        yield


def managed_guard(settings):
    if os.environ.get("HERDR_ENV") != "1":
        raise RuntimeErrorDetail("not_managed", "Run Herdr controls from a genuine Herdr-managed pane")
    if os.environ.get("HERDR_PANE_ID") != settings.get("control_pane_id"):
        raise RuntimeErrorDetail("control_pane_mismatch", "This is not the registered scheduler control pane")
    if os.environ["HERDR_PANE_ID"] == settings["agent"]["pane_id"]:
        raise RuntimeErrorDetail("self_prompt", "Refusing to prompt the scheduler's own pane")


def herdr_call(settings, args):
    managed_guard(settings)
    command = [settings.get("herdr_binary", "herdr"), "--session", settings["session"], *args]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=25, check=False)
        if result.returncode:
            raise RuntimeErrorDetail("herdr_failed", f"Herdr {args[0:2]} failed with exit {result.returncode}; inspect the registered endpoint")
        response = json.loads(result.stdout)
        if not isinstance(response, dict) or response.get("error"):
            raise ValueError("Invalid response or API error")
        if not isinstance(response["result"], dict):
            raise ValueError("Invalid result")
        return response["result"]
    except (ValueError, KeyError, TypeError):
        raise RuntimeErrorDetail("invalid_herdr_response", "Herdr did not return a successful structured result") from None


def verify_identity(actual, expected):
    if not isinstance(actual, dict):
        raise RuntimeErrorDetail("invalid_herdr_response", "Herdr did not return an agent object")
    for field in ("name", "agent", "pane_id", "terminal_id"):
        if actual.get(field) != expected[field]:
            raise RuntimeErrorDetail("identity_mismatch", f"Coordinator {field} changed; rebind explicitly")
    native = actual.get("agent_session") or {}
    if not isinstance(native, dict):
        raise RuntimeErrorDetail("invalid_herdr_response", "Herdr did not return a native session object")
    for field in ("agent", "kind", "value"):
        if native.get(field) != expected["agent_session"][field]:
            raise RuntimeErrorDetail("identity_mismatch", "Coordinator native session changed; rebind explicitly")


def enabled(state, settings):
    return state["scheduler"].get("enabled", settings.get("enabled", False)) is True


def endpoint_failure(schedule):
    failure = schedule.get("failure") or {}
    return failure if failure.get("id", "").startswith("endpoint-") else None


def tick(run_dir, now=None):
    now = now or datetime.now(timezone.utc)
    with exclusive(run_dir, "delivery.lock"):
        state = Engine.read(run_dir)
        settings = scheduler_config(state["config"], state["scheduler"])
        if not enabled(state, settings):
            return {"status": "scheduler_stopped"}
        managed_guard(settings)
        Engine.heartbeat(run_dir, timestamp(now))
        state = Engine.read(run_dir)
        schedule = state["scheduler"]
        if schedule.get("pending_action_id"):
            return {"status": "awaiting_reconciliation", "wake_id": schedule["pending_action_id"],
                    "delivery_status": schedule.get("delivery_status")}
        last = parse_time(schedule.get("last_attempt_at"))
        completed = parse_time(schedule.get("last_completed_at"))
        if completed and (last is None or completed > last):
            last = completed
        due = parse_time(schedule.get("next_due_at"))
        requested = bool(schedule.get("wake_requested_at"))
        if last and now < scheduler_deadline(last, settings["minimum_cadence_seconds"]):
            return {"status": "minimum_cadence"}
        if due and now < due and not requested:
            return {"status": "not_due", "next_due_at": timestamp(due)}
        scheduler_patch(run_dir, lambda _: {"last_attempt_at": timestamp(now),
                        "next_due_at": timestamp(scheduler_deadline(now, settings["cadence_seconds"]))})

        def check_binding(current):
            if scheduler_config(current["config"], current["scheduler"]) != settings:
                raise RuntimeErrorDetail("scheduler_rebound", "Scheduler configuration changed during identity lookup; inspect again")

        try:
            actual = herdr_call(settings, ["agent", "get", settings["agent"]["name"]])["agent"]
            verify_identity(actual, settings["agent"])
            status = actual.get("agent_status", "unknown")
            if status not in {"working", "idle", "done"}:
                raise RuntimeErrorDetail("coordinator_" + str(status),
                    f"Coordinator at {settings['session']}/{settings['agent']['pane_id']} is {status}; inspect its original pane")
            def recovered(current):
                check_binding(current)
                return {"failure": None} if endpoint_failure(current["scheduler"]) else None
            scheduler_patch(run_dir, recovered)  # Verified recovery survives a concurrent manual completion.
            if status == "working":
                def busy(current):
                    check_binding(current)
                    if current["scheduler"].get("last_completed_action_id") != schedule.get("last_completed_action_id"):
                        return None
                    return {"delivery_status": "busy", "failure": None,
                            "busy_since_at": current["scheduler"].get("busy_since_at") or timestamp(now)}
                scheduler_patch(run_dir, busy)
                return {"status": "busy", "agent_status": status}
        except (RuntimeErrorDetail, OSError, subprocess.TimeoutExpired, KeyError, TypeError) as exc:
            code = str(getattr(exc, "code", type(exc).__name__))
            def failed(current):
                check_binding(current)
                previous = current["scheduler"].get("failure") or {}
                continuing = previous.get("code") == code or previous.get("id") == "endpoint-" + code
                return {"failure": {"id": previous["id"] if continuing else "endpoint-" + uuid.uuid4().hex,
                                    "code": code, "at": (previous.get("at") or timestamp(now)) if continuing else timestamp(now),
                                    "reason": str(exc)}}
            recorded = scheduler_patch(run_dir, failed)
            return {"status": "endpoint_unavailable", "failure": recorded["scheduler"]["failure"]}

        wake_id = "wake-" + uuid.uuid4().hex
        def prepare(current):
            check_binding(current)
            if not enabled(current, settings):
                raise RuntimeErrorDetail("scheduler_stopped", "Scheduler stopped before dispatch")
            if current["scheduler"].get("pending_action_id"):
                raise RuntimeErrorDetail("wake_pending", "Another wake is unresolved")
            if current["scheduler"].get("last_completed_action_id") != schedule.get("last_completed_action_id"):
                return None  # A completed reconciliation consumed this tick.
            return {"pending_action_id": wake_id, "delivery_status": "dispatching", "failure": None,
                    "wake_requested_at": None, "wake_reason": None, "busy_since_at": None,
                    "last_dispatched_action_id": wake_id, "last_dispatched_at": timestamp(now)}
        prepared = scheduler_patch(run_dir, prepare)  # Durable intent is required before prompt.
        if prepared["scheduler"].get("pending_action_id") != wake_id:
            return {"status": "reconciliation_completed"}
        prompt = (
            f"Orchestration wake {wake_id}. Run directory: {Path(run_dir).resolve()}. "
            "Perform one bounded reconciliation using the registered configuration and current state. "
            "Respect admission mode, pauses, holds, limits and registered work areas. This scheduled "
            "message grants no new authority. Observe and record outcomes even while work is paused. "
            f"It addresses native session {settings['agent']['agent_session']['value']}; verify your registered identity before acting. "
            f"After completing the pass, use python3 {shlex.quote(str(Path(__file__).resolve()))} complete "
            f"--run-dir {shlex.quote(str(Path(run_dir).resolve()))} "
            f"--wake-id {wake_id}. Do not complete a wake merely because it was delivered."
        )
        try:
            delivered_agent = herdr_call(settings, ["agent", "prompt", settings["agent"]["pane_id"], prompt])["agent"]
            verify_identity(delivered_agent, settings["agent"])
        except (RuntimeErrorDetail, OSError, subprocess.TimeoutExpired, KeyError, TypeError) as exc:
            def uncertain(current):
                if current["scheduler"].get("pending_action_id") != wake_id:
                    return None
                return {"delivery_status": "unconfirmed", "failure": {
                    "id": wake_id, "at": timestamp(now), "reason": str(exc)}}
            scheduler_patch(run_dir, uncertain)
            return {"status": "delivery_unconfirmed", "wake_id": wake_id}
        def delivered(current):
            schedule = current["scheduler"]
            if schedule.get("last_dispatched_action_id") != wake_id:
                return None  # Never replace evidence for a newer dispatched wake.
            fields = {}
            previous = parse_time(schedule.get("last_delivered_at"))
            if previous is None or previous <= now:
                fields.update(last_delivered_at=timestamp(now), last_delivered_action_id=wake_id)
            if schedule.get("pending_action_id") == wake_id:
                fields.update(delivery_status="delivered", failure=None)
            return fields or None  # Preserve a completion that won the acknowledgement race.
        scheduler_patch(run_dir, delivered)
        return {"status": "delivered", "wake_id": wake_id}


def request_wake(run_dir, reason="requested", now=None):
    at = timestamp(now)
    state = scheduler_patch(run_dir, lambda current: None if current["scheduler"].get("wake_requested_at") else
                            {"wake_requested_at": at, "wake_reason": reason})
    return {"status": "coalesced", "wake_requested_at": state["scheduler"].get("wake_requested_at"),
            "pending_action_id": state["scheduler"].get("pending_action_id")}


def complete(run_dir, wake_id, now=None):
    now = now or datetime.now(timezone.utc)
    def finish(current):
        schedule = current["scheduler"]
        if (schedule.get("last_completed_action_id") == wake_id
                or wake_id != "manual" and schedule.get("last_completed_wake_id") == wake_id):
            return None
        pending = schedule.get("pending_action_id")
        if wake_id != "manual" and pending != wake_id:
            raise RuntimeErrorDetail("wrong_wake", "Completion must name the pending wake or 'manual' for a full manual pass")
        settings = scheduler_config(current["config"], current["scheduler"])
        interval = max(settings["cadence_seconds"], settings["minimum_cadence_seconds"])
        # Dispatch already consumed earlier requests. Anything now queued arrived
        # during this pass; only a full manual reconciliation may consume it too.
        requested = schedule.get("wake_requested_at") if wake_id != "manual" else None
        return {"pending_action_id": None, "delivery_status": "completed", "last_completed_at": timestamp(now),
                "last_completed_action_id": wake_id if wake_id != "manual" else "manual-" + uuid.uuid4().hex,
                "last_completed_wake_id": pending or schedule.get("last_completed_wake_id"),
                "next_due_at": timestamp(scheduler_deadline(now, interval)),
                "wake_requested_at": requested, "wake_reason": schedule.get("wake_reason") if requested else None,
                "failure": endpoint_failure(schedule), "busy_since_at": None}
    state = scheduler_patch(run_dir, finish)
    return {"status": "completed", "last_completed_at": state["scheduler"].get("last_completed_at"),
            "next_due_at": state["scheduler"].get("next_due_at")}


def health_failures(schedule, settings, now, created_at=None):
    """Return active incidents in reporting order, including temporarily hidden ones."""
    failures = []
    heartbeat = parse_time(schedule.get("heartbeat_at"))
    if not heartbeat or now > scheduler_deadline(heartbeat, max(90, settings["cadence_seconds"] * 2)):
        failures.append({"id": "heartbeat-" + str(schedule.get("heartbeat_at")),
                         "reason": "Scheduler heartbeat missing or overdue"})
    if schedule.get("failure"):
        failures.append(schedule["failure"])
    attempted = parse_time(schedule.get("last_attempt_at"))
    if schedule.get("pending_action_id") and attempted and now > scheduler_deadline(attempted, settings["cadence_seconds"] * 2):
        failures.append({"id": "pending-" + schedule["pending_action_id"],
                         "reason": "Wake remains unresolved; inspect coordinator execution"})
    busy_since = parse_time(schedule.get("busy_since_at"))
    if busy_since and now >= scheduler_deadline(busy_since, settings["busy_timeout_seconds"]):
        failures.append({"id": "busy-" + schedule["busy_since_at"],
                         "reason": "Coordinator remains busy beyond the supervision timeout; inspect its registered execution"})
    if not schedule.get("pending_action_id") and not busy_since:
        interval = max(settings["cadence_seconds"], settings["minimum_cadence_seconds"])
        completed = parse_time(schedule.get("last_completed_at"))
        progress = completed or parse_time(schedule.get("last_dispatched_at")) or parse_time(created_at)
        if progress:
            due = scheduler_deadline(progress, interval)
            requested = parse_time(schedule.get("wake_requested_at"))
            if requested:
                due = min(due, max(requested, scheduler_deadline(progress, settings["minimum_cadence_seconds"])))
            if now > scheduler_deadline(due, interval * 2):
                failures.append({"id": "progress-" + timestamp(progress),
                                 "reason": "Eligible reconciliation is overdue despite scheduler liveness"})
    return failures


def release_unsent_claim(run_dir, claim, exc):
    """Journal recovery can make a failed claim durable; this invocation knows it never notified."""
    released = {**claim, "status": "not_started", "error": type(exc).__name__}
    def release(current):
        alerts = current["scheduler"].get("health_alerts", {})
        if alerts.get(claim["failure_id"]) != claim:
            return None
        return {"health_alerts": {**alerts, claim["failure_id"]: released}, "last_alert": released}
    try:
        current = scheduler_patch(run_dir, release)
    except (OSError, RuntimeErrorDetail, StateError):
        return False
    return current["scheduler"].get("health_alerts", {}).get(claim["failure_id"]) != claim


def health(run_dir, now=None):
    now = now or datetime.now(timezone.utc)
    with exclusive(run_dir, "health.lock"):
        decision = {}
        def prepare(current):
            # This callback is rerun on policy/scheduler conflicts. Only its
            # successful durable claim can authorize the external notification.
            decision.clear()
            schedule = current["scheduler"]
            settings = scheduler_config(current["config"], schedule)
            if not enabled(current, settings):
                decision["result"] = {"status": "scheduler_stopped", "alert": "suppressed"}
                return None
            failures = health_failures(schedule, settings, now, current["created_at"])
            active_ids = {failure["id"] for failure in failures}
            previous = schedule.get("health_alerts", {})
            if "health_alerts" not in schedule and schedule.get("alerted_failure_id"):
                # Import the old single-incident record conservatively: lack of
                # a matching receipt cannot prove that notification never began.
                legacy_id = schedule["alerted_failure_id"]
                last = schedule.get("last_alert") or {}
                previous = {legacy_id: last if last.get("failure_id") == legacy_id else
                            {"failure_id": legacy_id, "status": "transport_unconfirmed"}}
            alerts = {key: value for key, value in previous.items() if key in active_ids}
            fields = {"health_alerts": alerts} if alerts != schedule.get("health_alerts") else {}
            if not failures:
                decision["result"] = {"status": "healthy"}
                if schedule.get("alerted_failure_id"):
                    fields["alerted_failure_id"] = None
                return fields or None
            failure = failures[0]
            notice = {"status": "unhealthy", "failure": failure, "run_dir": str(Path(run_dir).resolve())}
            notifier = settings.get("notifier_argv")
            decision["result"] = {**notice, "alert": "local_evidence_only"}
            if not notifier:
                return fields or None
            last = alerts.get(failure["id"])
            attempts = 0
            if last is not None:
                if (last.get("status") != "not_started" or type(last.get("attempts")) is not int
                        or last["attempts"] < 1):
                    decision["result"]["alert"] = "already_attempted"
                    return fields or None
                try:
                    retry_at = scheduler_deadline(parse_time(last["at"]), HEALTH_ALERT_RETRY_SECONDS)
                except (KeyError, TypeError, AttributeError, ValueError, RuntimeErrorDetail):
                    # An incomplete receipt cannot establish that another send is safe.
                    decision["result"]["alert"] = "already_attempted"
                    return fields or None
                attempts = last["attempts"]
                if attempts >= HEALTH_ALERT_MAX_ATTEMPTS:
                    decision["result"]["alert"] = "retry_exhausted"
                    return fields or None
                if now < retry_at:
                    decision["result"]["alert"] = "retry_pending"
                    return fields or None
            claim = {"failure_id": failure["id"], "status": "dispatching", "at": timestamp(now),
                     "attempts": attempts + 1, "notifier_argv": notifier}
            alerts[failure["id"]] = claim
            decision.update(notice=notice, claim=claim)
            return {"health_alerts": alerts, "alerted_failure_id": failure["id"], "last_alert": claim}

        try:
            scheduler_patch(run_dir, prepare, check_heartbeat=True)
        except OSError as exc:
            # Never send a notice whose durable claim failed, or call failed
            # health persistence healthy merely because the heartbeat survived.
            failed = {**decision.get("result", {}), "status": "unhealthy", "alert": "storage_failed",
                      "error": str(exc)}
            if "claim" in decision:
                failed["claim_reconciled"] = release_unsent_claim(run_dir, decision["claim"], exc)
            return failed
        if "claim" not in decision:
            return decision["result"]
        notice, claim = decision["notice"], decision["claim"]
        failure, notifier = notice["failure"], claim["notifier_argv"]
        try:
            # Only the exit status is part of the notifier's output contract.
            result = subprocess.run(notifier, input=(json.dumps(notice) + "\n").encode("utf-8"),
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    timeout=20, check=False)
            receipt = {"failure_id": failure["id"], "at": timestamp(now),
                       "status": "transport_accepted" if result.returncode == 0 else "transport_failed",
                       "returncode": result.returncode}
        except (OSError, subprocess.TimeoutExpired) as exc:
            receipt = {"failure_id": failure["id"], "at": timestamp(now),
                       "status": "not_started" if isinstance(exc, (FileNotFoundError, PermissionError)) else "transport_unconfirmed",
                       "error": type(exc).__name__}
        receipt.update(attempts=claim["attempts"], notifier_argv=notifier)
        def record(current):
            alerts = {**current["scheduler"].get("health_alerts", {}), failure["id"]: receipt}
            return {"health_alerts": alerts, "last_alert": receipt}
        scheduler_patch(run_dir, record)
        return {**notice, "alert": receipt["status"], "receipt": receipt}


def supervise(run_dir):
    state = Engine.read(run_dir)
    settings = scheduler_config(state["config"], state["scheduler"])
    if not enabled(state, settings):
        return {"status": "scheduler_stopped"}
    managed_guard(settings)
    stopping = False
    def stop(signum, frame):
        nonlocal stopping
        stopping = True
    previous = {s: signal.signal(s, stop) for s in (signal.SIGINT, signal.SIGTERM)}
    try:
        with exclusive(run_dir, "supervisor.lock"):
            while not stopping:
                try:
                    result = tick(run_dir)
                    if result["status"] == "scheduler_stopped":
                        return result
                    # Optional stdout failure does not kill supervision.
                    try:
                        output(result)
                    except OSError:
                        pass
                except (StateError, RuntimeErrorDetail, OSError) as exc:
                    try:
                        print(json.dumps({"status": "scheduler_error", "error": str(exc)}), file=sys.stderr, flush=True)
                    except OSError:
                        pass
                time.sleep(5)
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    return {"status": "process_stopped", "scheduler_enabled": True,
            "note": "Intentional scheduler stop must be recorded separately"}


def skill_digest(directory):
    root = Path(directory)
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if not path.is_file() or any(part in {"__pycache__", ".DS_Store", ".pytest_cache"} for part in path.parts):
            continue
        digest.update(path.relative_to(root).as_posix().encode() + b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()


def preflight(config, host_id):
    host = config.get("hosts", {}).get(host_id)
    if not isinstance(host, dict):
        raise RuntimeErrorDetail("unknown_host", "Choose a registered host ID")
    roles = host_roles(host)
    profiles = host.get("profiles", [])
    runtime_roles = set(roles)
    review_agents = set()
    for profile in profiles:
        if not isinstance(profile, dict) or not isinstance(profile.get("agent_home"), str) or not Path(profile["agent_home"]).is_absolute():
            raise RuntimeErrorDetail("invalid_config", "Each profile needs its actual absolute agent_home")
        agent = profile.get("agent", "codex")
        if agent not in PROFILE_AGENTS:
            raise RuntimeErrorDetail("invalid_config", "A profile agent must be codex or claude")
        profile_roles = profile.get("roles", roles)
        runtime_roles.update(profile_roles)
        if "review" in profile_roles:
            review_agents.add(agent)
    required = {"git": (2, 42) if "review" in runtime_roles else None, "herdr": None}
    if "coordinator" in runtime_roles or "review" in runtime_roles:
        required["gh"] = None
    if "coordinator" in runtime_roles:
        required["python3"] = (3, 10)
    if "review" in runtime_roles:
        # Each review profile's agent runs the review pair; a host review role with no review profile keeps the Codex default.
        required.update({"node": (22,), **dict.fromkeys(review_agents or {"codex"})})
    tracker = config.get("tracker", {}).get("kind")
    if "tracker" in runtime_roles and tracker in {"br", "bead"}:
        required[tracker] = None
    for reviewer in host.get("reviewers", []):
        if reviewer not in {"codex", "claude", "cursor"}:
            raise RuntimeErrorDetail("invalid_config", "Unknown reviewer CLI; bind it explicitly before support")
        required["agent" if reviewer == "cursor" else reviewer] = None
    tools = []
    for name, minimum in sorted(required.items()):
        executable = shutil.which(name)
        item = {"tool": name, "path": executable, "ok": False}
        if executable:
            try:
                result = subprocess.run([executable, "--version"], text=True, capture_output=True, timeout=10, check=False)
                version = (result.stdout or result.stderr).strip().splitlines()
                item["version"] = version[0][:200] if version else ""
                match = re.search(r"\d+(?:\.\d+)+", item["version"])
                actual = tuple(map(int, match.group().split("."))) if match else ()
                item["ok"] = result.returncode == 0 and (minimum is None or actual >= minimum)
            except (OSError, subprocess.TimeoutExpired):
                item["error"] = "version_probe_failed"
        tools.append(item)
    installations = []
    for profile in profiles:
        paths = profile.get("skill_paths", {})
        profile_roles = profile.get("roles", roles)
        wanted = set(profile.get("required_skills", []))
        if "coordinator" in profile_roles:
            wanted.update({"herdr-orchestrate", "herdr"})
        if "review" in profile_roles:
            wanted.update({"review-fix-loop", "panel-review"})
        for skill in sorted(wanted):
            path = paths.get(skill)
            exists = isinstance(path, str) and Path(path).is_absolute() and (Path(path) / "SKILL.md").is_file()
            item = {"profile": profile.get("id"), "agent_home": profile["agent_home"], "skill": skill,
                    "path": path, "ok": exists}
            if exists:
                item["sha256"] = skill_digest(path)
                expected = profile.get("expected_skill_hashes", {}).get(skill)
                if expected and expected != item["sha256"]:
                    item["ok"] = False
                    item["error"] = "installed_skill_changed"
            installations.append(item)
    required_skills = set()
    if "coordinator" in runtime_roles:
        required_skills.update({"herdr-orchestrate", "herdr"})
    if "review" in runtime_roles:
        required_skills.update({"review-fix-loop", "panel-review"})
    observed_skills = {item["skill"] for item in installations if item["ok"]}
    missing_skills = sorted(required_skills - observed_skills)
    return {"host": host_id, "observed_at": timestamp(), "tools": tools, "installations": installations,
            "missing_role_skills": missing_skills,
            "local_inventory_ok": bool(runtime_roles and profiles) and not missing_skills and all(x["ok"] for x in tools + installations),
            "unchecked": ["SSH host identity and selected agent environment", "review pair compatibility",
                          "reviewer authentication/model access", "Herdr endpoint/native identity and control contracts",
                          "return-route restriction", "tracker claim/publication contract", "pause and limit enforcement"],
            "note": "Inventory only on the current machine; this does not admit a host or prove authentication"}


def serve(run_dir, caller, request):
    # Pin caller and run-dir in an authorized_keys forced command, with restrict.
    if os.environ.get("SSH_ORIGINAL_COMMAND", ""):
        raise RuntimeErrorDetail("remote_command_rejected", "Send JSON on stdin without a remote command")
    if "caller" in request:
        raise RuntimeErrorDetail("caller_spoof", "Caller identity comes from the forced SSH command")
    state = Engine.read(run_dir)
    actor = state["config"].get("actors", {}).get(caller)
    if caller == "coordinator" or not actor or actor.get("helper_route") is not True:
        raise RuntimeErrorDetail("unknown_caller", "Only a registered restricted worker route may serve requests")
    if request.get("op") == "query":
        task_id = request.get("task_id")
        if task_id not in actor.get("task_ids", []):
            raise RuntimeErrorDetail("wrong_task", "Caller is not assigned this task")
        task = state["tasks"].get(task_id)
        if task is not None and (task["driver"] != caller or task["host"] != actor["host"]):
            raise RuntimeErrorDetail("wrong_task", "Caller does not drive this task on its registered host")
        return {"policy_version": state["policy_version"], "controls": state["controls"],
                "task": task, "staging": state["staging"]}
    if request.get("op") == "action":
        record = Engine.action(run_dir, request["action_id"])
        if record is None:
            return {"status": "not_found"}
        # The engine records the original caller; do not disclose other workers' records.
        if record.get("caller") != caller:
            raise RuntimeErrorDetail("wrong_caller", "Action belongs to another caller")
        return record
    return Engine.apply(run_dir, request, caller=caller)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("init", "status", "apply", "action", "serve", "tick", "supervise", "wake", "complete", "health"):
        child = sub.add_parser(name)
        child.add_argument("--run-dir", required=True)
        if name == "init":
            child.add_argument("--config", required=True)
        elif name == "status":
            child.add_argument("--task")
        elif name == "apply":
            child.add_argument("--request", default="-")
        elif name == "action":
            child.add_argument("--id", required=True)
        elif name == "serve":
            child.add_argument("--caller", required=True)
        elif name == "wake":
            child.add_argument("--reason", default="requested")
        elif name == "complete":
            child.add_argument("--wake-id", required=True)
    probe = sub.add_parser("preflight")
    probe.add_argument("--config", required=True)
    probe.add_argument("--host", required=True)
    args = parser.parse_args(argv)
    if args.command != "serve" and os.environ.get("SSH_ORIGINAL_COMMAND"):
        raise RuntimeErrorDetail("remote_command_rejected", "Restricted routes may only use serve")
    if args.command == "init":
        config = read_json(args.config)
        settings = scheduler_config(config)
        next_due = timestamp(scheduler_deadline(datetime.now(timezone.utc), settings["cadence_seconds"]))
        result = Engine.initialize(args.run_dir, config)
        scheduler_patch(args.run_dir, lambda _: {"enabled": settings.get("enabled", False),
                        "next_due_at": next_due})
        return {"status": "initialized", "policy_version": result["policy_version"],
                "scheduler_started": False, "notifications": "authorized" if settings.get("notifier_argv") else "local_evidence_only"}
    if args.command == "status":
        state = Engine.read(args.run_dir)
        return state["tasks"].get(args.task) if args.task else {**state, "summary": Engine.summary(state)}
    if args.command == "apply":
        return Engine.apply(args.run_dir, read_json(args.request), caller="coordinator")
    if args.command == "action":
        return Engine.action(args.run_dir, args.id)
    if args.command == "serve":
        return serve(args.run_dir, args.caller, read_json("-"))
    if args.command == "preflight":
        return preflight(read_json(args.config), args.host)
    if args.command == "wake":
        return request_wake(args.run_dir, args.reason)
    if args.command == "complete":
        return complete(args.run_dir, args.wake_id)
    return {"tick": tick, "supervise": supervise, "health": health}[args.command](args.run_dir)


if __name__ == "__main__":
    try:
        output(main())
    except (StateError, RuntimeErrorDetail, OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        output({"ok": False, "error": {"code": getattr(error, "code", "invalid_input"), "message": str(error)}})
        sys.exit(1)
