"""Host-owned lifetime records and workspace leases for isolated processes.

Bubblewrap keeps an unread socket carrying lock references in its PID-1 reaper
and closes it in the executed program. A model cannot release those locks.
Its trusted namespace information is written outside the mounted workspace,
and job outcomes survive session revoke.
"""
from __future__ import annotations

from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
import array
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time

import channel
from state import Engine, ExecutionGuard, StateError, canonical, locked, private, read_json, require, timestamp, write_atomic


def records(state):
    return channel.data(state).setdefault("jobs", {})


@contextmanager
def retained_locks(descriptors):
    """Keep lock descriptions in an unread socket queue owned by the reaper.

    Bubblewrap supports only one --sync-fd. SCM_RIGHTS retains every queued
    open-file description until the receiving socket is closed. The reaper
    retains that one socket; the model receives neither it nor the lock fds.
    """
    sender, receiver = socket.socketpair()
    try:
        rights = array.array("i", descriptors)
        require(sender.sendmsg([b"L"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, rights)]) == 1,
                "job", "could not retain execution and source locks")
        sender.close()
        yield receiver
    finally:
        sender.close()
        receiver.close()


@dataclass
class WorkspaceLease:
    run_dir: Path
    workspace: str
    readonly: bool
    fd: int
    active: bool = True


def lease_path(run_dir, workspace):
    directory = Path(run_dir) / "workspace-leases"
    directory.mkdir(mode=0o700, exist_ok=True)
    private(directory, directory=True)
    name = hashlib.sha256(workspace.encode()).hexdigest()
    return directory / name


@contextmanager
def lease(run_dir, workspace, readonly, *, wait_seconds=0):
    path = lease_path(run_dir, workspace)
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    held = WorkspaceLease(Path(run_dir).resolve(), workspace, readonly, fd)
    try:
        private(path)
        deadline = time.monotonic() + wait_seconds
        while True:
            try:
                fcntl.flock(fd, (fcntl.LOCK_SH if readonly else fcntl.LOCK_EX) | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                require(time.monotonic() < deadline, "unsettled", "another isolated writer or reviewer still owns the workspace")
                time.sleep(.02)
        yield held
    finally:
        held.active = False
        os.close(fd)


def namespace(job):
    """Return verified live PID 1, None for gone, False for unknown evidence."""
    path = Path(job["directory"]) / "namespace.json"
    try:
        if not job.get("boot_id"):
            return False
        if job["boot_id"] != Path("/proc/sys/kernel/random/boot_id").read_text().strip():
            return None
        info = read_json(path)
        pid, expected = info["child-pid"], info["pid-namespace"]
        require(type(pid) is int and pid > 1 and type(expected) is int, "job", "invalid namespace record")
        try:
            actual = Path(f"/proc/{pid}/ns/pid").stat().st_ino
        except FileNotFoundError:
            return None
        return pid if actual == expected else None
    except (FileNotFoundError, json.JSONDecodeError):
        return False
    except (PermissionError, KeyError):
        return False


def settle_old(state, workspace, readonly):
    # Called while this new launch holds the workspace lease. Compatible readers
    # may coexist; a live namespace still prevents replacing a source writer.
    for job in records(state).values():
        if job["workspace"] != workspace or job.get("local_settled") or readonly and job["readonly"]:
            continue
        live = namespace(job)
        require(not live, "unsettled", "previous job namespace remains live")
        # If namespace information was never written, the acquired exclusive
        # lease proves no prior Bubblewrap reaper retains that launch.
        job.update(local_settled=True, settled_at=timestamp())
        job.setdefault("outcome", "unknown")


def stop_generations(state, task):
    return [state["controls"].get("stop_generation", 0), task.get("stop_generation", 0)]


def source_readonly(spec, directory):
    # workspace_access=none uses a launch-private scratch directory. Its writes
    # cannot change task source and need no exception to source isolation.
    return spec["readonly"] or spec["workspace"] == str(Path(directory) / "workspace")


def inspection_current(state, task, readonly, inspection):
    pending = task.get("pending_intent") or {}
    return (readonly and isinstance(inspection, dict)
            and inspection.get("operation_id") == pending.get("id")
            and bool(pending.get("execution", {}).get("dispatched_at"))
            and inspection.get("stop_generations") == stop_generations(state, task))


def check_new_work(state, task):
    require(not state["controls"]["paused"] and not task["paused"]
            and not state["controls"]["cancel_requested"] and not task["cancel_requested"],
            "paused", "new isolated work is paused or awaiting cancellation")


def launch_authority(run_dir, state, session, spec, prepared, inspection=None):
    """Check authority at both reservation and the command's start boundary."""
    import capabilities
    principal = channel.check(state, session, task_id=spec["task_id"])
    if capabilities.enforced(state):
        require(prepared is not None, "host_unverified", "launch requires prepared filesystem checks")
        task = state["tasks"].get(spec["task_id"])
        host = task["host"] if task else capabilities.local_host(state)
        workspace = spec["workspace"] if task and spec["workspace"] == task["worktree"] else None
        prepared.validate(run_dir, state, host, workspace, excluding=task["id"] if workspace else None)
    if principal["role"] != "coordinator":
        task = state["tasks"][spec["task_id"]]
        if inspection is not None:
            require(inspection_current(state, task, source_readonly(spec, Path(spec["home"]).parent), inspection),
                    "paused", "inspection authorization changed before launch; retry the original operation")
        else:
            check_new_work(state, task)
    return principal


@contextmanager
def start_gate():
    reader, writer = os.pipe2(os.O_CLOEXEC)
    try:
        # A single byte to a fresh pipe cannot fill it, but keep even a failed
        # release bounded while holding the state lock. Only the reader is inherited.
        os.set_blocking(writer, False)
        yield reader, writer
    finally:
        os.close(writer)
        os.close(reader)


def launch(directory, spec, argv, *, mounts=None, environment=None,
           execution=None, workspace_lease=None, source_lease=None, inspection=False, **options):
    directory = Path(directory)
    run_dir = directory.parent.parent
    job_id = directory.name
    session = channel.parse_credential(Path(spec["credential"]).read_text().strip())
    require(execution is None or isinstance(execution, ExecutionGuard) and execution.active
            and execution.run_dir == run_dir.absolute(), "execution", "invalid inherited execution guard")
    require(not inspection or execution is not None and source_readonly(spec, directory),
            "execution", "recovery inspection requires its execution guard and a read-only workspace")
    require(workspace_lease is None or isinstance(workspace_lease, WorkspaceLease)
            and workspace_lease.active and workspace_lease.run_dir == run_dir.resolve()
            and workspace_lease.workspace == spec["workspace"] and workspace_lease.readonly == spec["readonly"],
            "job", "invalid inherited workspace lease")
    require(source_lease is None or isinstance(source_lease, WorkspaceLease) and source_lease.active
            and source_lease.run_dir == run_dir.resolve(), "job", "invalid inherited source lease")
    from isolation import command as build_command
    control = spec["actor"] == "coordinator"
    command = build_command(spec, argv, mounts=mounts, environment=environment, control=control)
    digest = hashlib.sha256(canonical(command).encode()).hexdigest()
    require("pass_fds" not in options and "preexec_fn" not in options and "shell" not in options,
            "job", "launcher owns process isolation and inherited descriptors")
    capture = options.pop("capture_output", False)
    timeout = options.pop("timeout", None)
    check = options.pop("check", False)
    input_data = options.pop("input", None)
    require(not capture or "stdout" not in options and "stderr" not in options, "job", "conflicting output options")
    if capture:
        options.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if input_data is not None:
        require("stdin" not in options, "job", "conflicting input options")
        options["stdin"] = subprocess.PIPE
    process = None
    with (nullcontext(workspace_lease) if workspace_lease is not None
          else lease(run_dir, spec["workspace"], spec["readonly"])) as held:
        lease_fd = held.fd
        state = Engine.read(run_dir)
        principal = channel.check(state, session, task_id=spec["task_id"])
        require(source_lease is None or source_lease.workspace == state["tasks"][spec["task_id"]]["worktree"],
                "job", "inherited source lease belongs to another task checkout")
        recovery = ({"operation_id": execution.operation_id,
                     "stop_generations": stop_generations(state, state["tasks"][spec["task_id"]])}
                    if inspection else None)
        import capabilities
        prepared = None
        if capabilities.enforced(state):
            bound = spec.get("host_capability")
            require(isinstance(bound, dict) and set(bound) == {"host", "id"}
                    and isinstance(bound["id"], str) and bool(bound["id"]),
                    "host_unverified", "launch lacks verified host binding; prepare it again")
            task = state["tasks"].get(spec["task_id"])
            host = task["host"] if task else capabilities.local_host(state)
            require(bound.get("host") == host, "host_unverified", "launch host binding changed")
            # A control driver can have an empty workspace. It must not use
            # that unrelated lease to certify mutable task Git metadata.
            workspace = spec["workspace"] if task and spec["workspace"] == task["worktree"] else None
            prepared = capabilities.prepare_check(run_dir, state, host, workspace,
                                                  lease=held, excluding=task["id"] if workspace else None,
                                                  receipt_id=bound["id"], control=principal["role"] == "coordinator")
        with locked(run_dir) as path:
            state = read_json(path / "state.json")
            principal = launch_authority(run_dir, state, session, spec, prepared, recovery)
            prior = records(state).get(job_id)
            require(prior is None, "job_replay", "launch already has a durable job; inspect it instead of relaunching")
            settle_old(state, spec["workspace"], spec["readonly"])
            job = {"id": job_id, "directory": str(directory), "workspace": spec["workspace"],
                   "task_id": spec["task_id"], "session_id": session.id, "actor": principal["actor"],
                   "role": principal["role"], "readonly": spec["readonly"], "command_hash": digest,
                   "status": "prepared", "local_settled": False, "prepared_at": timestamp(),
                   "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip()}
            if recovery is not None:
                job["inspection"] = recovery
            records(state)[job_id] = job
            from storage import reserve
            reserve(path, {"state.json": len(canonical(state).encode()) + 1})
            write_atomic(path / "state.json", state)
        release_attempted = False
        no_process = True
        try:
            with start_gate() as (reader, writer):
                gated = build_command(spec, argv, mounts=mounts, environment=environment,
                                      start_fd=reader, control=control)
                info_fd = os.open(directory / "namespace.json", os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
                try:
                    locks = [lease_fd] + ([execution.fd] if execution is not None else [])
                    if source_lease is not None and source_lease.fd != lease_fd:
                        locks.append(source_lease.fd)
                    with retained_locks(locks) as retained:
                        isolated = [gated[0], "--sync-fd", str(retained.fileno()),
                                    "--info-fd", str(info_fd), *gated[1:]]
                        no_process = False
                        try:
                            process = subprocess.Popen(isolated, pass_fds=(retained.fileno(), info_fd, reader), **options)
                        except OSError:
                            no_process = True
                            raise
                finally:
                    os.close(info_fd)
                with locked(run_dir) as path:
                    state = read_json(path / "state.json")
                    launch_authority(run_dir, state, session, spec, prepared, recovery)
                    job = records(state)[job_id]
                    require(not job.get("local_settled") and job["status"] == "prepared",
                            "unsettled", "prepared launch was already reconciled; do not start it again")
                    # This records the running launcher and start authorization,
                    # not proof that the command has executed or completed.
                    job.update(status="running", launcher_pid=process.pid, start_authorized_at=timestamp())
                    write_atomic(path / "state.json", state)
                    # Record uncertainty before writing: interruption after the
                    # byte is sent must never become a claim of non-execution.
                    release_attempted = True
                    require(os.write(writer, b"S") == 1, "job", "could not authorize command start")
            stdout, stderr = process.communicate(input_data, timeout=timeout)
        except BaseException:
            if process is not None:
                process.kill()
                process.communicate()
            raise
        finally:
            # The outer monitor can exit just before PID 1. Retain the lease and
            # observe namespace teardown rather than equating exit with settlement.
            deadline = time.monotonic() + 2
            while not no_process and namespace(job) is not None and time.monotonic() < deadline:
                time.sleep(.01)
            with locked(run_dir) as path:
                state = read_json(path / "state.json")
                job = records(state)[job_id]
                settled = no_process or namespace(job) is None
                job.update(status="exited" if release_attempted else "not_started",
                           local_settled=settled, observed_exit_at=timestamp())
                if process is not None:
                    job["returncode"] = process.returncode
                if not release_attempted:
                    job["outcome"] = "not_started"
                if settled:
                    job["settled_at"] = timestamp()
                # Terminal observations only extend existing job records with
                # fixed fields. They must survive exhaustion by ordinary data.
                write_atomic(path / "state.json", state, control=True)
        result = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
        if check:
            result.check_returncode()
        return result


def cancel_requested(run_dir):
    """Host reconciler; a signal request alone never records settlement."""
    with locked(run_dir) as path:
        state = read_json(path / "state.json")
        targets = []
        changed = False
        for job in records(state).values():
            if job.get("local_settled"):
                continue
            live = namespace(job)
            if live is False:
                try:
                    # Nonblocking: launches acquire this lease before the state
                    # lock. Never wait on them while holding that lock here.
                    with lease(run_dir, job["workspace"], False):
                        if not namespace(job):
                            live = None
                except StateError as error:
                    if error.code != "unsettled":
                        raise
            if live is None:
                job.update(local_settled=True, settled_at=timestamp())
                if "returncode" not in job:
                    job.update(status="observed_exit")
                    job.setdefault("outcome", "unknown")
                changed = True
                continue
            if job["role"] == "coordinator":
                continue
            task = state["tasks"][job["task_id"]]
            if not (state["controls"]["cancel_requested"] or task["cancel_requested"]):
                continue
            if inspection_current(state, task, source_readonly(job, job["directory"]), job.get("inspection")):
                continue
            if live:
                targets.append((job["id"], live))
        if changed:
            write_atomic(path / "state.json", state, control=True)
    for job_id, pid in targets:
        # Recheck the trusted namespace identity immediately before signaling.
        with locked(run_dir) as path:
            state = read_json(path / "state.json")
            job = records(state)[job_id]
            try:
                fd = os.pidfd_open(pid)
            except ProcessLookupError:
                continue
            try:
                if namespace(job) == pid:
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                    job["cancel_requested_at"] = timestamp()
                    write_atomic(path / "state.json", state, control=True)
            except ProcessLookupError:
                pass
            finally:
                os.close(fd)
