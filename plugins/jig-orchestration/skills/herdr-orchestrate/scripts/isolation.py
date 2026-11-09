#!/usr/bin/env python3
"""Linux task launcher. The host provisions policy; agents receive no host shell.

An empty mount namespace exposes only the selected checkout, private home,
immutable client runtime, system tools and authenticated gateway socket. All
network namespaces are private. There is deliberately no unconfined fallback.
"""
from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import channel
from state import Engine, canonical, private, require


def snapshot(run_dir):
    sources = [(source.name, source.read_bytes()) for source in sorted(Path(__file__).parent.glob("*.py"))]
    digest = hashlib.sha256()
    for name, contents in sources:
        digest.update(name.encode() + b"\0" + contents)
    root = Path(run_dir) / "client-runtimes"
    destination = root / digest.hexdigest()
    if not destination.exists():
        from runtime_storage import allocation
        with allocation(run_dir, additional_bytes=sum(max(4096, len(content)) for _, content in sources) + 8192,
                        additional_files=len(sources) + 2):
            if destination.exists():
                return destination
            root.mkdir(mode=0o700, exist_ok=True)
            temporary = Path(tempfile.mkdtemp(dir=root))
            try:
                for name, contents in sources:
                    (temporary / name).write_bytes(contents)
                    (temporary / name).chmod(0o400)
                try:
                    temporary.rename(destination)
                except OSError as error:
                    if error.errno not in {errno.EEXIST, errno.ENOTEMPTY}:
                        raise
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
    return destination


def prepare(run_dir, actor, task_id=None, *, role=None, review_contract=None, egress_hosts=None, profile=None,
            parent_session=None, expected_binding=None):
    """Reserve capacity for provisioning before replacing any credential."""
    from runtime_storage import allocation, footprint, settings
    state = Engine.read(run_dir)
    limits = settings(state["config"])
    if profile is not None:
        from profiles import exposure
        profile = exposure(profile, run_dir, state)
    extra_bytes, extra_files = 0, 0
    if limits is not None:
        # Conservative peak: a fresh Python snapshot, launch metadata, home
        # files and all public tool aliases, even when a snapshot can be reused.
        extra_bytes, extra_files = footprint([Path(__file__).parent], max_bytes=limits["max_bytes"],
                                             max_files=limits["max_files"])
        aliases = list(Path("/etc/alternatives").iterdir()) if Path("/etc/alternatives").is_dir() else []
        extra_files += len(aliases) + 16
        extra_bytes += 4096 * (len(aliases) + 16) + len(canonical(profile or {}).encode())
        if review_contract is not None:
            # Include the immutable body, its atomic-write peak and directory
            # metadata even when content deduplication may reuse an older blob.
            extra_bytes += 2 * (len(canonical(review_contract).encode()) + 1) + 3 * 4096
            extra_files += 3
        for item in (profile or {}).get("files", []):
            size = len(item["content"].encode()) if "content" in item else Path(item["source"]).stat().st_size
            count = len(Path(item["target"]).parts)
            extra_files += count
            extra_bytes += max(4096, size) + 4096 * count
    with allocation(run_dir, additional_bytes=extra_bytes, additional_files=extra_files, control=actor == "coordinator"):
        return _prepare(run_dir, actor, task_id, role=role, review_contract=review_contract,
                        egress_hosts=egress_hosts, profile=profile, parent_session=parent_session,
                        expected_binding=expected_binding)


def _prepare(run_dir, actor, task_id=None, *, role=None, review_contract=None, egress_hosts=None, profile=None,
             parent_session=None, expected_binding=None):
    """Host-only. Provision private files; do not print the credential."""
    run_dir = Path(run_dir).resolve()
    private(run_dir, directory=True)
    state = Engine.read(run_dir)
    if profile is not None:
        from profiles import exposure
        profile = exposure(profile, run_dir, state)
        require(egress_hosts is None, "profile", "choose provider grants through the selected profile")
        egress_hosts = profile.get("egress_hosts", [])
    task = state["tasks"].get(task_id)
    require(task is not None or actor == "coordinator", "scope", "admit the task before launch")
    if expected_binding is not None:
        require(task is not None and channel.task_binding(task) == expected_binding,
                "session_revoked", "task binding changed before launch preparation")
    import capabilities
    verified = None
    if capabilities.enforced(state):
        verified = capabilities.check(run_dir, state, task["host"] if task else None)
        if task is not None:
            capabilities.checkout(state, task["host"], task["worktree"], run_dir, excluding=task_id)
    if task is not None:
        workspace = Path(task["worktree"]).resolve(strict=True)
        require(workspace.is_dir() and workspace != run_dir and run_dir not in workspace.parents
                and workspace not in run_dir.parents, "location", "workspace and runtime must be separate")
        # Linked worktrees share writable refs/configuration outside the checkout.
        require(not (workspace / ".git").is_file() and not (workspace / ".git").is_symlink(),
                "shared_git", "enforced tasks need private Git metadata; use a separate clone at admission")
        if (workspace / ".git").is_dir():
            metadata = workspace / ".git" / "jig"
            require(not metadata.is_symlink(), "shared_git", "private review metadata must not be a symlink")
            # Reserve the hidden mount before a controller creates its first
            # report; existing readers must not see reports created later.
            metadata.mkdir(mode=0o700, exist_ok=True)
    launches = run_dir / "launches"
    launches.mkdir(mode=0o700, exist_ok=True)
    launch = Path(tempfile.mkdtemp(prefix="launch-", dir=launches))
    home = launch / "home"
    home.mkdir(mode=0o700)
    if profile is not None:
        from profiles import provision
        provision(home, profile)
    if actor == "coordinator" or (profile or {}).get("workspace_access") == "none":
        # A coordinator uses the gateway, not a task checkout. Holding a shared
        # lease on a task for its whole session would prevent the actual writer.
        workspace = launch / "workspace"
        workspace.mkdir(mode=0o700)
    # Recreate public /usr tool aliases without exposing the host's /etc.
    alternatives = launch / "alternatives"
    alternatives.mkdir(mode=0o700)
    if Path("/etc/alternatives").is_dir():
        for alias in Path("/etc/alternatives").iterdir():
            target = alias.resolve()
            if alias.is_symlink() and Path("/usr") in target.parents and target.exists():
                (alternatives / alias.name).symlink_to(target)
    credential = channel.issue(run_dir, actor, role=role, task_ids=[task_id],
                               review_contract=review_contract, egress_hosts=egress_hosts,
                               parent_session=parent_session,
                               expected_bindings={task_id: channel.task_binding(task)} if task is not None else None)
    key = launch / "credential"
    key.write_text(credential)
    key.chmod(0o400)
    spec = {"run_dir": str(run_dir), "actor": actor, "task_id": task_id, "workspace": str(workspace),
            "home": str(home), "credential": str(key), "runtime": str(snapshot(run_dir)),
            "endpoint": str(run_dir / "endpoint"), "alternatives": str(alternatives),
            "readonly": role == "reviewer" or actor == "coordinator" or (profile or {}).get("workspace_access") == "read",
            "egress": bool(egress_hosts)}
    if verified is not None:
        spec["host_capability"] = {"host": verified["binding"]["host"], "id": verified["id"]}
    if profile is not None:
        spec.update(argv=profile.get("argv", []), mounts=profile.get("mounts", []), environment=profile.get("environment", {}))
    (launch / "launch.json").write_text(canonical(spec))
    (launch / "launch.json").chmod(0o600)
    return launch


def command(spec, argv, *, mounts=None, environment=None, start_fd=None, control=False):
    require(sys.platform == "linux" and shutil.which("bwrap"), "unsupported", "enforced launch requires Linux and Bubblewrap")
    require(isinstance(argv, list) and argv and all(isinstance(arg, str) and "\0" not in arg for arg in argv),
            "invalid", "command must be a nonempty argv")
    workspace = str(Path(spec["workspace"]).resolve(strict=True))
    result = [shutil.which("bwrap"), "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
              "--clearenv", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
              "--symlink", "usr/sbin", "/sbin", "--symlink", "usr/lib", "/lib"]
    if Path("/usr/lib64").exists():
        result += ["--symlink", "usr/lib64", "/lib64"]
    result += ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/etc",
               "--dir", "/run/orchestration", "--dir", "/home/agent",
               "--ro-bind", spec["runtime"], "/opt/orchestration",
               "--ro-bind", spec["credential"], "/run/orchestration/credential",
               "--ro-bind", spec["endpoint"], "/run/orchestration/endpoint",
               "--ro-bind", spec["alternatives"], "/etc/alternatives",
               "--bind", spec["home"], "/home/agent",
               "--ro-bind" if spec.get("readonly") else "--bind", workspace, workspace]
    # The review-fix controller keeps private assignments and earlier reports
    # in Git metadata. Read-only access would still disclose peer findings.
    # Source workers also receive only their assigned evidence over the channel.
    review_state = Path(workspace) / ".git" / "jig"
    if review_state.exists():
        require(review_state.is_dir() and not review_state.is_symlink(),
                "shared_git", "private review metadata must be a local directory")
        # Pin the writable Git ancestor as its own mount. Otherwise a writer
        # can rename .git and recreate .git/jig outside the hidden mount, forging
        # the controller journal that the host will read on resume.
        metadata = str(Path(workspace) / ".git")
        result += ["--ro-bind" if spec.get("readonly") else "--bind", metadata, metadata,
                   "--tmpfs", str(review_state), "--remount-ro", str(review_state)]
    # These files are public runtime inputs; the host's /etc and home stay hidden.
    for source in ("/etc/ssl/certs", "/etc/ld.so.cache"):
        if Path(source).exists():
            result += ["--ro-bind", source, source]
    for mount in mounts or []:
        source, target = Path(mount["source"]).resolve(strict=True), mount["target"]
        require(str(target).startswith("/opt/tools/") and ".." not in Path(target).parts,
                "location", "extra read-only tools must be mounted below /opt/tools")
        require(source.is_file() or source.is_dir(), "location", "tool mount must be a file or directory")
        result += ["--ro-bind", str(source), str(target)]
    env = {"PATH": "/opt/tools/bin:/usr/bin:/bin", "HOME": "/home/agent", "TMPDIR": "/tmp", "LANG": "C.UTF-8",
           "XDG_CONFIG_HOME": "/home/agent/.config", "XDG_CACHE_HOME": "/home/agent/.cache",
           "ORCHESTRATION_SOCKET": "/run/orchestration/endpoint/gateway.sock",
           "ORCHESTRATION_CREDENTIAL_FILE": "/run/orchestration/credential"}
    if spec["task_id"] is not None:
        env["ORCHESTRATION_TASK"] = spec["task_id"]
    for name, value in (environment or {}).items():
        require(isinstance(name, str) and name not in env and isinstance(value, str) and "\0" not in value,
                "environment", "extra environment cannot replace launcher-owned variables")
        env[name] = value
    if spec.get("egress"):
        argv = ["/usr/bin/python3", "/opt/orchestration/egress.py", "--", *argv]
    # Host process arguments are observable outside the private namespace. Keep
    # profile values in a private immutable file and expose only its path there.
    encoded = canonical(env).encode()
    directory = Path(spec["credential"]).parent
    private(directory, directory=True)
    environment_file = directory / ("environment-" + hashlib.sha256(encoded).hexdigest() + ".json")
    from runtime_storage import allocation
    if environment_file.exists():
        private(environment_file)
        require(environment_file.read_bytes() == encoded, "environment", "launch environment changed")
    else:
        with allocation(spec.get("run_dir", str(Path(spec["endpoint"]).parent)),
                        additional_bytes=max(4096, len(encoded)), additional_files=1, control=control):
            try:
                fd = os.open(environment_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o400)
            except FileExistsError:
                private(environment_file)
                require(environment_file.read_bytes() == encoded, "environment", "launch environment changed")
            else:
                with os.fdopen(fd, "wb") as output:
                    output.write(encoded)
    result += ["--ro-bind", str(environment_file), "/run/orchestration/environment.json"]
    # Apply even loader/interpreter settings only after the private start gate.
    # The direct host command helper uses an explicit ungated invocation.
    argv = ["/usr/bin/python3", "-I", "-S", "/opt/orchestration/startup.py",
            str(start_fd) if start_fd is not None else "direct",
            "/run/orchestration/environment.json", "--", *argv]
    return [*result, "--chdir", workspace, "--", *argv]


def launch(directory, argv=None, *, mounts=None, environment=None, **kwargs):
    directory = Path(directory).resolve(strict=True)
    private(directory, directory=True)
    spec = json.loads((directory / "launch.json").read_text())
    argv = spec.get("argv", []) if argv is None else argv
    mounts = spec.get("mounts", []) if mounts is None else mounts
    environment = spec.get("environment", {}) if environment is None else environment
    from profiles import exposure
    mounts = exposure({"schema": 1, "mounts": mounts}, directory.parent.parent,
                      Engine.read(directory.parent.parent))["mounts"]
    from jobs import launch as launch_job
    return launch_job(directory, spec, argv, mounts=mounts, environment=environment, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir")
    parser.add_argument("--actor")
    parser.add_argument("--launch-dir", help="start an already provisioned launch, without changing its profile")
    parser.add_argument("--task")
    parser.add_argument("--role", choices=("coordinator", "driver", "reviewer", "executor"))
    parser.add_argument("--profile")
    parser.add_argument("--review-contract")
    parser.add_argument("--owner-session", help="host-pinned authorizing session for a reviewer or executor")
    parser.add_argument("--prepare-only", action="store_true", help="provision a launch and print its non-secret identity")
    parser.add_argument("argv", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    argv = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
    if args.launch_dir:
        require(not any((args.run_dir, args.actor, args.task, args.role, args.profile,
                         args.review_contract, args.owner_session, args.prepare_only, argv)),
                "invalid", "start a prepared launch without overriding its pinned inputs")
        return launch(args.launch_dir).returncode
    require(args.run_dir and args.actor, "invalid", "provisioning requires run-dir and actor")
    from profiles import load
    profile = load(args.profile) if args.profile else None
    argv = [*((profile or {}).get("argv", [])), *argv]
    require(argv, "invalid", "a command is required directly or in the launch profile")
    contract = json.loads(Path(args.review_contract).read_text()) if args.review_contract else None
    owner = channel.authorizing_session(Engine.read(args.run_dir), args.owner_session, args.task) if args.owner_session else None
    directory = prepare(args.run_dir, args.actor, args.task, role=args.role, profile=profile,
                        review_contract=contract, parent_session=owner)
    if args.prepare_only:
        spec = json.loads((directory / "launch.json").read_text())
        # Pin directly supplied arguments too, for a subsequent host launch.
        spec["argv"] = argv
        (directory / "launch.json").write_text(canonical(spec))
        session = channel.parse_credential(Path(spec["credential"]).read_text().strip())
        print(json.dumps({"launch_dir": str(directory), "session_id": session.id, "actor": args.actor}))
        return 0
    return launch(directory, argv).returncode


if __name__ == "__main__":
    raise SystemExit(main())
