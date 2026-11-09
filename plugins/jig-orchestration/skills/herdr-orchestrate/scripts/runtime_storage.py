"""Aggregate admission limits, not filesystem quotas on running commands.

Scans include the private run and admitted checkouts, including old jobs and
runtime copies. No evidence is deleted. Scans and allocation serialization run
outside the authoritative state lock, so reads and stop controls stay available.
"""
from contextlib import closing, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import os
from pathlib import Path
import stat

from state import Engine, StateError, canonical, lock_file, private, require


DEFAULTS = {"max_bytes": 8 * 1024 ** 3, "reserved_bytes": 64 * 1024 ** 2,
            "max_files": 250000, "reserved_files": 1024, "min_free_bytes": 64 * 1024 ** 2}
ALLOCATING = ContextVar("runtime_storage_allocation", default=None)


def settings(config):
    communication = config.get("communication", {})
    if communication.get("mode") != "enforced" and "runtime_storage" not in communication:
        return None
    selected = communication.get("runtime_storage", {})
    require(isinstance(selected, dict) and set(selected) <= DEFAULTS.keys(),
            "runtime_capacity", "unknown runtime storage capacity setting")
    limits = {**DEFAULTS, **selected}
    require(all(type(value) is int and value > 0 for value in limits.values())
            and limits["reserved_bytes"] < limits["max_bytes"]
            and limits["reserved_files"] < limits["max_files"],
            "runtime_capacity", "runtime storage capacity needs positive limits and reserved headroom")
    return limits


def binding(state):
    return canonical({"limits": settings(state["config"]),
                      "worktrees": {name: task["worktree"] for name, task in state["tasks"].items()}})


def roots(paths):
    selected = []
    for path in sorted({Path(path).absolute() for path in paths}, key=lambda value: len(value.parts)):
        if not any(parent == path or parent in path.parents for parent in selected):
            selected.append(path)
    return selected


def entries(paths):
    """Walk open directory descriptors so a source rename cannot redirect us."""
    stack = []

    def descend(name, parent=None):
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            iterator = os.scandir(fd)
        except BaseException:
            os.close(fd)
            raise
        stack.append((fd, iterator))

    try:
        for path in roots(paths):
            try:
                info = path.lstat()
            except FileNotFoundError:
                continue
            yield info
            if stat.S_ISDIR(info.st_mode):
                descend(path)
            while stack:
                fd, iterator = stack[-1]
                try:
                    child = next(iterator)
                except StopIteration:
                    iterator.close()
                    os.close(fd)
                    stack.pop()
                    continue
                try:
                    info = child.stat(follow_symlinks=False)
                    yield info
                    if stat.S_ISDIR(info.st_mode):
                        descend(child.name, fd)
                except FileNotFoundError:
                    continue
    finally:
        for fd, iterator in reversed(stack):
            iterator.close()
            os.close(fd)


def footprint(paths, *, max_bytes, max_files):
    """Count logical/allocated bytes and entries without following symlinks."""
    total, count = 0, 0
    try:
        with closing(entries(paths)) as observed:
            for info in observed:
                total += max(4096, info.st_size, getattr(info, "st_blocks", 0) * 512)
                count += 1
                require(total <= max_bytes and count <= max_files, "runtime_capacity",
                        f"runtime storage capacity reached ({total} charged bytes, {count} entries); preserve evidence and stop new work")
    except OSError as error:
        raise StateError("runtime_capacity_unknown", "runtime storage capacity could not be inspected; preserve evidence") from error
    return total, count


@dataclass(frozen=True)
class Check:
    source_binding: str
    charged_bytes: int
    entries: int

    def validate(self, state):
        require(binding(state) == self.source_binding, "runtime_capacity_changed",
                "runtime storage limits or admitted checkouts changed; inspect capacity again")


def check(run_dir, state=None, *, extra=(), additional_bytes=0, additional_files=0, control=False):
    state = Engine.read(run_dir) if state is None else state
    limits = settings(state["config"])
    if limits is None:
        return None
    require(type(additional_bytes) is int and additional_bytes >= 0
            and type(additional_files) is int and additional_files >= 0,
            "runtime_capacity", "invalid projected runtime allocation")
    maximum = limits["max_bytes"] - (0 if control else limits["reserved_bytes"])
    files = limits["max_files"] - (0 if control else limits["reserved_files"])
    require(additional_bytes <= maximum and additional_files <= files, "runtime_capacity",
            "projected allocation exceeds runtime storage capacity")
    paths = roots([run_dir, *(task["worktree"] for task in state["tasks"].values()), *extra])
    require(not any(path.is_symlink() for path in paths), "runtime_capacity_unknown",
            "runtime storage capacity cannot follow a replaced root symlink")
    total, entries = footprint(paths, max_bytes=maximum - additional_bytes, max_files=files - additional_files)
    devices = set()
    try:
        for path in paths:
            if not path.exists():
                continue
            device = path.stat().st_dev
            if device in devices:
                continue
            devices.add(device)
            filesystem = os.statvfs(path)
            available = filesystem.f_bavail * filesystem.f_frsize
            require(available >= limits["min_free_bytes"] + additional_bytes, "runtime_capacity",
                    "runtime storage capacity has insufficient free filesystem headroom")
    except OSError as error:
        raise StateError("runtime_capacity_unknown", "free filesystem capacity could not be inspected") from error
    return Check(binding(state), total, entries)


@contextmanager
def allocation(run_dir, *, additional_bytes=0, additional_files=0, control=False):
    """Serialize trusted copies/provisioning, without holding the state lock."""
    run_dir = Path(run_dir).resolve()
    if ALLOCATING.get() == run_dir:
        yield  # The outer estimate includes its nested runtime snapshot.
        return
    state = Engine.read(run_dir)
    if settings(state["config"]) is None:
        yield
        return
    fd = os.open(run_dir / "runtime-capacity.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    token = None
    try:
        private(run_dir / "runtime-capacity.lock")
        lock_file(fd)
        check(run_dir, additional_bytes=additional_bytes, additional_files=additional_files, control=control)
        token = ALLOCATING.set(run_dir)
        yield
    finally:
        if token is not None:
            ALLOCATING.reset(token)
        os.close(fd)
