"""Explicit host-owned launch profiles; only selected files enter a private home."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import re
import stat

from state import private, require


def validate(profile):
    require(isinstance(profile, dict) and profile.get("schema") == 1, "profile", "launch profile schema must be 1")
    require(set(profile) <= {"schema", "argv", "mounts", "environment", "files", "egress_hosts", "workspace_access"},
            "profile", "unknown launch profile field")
    require(isinstance(profile.get("workspace_access", "write"), str)
            and profile.get("workspace_access", "write") in {"none", "read", "write"},
            "profile", "workspace_access must be none, read or write")
    argv = profile.get("argv", [])
    require(isinstance(argv, list) and all(isinstance(arg, str) and "\0" not in arg for arg in argv),
            "profile", "profile argv must be an argument array")
    require(isinstance(profile.get("mounts", []), list) and isinstance(profile.get("files", []), list),
            "profile", "mounts and files must be lists")
    environment = profile.get("environment", {})
    require(isinstance(environment, dict) and all(isinstance(key, str) and re.fullmatch(r"[A-Z_][A-Z_0-9]*", key)
            and isinstance(value, str) and "\0" not in value for key, value in environment.items()),
            "profile", "environment must contain explicit string variables")
    for item in profile.get("mounts", []):
        require(isinstance(item, dict) and set(item) == {"source", "target"}
                and all(isinstance(value, str) and value and "\0" not in value for value in item.values()),
                "profile", "tool mounts need string source and target paths")
        target = Path(item["target"])
        require(target.is_absolute() and target.parts[:3] == ("/", "opt", "tools")
                and len(target.parts) > 3 and ".." not in target.parts,
                "profile", "tool mounts must stay below /opt/tools")
    targets = set()
    for item in profile.get("files", []):
        require(isinstance(item, dict) and set(item) in ({"source", "target"}, {"content", "target"})
                and all(isinstance(value, str) and "\0" not in value for value in item.values()),
                "profile", "home files need string target and exactly one string source or content")
        target = Path(item["target"])
        require(not target.is_absolute() and target.parts and ".." not in target.parts,
                "profile", "home file target must stay inside the private home")
        require(target not in targets and not any(other in target.parents or target in other.parents for other in targets),
                "profile", "home file targets must not duplicate or contain one another")
        targets.add(target)
        require("content" not in item or len(item["content"].encode()) <= 2 * 1024 * 1024,
                "profile", "inline home content exceeds 2 MiB")
    from egress import destination
    hosts = profile.get("egress_hosts", [])
    require(isinstance(hosts, list), "profile", "egress_hosts must be a list")
    for host in hosts:
        destination(host)
    return copy.deepcopy(profile)


def load(path):
    path = Path(path).resolve(strict=True)
    private(path)
    return validate(json.loads(path.read_text()))


def exposure(profile, run_dir, state):
    """Reject tool sources exposing control state, checkouts or host services.

    Administrators still select trusted tools and individual provider files.
    A read-only bind is not sufficient isolation for secrets or Unix sockets.
    """
    profile = validate(profile)
    protected = [Path(run_dir).resolve(), Path(state["config"]["repository"]["path"]).resolve()]
    protected += [Path(task["worktree"]).resolve() for task in state["tasks"].values()]
    protected += [Path(info["worktree_root"]).resolve() for info in state["config"]["hosts"].values()]
    protected += [Path(info["repository_path"]).resolve() for info in state["config"]["hosts"].values()
                  if info.get("repository_path")]
    administrative = [Path(path) for path in ("/proc", "/sys", "/dev", "/run")]
    administrative += [Path.home() / name for name in (".ssh", ".aws", ".gnupg", ".kube", ".docker")]

    def source_path(value, *, tool):
        source = Path(value).resolve(strict=True)
        roots = protected + (administrative if tool else administrative[:4])
        require(not any(source == root or source in root.parents or root in source.parents for root in roots),
                "profile_exposure", "profile source overlaps private runtime, administrative state or a checkout")
        if tool:
            require(source != Path.home() and source not in Path.home().parents,
                    "profile_exposure", "a tool mount must not expose the host home")
        return source

    for item in profile.get("mounts", []):
        source = source_path(item["source"], tool=True)
        require(source.is_file() or source.is_dir(), "profile_exposure", "tool sources must be regular files or directories")
        pending = [source]
        while pending:
            path = pending.pop()
            info = path.lstat()
            if stat.S_ISDIR(info.st_mode):
                pending.extend(path.iterdir())
            elif stat.S_ISLNK(info.st_mode):
                target = path.resolve()
                if target.exists():
                    source_path(target, tool=True)
                require(not target.exists() or target.is_file() or target.is_dir(),
                        "profile_exposure", "tool bundle contains a link to a host socket or device")
            else:
                require(stat.S_ISREG(info.st_mode), "profile_exposure", "tool bundle contains a host socket or device")
        item["source"] = str(source)
    for item in profile.get("files", []):
        if "source" in item:
            item["source"] = str(source_path(item["source"], tool=False))
    return profile


def provision(home, profile):
    for item in profile.get("files", []):
        require(isinstance(item, dict) and set(item) in ({"source", "target"}, {"content", "target"}),
                "profile", "home files need a target and exactly one source or content")
        target = Path(item["target"])
        require(not target.is_absolute() and target.parts and ".." not in target.parts,
                "profile", "home file target must stay inside the private home")
        destination = home / target
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        require(home.resolve() in destination.resolve().parents, "profile", "home file escapes private home")
        if "source" in item:
            source = Path(item["source"]).resolve(strict=True)
            require(source.is_file() and source.stat().st_size <= 2 * 1024 * 1024,
                    "profile", "home sources must be individual files up to 2 MiB")
            contents = source.read_bytes()
        else:
            require(isinstance(item["content"], str), "profile", "inline home content must be text")
            contents = item["content"].encode()
        fd = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(contents)
