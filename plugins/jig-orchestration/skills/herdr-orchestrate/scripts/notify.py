"""Host-only generic Herdr hints for already committed protocol events.

A hint spends one model turn of its recipient. It is sent only for a pending
wake that no acknowledgement has retired, only to an agent that is not working,
and never into a pane in any other state.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timedelta, timezone
import subprocess

from state import Engine, locked, read_json, require, scheduler_identity, timestamp, write_atomic

HINT = "Orchestration updates are available. Read your authenticated inbox."
RETRY_SECONDS = 5
MAX_RETRY_SECONDS = 60


def bind(run_dir, actor, session_id, endpoint):
    scheduler_identity({**endpoint, "enabled": True})
    if session_id is None:
        # An unconfined run has no launch credential to name: its transport
        # identifies the actor. Enforced bindings always name their launch.
        import channel
        require(Engine.read(run_dir)["config"].get("communication", {}).get("mode") != "enforced",
                "invalid", "an enforced binding must name its launch session")
        session_id = channel.transport_session(run_dir, actor).id
    with locked(run_dir) as path:
        state = read_json(path / "state.json")
        communication = state["communication"]
        require(communication["active"].get(actor) == session_id, "session_revoked", "bind the current launch session")
        communication["sessions"][session_id]["endpoint"] = copy.deepcopy(endpoint)
        # An explicit host rebind is a recovery action. Ordinary new events do
        # not clear a recipient's backoff or it could monopolize delivery.
        notice = communication["wakes"].setdefault(actor, {"sequence": communication["sequence"]})
        notice.update(delivered=False, failures=0, retry_at=None, pending_since=timestamp())
        write_atomic(path / "state.json", state)
    return session_id


def target(state, name):
    """Return (session id, endpoint) for an actor that can be hinted, else None."""
    communication = state.get("communication", {})
    sid = communication.get("active", {}).get(name)
    session = communication.get("sessions", {}).get(sid, {})
    if session.get("endpoint") and not session.get("revoked"):
        return sid, session["endpoint"]
    if name == "coordinator" and state["config"].get("communication", {}).get("mode") != "enforced":
        # An unconfined run already registered its coordinator's exact Herdr
        # identity for scheduled supervision. Hints use that pane, including
        # before the coordinator has made its first channel request.
        from supervise import scheduler_config
        settings = scheduler_config(state["config"], state["scheduler"])
        if isinstance(settings.get("agent"), dict) and not session.get("revoked"):
            return sid, settings
    return None


def deliver(run_dir, actor=None, *, now=None, exclude=()):
    from supervise import exclusive, herdr_call, parse_time, verify_identity, RuntimeErrorDetail
    now = now or datetime.now(timezone.utc)
    with exclusive(run_dir, "channel-delivery.lock"):
        state = Engine.read(run_dir)
        communication = state.get("communication", {})
        candidates = [(name, notice) for name, notice in communication.get("wakes", {}).items()
                      if not notice["delivered"] and (actor is None or actor == name) and name not in exclude]
        if not candidates:
            return {"status": "quiet"}
        # Oldest attempted recipient first. Keep this state in the outbox so
        # neither a restart nor a stream of new events resets fairness.
        candidates.sort(key=lambda item: (item[1].get("last_attempt_at", ""), item[0]))
        bound = []
        for name, notice in candidates:
            selected = target(state, name)
            if selected is not None:
                bound.append((name, notice, *selected))
        if not bound:
            return {"status": "unbound", "actors": [name for name, _ in candidates]}
        for name, notice, sid, endpoint in bound:
            retry = parse_time(notice.get("retry_at"))
            if retry is None or now >= retry:
                break
        else:
            return {"status": "backoff", "retry_at": min(item[1]["retry_at"] for item in bound)}
        sequence = notice["sequence"]
        failures = notice.get("failures", 0) + 1
        retry_at = (now + timedelta(seconds=min(MAX_RETRY_SECONDS, RETRY_SECONDS * 2 ** min(failures - 1, 4)))).isoformat()
        # Persist before even looking up the endpoint: a crashing or unavailable
        # first recipient must not starve all the others after every restart.
        with locked(run_dir) as path:
            current = read_json(path / "state.json")
            require(current["communication"]["active"].get(name) == sid,
                    "session_revoked", "delivery session changed")
            if current["communication"]["wakes"][name]["delivered"]:
                return {"status": "acknowledged", "actor": name, "sequence": sequence}
            current["communication"]["wakes"][name].update(
                last_attempt_at=now.isoformat(), retry_at=retry_at, failures=failures,
                attempt={"session_id": sid, "sequence": sequence, "status": "dispatching", "at": now.isoformat()})
            write_atomic(path / "state.json", current)
        failure, prompted = None, False
        try:
            actual = herdr_call(endpoint, ["agent", "get", endpoint["agent"]["name"]])["agent"]
            verify_identity(actual, endpoint["agent"])
            observed = actual.get("agent_status", "unknown")
            if observed == "working":
                # It will end its turn, or is already waiting on its inbox.
                status = "busy"
            else:
                if observed not in {"idle", "done"}:
                    # A blocked pane may be showing an approval prompt, which
                    # typed text could answer. Never prompt an unknown state.
                    raise RuntimeErrorDetail("agent_" + str(observed), f"{name} is {observed}; inspect its original pane")
                with locked(run_dir) as path:
                    current = read_json(path / "state.json")
                    require(current["communication"]["active"].get(name) == sid,
                            "session_revoked", "delivery session changed")
                    retired = current["communication"]["wakes"][name]["delivered"]
                if retired:
                    status = "acknowledged"
                else:
                    prompted = True  # From here the pane may have received text.
                    delivered = herdr_call(endpoint, ["agent", "prompt", endpoint["agent"]["pane_id"], HINT])["agent"]
                    verify_identity(delivered, endpoint["agent"])
                    status = "delivered"
        except (RuntimeErrorDetail, ValueError, OSError, subprocess.TimeoutExpired) as error:
            status = "unconfirmed"
            failure = {"code": getattr(error, "code", type(error).__name__), "message": str(error)[:512]}
        with locked(run_dir) as path:
            current = read_json(path / "state.json")
            active = current["communication"]["active"].get(name) == sid
            wake = current["communication"]["wakes"].get(name)
            if active and wake:
                wake["attempt"] = {"session_id": sid, "sequence": sequence, "status": status,
                                   "at": now.isoformat(), "failure": failure}
                if prompted:
                    wake["last_hint_at"] = now.isoformat()
                if status == "delivered":
                    # An acknowledgement may have retired it during the prompt;
                    # a newer event keeps it pending for the next interval.
                    wake["delivered"] = wake["delivered"] or wake["sequence"] == sequence
                    wake.update(failures=0, retry_at=(now + timedelta(seconds=RETRY_SECONDS)).isoformat())
                elif status in {"busy", "acknowledged"}:
                    # Neither is a transport failure: keep the short interval.
                    wake.update(failures=failures - 1, retry_at=(now + timedelta(seconds=RETRY_SECONDS)).isoformat())
                write_atomic(path / "state.json", current)
        return {"status": status if active else "session_changed", "actor": name, "sequence": sequence}


def main():
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--actor")
    parser.add_argument("--bind-session", help="host-only: bind this launch session to --endpoint; "
                        "omit in an unconfined run to bind the actor's transport session")
    parser.add_argument("--endpoint", help="host-owned JSON endpoint to bind, including exact native identity")
    args = parser.parse_args()
    if args.bind_session or args.endpoint:
        require(args.actor and args.endpoint, "invalid", "binding requires actor and endpoint")
        from pathlib import Path
        session_id = bind(args.run_dir, args.actor, args.bind_session, json.loads(Path(args.endpoint).read_text()))
        print(json.dumps({"status": "bound", "actor": args.actor, "session_id": session_id}))
        return
    print(json.dumps(deliver(args.run_dir, args.actor)))


if __name__ == "__main__":
    main()
