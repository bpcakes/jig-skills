"""Quiet integration observations; Git runs only in a private object cache.

The state engine calls the pure policy functions here. Only refresh() executes
commands, outside state transactions and task execution slots.
"""
from __future__ import annotations

from collections import defaultdict
import copy
import fcntl
import fnmatch
import hashlib
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
from datetime import datetime, timezone

from state import Engine, StateError, canonical, instant, nonempty, private, require, timestamp, write_atomic

OID = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
PROBE_VERSION = 1
DEFAULT_GROUPS = {
    "migrations": ["migrations/*", "*/migrations/*", "db/migrate/*", "*/db/migrate/*"],
    "generated": ["generated/*", "*/generated/*", "*.generated.*"],
}


def settings(config):
    return {"enabled": True, "remote": "origin", "max_age_seconds": 120,
            "timeout_seconds": 30, "overlap_groups": DEFAULT_GROUPS,
            **config.get("integration", {})}


def validate_config(config):
    raw = config.get("integration", {})
    require(isinstance(raw, dict) and set(raw) <= {
        "enabled", "source", "remote", "max_age_seconds", "timeout_seconds", "overlap_groups"},
        "invalid", "unsupported integration configuration")
    cfg = settings(config)
    require(type(cfg["enabled"]) is bool, "invalid", "integration.enabled must be boolean")
    for key in ("source", "remote"):
        if key in cfg:
            require(nonempty(cfg[key]) and not cfg[key].startswith("-") and "\0" not in cfg[key],
                    "invalid", f"integration.{key} must name a configured Git source")
    for key, maximum in (("max_age_seconds", 3600), ("timeout_seconds", 60)):
        require(type(cfg[key]) in {int, float} and 0 < cfg[key] <= maximum,
                "invalid", f"integration.{key} must be positive and at most {maximum}")
    groups = cfg["overlap_groups"]
    require(isinstance(groups, dict) and all(nonempty(k) and isinstance(v, list) and v
            and all(nonempty(p) and "\0" not in p for p in v) for k, v in groups.items()),
            "invalid", "overlap_groups maps names to nonempty path-pattern lists")


def valid_ref(value):
    return (nonempty(value) and value.startswith("refs/") and not value.endswith(("/", "."))
            and not any(x in value for x in ("..", "@{", "//"))
            and not any(ord(c) < 33 or ord(c) == 127 or c in "~^:?*[\\" for c in value)
            and all(not p.startswith(".") and not p.endswith(".lock") for p in value.split("/")))


def registrations(state):
    return {tid: {cid: c for cid, c in task.get("candidates", {
                "branch": {"ref": "refs/heads/" + task["branch"], "pr": None, "active": True}}).items() if c.get("active", True)}
            for tid, task in state["tasks"].items() if task["phase"] != "closed"}


def binding(state):
    return hashlib.sha256(canonical({"probe_version": PROBE_VERSION, "repository": state["config"]["repository"],
        "settings": settings(state["config"]), "candidates": registrations(state),
        "epoch": state.get("integration", {}).get("epoch", 0)}).encode()).hexdigest()


def invalidate(state, reason):
    observations = state.setdefault("integration", {})
    observations["epoch"] = observations.get("epoch", 0) + 1
    observations["pending_refresh"] = reason


def register(state, task, candidate):
    require(isinstance(candidate, dict) and set(candidate) <= {"id", "ref", "pr", "active"},
            "invalid", "candidate needs id, ref, optional pr and active")
    cid = candidate.get("id")
    require(nonempty(cid) and len(cid) <= 200 and valid_ref(candidate.get("ref")),
            "invalid", "candidate requires a stable ID and full Git ref")
    require(candidate.get("pr") is None or type(candidate["pr"]) is int and candidate["pr"] > 0,
            "invalid", "candidate pr must be a positive number")
    require(type(candidate.get("active", True)) is bool, "invalid", "candidate.active must be boolean")
    normalized = {"ref": candidate["ref"], "pr": candidate.get("pr"), "active": candidate.get("active", True)}
    candidates = task.setdefault("candidates", {})
    if candidates.get(cid) != normalized:
        candidates[cid] = normalized
        invalidate(state, "candidate_changed")
    return {"candidate_id": cid, **normalized}


def gated(config, request):
    if not settings(config)["enabled"]:
        return False
    kind = request.get("kind")
    if kind == "validate":
        purpose = request.get("purpose", "final")
        require(purpose in {"final", "repair", "acceptance"}, "invalid", "validation purpose is final, repair or acceptance")
        return purpose == "final"
    return kind in {"review", "merge"}


def fresh(state):
    current = state.get("integration", {})
    return (current.get("binding") == binding(state) and not current.get("pending_refresh")
            and current.get("observed_at") is not None
            and 0 <= (datetime.now(timezone.utc) - instant(current["observed_at"])).total_seconds()
            <= settings(state["config"])["max_age_seconds"])


def stage_waiter(task, request, candidate_id, expected=None):
    """Keep the counted assignment's identity as well as the rejected request."""
    if expected is None:
        expected = task["reservations"].get(request.get("reservation_id"), {}).get("integration")
    waiter = {"task_id": task["id"], "candidate_id": candidate_id, "head": request["target"]["head"]}
    if expected is not None:
        waiter["assignment"] = {key: expected.get(key) for key in ("candidate_id", "head", "configuration")}
    return waiter


def gate(state, task, request, expected=None):
    """Bind a new final stage to fresh evidence without changing review refs."""
    if not gated(state["config"], request):
        if request.get("kind") == "validate" and request.get("purpose") == "acceptance":
            require(bool(task.get("merged_prs")), "integration", "acceptance validation requires a recorded merge")
        return None
    candidates = registrations(state).get(task["id"], {})
    cid = request.get("candidate_id")
    if cid is None and len(candidates) == 1:
        cid = next(iter(candidates))
    require(cid in candidates, "integration", "select a registered active candidate_id for this stage")
    target = request.get("target", {})
    require(isinstance(target, dict) and OID.fullmatch(str(target.get("head", ""))),
            "integration", "final stages require target.head as an exact committed SHA")
    if request.get("kind") == "merge":
        require(candidates[cid].get("pr") == target.get("pr"), "integration", "merge candidate must bind this PR")
    current = state.get("integration", {})
    observation = current.get("observations", {}).get(task["id"], {}).get(cid, {})
    result = {"candidate_id": cid, "head": observation.get("head"), "target": observation.get("target"),
              "configuration": current.get("configuration")}
    reason = ("stale" if not fresh(state) else "head_changed" if observation.get("head") != target["head"]
              else observation.get("status", "unknown"))
    # A clean target-only update refreshes evidence for the same unissued
    # assignment. Candidate identity and merge policy still fence its scope.
    changed = expected is not None and any(result[key] != expected.get(key)
                                           for key in ("candidate_id", "head", "configuration"))
    if reason != "clean" or changed:
        error = StateError("integration", f"Integration {reason if reason != 'clean' else 'changed'} for {cid}; refresh and inspect this candidate before starting the stage")
        error.integration_waiter = stage_waiter(task, request, cid, expected)
        if reason == "stale":
            error.integration_waiter["after"] = current.get("checked_at")
        raise error
    return result


def overlaps(observations, groups):
    by_path, by_group = defaultdict(set), defaultdict(set)
    for tid, candidates in observations.items():
        for cid, result in candidates.items():
            for path in result.get("changed_paths", []):
                by_path[path].add((tid, cid))
                for group, patterns in groups.items():
                    if any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns):
                        by_group[group].add((tid, cid))
    warnings = defaultdict(list)
    for kind, index in (("path", by_path), ("group", by_group)):
        for name, owners in sorted(index.items()):
            if len(owners) < 2:
                continue
            warning = {"kind": kind, "name": name, "owners": [list(o) for o in sorted(owners)]}
            for owner in owners:
                warnings[owner].append(warning)
    return warnings


def annotate_overlaps(observations, previous, groups):
    # Unknown is not proof that an overlap disappeared. Retain the paths at
    # their original evidence, so healthy partners keep the same advisory too.
    for tid, candidates in observations.items():
        for cid, result in candidates.items():
            old = previous.get("observations", {}).get(tid, {}).get(cid, {})
            if result["status"] == "unknown" and "changed_paths" in old:
                result.update(changed_paths=old["changed_paths"], paths_stale=True,
                              paths_evidence=old.get("paths_evidence") or previous.get("evidence"))
    warnings = overlaps(observations, groups)
    for tid, candidates in observations.items():
        for cid, result in candidates.items():
            result["overlaps"] = warnings[(tid, cid)]
            stale = {observations[owner][candidate].get("paths_evidence")
                     for warning in result["overlaps"] for owner, candidate in warning["owners"]
                     if observations[owner][candidate].get("paths_stale")}
            result["overlaps_stale"] = bool(stale)
            result["overlap_evidence"] = sorted(ref for ref in stale if ref)


def publish(state, snapshot, report):
    """Called only inside the engine lock; obsolete scans never clear blockers."""
    if binding(state) != snapshot:
        return False
    current = state.setdefault("integration", {})
    if current.get("checked_at") and instant(current["checked_at"]) >= instant(report["checked_at"]):
        return False
    incidents = current.setdefault("incidents", {})
    at = report["checked_at"]
    for tid, candidates in report["observations"].items():
        for cid, result in candidates.items():
            key = canonical([tid, cid])
            prior = incidents.get(key, {})
            if result["status"] == "conflicted" and not prior.get("active"):
                if prior:
                    current.setdefault("incident_history", []).append(copy.deepcopy(prior))
                incidents[key] = {"id": hashlib.sha256((key + at).encode()).hexdigest()[:20],
                    "active": True, "target_observed_at": report["observed_at"], "detected_at": at,
                    "head": result["head"], "target": result["target"],
                    "active_executions": copy.deepcopy(state["tasks"][tid]["reservations"])}
            elif result["status"] == "clean" and prior.get("active"):
                prior.update(active=False, resolved_at=at)
    active_keys = {canonical([tid, cid]) for tid, candidates in registrations(state).items() for cid in candidates}
    for key, incident in incidents.items():
        if key not in active_keys and incident.get("active"):
            incident.update(active=False, retired_at=at)
    stats = current.setdefault("stats", {})
    for key, value in report["counts"].items():
        stats[key] = stats.get(key, 0) + value
    current.update(report, binding=snapshot, pending_refresh=None)
    return True


def view(state, task_id):
    """Compact evidence plus a separate actionable-only watch projection."""
    current = state.get("integration", {})
    if not settings(state["config"])["enabled"]:
        return {"enabled": False}, {}
    values, signals = {}, {}
    for cid, candidate in registrations(state).get(task_id, {}).items():
        result = current.get("observations", {}).get(task_id, {}).get(cid, {})
        incident = current.get("incidents", {}).get(canonical([task_id, cid]), {})
        waiting = current.get("waiters", {}).get(canonical([task_id, cid]))
        warnings = result.get("overlaps", [])
        active = incident.get("active", False)
        outcome = None
        if waiting:
            bound = waiting.get("assignment", waiting)
            # This is a notification about a completed observation, not an
            # admission check. Clock expiry/global invalidation stays silent;
            # gate() always checks freshness again before starting work.
            if "after" in waiting and current.get("checked_at") == waiting["after"]:
                outcome = {"status": "pending"}
            elif bound["candidate_id"] != cid:
                outcome = {"status": "candidate_changed", "candidate_id": cid}
            elif result.get("status", "unknown") == "unknown":
                outcome = {"status": "unknown", "reason": result.get("reason") or "not_observed"}
            elif result.get("head") != waiting["head"] or result.get("head") != bound["head"]:
                outcome = {"status": "head_changed", "head": result.get("head")}
            elif "configuration" in bound and bound["configuration"] != current.get("configuration"):
                outcome = {"status": "policy_changed", "configuration": current.get("configuration")}
            else:
                outcome = {"status": "ready" if result["status"] == "clean" else "conflicted"}
        next_action = {
            "pending": "Wait for the shared integration scan to finish.",
            "ready": "Retry the waiting final stage with current integration evidence.",
            "head_changed": "Inspect the published candidate and update the final stage's target.head.",
            "policy_changed": "Inspect the changed merge policy and settle the unstarted stage before replacing it.",
            "unknown": "Restore candidate/source access or probe support, then refresh integration evidence.",
        }.get((outcome or {}).get("status"))
        if waiting and waiting.get("assignment") and outcome["status"] in {"candidate_changed", "head_changed"}:
            next_action = "Inspect the changed candidate; settle the unstarted stage before replacing its frozen assignment."
        signals[cid] = {"conflict": incident.get("id") if active else None,
                        "waiting": outcome, "overlaps": [] if active else warnings}
        values[cid] = {"status": result.get("status", "unknown"), "head": result.get("head"),
            "target": result.get("target"), "observed_at": current.get("observed_at"),
            "conflict_paths": result.get("conflict_paths", [])[:30], "reason": result.get("reason"),
            "overlaps": warnings[:10], "overlap_count": len(warnings), "evidence": current.get("evidence"),
            "overlaps_stale": result.get("overlaps_stale", False), "overlap_evidence": result.get("overlap_evidence"),
            "incident_id": incident.get("id") if active else None, "waiting": outcome,
            "next_action": "Settle the active execution, integrate the latest target, and review the resulting candidate."
                if active else next_action or ("Inspect overlapping work with its owners before final validation." if warnings else None)}
    return {"enabled": True, "candidates": values}, signals


class ProbeError(Exception):
    pass


class Git:
    def __init__(self, directory, timeout):
        self.directory = directory
        self.deadline = time.monotonic() + timeout
        self.version = ""

    def run(self, *args, isolated=False):
        # Repository identity never leaks in from the caller. Keep configured
        # authentication and Git configuration when reading policy/fetching;
        # isolate configuration completely for object-only merge operations.
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_") or k in {
            "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "GIT_SSH_VARIANT", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH"}
            or not isolated and k.startswith("GIT_CONFIG_")}
        env["GIT_TERMINAL_PROMPT"] = "0"
        if isolated:
            env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_ATTR_NOSYSTEM="1")
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise ProbeError("timeout")
        with tempfile.TemporaryFile(dir=self.directory) as out, tempfile.TemporaryFile(dir=self.directory) as err:
            try:
                process = subprocess.Popen(["git", *args], stdout=out, stderr=err, env=env, start_new_session=True)
                try:
                    process.wait(timeout=remaining)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
                    raise
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise ProbeError("git_unavailable_or_timeout") from exc
            out.seek(0)
            data = out.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise ProbeError("output_limit")
            # Keep command errors out of task prompts (remote URLs may contain credentials).
            return process.returncode, data

    def checked(self, *args, **kwargs):
        code, data = self.run(*args, **kwargs)
        if code:
            raise ProbeError("git_command_failed")
        return data


def merge_policy(git, repository):
    git.version = git.checked("--version").decode().strip()
    version = re.search(r"(\d+)\.(\d+)", git.version)
    if version is None or tuple(map(int, version.groups())) < (2, 42):
        raise ProbeError("git_2_42_required")
    code, raw = git.run("-C", repository, "config", "--null", "--get-regexp",
        r"^(merge\.|filter\.|diff\.(renames|renamelimit)$|branch\..*\.mergeoptions$|core\.(attributesfile|autocrlf|eol|safecrlf|checkroundtripencoding)$)")
    if code not in {0, 1}:
        raise ProbeError("repository_config_unavailable")
    entries = []
    for record in raw.decode(errors="replace").split("\0"):
        if record:
            key, separator, value = record.partition("\n")
            entries.append((key, value if separator else None))
    options = []
    normalization = dict(entries).get("merge.renormalize", "false")
    renormalize = normalization is None or normalization.lower() in {"true", "yes", "on", "1"}
    for key, value in entries:
        if ((key.startswith("filter.") and renormalize) or key in {"core.attributesfile", "merge.default"}
                or key.endswith((".driver", ".mergeoptions"))):
            raise ProbeError("custom_merge_policy")
        if key in {"merge.renames", "merge.renamelimit", "merge.directoryrenames", "merge.renormalize",
                   "diff.renames", "diff.renamelimit", "core.autocrlf", "core.eol", "core.safecrlf", "core.checkroundtripencoding"}:
            options.extend(["-c", key if value is None else key + "=" + value])
    info = git.checked("-C", repository, "rev-parse", "--git-path", "info/attributes").decode().strip()
    info_path = Path(info) if Path(info).is_absolute() else Path(repository) / info
    if info_path.exists() and info_path.read_bytes().strip():
        raise ProbeError("external_attributes")
    for variable in ("GIT_ATTR_SYSTEM", "GIT_ATTR_GLOBAL"):
        code, path = git.run("var", variable)
        if code:
            raise ProbeError("attribute_policy_unavailable")
        attribute_path = Path(os.fsdecode(path.strip()))
        if attribute_path.is_file() and attribute_path.read_bytes().strip():
            raise ProbeError("external_attributes")
    return options, hashlib.sha256(canonical([git.version, entries]).encode()).hexdigest()


def probe(git, cache, head, target, options):
    for oid in (head, target):
        if not OID.fullmatch(oid) or git.run("--git-dir", str(cache), "cat-file", "-e", oid + "^{commit}", isolated=True)[0]:
            raise ProbeError("missing_commit")
        code, attrs = git.run("--git-dir", str(cache), "grep", "-I", "-h", "-e", "merge=", oid,
                              "--", ".gitattributes", ":(glob)**/.gitattributes", isolated=True)
        if code not in {0, 1}:
            raise ProbeError("attributes_unavailable")
        if any(name not in {b"text", b"binary", b"union"} for name in re.findall(rb"\bmerge=([^\s]+)", attrs)):
            raise ProbeError("custom_merge_attributes")
    code, data = git.run("--attr-source=" + target, *options, "--git-dir", str(cache), "merge-tree",
                         "--write-tree", "--name-only", "-z", target, head, isolated=True)
    fields = data.split(b"\0")
    if code not in {0, 1} or not OID.fullmatch(os.fsdecode(fields[0])) or b"" not in fields[1:]:
        raise ProbeError("invalid_merge_result")
    end = fields.index(b"", 1)
    result = {"status": "clean" if code == 0 else "conflicted",
              "conflict_paths": [os.fsdecode(p) for p in fields[1:end]], "changed_paths": []}
    # Multiple merge bases are handled by merge-tree itself. Union path hints
    # across them without inventing a base for the actual merge operation.
    bases = git.checked("--git-dir", str(cache), "merge-base", "--all", target, head, isolated=True).splitlines()
    paths = set()
    for base in bases:
        paths.update(p for p in git.checked("--git-dir", str(cache), "diff", "--name-only", "--no-renames", "-z",
                     os.fsdecode(base), head, "--", isolated=True).split(b"\0") if p)
    result["changed_paths"] = sorted(os.fsdecode(p) for p in paths)
    return result


def scan(directory, state, deadline=None):
    cfg = settings(state["config"])
    timeout = cfg["timeout_seconds"]
    if deadline is not None:
        timeout = min(timeout, max(0, deadline - time.monotonic()))
    git = Git(directory, timeout)
    candidates = registrations(state)
    observations = {tid: {cid: {"status": "unknown", "reason": "not_observed"} for cid in items} for tid, items in candidates.items()}
    counts = {"scans": 1, "probes": 0, "cache_hits": 0, "fetches": 0}
    report = {"observations": observations, "counts": counts, "configuration": None, "target": None}
    cache = directory / "objects.git"
    try:
        repository = state["config"]["repository"]["path"]
        source = cfg.get("source") or git.checked("-C", repository, "remote", "get-url", cfg["remote"]).decode().strip()
        require(nonempty(source) and not source.startswith("-"), "invalid", "invalid integration source")
        if not Path(source).is_absolute() and ":" not in source:
            source = str((Path(repository) / source).resolve())
        options, policy = merge_policy(git, repository)
        # Observation budgets and advisory groups do not change a Git merge or
        # the scope of an already counted assignment.
        report["configuration"] = hashlib.sha256(canonical([PROBE_VERSION, source, policy]).encode()).hexdigest()
        if not cache.exists():
            object_format = git.checked("-C", repository, "rev-parse", "--show-object-format").decode().strip()
            git.checked("init", "--bare", "--template=", "--object-format=" + object_format, str(cache), isolated=True)
            cache.chmod(0o700)
        private(cache, directory=True)
        target_ref = state["config"]["repository"]["target"]
        target_ref = target_ref if target_ref.startswith("refs/") else "refs/heads/" + target_ref
        if not valid_ref(target_ref):
            raise ProbeError("invalid_target_ref")
        refs = sorted({target_ref} | {c["ref"] for items in candidates.values() for c in items.values()})
        advertised = None
        for attempt in range(2):
            code, listing = git.run("ls-remote", "--refs", "--", source, *refs)
            if code == 0:
                advertised = dict(line.split("\t", 1)[::-1] for line in listing.decode().splitlines() if "\t" in line)
                break
            if attempt == 0 and git.deadline - time.monotonic() > 1:
                time.sleep(0.25)
        if advertised is None or target_ref not in advertised:
            raise ProbeError("target_unavailable")
        advertised = {ref: oid for ref, oid in advertised.items() if ref in refs and OID.fullmatch(oid)}
        local_refs = {ref: "refs/observed/" + hashlib.sha256(ref.encode()).hexdigest() for ref in advertised}
        prior = git.checked("--git-dir", str(cache), "for-each-ref", "--format=%(refname) %(objectname)", "refs/observed/", isolated=True)
        known = dict(line.split(" ", 1) for line in prior.decode().splitlines())
        if any(known.get(local_refs[ref]) != oid for ref, oid in advertised.items()):
            git.checked("-c", "core.hooksPath=" + os.devnull, "-c", "maintenance.auto=false", "-c", "gc.auto=0",
                        "-c", "fetch.recurseSubmodules=false", "--git-dir", str(cache),
                        "fetch", "--atomic", "--no-tags", "--no-write-fetch-head", "--", source,
                        *["+" + ref + ":" + local_refs[ref] for ref in advertised])
            counts["fetches"] += 1
        fetched = git.checked("--git-dir", str(cache), "for-each-ref", "--format=%(refname) %(objectname)", "refs/observed/", isolated=True)
        actual = dict(line.split(" ", 1) for line in fetched.decode().splitlines())
        heads = {ref: actual[local_refs[ref]] for ref in advertised}
        report["observed_at"] = timestamp()
        target = report["target"] = heads[target_ref]
        results_dir = directory / "pairs"
        results_dir.mkdir(mode=0o700, exist_ok=True)
        private(results_dir, directory=True)
        from state import read_json
        for tid, items in candidates.items():
            for cid, candidate in items.items():
                head = heads.get(candidate["ref"])
                result = {"head": head, "target": target, "status": "unknown", "reason": "candidate_unavailable"}
                if head:
                    key = hashlib.sha256(canonical([head, target, report["configuration"]]).encode()).hexdigest()
                    path = results_dir / (key + ".json")
                    try:
                        if path.exists():
                            result = {**result, **read_json(path), "reason": None}
                            counts["cache_hits"] += 1
                        else:
                            counts["probes"] += 1
                            result = {**result, **probe(git, cache, head, target, options), "reason": None}
                            write_atomic(path, result)
                    except ProbeError as exc:
                        result["reason"] = str(exc)
                observations[tid][cid] = result
    except (ProbeError, OSError, ValueError) as exc:
        counts["failed_scans"] = 1
        for items in observations.values():
            for result in items.values():
                result.update(status="unknown", reason=str(exc) if isinstance(exc, ProbeError) else "observation_failed")
    annotate_overlaps(observations, state.get("integration", {}), cfg["overlap_groups"])
    report["checked_at"] = timestamp()
    report.setdefault("observed_at", report["checked_at"])
    report["evidence"] = str(directory / ("scan-" + hashlib.sha256(report["checked_at"].encode()).hexdigest()[:20] + ".json"))
    write_atomic(Path(report["evidence"]), report)
    return report


def refresh(run_dir, task_id=None, caller="coordinator", *, wait=False):
    state = Engine.read(run_dir)
    if caller != "coordinator":
        Engine._authorize(state, {"op": "observe"}, caller, state["tasks"].get(task_id))
    if not settings(state["config"])["enabled"]:
        return {"status": "disabled"}
    if not any(registrations(state).values()):
        return {"status": "idle"}
    after = state.get("integration", {}).get("checked_at")
    deadline = time.monotonic() + settings(state["config"])["timeout_seconds"]

    def observed(latest, coalesced=False):
        if caller != "coordinator":
            Engine._authorize(latest, {"op": "observe"}, caller, latest["tasks"].get(task_id))
        current = latest["integration"]
        return {"status": "observed", "coalesced": coalesced,
                **({"integration": view(latest, task_id)[0]} if task_id else
                   {"target": current["target"], "counts": current.get("counts", {}), "evidence": current["evidence"]})}

    directory = Path(run_dir).absolute() / "integration"
    directory.mkdir(mode=0o700, exist_ok=True)
    private(directory, directory=True)
    fd = os.open(directory / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        private(directory / "lock")
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                if not wait or remaining <= 0:
                    return {"status": "busy" if not wait else "timeout"}
                time.sleep(min(0.05, remaining))
        # Re-read after acquiring the separate probe lock; no state lock crosses Git.
        attempts = 0
        while True:
            state = Engine.read(run_dir)
            if caller != "coordinator":
                Engine._authorize(state, {"op": "observe"}, caller, state["tasks"].get(task_id))
            if not settings(state["config"])["enabled"]:
                return {"status": "disabled"}
            if not any(registrations(state).values()):
                return {"status": "idle"}
            if state.get("integration", {}).get("checked_at") != after and fresh(state):
                return observed(state, coalesced=True)
            if time.monotonic() >= deadline:
                return {"status": "timeout"}
            report = scan(directory, state, deadline=deadline)
            if Engine.publish_integration(run_dir, binding(state), report):
                return observed(Engine.read(run_dir))
            attempts += 1
            if not wait and attempts >= 2:
                return {"status": "superseded"}
    finally:
        os.close(fd)


def before_stage(run_dir, request, caller):
    state = Engine.read(run_dir)
    task = state["tasks"].get(request.get("task_id"))
    Engine._authorize(state, {**request, "op": "prepare"}, caller, task)
    if gated(state["config"], request):
        result = refresh(run_dir, request.get("task_id"), caller)
        if result["status"] in {"busy", "superseded", "timeout"}:
            Engine.wait_for_integration(run_dir, request, caller, state.get("integration", {}).get("checked_at"))
        require(result["status"] == "observed", "integration",
                "Integration refresh " + result["status"] + "; inspect candidate registration or retry this unstarted stage")


def after_transition(run_dir, request, result):
    """A durable invalidation survives a crash or a concurrently running scan."""
    if request.get("op") in {"candidate", "observe", "outcome", "finish"}:
        state = Engine.read(run_dir)
        if state.get("integration", {}).get("pending_refresh"):
            try:
                refresh(run_dir)
            except (OSError, StateError):
                # An observation failure must never relabel a settled external
                # effect or authorize replay. The durable invalidation remains.
                return

