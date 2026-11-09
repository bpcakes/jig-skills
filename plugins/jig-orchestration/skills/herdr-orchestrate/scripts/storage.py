"""Conservative budgets for retained protocol data, independent of source files.

Reservations precede writes and survive crashes. Unused reservations are not
silently reclaimed: doing so could forget uncertain writes or replay receipts.
This is not a filesystem quota for job homes, process logs or source checkouts.
"""
from __future__ import annotations

import copy
import os
from pathlib import Path

from state import lock_file, private, read_json, require, write_atomic

LEDGER = "protocol-storage.json"
DEFAULTS = {"max_bytes": 256 * 1024 * 1024, "reserved_bytes": 16 * 1024 * 1024,
            "max_files": 8192, "reserved_files": 256, "max_state_bytes": 4 * 1024 * 1024}
DIRECTORIES = {"actions", "execution-actions", "artifacts", "view-snapshots", "review-contracts"}
FILES = {"state.json", "transaction.json", "heartbeat.json"}


def settings(config):
    communication = config.get("communication", {})
    if communication.get("mode") != "enforced" and "storage" not in communication:
        return None
    configured = communication.get("storage", {})
    require(isinstance(configured, dict) and set(configured) <= DEFAULTS.keys(),
            "storage", "unknown retained protocol storage setting")
    limits = {**DEFAULTS, **configured}
    require(all(type(value) is int and value > 0 for value in limits.values()),
            "storage", "retained protocol storage limits must be positive integers")
    require(limits["reserved_bytes"] < limits["max_bytes"] and limits["reserved_files"] < limits["max_files"]
            and limits["max_state_bytes"] < limits["max_bytes"] - limits["reserved_bytes"],
            "storage", "protocol storage must leave ordinary and recovery capacity")
    return limits


def initialize(run_dir, config):
    limits = settings(config)
    if limits is None:
        return
    path = Path(run_dir)
    require(not (path / LEDGER).exists(), "storage", "protocol storage is already initialized")
    existing = {name: (path / name).stat().st_size for name in FILES if (path / name).is_file()}
    for name in DIRECTORIES:
        if (path / name).is_dir():
            existing.update({str(item.relative_to(path)): item.stat().st_size
                             for item in (path / name).iterdir() if item.is_file()})
    ledger = {"schema": 1, "limits": limits, "files": {}}
    allocate(ledger, existing, recovery=False)
    write_atomic(path / LEDGER, ledger)


def ensure(run_dir, config):
    if settings(config) is not None:
        require((Path(run_dir) / LEDGER).is_file(), "incompatible",
                "retained protocol budget is missing; resume with the compatible runtime, do not reset live receipts")


def locate(path):
    path = Path(path)
    root = path.parent if path.name in FILES else path.parent.parent if path.parent.name in DIRECTORIES else None
    return root if root is not None and (root / LEDGER).exists() else None


def allocate(ledger, files, *, recovery, control=False):
    limits = ledger["limits"]
    before = sum(ledger["files"].values())
    # The final half is for stopping work: pause/cancel, trusted coordinator
    # replacement and bounded terminal job observations. Ordinary recovery
    # receipts, replies and new work cannot spend it.
    withheld_bytes = 0 if control else (limits["reserved_bytes"] + 1) // 2 if recovery else limits["reserved_bytes"]
    withheld_files = 0 if control else (limits["reserved_files"] + 1) // 2 if recovery else limits["reserved_files"]
    for name, size in files.items():
        require(type(size) is int and size >= 0, "storage", "invalid storage reservation")
        relative = Path(name)
        require(not relative.is_absolute() and ".." not in relative.parts
                and (name in FILES or len(relative.parts) == 2 and relative.parts[0] in DIRECTORIES),
                "storage", "reservation is outside retained protocol storage")
        charge = max(4096, 2 * size + 512)
        if name == "state.json":
            extra = min(limits["reserved_bytes"], 1024 * 1024)
            maximum = limits["max_state_bytes"] + (extra if control else extra // 2 if recovery else 0)
            # Completing a previously reserved transaction requires no new
            # capacity, including crash recovery after a protected control.
            require(size <= maximum or charge <= ledger["files"].get(name, 0),
                    "storage_capacity", "retained state limit reached; preserve existing evidence and stop new work")
        # Metadata allowance bounds the ledger itself, including tiny files.
        ledger["files"][name] = max(ledger["files"].get(name, 0), charge)
    used = sum(ledger["files"].values())
    require(used == before or used <= limits["max_bytes"] - withheld_bytes
            and len(ledger["files"]) <= limits["max_files"] - withheld_files,
            "storage_capacity", "retained protocol capacity reached; existing receipts remain readable and recovery capacity is reserved")


def reserve(run_dir, files, *, recovery=False, control=False):
    path = Path(run_dir)
    if not (path / LEDGER).exists():
        return  # Explicit legacy runs do not acquire an implicit new policy.
    fd = os.open(path / "protocol-storage.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        private(path / "protocol-storage.lock")
        lock_file(fd)
        ledger = read_json(path / LEDGER)
        require(ledger.get("schema") == 1, "incompatible", "unsupported retained protocol storage schema")
        updated = copy.deepcopy(ledger)
        allocate(updated, files, recovery=recovery, control=control)
        if updated != ledger:
            write_atomic(path / LEDGER, updated)
    finally:
        os.close(fd)


def status(run_dir):
    ledger = read_json(Path(run_dir) / LEDGER)
    return {"limits": ledger["limits"], "reserved_bytes": sum(ledger["files"].values()),
            "reserved_files": len(ledger["files"]), "accounting": "conservative retained protocol reservations"}
