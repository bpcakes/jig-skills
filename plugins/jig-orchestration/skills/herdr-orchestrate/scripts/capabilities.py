"""Host-only verification of the local enforced execution backend.

Full probes, runtime hashing and checkout scans execute outside the state lock.
Commit-time checks retain their source lease and compare the receipt, ownership
and fixed runtime metadata; inventory and model assertions are not receipts.
"""
from __future__ import annotations

import hashlib
from contextlib import contextmanager
from dataclasses import dataclass
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time

from state import (Engine, LOADED_RUNTIME_SHA256, canonical, locked, private, read_json,
                   require, runtime_fingerprint, timestamp, write_atomic)


RECEIPT = "host-capability.json"


def enforced(state):
    return state["config"].get("communication", {}).get("mode") == "enforced"


def local_host(state, host=None):
    hosts = state["config"]["hosts"]
    local = [name for name, info in hosts.items() if info.get("execution") == {"kind": "local"}]
    require(len(local) == 1 and (host is None or host == local[0]), "unsupported_host",
            "enforced execution requires exactly one explicitly local host (execution.kind=local)")
    return local[0]


def digest_file(path):
    with Path(path).open("rb") as stream:
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def host_identity():
    require(sys.platform == "linux" and shutil.which("bwrap"), "unsupported_host",
            "enforced execution requires Linux and Bubblewrap")
    binary = Path(shutil.which("bwrap")).resolve(strict=True)
    controls = {}
    for name in ("/proc/sys/kernel/unprivileged_userns_clone", "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
                 "/proc/sys/user/max_user_namespaces", "/proc/self/attr/current"):
        path = Path(name)
        if path.exists():
            controls[name] = path.read_text().strip()
    return {"machine": Path("/etc/machine-id").read_text().strip(),
            "boot": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "kernel": os.uname().release, "runtime_sha256": LOADED_RUNTIME_SHA256,
            "uid": os.getuid(), "euid": os.geteuid(), "groups": sorted(os.getgroups()), "controls": controls,
            "python": str(Path("/usr/bin/python3").resolve(strict=True)), "bwrap": str(binary)}


def identity():
    require(runtime_fingerprint() == LOADED_RUNTIME_SHA256, "runtime_changed",
            "runtime files changed after this process started; restart from the selected pinned runtime")
    current = host_identity()
    return {**current, "python_sha256": digest_file("/usr/bin/python3"),
            "bwrap_sha256": digest_file(current["bwrap"])}


def binding(run_dir, state, host):
    local_host(state, host)
    return {"run_dir": str(Path(run_dir).resolve()), "host": host,
            "host_config": {key: value for key, value in state["config"]["hosts"][host].items() if key != "slots"},
            "repository": state["config"]["repository"]}


def check(run_dir, state, host=None, *, receipt_id=None):
    """Full filesystem verification; never call while holding the state lock."""
    host = local_host(state, host)
    path = Path(run_dir) / RECEIPT
    require(path.exists(), "host_unverified", "verify this host with supervise.py verify-host before enforced admission or launch")
    private(path)
    receipt = read_json(path)
    require(receipt.get("schema") == 1 and receipt.get("binding") == binding(run_dir, state, host)
            and receipt.get("identity") == identity(), "host_unverified",
            "host capability verification is stale; verify the current host, runtime and configuration")
    require(receipt_id is None or receipt.get("id") == receipt_id, "host_unverified",
            "prepared launch belongs to an earlier host verification; prepare it again")
    return receipt


def metadata(paths):
    def signature(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)
    return tuple((str(path), signature(path.lstat()), signature(path.stat())) for path in paths)


def identity_paths(current):
    runtime = Path(__file__).parent
    return [runtime, *sorted(runtime.glob("*.py")), Path("/usr/bin/python3"),
            Path(current["python"]), Path(current["bwrap"])]


def checkout_binding(state, host, workspace, excluding):
    """Only state data: changes to ownership invalidate an in-flight scan."""
    return canonical({"host": host, "workspace": workspace, "excluding": excluding,
                      "root": state["config"]["hosts"][host]["worktree_root"],
                      "repository": state["config"]["repository"],
                      "host_repositories": {name: info.get("repository_path")
                                            for name, info in state["config"]["hosts"].items()},
                      "worktrees": {name: task["worktree"] for name, task in state["tasks"].items()
                                    if name != excluding}})


@dataclass(frozen=True)
class PreparedCheck:
    """Process-local scan result, usable only while its source lease is held."""
    receipt: dict
    host_state: dict
    paths: tuple
    stamps: tuple
    workspace: str | None
    source_binding: str | None
    lease: object
    capacity: object = None

    def validate(self, run_dir, state, host, workspace=None, excluding=None):
        if self.capacity is not None:
            self.capacity.validate(state)
        current = Path(run_dir) / RECEIPT
        private(current)
        require(self.receipt == read_json(current)
                and self.receipt["binding"] == binding(run_dir, state, host),
                "host_unverified", "host verification changed during filesystem checks; retry preparation")
        require(host_identity() == self.host_state and metadata(self.paths) == self.stamps,
                "host_unverified", "host runtime or checkout changed during filesystem checks; retry preparation")
        require(workspace == self.workspace, "host_unverified", "filesystem check belongs to another checkout")
        if workspace is not None:
            from jobs import WorkspaceLease
            require(isinstance(self.lease, WorkspaceLease) and self.lease.active
                    and self.lease.run_dir == Path(run_dir).resolve() and self.lease.workspace == workspace,
                    "unsettled", "filesystem checks require the retained checkout lease")
            require(self.source_binding == checkout_binding(state, host, workspace, excluding),
                    "host_unverified", "checkout ownership changed during filesystem checks; retry preparation")
        return workspace


def prepare_check(run_dir, state, host=None, workspace=None, *, lease=None, excluding=None, receipt_id=None, control=False):
    """Hash and scan outside the state lock, retaining the caller's source lease."""
    host = local_host(state, host)
    current = host_identity()
    paths = identity_paths(current)
    if workspace is not None:
        from jobs import WorkspaceLease
        require(isinstance(lease, WorkspaceLease) and lease.active and lease.workspace == workspace
                and lease.run_dir == Path(run_dir).resolve(), "unsettled", "retain the source lease while checking its files")
    stamps = metadata(paths)
    receipt = check(run_dir, state, host, receipt_id=receipt_id)
    if workspace is not None:
        checkout(state, host, workspace, run_dir, excluding=excluding)
    require(current == host_identity() and stamps == metadata(paths),
            "host_unverified", "host runtime changed during filesystem checks; retry preparation")
    if workspace is not None:
        source_paths = [Path(workspace), Path(workspace) / ".git", Path(workspace) / ".git/HEAD"]
        paths.extend(source_paths)
        stamps += metadata(source_paths)
    from runtime_storage import check as check_capacity
    capacity = check_capacity(run_dir, state, extra=[workspace] if workspace is not None else (), control=control)
    return PreparedCheck(receipt, current, tuple(paths), stamps, workspace,
                         checkout_binding(state, host, workspace, excluding) if workspace is not None else None, lease, capacity)


@contextmanager
def admission_check(run_dir, request, caller, session):
    """Admission and handoff hold the source lease, not the global state lock."""
    if request["op"] not in {"admit", "handoff"}:
        yield None
        return
    state = Engine.read(run_dir)
    if not enforced(state) or Engine.action(run_dir, request["action_id"]) is not None:
        yield None  # Existing receipts are authenticated and matched in Engine.apply.
        return
    if session is not None:
        import channel
        channel.check(state, session, operation=request["op"], task_id=request.get("task_id"))
    require(caller == "coordinator", "forbidden", "admission and handoff require the coordinator")
    host = request.get("host")
    require(host in state["config"]["hosts"], "invalid", "unregistered host")
    excluding = request.get("task_id") if request["op"] == "handoff" else None
    workspace = Engine._worktree(state, host, request.get("worktree", ""), excluding=excluding)
    from jobs import lease
    with lease(run_dir, workspace, False) as held:
        yield prepare_check(run_dir, state, host, workspace, lease=held, excluding=excluding)


def checkout(state, host, value, run_dir, *, excluding=None):
    """Check physical ownership and private Git metadata on the verified host."""
    local_host(state, host)
    workspace = Path(value)
    root = Path(state["config"]["hosts"][host]["worktree_root"]).resolve(strict=True)
    require(workspace.is_dir() and workspace.resolve(strict=True) == workspace and root in workspace.parents,
            "location", "enforced checkout must be a canonical directory inside its host worktree root")
    protected = [Path(run_dir).resolve(), Path(state["config"]["repository"]["path"]).resolve()]
    protected += [Path(info["repository_path"]).resolve() for info in state["config"]["hosts"].values()
                  if info.get("repository_path")]
    protected += [Path(task["worktree"]).resolve() for task in state["tasks"].values() if task["id"] != excluding]
    require(not any(workspace == other or workspace in other.parents or other in workspace.parents for other in protected),
            "ownership", "enforced checkout overlaps private state or another checkout")
    metadata = workspace / ".git"
    # Git's local-clone optimization can share mutable object inodes. Reject it,
    # and reject symlinked metadata before trusted Git can follow it on the host.
    # Host controller claims briefly have two links while being published. The
    # source lease excludes worker writes, but not these host-owned records.
    # Retry the whole scan after transient links/disappearances; never accept a
    # scan that observed shared inodes or silently skipped a vanished directory.
    deadline = time.monotonic() + 1
    def walk_error(error):
        raise error
    while True:
        require(metadata.is_dir() and not metadata.is_symlink() and (metadata / "HEAD").is_file()
                and not (metadata / "commondir").exists() and not (metadata / "objects/info/alternates").exists(),
                "shared_git", "enforced tasks require a separate clone with private Git metadata and no alternates")
        unsettled = False
        try:
            for directory, folders, files in os.walk(metadata, followlinks=False, onerror=walk_error):
                for name in folders + files:
                    info = (Path(directory) / name).lstat()
                    require(not stat.S_ISLNK(info.st_mode), "shared_git",
                            "Git metadata must not contain symlinks or shared hardlinks; clone with --no-hardlinks")
                    unsettled |= stat.S_ISREG(info.st_mode) and info.st_nlink != 1
        except FileNotFoundError:
            unsettled = True
        if not unsettled:
            break
        require(time.monotonic() < deadline, "shared_git",
                "Git metadata did not settle without shared hardlinks; clone with --no-hardlinks")
        time.sleep(0.01)
    return str(workspace)


PROBE = r'''
import json, os, pathlib, socket, subprocess, sys
request=json.loads(sys.argv[1])
assert not pathlib.Path(request['canary']).exists(), 'host canary exposed'
assert not pathlib.Path('/run/docker.sock').exists(), 'host socket exposed'
assert 'HOST_CAPABILITY_CANARY' not in os.environ, 'ambient environment exposed'
namespaces={name:os.stat('/proc/self/ns/'+name).st_ino for name in request['namespaces']}
assert all(namespaces[name]!=inode for name,inode in request['namespaces'].items()), 'namespace shared with host'
child=json.loads(subprocess.check_output(['/usr/bin/python3','-c',
    "import json,os;print(json.dumps({n:os.stat('/proc/self/ns/'+n).st_ino for n in ['mnt','pid','net','user']}))"]))
assert child==namespaces, 'descendant escaped namespaces'
try:
    socket.create_connection(('127.0.0.1',request['port']),timeout=.2)
except OSError:
    pass
else:
    raise AssertionError('host network reachable')
with socket.socket(socket.AF_UNIX) as client:
    client.connect('/run/orchestration/endpoint/probe.sock')
    client.sendall(b'canonical-endpoint')
target=pathlib.Path('write-probe')
if request['readonly']:
    try:
        target.write_text('changed')
    except OSError as error:
        assert error.errno in (13,30), error
    else:
        raise AssertionError('read-only checkout writable')
else:
    target.write_text('legitimate-write')
assert pathlib.Path('/run/orchestration/credential').read_text()=='dummy-credential'
print(json.dumps({'namespaces':namespaces,'readonly':request['readonly'],'endpoint':True}))
'''


def probe(run_dir):
    from isolation import command
    with tempfile.TemporaryDirectory(prefix="capability-", dir=run_dir) as temporary:
        root = Path(temporary)
        for name in ("workspace", "home", "endpoint", "runtime", "alternatives"):
            (root / name).mkdir()
        (root / "canary").write_text("private-host-canary")
        (root / "credential").write_text("dummy-credential")
        (root / "runtime/startup.py").write_bytes(Path(__file__).with_name("startup.py").read_bytes())
        spec = {name: str(root / name) for name in ("workspace", "home", "endpoint", "runtime", "alternatives", "credential")}
        spec.update(run_dir=str(run_dir), task_id=None, egress=False)
        with socket.socket() as network, socket.socket(socket.AF_UNIX) as endpoint:
            network.bind(("127.0.0.1", 0))
            network.listen(2)
            endpoint.bind(str(root / "endpoint/probe.sock"))
            endpoint.listen(2)
            endpoint.settimeout(2)
            results = []
            for readonly in (False, True):
                spec["readonly"] = readonly
                request = {"readonly": readonly, "canary": str(root / "canary"), "port": network.getsockname()[1],
                           "namespaces": {name: os.stat("/proc/self/ns/" + name).st_ino for name in ("mnt", "pid", "net", "user")}}
                result = subprocess.run(command(spec, ["/usr/bin/python3", "-B", "-c", PROBE, canonical(request)],
                                                control=True),
                                        capture_output=True, text=True, timeout=15,
                                        env={**os.environ, "HOST_CAPABILITY_CANARY": "must-stay-outside"})
                require(result.returncode == 0, "host_unverified", "host isolation probe failed: " + result.stderr[-4000:])
                connection, _ = endpoint.accept()
                with connection:
                    require(connection.recv(64) == b"canonical-endpoint", "host_unverified", "host endpoint probe failed")
                results.append(json.loads(result.stdout))
        require((root / "workspace/write-probe").read_text() == "legitimate-write", "host_unverified",
                "host isolation probe did not preserve legitimate write and reader separation")
        return results


def verify(run_dir, host):
    run_dir = Path(run_dir).resolve(strict=True)
    private(run_dir, directory=True)
    state = Engine.read(run_dir)
    require(enforced(state), "unsupported_host", "host verification is for explicitly enforced runs")
    expected = binding(run_dir, state, host)
    before = identity()
    # A failed explicit re-verification must not leave a previously successful
    # receipt available for new work. Running jobs keep their settlement path.
    with locked(run_dir) as path:
        require(binding(run_dir, read_json(path / "state.json"), host) == expected,
                "host_unverified", "host configuration changed before verification")
        (path / RECEIPT).unlink(missing_ok=True)
    results = probe(run_dir)
    observed_host = host_identity()
    paths = identity_paths(observed_host)
    stamps = metadata(paths)
    after = identity()
    with locked(run_dir) as path:
        current = read_json(path / "state.json")
        require(enforced(current) and binding(run_dir, current, host) == expected and after == before
                and host_identity() == observed_host and metadata(paths) == stamps,
                "host_unverified", "host configuration or runtime changed during verification")
        receipt = {"schema": 1, "id": os.urandom(16).hex(), "binding": expected, "identity": before,
                   "verified_at": timestamp(), "probe": results}
        write_atomic(path / RECEIPT, receipt)
    return {"host": host, "backend": "local-linux", "verified": True, "receipt_id": receipt["id"],
            "scope": "OS isolation and canonical endpoint access; provider and build capabilities require their own acceptance"}
