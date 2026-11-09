#!/usr/bin/env python3
"""Trusted host gateway. Only its endpoint directory is mounted into agents."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import select
import selectors
import socket
import struct
import threading
import time

import channel
from communicate import MAX_FRAME, PROTOCOL
from state import Engine, StateError, canonical, lock_timeout, private, require


def query(run_dir, session, task_id=None, mode="auto"):
    state = Engine.read(run_dir)
    principal = channel.check(state, session, operation="query", task_id=task_id)
    require(mode in {"auto", "compact", "full"}, "invalid", "query mode must be auto, compact or full")
    if principal["role"] == "reviewer":
        binding = principal["bindings"][task_id]
        # General task views contain previous verdicts, findings and handoffs.
        view = {"task": {"id": task_id, "worktree": binding["worktree"], "branch": binding["branch"]},
                "review": channel.contract(run_dir, principal),
                "paused": state["controls"]["paused"] or state["tasks"][task_id]["paused"]}
        channel.check(Engine.read(run_dir), session, operation="query", task_id=task_id)
    elif task_id is None:
        require(principal["role"] == "coordinator", "wrong_task", "a task is required")
        from views import complete, overview, unresolved_finding
        tasks = {key: task for key, task in state["tasks"].items() if key in principal["task_ids"]}
        view = {"version": state["version"], "policy_version": state["policy_version"],
                "controls": state["controls"], "summary": Engine.summary(state),
                "blocking_summary": {
                    "tasks": len(tasks), "paused": state["controls"]["paused"],
                    "cancel_requested": state["controls"]["cancel_requested"],
                    "run_holds": len(state["controls"].get("holds", {})),
                    "paused_tasks": sum(bool(task["paused"]) for task in tasks.values()),
                    "cancel_requested_tasks": sum(bool(task["cancel_requested"]) for task in tasks.values()),
                    "held_tasks": sum(bool(task.get("holds")) for task in tasks.values()),
                    "blocked_tasks": sum(bool(task.get("blocker")) for task in tasks.values()),
                    "unsettled_tasks": sum(task.get("pending_intent") is not None for task in tasks.values()),
                    "unresolved_findings": sum(sum(unresolved_finding(item) for item in task["findings"])
                                               for task in tasks.values() if isinstance(task.get("findings"), list)),
                    "tasks_with_unknown_findings": sum(not isinstance(task.get("findings"), list) for task in tasks.values())},
                "tasks": {key: {field: task.get(field) for field in
                                ("id", "phase", "version", "driver", "host", "blocker", "next_action",
                                 "holds", "paused", "cancel_requested")}
                          for key, task in tasks.items()}}
        view = channel.public(view)
        view["change_token"] = hashlib.sha256(canonical(view).encode()).hexdigest()
        return complete(view) if mode == "full" else overview(run_dir, session, view, adaptive=mode == "auto")
    else:
        from supervise import task_view
        full = channel.public(task_view(run_dir, task_id, state=state))
        if mode == "full":
            from views import complete
            return complete(full)
        from views import compact
        return compact(run_dir, session, task_id, full, adaptive=mode == "auto")
    return {**view, "change_token": hashlib.sha256(canonical(view).encode()).hexdigest()}


def execution_context(run_dir, session, task_id, connection):
    """Attest the connecting process's registered namespace, not an env flag."""
    from jobs import namespace
    state = Engine.read(run_dir)
    principal = channel.check(state, session, operation="context", task_id=task_id)
    require(state["config"].get("communication", {}).get("mode") == "enforced"
            and connection is not None and hasattr(socket, "SO_PEERCRED"),
            "boundary", "execution context requires an enforced local namespace connection")
    peer_pid, peer_uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    require(peer_pid > 1 and peer_uid == os.getuid(), "boundary", "invalid local namespace peer")
    candidates = [job for job in state.get("communication", {}).get("jobs", {}).values()
                  if job["session_id"] == session.id and job["task_id"] == task_id and not job.get("local_settled")]
    require(len(candidates) == 1, "boundary", "session has no unique running namespace")
    job = candidates[0]
    leader = namespace(job)
    require(type(leader) is int and leader > 1, "boundary", "registered namespace is unavailable")
    for kind in ("pid", "net", "mnt", "user"):
        expected = Path(f"/proc/{leader}/ns/{kind}").stat().st_ino
        require(Path(f"/proc/{peer_pid}/ns/{kind}").stat().st_ino == expected
                and Path(f"/proc/self/ns/{kind}").stat().st_ino != expected,
                "boundary", "connecting process is outside its registered execution boundary")
    # The namespace may have exited or its owner may have been replaced while
    # procfs was inspected. Recheck before issuing the capability description.
    channel.check(Engine.read(run_dir), session, operation="context", task_id=task_id)
    task = state["tasks"][task_id]
    source_access = ("none" if job["workspace"] != task["worktree"] else "read" if job["readonly"] else "write")
    return {"context_schema": 1, "boundary": "linux-namespaces", "session_id": session.id,
            "role": principal["role"], "task_id": task_id, "source_access": source_access,
            "worktree": task["worktree"], "network": "gateway-egress-only"}


def handle(run_dir, session, payload, connection=None, stopping=None):
    require(isinstance(payload, dict) and "caller" not in payload and "session" not in payload,
            "invalid", "request must be an object without a caller or session override")
    operation, task_id = payload.get("op"), payload.get("task_id")
    channel.caller(run_dir, session, operation, task_id)
    if operation == "context":
        require(set(payload) == {"op", "task_id"}, "invalid", "context requires only the assigned task")
        return execution_context(run_dir, session, task_id, connection)
    from protocol import READS, read
    if operation in READS:
        return read(run_dir, session, payload)
    if operation == "query":
        return query(run_dir, session, task_id, payload.get("mode", "auto"))
    if operation == "view_read":
        from views import read as view_read
        return view_read(run_dir, session, payload)
    if operation == "watch":
        require(set(payload) <= {"op", "task_id", "view", "after", "timeout_seconds", "until_change"},
                "invalid", "watch accepts only op, task_id, view, after, timeout_seconds and until_change; "
                "use view:\"inbox\" with an inbox cursor to wait for messages")
        after = payload.get("after")
        timeout = payload.get("timeout_seconds", 30)
        require(isinstance(after, str) and type(timeout) in {int, float} and math.isfinite(timeout)
                and 0 <= timeout <= 30 and type(payload.get("until_change", False)) is bool,
                "invalid", "watch needs a token and a bounded timeout")
        deadline = time.monotonic() + timeout
        while True:
            if payload.get("view", "task") == "inbox":
                view = read(run_dir, session, {"op": "inbox", "task_id": task_id, "after": after})
                changed = view.get("resync_required") or bool(view.get("events"))
            else:
                require(payload.get("view", "task") == "task", "invalid", "watch view must be task or inbox")
                view = query(run_dir, session, task_id)
                changed = view["change_token"] != after
            if changed or time.monotonic() >= deadline:
                return {**view, "changed": changed}
            if stopping is not None and stopping.is_set():
                raise StateError("restarting", "gateway is stopping; reconnect with the same cursor")
            if connection is not None and select.select([connection], [], [], 0)[0]:
                raise StateError("disconnected", "watch connection closed or sent extra input")
            time.sleep(0.05)
    if operation == "execute":
        from execute import execute
        return execute(run_dir, payload, channel.caller(run_dir, session, operation, task_id), session=session)
    if operation == "review_answer":
        from review_controller import answer
        return answer(run_dir, session, payload)
    if operation == "review_release":
        from review_controller import release_controller
        return release_controller(run_dir, session, payload)
    return channel.apply(run_dir, session, payload)


def decode(raw):
    require(len(raw) <= MAX_FRAME and raw.endswith(b"\n"), "invalid", "missing or oversized request frame")
    try:
        value = json.loads(raw)
    except (ValueError, RecursionError):
        raise StateError("invalid", "invalid JSON") from None
    require(isinstance(value, dict), "invalid", "request frame must be an object")
    require(type(value.get("protocol")) is int and value["protocol"] == PROTOCOL,
            "protocol", "incompatible orchestration protocol")
    pending = [(value, 1)]
    while pending:
        item, depth = pending.pop()
        require(depth <= 64, "invalid", "JSON is nested too deeply")
        values = item.values() if isinstance(item, dict) else item
        pending.extend((child, depth + 1) for child in values if isinstance(child, (dict, list)))
    return value


def reply(connection, result):
    wire = canonical({**result, "protocol": PROTOCOL}).encode() + b"\n"
    if len(wire) > MAX_FRAME:
        wire = canonical({"protocol": PROTOCOL, "error": "response_too_large",
                          "message": "Use a narrower query or artifact read"}).encode() + b"\n"
    try:
        connection.settimeout(0.5)
        connection.sendall(wire)
    except OSError:
        pass  # Durable actions remain queryable after a lost reply.
    finally:
        connection.close()


class Server:
    """Nonblocking handshakes; separate bounded control, wait and work slots.

    An idle unauthenticated socket consumes no worker. Limits are per actor, so
    replacing a session cannot buy extra work slots while old requests settle.
    This bounds resource use, not OS-level denial of service against the host.
    """
    LIMITS = {"control": (4, 2), "watch": (32, 1), "work": (32, 4), "egress": (64, 4), "authentication": (4, 1)}

    def __init__(self, run_dir, socket_path):
        self.run_dir = Path(run_dir)
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.bind(str(socket_path))
        os.chmod(socket_path, 0o600)
        self.socket.listen(128)
        self.socket.setblocking(False)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.socket, selectors.EVENT_READ)
        self.pending = {}
        self.buffered = 0
        self.stopping = threading.Event()
        self.finished = threading.Event()
        self.lock = threading.Lock()
        self.active = {}
        self.workers = set()
        self.known_sessions = self.identities(Engine.read(self.run_dir))
        self.maintenance_failure = None

    @staticmethod
    def identities(state):
        # This cache only selects a bounded queue. Every request checks current
        # authority again inside its worker, and mutations check under the lock.
        return {identifier: {key: record[key] for key in ("actor", "role", "digest")}
                for identifier, record in state.get("communication", {}).get("sessions", {}).items()}

    def start_worker(self, target, args, key):
        total_limit, actor_limit = self.LIMITS[key[1]]
        with self.lock:
            total = sum(count for (_, category), count in self.active.items() if category == key[1])
            require(total < total_limit and self.active.get(key, 0) < actor_limit,
                    "busy", "request capacity reached; retry the same action or cursor")
            self.active[key] = self.active.get(key, 0) + 1
            worker = threading.Thread(target=target, args=(*args, key), daemon=True)
            self.workers.add(worker)
        worker.start()

    def release_worker(self, key):
        with self.lock:
            self.active[key] -= 1
            if not self.active[key]:
                del self.active[key]
            self.workers.discard(threading.current_thread())

    def route(self, connection, session, payload, principal):
        group = ("control" if principal["role"] == "coordinator" and payload.get("op") == "control"
                 else "egress" if payload.get("op") == "egress"
                 else "watch" if payload.get("op") == "watch" else "work")
        self.start_worker(self.run_request, (connection, session, payload), (principal["actor"], group))

    def authenticate(self, connection, session, payload, key):
        try:
            with lock_timeout(.5):
                principal = channel.check(Engine.read(self.run_dir), session,
                                          operation=payload.get("op"), task_id=payload.get("task_id"))
            with self.lock:
                self.known_sessions[session.id] = {name: principal[name] for name in ("actor", "role", "digest")}
            self.route(connection, session, payload, principal)
        except (StateError, ValueError, OSError, TypeError, KeyError) as error:
            reply(connection, {"error": getattr(error, "code", "channel_error"), "message": str(error)})
        finally:
            self.release_worker(key)

    def detach(self, connection):
        data = self.pending.pop(connection)
        self.buffered -= len(data[0])
        self.selector.unregister(connection)
        return data[0]

    def accept(self):
        for _ in range(32):
            try:
                connection, _ = self.socket.accept()
            except BlockingIOError:
                return
            connection.setblocking(False)
            if len(self.pending) >= 256:
                connection.close()
                continue
            self.pending[connection] = [bytearray(), time.monotonic() + 2]
            self.selector.register(connection, selectors.EVENT_READ)

    def receive(self, connection):
        try:
            chunk = connection.recv(65536)
        except BlockingIOError:
            return
        except ConnectionResetError:
            chunk = b""
        data = self.pending[connection][0]
        data.extend(chunk)
        self.buffered += len(chunk)
        if not chunk or len(data) > MAX_FRAME or self.buffered > 8 * MAX_FRAME:
            self.detach(connection)
            connection.close()
        elif b"\n" in chunk:
            self.dispatch(connection, self.detach(connection))

    def dispatch(self, connection, raw):
        try:
            envelope = decode(raw)
            session = channel.parse_credential(envelope.get("credential"))
            payload = envelope.get("request")
            require(isinstance(payload, dict), "invalid", "request must be an object")
            with self.lock:
                principal = self.known_sessions.get(session.id)
            if principal is None:
                self.start_worker(self.authenticate, (connection, session, payload), (session.id, "authentication"))
            else:
                require(hmac.compare_digest(principal["digest"], session.digest), "unauthenticated", "invalid launch credential")
                self.route(connection, session, payload, principal)
        except (StateError, ValueError, OSError) as error:
            reply(connection, {"error": getattr(error, "code", "channel_error"), "message": str(error)})

    def run_request(self, connection, session, payload, key):
        try:
            try:
                with lock_timeout(2.0 if payload.get("op") in {"execute", "review_answer"} else .5):
                    channel.check(Engine.read(self.run_dir), session,
                                  operation=payload.get("op"), task_id=payload.get("task_id"))
                    if payload.get("op") == "egress":
                        from egress import serve
                        serve(self.run_dir, session, payload, connection, self.stopping)
                        return
                    result = handle(self.run_dir, session, payload, connection, self.stopping)
            except (StateError, ValueError, OSError, TypeError, KeyError, AttributeError) as error:
                result = {"error": getattr(error, "code", "channel_error"), "message": str(error)}
            reply(connection, channel.public(result))
        finally:
            connection.close()
            self.release_worker(key)

    def maintain(self):
        from jobs import cancel_requested
        while not self.stopping.is_set():
            try:
                with lock_timeout(.5):
                    identities = self.identities(Engine.read(self.run_dir))
                    with self.lock:
                        self.known_sessions = identities
                    cancel_requested(self.run_dir)
            except StateError as error:
                if error.code != "state_busy":
                    self.maintenance_failure = error
                    self.stopping.set()
            except Exception as error:
                self.maintenance_failure = error
                self.stopping.set()
            self.stopping.wait(.25)

    def serve_forever(self, poll_interval=0.1):
        maintenance = threading.Thread(target=self.maintain, daemon=True)
        maintenance.start()
        try:
            while not self.stopping.is_set():
                for key, _ in self.selector.select(min(poll_interval, 0.1)):
                    if key.fileobj is self.socket:
                        self.accept()
                    else:
                        self.receive(key.fileobj)
                for connection, (_, deadline) in list(self.pending.items()):
                    if time.monotonic() >= deadline:
                        self.detach(connection)
                        connection.close()
            if self.maintenance_failure is not None:
                raise self.maintenance_failure
        finally:
            self.stopping.set()
            maintenance.join(2)
            self.finished.set()

    def shutdown(self):
        self.stopping.set()
        self.finished.wait(5)

    def server_close(self):
        self.stopping.set()
        for connection in list(self.pending):
            self.detach(connection)
            connection.close()
        self.selector.close()
        self.socket.close()
        with self.lock:
            workers = list(self.workers)
        deadline = time.monotonic() + 2
        for worker in workers:
            worker.join(max(0, deadline - time.monotonic()))


@contextmanager
def server(run_dir, socket_path=None):
    run_dir = Path(run_dir).resolve()
    private(run_dir, directory=True)
    endpoint = run_dir / "endpoint"
    endpoint.mkdir(mode=0o700, exist_ok=True)
    private(endpoint, directory=True)
    socket_path = Path(socket_path or endpoint / "gateway.sock")
    require(socket_path.parent.resolve() == endpoint, "location", "gateway socket must be inside the endpoint directory")
    lock = os.open(run_dir / "gateway.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if socket_path.exists():
            socket_path.unlink()
        instance = Server(run_dir, socket_path)
        try:
            yield instance
        finally:
            instance.server_close()
            socket_path.unlink(missing_ok=True)
    finally:
        os.close(lock)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True)
    args = parser.parse_args()
    with server(args.run_dir) as instance:
        instance.serve_forever()


if __name__ == "__main__":
    main()
