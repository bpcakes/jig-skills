"""Behavioral tests with isolated state; no Herdr, tracker, or GitHub access."""

import copy
import json
import multiprocessing
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "herdr-orchestrate" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import state as state_module
from state import Engine, StateError


def concurrent_reserve(run_dir, task_id, version, queue):
    try:
        result = Engine.apply(run_dir, {"action_id": "parallel-" + task_id, "op": "reserve",
                                       "expected_policy": 1, "task_id": task_id, "expected_task": version,
                                       "kind": "implement", "unit": "implementation", "refs": {}})
        queue.put(result.get("reservation_id"))
    except StateError as exc:
        queue.put(exc.code)


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / "source"
        self.repo.mkdir()
        self.run = self.base / "private-run"
        self.serial = 0
        self.config = {
            "repository": {"path": str(self.repo), "target": "main"},
            "scope": {"task_ids": ["A", "B", "C"]},
            "tracker": {"kind": "bead", "authority": "canonical-ref"},
            "hosts": {"local": {"slots": 1, "worktree_root": "/worktrees", "endpoint": {"session": "owned"}},
                      "remote": {"slots": 1, "worktree_root": "/remote-worktrees", "endpoint": {"profile": "verified"}}},
            "actors": {"worker-a": {"role": "driver", "task_ids": ["A"], "host": "local", "helper_route": True}},
            "authority": sorted(Engine.ACTIONS), "unfinished_task_cap": None, "limits": [],
            "scheduler": {"enabled": True, "session": "owned", "control_pane_id": "w1:p2",
                          "agent": {"name": "coordinator", "agent": "codex", "pane_id": "w1:p1",
                                    "terminal_id": "terminal-1", "agent_session": {
                                        "agent": "codex", "kind": "session_id", "value": "native-1"}}},
        }
        Engine.initialize(self.run, self.config)

    def proof(self, settled=False):
        result = {"ref": "/evidence/receipt.json", "observed_at": "2026-10-11T12:00:00+00:00"}
        if settled:
            result["all_jobs_settled"] = True
        return result

    def request(self, op, task_id=None, **fields):
        current = Engine.read(self.run)
        self.serial += 1
        req = {"action_id": f"action-{self.serial}", "op": op, "expected_policy": current["policy_version"], **fields}
        if task_id:
            req["task_id"] = task_id
            if task_id in current["tasks"]:
                req["expected_task"] = current["tasks"][task_id]["version"]
        return req

    def apply(self, op, task_id=None, caller="coordinator", **fields):
        return Engine.apply(self.run, self.request(op, task_id, **fields), caller=caller)

    def admit(self, task_id="A", host="local", **changes):
        claim = {**self.proof(), "authority": "canonical-ref", "task_id": task_id, "owner": "tracker-actor",
                 "confirmed": True, "ready": True, "unpublished": False}
        values = {"host": host, "driver": "worker-a" if task_id == "A" else "coordinator",
                  "worktree": self.config["hosts"][host]["worktree_root"] + "/" + task_id,
                  "branch": "task/" + task_id, "claim": claim}
        values.update(changes)
        return self.apply("admit", task_id, **values)

    def reserve(self, task_id="A", kind="implement", refs=None, caller="coordinator"):
        return self.apply("reserve", task_id, kind=kind, unit=Engine.UNITS[kind], refs=refs or {}, caller=caller)

    def settle(self, reservation_id, task_id="A", refs=None):
        return self.apply("settle", task_id, reservation_id=reservation_id, refs=refs or {}, evidence=self.proof(True))

    def assert_error(self, code, fn, *args, **kwargs):
        with self.assertRaises(StateError) as ctx:
            fn(*args, **kwargs)
        self.assertEqual(ctx.exception.code, code)

    def reset(self, **changes):
        self.config.update(changes)
        self.run = self.base / f"private-run-{self.serial}"
        self.serial += 1
        Engine.initialize(self.run, self.config)

    def assert_cli_object_error(self, command, request, *arguments):
        before = Engine.read(self.run)
        argv = [sys.executable, "-B", str(SCRIPTS / "supervise.py"), command]
        if command != "preflight":
            argv.extend(["--run-dir", str(self.run)])
        with patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": ""}):
            result = subprocess.run([*argv, *arguments], input=json.dumps(request),
                                    capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "")
        response = json.loads(result.stdout)
        self.assertIs(response["ok"], False)
        self.assertEqual(response["error"]["code"], "invalid_input")
        self.assertTrue(response["error"]["message"])
        self.assertEqual(Engine.read(self.run), before)
        self.assertFalse((self.run / "transaction.json").exists())

    def test_cli_rejects_wrong_shape_successor_on_restricted_route(self):
        self.admit()
        self.apply("observe", "A", fields={"refs": {"session": "old"}}, evidence=self.proof())
        for successor in ("x", [], 1, None):
            with self.subTest(successor=successor):
                request = self.request("observe", "A", fields={"refs": {"session": "new"}},
                                       successor=successor, evidence=self.proof())
                self.assert_cli_object_error("serve", request, "--caller", "worker-a")
        self.apply("observe", "A", caller="worker-a", fields={"refs": {"session": "new"}},
                   successor={"previous_refs": {"session": "old"}, "evidence": self.proof(True)},
                   evidence=self.proof())
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["refs"]["session"], "new")

    def test_cli_rejects_wrong_shape_merge_gates_on_restricted_route(self):
        self.admit()
        self.apply("delegate", "A", executor="worker-a", actions=["merge"])
        reservation = self.reserve(kind="merge", caller="worker-a")
        target = {"repository": str(self.repo), "base": "main", "pr": 10, "head": "H2"}
        for gates in ([], "x", 1, None):
            with self.subTest(gates=gates):
                request = self.request("intent", "A", kind="merge", target=target,
                                       reservation_id=reservation["reservation_id"], gates=gates, evidence=self.proof())
                self.assert_cli_object_error("serve", request, "--caller", "worker-a")

    def test_cli_rejects_wrong_shape_claim_and_reopen_targets(self):
        for target in ("x", [], 1, None):
            with self.subTest(op="claim_intent", target=target):
                self.assert_cli_object_error("apply", self.request(
                    "claim_intent", "A", target=target, evidence=self.proof()))
        self.admit()
        self.apply("close", "A", receipt={
            **self.proof(), "authority": "canonical-ref", "task_id": "A", "owner": "tracker-actor",
            "status": "closed", "criteria_met": True, "acceptance_ref": "/proof", "unpublished": False})
        for target in ("x", [], 1, None):
            with self.subTest(op="reopen_intent", target=target):
                self.assert_cli_object_error("apply", self.request(
                    "reopen_intent", "A", target=target, evidence=self.proof()))

    def test_cli_rejects_wrong_shape_configuration_objects(self):
        for field in ("repository", "scope", "tracker"):
            for value in ("x", [], 1, None):
                with self.subTest(field=field, value=value):
                    config = {**self.config, field: value}
                    self.assert_cli_object_error("init", config, "--config", "-")
        self.assert_cli_object_error("init", {**self.config, "hosts": {"local": "x"}}, "--config", "-")
        self.assert_cli_object_error("preflight", {**self.config, "hosts": []},
                                     "--config", "-", "--host", "local")

    def assert_cli_rejects_role_config(self, config):
        fresh_run = self.base / "invalid-roles-run"
        before = Engine.read(self.run)
        request = self.request("configure", fields={"hosts": config["hosts"]}, evidence=self.proof())
        commands = (("init", ["--run-dir", str(fresh_run), "--config", "-"], config),
                    ("preflight", ["--config", "-", "--host", "local"], config),
                    ("apply", ["--run-dir", str(self.run)], request))
        for command, arguments, payload in commands:
            with self.subTest(command=command):
                with patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": ""}):
                    result = subprocess.run(
                        [sys.executable, "-B", str(SCRIPTS / "supervise.py"), command, *arguments],
                        input=json.dumps(payload), capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stderr, "")
                response = json.loads(result.stdout)
                self.assertIs(response["ok"], False)
                self.assertIn("roles", response["error"]["message"])
                self.assertFalse(fresh_run.exists())
                self.assertEqual(Engine.read(self.run), before)
                self.assertFalse((self.run / "transaction.json").exists())

    def test_cli_rejects_host_roles_before_configuration_persistence(self):
        for roles in (None, 5, "coordinator", {}, [None], [5], [""], ["coordinator", " "]):
            with self.subTest(roles=roles):
                config = copy.deepcopy(self.config)
                config["hosts"]["local"]["roles"] = roles
                self.assert_cli_rejects_role_config(config)
        self.admit()

    def test_cli_rejects_profile_roles_before_configuration_persistence(self):
        for roles in (None, 5, "review", "coordinator", {}, [None], [5], [""], ["review", " "]):
            with self.subTest(roles=roles):
                config = copy.deepcopy(self.config)
                config["hosts"]["local"]["profiles"] = [
                    {"agent_home": str(self.base / "profile"), "roles": roles}]
                self.assert_cli_rejects_role_config(config)
        for roles in (None, [], ["review"]):
            with self.subTest(valid_roles=roles):
                hosts = copy.deepcopy(self.config["hosts"])
                profile = {"agent_home": str(self.base / "profile")}
                if roles is not None:
                    profile["roles"] = roles
                hosts["local"]["profiles"] = [profile]
                self.reset(hosts=hosts)
                self.apply("configure", fields={"hosts": hosts}, evidence=self.proof())
                self.assertEqual(Engine.read(self.run)["config"]["hosts"]["local"]["profiles"], [profile])
                self.admit()

    def test_host_role_lists_preserve_legacy_repository_protection(self):
        for roles in (None, [], ["worker"], ["worker", "coordinator"]):
            with self.subTest(roles=roles):
                hosts = copy.deepcopy(self.config["hosts"])
                hosts["local"].pop("roles", None)
                hosts["remote"].pop("roles", None)
                for info in hosts.values():
                    info["worktree_root"] = str(self.base)
                if roles is not None:
                    hosts["remote"]["roles"] = roles
                self.reset(hosts=hosts)
                self.apply("configure", fields={"hosts": hosts}, evidence=self.proof())
                protected = "remote" if roles and "coordinator" in roles else "local"
                other = "local" if protected == "remote" else "remote"
                self.assert_error("ownership", self.admit, "B", host=protected, worktree=str(self.repo))
                self.admit("B", host=other, worktree=str(self.repo))

    def test_private_external_state_and_unsupported_capabilities(self):
        self.assertEqual(self.run.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.run / "state.json").stat().st_mode & 0o777, 0o600)
        self.assert_error("location", Engine.initialize, self.repo / "run", self.config)
        bad = copy.deepcopy(self.config)
        bad["hard_spending_cap"] = 0
        self.assert_error("unsupported", Engine.initialize, self.base / "cost", bad)
        bad = copy.deepcopy(self.config)
        bad["limits"] = [{"id": "unsupported", "unit": "dollars", "scope": "run", "max": 5, "enforced": True}]
        self.assert_error("unsupported", Engine.initialize, self.base / "cost2", bad)
        other_source = self.base / "other-source"
        other_source.mkdir()
        (other_source / ".git").mkdir()
        (other_source / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
        self.assert_error("location", Engine.initialize, other_source / "state", self.config)
        self.run.chmod(0o755)
        self.assert_error("permissions", Engine.read, self.run)

    def test_same_action_is_idempotent_but_reused_payload_is_rejected(self):
        self.admit()
        req = self.request("reserve", "A", kind="repair", unit="source_repair", refs={})
        first = Engine.apply(self.run, req)
        self.assertEqual(Engine.apply(self.run, req), first)
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["counters"], {"source_repair": 1})
        altered = {**req, "kind": "review", "unit": "review"}
        self.assert_error("duplicate", Engine.apply, self.run, altered)
        self.assertEqual(Engine.action(self.run, req["action_id"])["result"], first)

    def test_write_ahead_recovery_covers_crash_after_state_before_receipt(self):
        self.admit()
        req = self.request("reserve", "A", kind="implement", unit="implementation", refs={})
        real_write = state_module.write_atomic

        def crash_action_write(path, value):
            if path.parent.name == "actions":
                raise OSError("simulated process interruption")
            return real_write(path, value)

        with patch.object(state_module, "write_atomic", side_effect=crash_action_write):
            with self.assertRaises(OSError):
                Engine.apply(self.run, req)
        self.assertTrue((self.run / "transaction.json").exists())
        restored = Engine.read(self.run)
        self.assertEqual(restored["tasks"]["A"]["counters"]["implementation"], 1)
        replay = Engine.apply(self.run, req)
        self.assertEqual(replay["version"], restored["version"])
        self.assertFalse((self.run / "transaction.json").exists())

    def test_failed_intent_storage_prevents_state_mutation(self):
        self.admit()
        before = Engine.read(self.run)
        req = self.request("reserve", "A", kind="implement", unit="implementation", refs={})
        with patch.object(state_module, "write_atomic", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                Engine.apply(self.run, req)
        self.assertEqual(Engine.read(self.run), before)

    def test_claim_scope_and_checkout_ownership(self):
        claim = {**self.proof(), "authority": "canonical-ref", "task_id": "A", "owner": "tracker-actor",
                 "confirmed": False, "ready": True, "unpublished": False}
        self.assert_error("claim", self.admit, claim=claim)
        claim.update(confirmed=True, ready=False)
        self.assert_error("claim", self.admit, claim=claim)
        self.assert_error("scope", self.admit, "outside")
        self.assert_error("location", self.admit, worktree=str(self.repo))
        self.admit()
        self.assert_error("ownership", self.admit)

    def test_lexical_checkout_aliases_cannot_duplicate_admission_or_handoff(self):
        self.admit("A", worktree="/worktrees/shared/.")
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["worktree"], "/worktrees/shared")
        self.assert_error("ownership", self.admit, "B", worktree="/worktrees/shared")
        self.assert_error("ownership", self.admit, "B", worktree="/worktrees/unused/../shared/")
        self.admit("B", host="remote")
        self.assert_error("ownership", self.apply, "handoff", "B", host="local", driver="coordinator",
                          worktree="/worktrees/shared/.", branch="task/B", identity={"agent_id": "new"},
                          source={**self.proof(), "published": True, "revision": "H1"}, evidence=self.proof(True))
        self.apply("handoff", "B", host="local", driver="coordinator", worktree="/worktrees/free/.", branch="task/B",
                   identity={"agent_id": "new"}, source={**self.proof(), "published": True, "revision": "H1"}, evidence=self.proof(True))
        self.assertEqual(Engine.read(self.run)["tasks"]["B"]["worktree"], "/worktrees/free")

    def test_configuration_normalizes_paths_and_protected_main_alias_is_rejected(self):
        hosts = copy.deepcopy(self.config["hosts"])
        hosts["local"]["worktree_root"] = str(self.base) + "/."
        self.reset(repository={"path": str(self.repo) + "/.", "target": "main"}, hosts=hosts)
        current = Engine.read(self.run)
        self.assertEqual(current["config"]["repository"]["path"], str(self.repo))
        self.assertEqual(current["config"]["hosts"]["local"]["worktree_root"], str(self.base))
        self.assert_error("ownership", self.admit, worktree=str(self.repo) + "/.")

    def test_admission_and_handoff_reject_overlapping_checkouts_on_the_same_host(self):
        hosts = copy.deepcopy(self.config["hosts"])
        for host in hosts.values():
            host["worktree_root"] = str(self.base.parent)
        self.reset(hosts=hosts)
        owned = self.base / "owned" / "A"
        self.admit("A", worktree=str(owned))
        self.admit("B", host="remote", worktree=str(self.base / "away"))
        target = {"host": "local", "driver": "coordinator", "branch": "task/B",
                  "identity": {"agent_id": "replacement"}, "evidence": self.proof(True),
                  "source": {**self.proof(), "published": True, "revision": "H1"}}
        for path in (str(self.repo), str(self.repo / "nested"), str(self.base),
                     str(owned), str(owned / "child"), str(owned.parent),
                     str(owned / "unused" / ".." / "child")):
            with self.subTest(path=path):
                before = Engine.read(self.run)
                self.assert_error("ownership", self.admit, "C", worktree=path)
                self.assertEqual(Engine.read(self.run), before)
                self.assert_error("ownership", self.apply, "handoff", "B", worktree=path, **target)
                self.assertEqual(Engine.read(self.run), before)
        sibling = str(owned) + "-sibling"
        self.apply("handoff", "B", worktree=sibling, **target)
        self.assertEqual(Engine.read(self.run)["tasks"]["B"]["worktree"], sibling)
        self.admit("C", host="remote", worktree=str(owned))
        self.assertEqual(Engine.read(self.run)["tasks"]["C"]["worktree"], str(owned))

    def test_repository_protection_uses_the_target_host_for_admission_and_handoff(self):
        hosts = copy.deepcopy(self.config["hosts"])
        for host in hosts.values():
            host["worktree_root"] = str(self.base)
        remote_main = self.base / "remote-main"
        hosts["remote"]["repository_path"] = str(remote_main) + "/."
        self.reset(hosts=hosts)
        self.admit("B", host="remote", worktree=str(self.repo))
        self.assert_error("ownership", self.admit, "A", worktree=str(self.repo))
        self.assert_error("ownership", self.admit, "C", host="remote", worktree=str(self.repo / "child"))
        for path in (remote_main, remote_main / "child"):
            self.assert_error("ownership", self.admit, "C", host="remote", worktree=str(path))
        self.admit("A", worktree=str(self.base / "task-A"))
        target = {"host": "remote", "driver": "coordinator", "branch": "task/A",
                  "identity": {"agent_id": "replacement"}, "evidence": self.proof(True),
                  "source": {**self.proof(), "published": True, "revision": "H1"}}
        self.assert_error("ownership", self.apply, "handoff", "A", worktree=str(remote_main), **target)
        self.apply("handoff", "B", host="local", driver="coordinator", worktree=str(self.base / "task-B"),
                   branch="task/B", identity={"agent_id": "other"}, evidence=self.proof(True),
                   source={**self.proof(), "published": True, "revision": "H1"})
        self.apply("handoff", "A", worktree=str(self.repo), **target)
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["host"], "remote")

    def test_explicit_and_legacy_repository_host_bindings(self):
        hosts = {"primary": {**self.config["hosts"]["local"], "worktree_root": str(self.base)},
                 "away": {**self.config["hosts"]["remote"], "worktree_root": str(self.base)}}
        self.reset(hosts=hosts, actors={})
        # Unidentified legacy ownership stays conservative, not silently local.
        self.assert_error("ownership", self.admit, "B", host="away", worktree=str(self.repo))
        hosts["primary"]["roles"] = ["coordinator"]
        self.apply("configure", fields={"hosts": hosts}, evidence=self.proof())
        self.admit("B", host="away", worktree=str(self.repo))
        self.assert_error("ownership", self.admit, "C", host="primary", worktree=str(self.repo))
        self.reset(hosts=hosts, actors={}, repository={**self.config["repository"], "host": "away"})
        self.admit("B", host="primary", worktree=str(self.repo))
        self.assert_error("ownership", self.admit, "C", host="away", worktree=str(self.repo))
        for changes in ({"repository": {**self.config["repository"], "host": "missing"}},
                        {"hosts": {"primary": {**hosts["primary"], "repository_path": "relative"}}}):
            self.assert_error("invalid", self.reset, **changes)

    def test_pre_admission_claim_uncertainty_cannot_admit_or_repeat(self):
        intent = self.apply("claim_intent", "A", target={"authority": "canonical-ref", "owner": "tracker-actor"},
                            evidence=self.proof())
        self.apply("claim_outcome", "A", intent_id=intent["action_id"], status="unknown", receipt=self.proof())
        self.assert_error("uncertain", self.admit)
        self.assert_error("uncertain", self.apply, "claim_intent", "A",
                          target={"authority": "canonical-ref", "owner": "tracker-actor"}, evidence=self.proof())
        claim = {**self.proof(), "authority": "canonical-ref", "owner": "tracker-actor", "task_id": "A",
                 "confirmed": True, "unpublished": False, "ready": True}
        self.apply("control", control="pause")
        self.apply("claim_outcome", "A", intent_id=intent["action_id"], status="confirmed", receipt=claim)
        self.apply("control", control="resume")
        self.admit(claim=claim)
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["claim"], claim)

    def test_scope_change_preserves_claim_until_its_outcome_is_known(self):
        intent = self.apply("claim_intent", "A", target={"authority": "canonical-ref", "owner": "tracker-actor"},
                            evidence=self.proof())
        narrowed = {"scope": {"task_ids": ["B", "C"]}, "actors": {}}
        self.assert_error("ownership", self.apply, "configure", fields=narrowed, evidence=self.proof())
        self.apply("claim_outcome", "A", intent_id=intent["action_id"], status="unknown", receipt=self.proof())
        self.assert_error("ownership", self.apply, "configure", fields=narrowed, evidence=self.proof())
        # Unrelated policy changes and pause still permit the same action's receipt.
        self.apply("configure", fields={"unfinished_task_cap": 2}, evidence=self.proof())
        self.apply("control", control="pause")
        claim = {**self.proof(), "authority": "canonical-ref", "owner": "tracker-actor", "task_id": "A",
                 "confirmed": True, "unpublished": False, "ready": True}
        self.apply("claim_outcome", "A", intent_id=intent["action_id"], status="confirmed", receipt=claim)
        self.apply("control", control="resume")
        self.admit(claim=claim)
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["claim"], claim)

    def test_failed_claim_does_not_prevent_scope_narrowing(self):
        intent = self.apply("claim_intent", "A", target={"authority": "canonical-ref", "owner": "tracker-actor"},
                            evidence=self.proof())
        self.apply("claim_outcome", "A", intent_id=intent["action_id"], status="failed", receipt=self.proof())
        self.apply("configure", fields={"scope": {"task_ids": ["B", "C"]}, "actors": {}}, evidence=self.proof())
        self.assertEqual(Engine.read(self.run)["claims"]["A"]["status"], "failed")
        self.assert_error("scope", self.apply, "claim_intent", "A",
                          target={"authority": "canonical-ref", "owner": "tracker-actor"}, evidence=self.proof())

    def test_claims_reserve_capacity_until_admitted_or_released(self):
        self.apply("configure", fields={"unfinished_task_cap": 1}, evidence=self.proof())
        target = {"authority": "canonical-ref", "owner": "tracker-actor"}
        intent = self.apply("claim_intent", "A", target=target, evidence=self.proof())
        self.assert_error("wip", self.apply, "claim_intent", "B", target=target, evidence=self.proof())
        self.assert_error("wip", self.admit, "B")
        self.apply("configure", fields={"unfinished_task_cap": 2}, evidence=self.proof())
        self.admit("B")
        self.assert_error("capacity", self.apply, "configure", fields={"unfinished_task_cap": 1}, evidence=self.proof())
        self.apply("claim_outcome", "A", intent_id=intent["action_id"], status="unknown", receipt=self.proof())
        self.assert_error("wip", self.admit, "C")
        receipt = {**self.proof(), **target, "task_id": "A", "confirmed": True, "unpublished": False, "ready": True}
        self.apply("claim_outcome", "A", intent_id=intent["action_id"], status="confirmed", receipt=receipt)
        self.assert_error("ownership", self.apply, "configure",
                          fields={"scope": {"task_ids": ["B", "C"]}, "actors": {}}, evidence=self.proof())
        self.admit(claim=receipt)  # Consume A's reservation, without counting it twice.
        self.assert_error("wip", self.apply, "claim_intent", "C", target=target, evidence=self.proof())

    def test_pending_claim_capacity_also_fences_reopening(self):
        self.apply("configure", fields={"unfinished_task_cap": 1}, evidence=self.proof())
        self.admit()
        self.apply("close", "A", receipt={**self.proof(), "authority": "canonical-ref", "task_id": "A",
                   "owner": "tracker-actor", "status": "closed", "criteria_met": True,
                   "acceptance_ref": "/proof/acceptance", "unpublished": False})
        target = {"authority": "canonical-ref", "owner": "tracker-actor"}
        self.apply("claim_intent", "B", target=target, evidence=self.proof())
        self.assert_error("wip", self.apply, "reopen_intent", "A", target=target, evidence=self.proof())

    def test_release_reconciles_claim_after_admission_stops_without_replay(self):
        self.apply("configure", fields={"unfinished_task_cap": 1}, evidence=self.proof())
        target = {"authority": "canonical-ref", "owner": "tracker-actor"}
        intent = self.apply("claim_intent", "A", target=target, evidence=self.proof())
        self.apply("control", control="finish_current")
        receipt = {**self.proof(), **target, "task_id": "A", "confirmed": True, "unpublished": False}
        self.apply("claim_outcome", "A", intent_id=intent["action_id"], status="confirmed", receipt=receipt)
        self.assert_error("admission", self.admit)
        self.apply("control", control="pause")
        release = self.apply("claim_release_intent", "A", claim_id=intent["action_id"], target=target, evidence=self.proof())
        self.apply("claim_release_outcome", "A", intent_id=release["action_id"], target=target,
                   status="unknown", receipt=self.proof())
        self.assert_error("uncertain", self.apply, "claim_release_intent", "A",
                          claim_id=intent["action_id"], target=target, evidence=self.proof())
        self.apply("control", control="resume")
        self.apply("control", control="reopen_admission", evidence=self.proof())
        self.assert_error("uncertain", self.admit)
        self.assert_error("wip", self.admit, "B")
        released = {**self.proof(), **target, "task_id": "A", "released": True, "unpublished": False}
        for field, value in (("owner", "other"), ("unpublished", True), ("released", False)):
            self.assert_error("claim", self.apply, "claim_release_outcome", "A", intent_id=release["action_id"],
                              target=target, status="succeeded", receipt={**released, field: value})
        self.apply("control", control="cancel")
        self.apply("claim_release_outcome", "A", intent_id=release["action_id"], target=target,
                   status="succeeded", receipt=released)
        self.apply("control", control="resume")
        self.assert_error("uncertain", self.admit)  # A's old confirmed receipt no longer suffices.
        self.admit("B")
        self.assertEqual(Engine.read(self.run)["claims"]["A"]["status"], "released")
        self.apply("configure", fields={"scope": {"task_ids": ["B", "C"]}, "actors": {}}, evidence=self.proof())

    def test_failed_release_keeps_claim_until_a_new_confirmed_release(self):
        target = {"authority": "canonical-ref", "owner": "tracker-actor"}
        intent = self.apply("claim_intent", "A", target=target, evidence=self.proof())
        self.apply("claim_outcome", "A", intent_id=intent["action_id"], status="confirmed",
                   receipt={**self.proof(), **target, "task_id": "A", "confirmed": True, "unpublished": False})
        release = self.apply("claim_release_intent", "A", claim_id=intent["action_id"], target=target, evidence=self.proof())
        self.apply("claim_release_outcome", "A", intent_id=release["action_id"], target=target,
                   status="failed", receipt=self.proof())
        self.assertEqual(Engine.read(self.run)["claims"]["A"]["status"], "confirmed")
        self.admit()  # A verified failed release did not drop ownership.

    def test_concurrent_hosts_compete_for_one_slot_at_authority(self):
        self.admit("A")
        self.admit("B")
        current = Engine.read(self.run)
        context = multiprocessing.get_context("fork")
        queue = context.Queue()
        children = [context.Process(target=concurrent_reserve, args=(str(self.run), task_id,
                    current["tasks"][task_id]["version"], queue)) for task_id in ("A", "B")]
        for child in children:
            child.start()
        for child in children:
            child.join(10)
            self.assertEqual(child.exitcode, 0)
        results = [queue.get(timeout=1) for _ in children]
        self.assertEqual(results.count("capacity"), 1)
        self.assertEqual(sum(t["slot"] is not None for t in Engine.read(self.run)["tasks"].values()), 1)

    def test_parked_tasks_retain_wip_and_resume_waits_for_slot(self):
        self.reset(unfinished_task_cap=2)
        self.admit("A")
        self.admit("B")
        first = self.reserve()
        self.assert_error("unsettled", self.apply, "park", "A", evidence=self.proof(True))
        self.settle(first["reservation_id"])
        self.apply("park", "A", evidence=self.proof(True))
        self.reserve("B")
        self.assert_error("capacity", self.reserve, "A")
        self.assert_error("wip", self.admit, "C")
        task = Engine.read(self.run)["tasks"]["A"]
        self.assertEqual(task["claim"]["owner"], "tracker-actor")
        self.assertEqual(task["counters"]["implementation"], 1)

    def test_finish_current_resume_and_scheduler_controls_are_independent(self):
        self.admit()
        self.apply("control", control="finish_current")
        self.apply("control", control="pause")
        self.assert_error("paused", self.reserve)
        self.apply("control", control="resume")
        self.reserve()
        self.assert_error("admission", self.admit, "B")
        current = Engine.read(self.run)
        self.assertEqual(current["controls"]["frozen_tasks"], ["A"])
        self.assertTrue(current["scheduler"]["enabled"])

    def test_configuration_changes_keep_counts_ownership_and_need_safe_boundary(self):
        self.admit()
        reservation = self.reserve(kind="repair")
        hosts = copy.deepcopy(self.config["hosts"])
        hosts["local"]["slots"] = 2
        self.apply("configure", fields={"hosts": hosts}, evidence=self.proof())
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["counters"], {"source_repair": 1})
        hosts["local"]["endpoint"] = {"session": "replacement"}
        self.assert_error("unsettled", self.apply, "configure", fields={"hosts": hosts}, evidence=self.proof())
        self.assert_error("invalid", self.apply, "configure", fields={"scope": {"task_ids": ["B"]}}, evidence=self.proof())
        self.settle(reservation["reservation_id"])
        self.apply("park", "A", evidence=self.proof(True))
        self.apply("configure", fields={"hosts": hosts, "limits": [
            {"id": "repair-cap", "unit": "source_repair", "scope": "task", "max": 1, "enforced": True}]}, evidence=self.proof())
        self.assert_error("budget", self.reserve, kind="repair")
        self.apply("control", control="finish_current")
        self.apply("control", control="resume")
        self.assert_error("admission", self.admit, "B")
        self.apply("control", control="reopen_admission", evidence=self.proof())
        self.admit("B")

    def test_configure_cannot_protect_or_rebind_an_admitted_checkout(self):
        hosts = copy.deepcopy(self.config["hosts"])
        hosts["remote"]["worktree_root"] = str(self.base.parent)
        self.reset(hosts=hosts)
        self.admit("B", host="remote", worktree=str(self.repo))
        reservation = self.reserve("B")
        self.settle(reservation["reservation_id"], "B")
        self.apply("park", "B", evidence=self.proof(True))
        for change in ({"repository_path": str(self.repo)},
                       {"repository_path": str(self.repo.parent)},
                       {"repository_path": str(self.repo / "nested")},
                       {"roles": ["coordinator"]}):
            with self.subTest(change=change):
                candidate = copy.deepcopy(hosts)
                candidate["remote"].update(change)
                before = Engine.read(self.run)
                self.assert_error("ownership", self.apply, "configure", fields={"hosts": candidate}, evidence=self.proof())
                self.assertEqual(Engine.read(self.run), before)
        # A nonoverlapping declaration remains configurable and work can resume.
        hosts["remote"]["repository_path"] = str(self.base / "remote-main")
        self.apply("configure", fields={"hosts": hosts}, evidence=self.proof())
        self.reserve("B")

    def test_cancel_requires_settlement_and_preserves_task_hold(self):
        self.admit()
        reservation = self.reserve()
        self.apply("control", "A", control="hold", hold_id="user-hold", reason="await decision", actions=["merge"])
        self.apply("control", control="cancel")
        self.assert_error("unsettled", self.apply, "control", control="resume")
        self.settle(reservation["reservation_id"])
        self.apply("control", control="resume")
        self.assertIn("user-hold", Engine.read(self.run)["tasks"]["A"]["holds"])
        self.assert_error("held", self.reserve, kind="merge")

    def test_stale_policy_task_and_scheduler_requests_are_fenced(self):
        self.admit()
        req = self.request("reserve", "A", kind="implement", unit="implementation", refs={})
        self.apply("control", control="pause")
        self.assert_error("stale_policy", Engine.apply, self.run, req)
        self.apply("control", control="resume")
        req = self.request("reserve", "A", kind="implement", unit="implementation", refs={})
        self.apply("observe", "A", fields={"next_action": "inspect"}, evidence=self.proof())
        self.assert_error("stale_task", Engine.apply, self.run, req)
        self.apply("scheduler", expected_scheduler=0, fields={"heartbeat_at": "2026-10-11T12:00:00Z"})
        self.assert_error("stale_scheduler", self.apply, "scheduler", expected_scheduler=0, fields={"enabled": False})
        self.assert_error("invalid", self.apply, "scheduler", expected_scheduler=1, fields={"heartbeat_at": 12})
        self.assert_error("invalid", self.apply, "scheduler", expected_scheduler=1, fields={"enabled": "yes"})

    def test_driver_cannot_modify_authority_other_tasks_or_scheduler(self):
        self.admit()
        self.admit("B")
        self.assert_error("forbidden", self.apply, "control", "A", caller="worker-a", control="resume")
        self.assert_error("forbidden", self.apply, "observe", "B", caller="worker-a", fields={"next_action": "edit"}, evidence=self.proof())
        self.assert_error("forbidden", self.apply, "scheduler", "A", caller="worker-a", expected_scheduler=0, fields={"enabled": False})
        self.assert_error("invalid", Engine.apply, self.run, {**self.request("park", "A"), "caller": "coordinator"})
        self.assert_error("invalid", self.apply, "observe", "A", caller="worker-a", fields={"driver": "attacker"}, evidence=self.proof())

    def test_driver_reservations_require_current_action_delegation_before_mutation(self):
        self.admit(identity={"native_id": "old"})
        def rejected():
            before = Engine.read(self.run)
            self.assert_error("authority", self.reserve, kind="repair", caller="worker-a")
            self.assertEqual(Engine.read(self.run), before)
        rejected()  # No delegation.
        self.apply("delegate", "A", executor="coordinator", actions=["repair"])
        rejected()  # Different executor.
        self.apply("delegate", "A", executor="worker-a", actions=["review"])
        rejected()  # Different action.
        self.apply("delegate", "A", executor="worker-a", actions=["repair"])
        self.apply("control", control="pause")
        self.apply("control", control="resume")
        rejected()  # Stale policy.
        self.apply("delegate", "A", executor="worker-a", actions=["repair"])
        self.apply("recover_session", "A", previous_identity={"native_id": "old"}, identity={"native_id": "new"},
                   evidence={**self.proof(), "previous_session_stopped": True, "replacement_verified": True,
                             "host": "local", "worktree": "/worktrees/A"})
        rejected()  # Recovery cleared delegation.
        self.apply("delegate", "A", executor="worker-a", actions=["repair"])
        reservation = self.reserve(kind="repair", caller="worker-a")
        self.apply("control", control="pause")
        self.apply("settle", "A", caller="worker-a", reservation_id=reservation["reservation_id"],
                   refs={}, evidence=self.proof(True))  # Settlement must remain available.
        self.apply("control", control="resume")
        self.reserve(kind="repair")  # Coordinator does not need delegation.
        task = Engine.read(self.run)["tasks"]["A"]
        self.assertEqual(task["counters"]["source_repair"], 2)

    def test_unknown_dispatch_keeps_slot_and_count_until_reconciled(self):
        self.admit()
        reservation = self.reserve()
        self.apply("delegate", "A", executor="worker-a", actions=["implement"])
        target = {"host": "local", "session": "owned", "agent_id": "native-123"}
        intent = self.apply("intent", "A", caller="worker-a", kind="implement", reservation_id=reservation["reservation_id"],
                            target=target, evidence=self.proof())
        self.apply("outcome", "A", intent_id=intent["action_id"], target=target, status="unknown", receipt=self.proof())
        self.assert_error("uncertain", self.settle, reservation["reservation_id"])
        self.assert_error("unsettled", self.apply, "park", "A", evidence=self.proof(True))
        self.assert_error("unsettled", self.reserve)
        self.apply("control", control="pause")
        self.apply("outcome", "A", intent_id=intent["action_id"], target=target, status="not_started", receipt=self.proof())
        self.settle(reservation["reservation_id"])
        self.apply("park", "A", evidence=self.proof(True))
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["counters"]["implementation"], 1)

    def test_current_delegation_required_after_policy_change(self):
        self.admit()
        reservation = self.reserve()
        self.apply("delegate", "A", executor="worker-a", actions=["implement"])
        self.apply("control", control="finish_current")
        self.assert_error("authority", self.apply, "intent", "A", caller="worker-a", kind="implement",
                          reservation_id=reservation["reservation_id"], target={"agent_id": "registered"}, evidence=self.proof())

    def test_attempt_limits_survive_successor_and_do_not_block_verification(self):
        self.reset(limits=[{"id": "repairs", "unit": "source_repair", "scope": "task", "max": 1, "enforced": True}])
        self.admit()
        old = {"controller_id": "controller", "run_id": "old"}
        self.apply("observe", "A", fields={"refs": old}, evidence=self.proof())
        repair = self.reserve(kind="repair", refs=old)
        self.assert_error("identity", self.settle, repair["reservation_id"], refs={"run_id": "wrong"})
        self.settle(repair["reservation_id"], refs=old)
        new = {"controller_id": "controller", "run_id": "successor"}
        self.apply("observe", "A", fields={"refs": new}, evidence=self.proof(),
                   successor={"previous_refs": old, "evidence": self.proof(True)})
        self.assert_error("budget", self.reserve, kind="repair", refs=new)
        self.assert_error("budget", self.apply, "reserve", "A", kind="repair", unit="validation", refs=new)
        self.reserve(kind="validate", refs=new)

    def test_launch_cutoff_does_not_prevent_receipts_and_settlement(self):
        self.reset(launch_cutoff="2000-01-01T00:00:00Z")
        self.admit()
        self.assert_error("deadline", self.reserve)
        self.apply("observe", "A", fields={"next_action": "explain deadline"}, evidence=self.proof())

    def test_push_limit_cannot_be_bypassed_or_reuse_consumed_reservation(self):
        self.reset(limits=[{"id": "pushes", "unit": "push", "scope": "task", "max": 1, "enforced": True}])
        self.admit()
        reservation = self.reserve(kind="push")
        target = {"remote": "origin", "branch": "task/A", "head": "H1"}
        self.assert_error("budget", self.apply, "intent", "A", kind="push", target=target, evidence=self.proof())
        intent = self.apply("intent", "A", kind="push", reservation_id=reservation["reservation_id"],
                            target=target, evidence=self.proof())
        self.apply("outcome", "A", intent_id=intent["action_id"], target=target, status="succeeded", receipt=self.proof())
        self.assert_error("budget", self.apply, "intent", "A", kind="push", reservation_id=reservation["reservation_id"],
                          target=target, evidence=self.proof())
        self.settle(reservation["reservation_id"])
        self.assert_error("budget", self.reserve, kind="push")

    def test_uncapped_intent_requires_existing_matching_reservation_id(self):
        for kind in ("push", "pr"):
            with self.subTest(kind=kind):
                self.reset()
                self.admit()
                reservation = self.reserve(kind=kind)
                target = {"remote": "origin", "branch": "task/A", "head": "H1"}
                self.assert_error("budget", self.apply, "intent", "A", kind=kind,
                                  target=target, evidence=self.proof())
                intent = self.apply("intent", "A", kind=kind, target=target, evidence=self.proof(),
                                    reservation_id=reservation["reservation_id"])
                self.apply("outcome", "A", intent_id=intent["action_id"], target=target,
                           status="succeeded", receipt=self.proof())
                self.assert_error("budget", self.apply, "intent", "A", kind=kind,
                                  target=target, evidence=self.proof())
                current = Engine.read(self.run)
                self.assertEqual(current["tasks"]["A"]["counters"][Engine.UNITS[kind]], 1)
                self.assertEqual(current["counters"][Engine.UNITS[kind]], 1)
                self.settle(reservation["reservation_id"])
                # Unreserved consequential actions remain supported and count once.
                self.apply("intent", "A", kind=kind, target=target, evidence=self.proof())
                current = Engine.read(self.run)
                self.assertEqual(current["tasks"]["A"]["counters"][Engine.UNITS[kind]], 2)
                self.assertEqual(current["counters"][Engine.UNITS[kind]], 2)

    def test_deadline_between_reservation_and_dispatch_blocks_external_action(self):
        self.admit()
        reservation = self.reserve(kind="push")
        self.apply("configure", fields={"launch_cutoff": "2000-01-01T00:00:00Z"}, evidence=self.proof())
        self.assert_error("deadline", self.apply, "intent", "A", kind="push", reservation_id=reservation["reservation_id"],
                          target={"branch": "task/A"}, evidence=self.proof())
        self.settle(reservation["reservation_id"])

    def test_tightened_task_and_run_limits_fence_previously_reserved_attempt(self):
        for scope in ("task", "run"):
            with self.subTest(scope=scope):
                limit = {"id": "repairs", "unit": "source_repair", "scope": scope, "max": 2, "enforced": True}
                self.reset(limits=[limit])
                self.admit()
                reservation = self.reserve(kind="repair")
                self.apply("configure", fields={"limits": [{**limit, "max": 0}]}, evidence=self.proof())
                self.apply("delegate", "A", executor="worker-a", actions=["repair"])
                self.assert_error("budget", self.apply, "intent", "A", caller="worker-a", kind="repair",
                                  reservation_id=reservation["reservation_id"], target={"agent_id": "worker-a"}, evidence=self.proof())
                current = Engine.read(self.run)
                self.assertEqual(current["tasks"]["A"]["counters"]["source_repair"], 1)
                self.assertEqual(current["counters"]["source_repair"], 1)
                self.assertIsNone(current["tasks"]["A"]["pending_intent"])
                self.apply("configure", fields={"limits": [{**limit, "max": 1}]}, evidence=self.proof())
                self.apply("delegate", "A", executor="worker-a", actions=["repair"])
                self.apply("intent", "A", caller="worker-a", kind="repair", reservation_id=reservation["reservation_id"],
                           target={"agent_id": "worker-a"}, evidence=self.proof())

    def test_staging_race_park_retention_and_release_during_pause(self):
        self.admit("A")
        self.admit("B")
        self.apply("staging", "A", expected_owner=None, expected_generation=0, to_task="A",
                   purpose="acceptance", release_condition="cleanup receipt", evidence=self.proof())
        self.apply("park", "A", evidence=self.proof(True))
        self.assertEqual(Engine.read(self.run)["staging"]["owner"], "A")
        self.assert_error("ownership", self.apply, "staging", "B", expected_owner=None, expected_generation=0,
                          to_task="B", purpose="other", release_condition="cleanup", evidence=self.proof())
        self.assert_error("unsettled", self.apply, "staging", "A", expected_owner="A", expected_generation=1,
                          to_task="B", purpose="acceptance", release_condition="cleanup", evidence=self.proof())
        self.apply("control", control="pause")
        self.apply("staging", "A", expected_owner="A", expected_generation=1, to_task=None, evidence=self.proof(True))
        self.assertIsNone(Engine.read(self.run)["staging"]["owner"])

    def test_staging_handoff_checks_both_tasks_controls_but_cleanup_release_remains_available(self):
        for caller in ("coordinator", "worker-a"):
            for affected in ("A", "B"):
                for control, actions in (("pause", None), ("cancel", None), ("hold", ["*"]), ("hold", ["deploy"])):
                    with self.subTest(caller=caller, affected=affected, control=control, actions=actions):
                        self.reset()
                        self.admit("A")
                        self.admit("B")
                        self.apply("staging", "A", expected_owner=None, expected_generation=0, to_task="A",
                                   purpose="acceptance", release_condition="cleanup", evidence=self.proof())
                        fields = {"hold_id": "hold", "reason": "retain staging", "actions": actions} if actions else {}
                        self.apply("control", affected, control=control, **fields)
                        self.apply("delegate", "A", executor="worker-a", actions=["deploy"])
                        before = Engine.read(self.run)
                        self.assert_error("held" if actions else "paused", self.apply, "staging", "A", caller=caller,
                                          expected_owner="A", expected_generation=1, to_task="B", purpose="acceptance",
                                          release_condition="cleanup", evidence=self.proof(True))
                        self.assertEqual(Engine.read(self.run), before)
                        self.apply("staging", "A", caller=caller, expected_owner="A", expected_generation=1,
                                   to_task=None, evidence=self.proof(True))
                        self.assertIsNone(Engine.read(self.run)["staging"]["owner"])
                        self.assertEqual(Engine.read(self.run)["staging"]["generation"], 2)
        self.reset()
        self.admit("A")
        self.admit("B")
        self.apply("staging", "A", expected_owner=None, expected_generation=0, to_task="A",
                   purpose="acceptance", release_condition="cleanup", evidence=self.proof())
        self.apply("control", "A", control="hold", hold_id="merge", reason="review", actions=["merge"])
        self.apply("delegate", "A", executor="worker-a", actions=["deploy"])
        self.apply("staging", "A", caller="worker-a", expected_owner="A", expected_generation=1, to_task="B",
                   purpose="acceptance", release_condition="cleanup", evidence=self.proof(True))
        self.assertEqual(Engine.read(self.run)["staging"]["owner"], "B")

    def test_deployment_requires_owned_environment_and_current_staging_generation(self):
        self.admit("A")
        self.admit("B")
        self.apply("staging", "B", expected_owner=None, expected_generation=0, to_task="B",
                   purpose="acceptance", release_condition="cleanup receipt", evidence=self.proof())
        reservation = self.reserve(kind="deploy")
        self.apply("delegate", "A", executor="worker-a", actions=["deploy"])
        target = {"environment": "shared-staging", "staging_generation": 1, "revision": "published-head"}
        self.assert_error("ownership", self.apply, "intent", "A", caller="worker-a", kind="deploy",
                          reservation_id=reservation["reservation_id"], target=target, evidence=self.proof())
        self.assertEqual(Engine.read(self.run)["staging"]["owner"], "B")
        self.apply("staging", "B", expected_owner="B", expected_generation=1, to_task="A",
                   purpose="acceptance", release_condition="cleanup receipt", evidence=self.proof(True))
        self.assert_error("ownership", self.apply, "intent", "A", caller="worker-a", kind="deploy",
                          reservation_id=reservation["reservation_id"], target=target, evidence=self.proof())
        self.assert_error("ownership", self.apply, "intent", "A", caller="worker-a", kind="deploy",
                          reservation_id=reservation["reservation_id"], target={"environment": "shared-staging"}, evidence=self.proof())
        self.assert_error("identity", self.apply, "intent", "A", caller="worker-a", kind="deploy",
                          reservation_id=reservation["reservation_id"],
                          target={"environment": "unmanaged", "staging_generation": 2}, evidence=self.proof())
        self.apply("intent", "A", caller="worker-a", kind="deploy", reservation_id=reservation["reservation_id"],
                   target={**target, "staging_generation": 2}, evidence=self.proof())

    def test_closure_requires_actual_owner_and_published_acceptance(self):
        self.admit()
        receipt = {**self.proof(), "authority": "canonical-ref", "task_id": "A", "owner": "tracker-actor",
                   "status": "closed", "criteria_met": True, "acceptance_ref": "/evidence/acceptance", "unpublished": True}
        self.assert_error("closure", self.apply, "close", "A", receipt=receipt)
        receipt.update(unpublished=False, owner="another-actor")
        self.assert_error("closure", self.apply, "close", "A", receipt=receipt)
        receipt["owner"] = "tracker-actor"
        self.apply("close", "A", receipt=receipt)
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["phase"], "closed")

    def test_reopening_preserves_closed_history_and_counts_and_fences_uncertainty(self):
        self.admit()
        execution = self.reserve(kind="repair")
        self.settle(execution["reservation_id"])
        receipt = {**self.proof(), "authority": "canonical-ref", "task_id": "A", "owner": "tracker-actor",
                   "status": "closed", "criteria_met": True, "acceptance_ref": "/proof/acceptance", "unpublished": False}
        self.apply("close", "A", receipt=receipt)
        target = {"authority": "canonical-ref", "owner": "tracker-actor"}
        intent = self.apply("reopen_intent", "A", target=target, evidence=self.proof())
        self.apply("reopen_outcome", "A", intent_id=intent["action_id"], target=target, status="unknown", receipt=self.proof())
        self.assert_error("closed", self.reserve, kind="repair")
        self.apply("control", control="pause")
        self.apply("reopen_outcome", "A", intent_id=intent["action_id"], target=target, status="succeeded",
                   receipt={**receipt, "status": "open"})
        task = Engine.read(self.run)["tasks"]["A"]
        self.assertEqual(task["counters"]["source_repair"], 1)
        self.assertEqual(task["closure_history"], [receipt])
        self.assertEqual(task["phase"], "admitted")

    def test_finish_current_rejects_reopening_a_previously_closed_task(self):
        self.admit("A")
        self.admit("B")
        receipt = {**self.proof(), "authority": "canonical-ref", "task_id": "A", "owner": "tracker-actor",
                   "status": "closed", "criteria_met": True, "acceptance_ref": "/proof", "unpublished": False}
        self.apply("close", "A", receipt=receipt)
        self.apply("control", control="finish_current")
        before = Engine.read(self.run)
        target = {"authority": "canonical-ref", "owner": "tracker-actor"}
        self.assert_error("admission", self.apply, "reopen_intent", "A", target=target, evidence=self.proof())
        self.assertEqual(Engine.read(self.run), before)
        self.assertEqual(before["controls"]["frozen_tasks"], ["B"])
        self.apply("control", control="reopen_admission", evidence=self.proof())
        intent = self.apply("reopen_intent", "A", target=target, evidence=self.proof())
        self.apply("reopen_outcome", "A", intent_id=intent["action_id"], target=target, status="succeeded",
                   receipt={**receipt, "status": "open"})
        self.reserve("A", kind="repair")

    def test_finish_current_preserves_member_reopening_and_already_issued_reopens(self):
        for pending_at_freeze in (False, True):
            with self.subTest(pending_at_freeze=pending_at_freeze):
                self.reset()
                self.admit()
                receipt = {**self.proof(), "authority": "canonical-ref", "task_id": "A", "owner": "tracker-actor",
                           "status": "closed", "criteria_met": True, "acceptance_ref": "/proof", "unpublished": False}
                target = {"authority": "canonical-ref", "owner": "tracker-actor"}
                if not pending_at_freeze:
                    self.apply("control", control="finish_current")
                self.apply("close", "A", receipt=receipt)
                intent = self.apply("reopen_intent", "A", target=target, evidence=self.proof())
                if pending_at_freeze:
                    self.apply("control", control="finish_current")
                self.assertEqual(Engine.read(self.run)["controls"]["frozen_tasks"], ["A"])
                self.apply("reopen_outcome", "A", intent_id=intent["action_id"], target=target,
                           status="unknown", receipt=self.proof())
                self.apply("control", control="pause")
                self.apply("reopen_outcome", "A", intent_id=intent["action_id"], target=target, status="succeeded",
                           receipt={**receipt, "status": "open"})
                self.assertEqual(Engine.read(self.run)["controls"]["frozen_tasks"], ["A"])
                self.apply("control", control="resume")
                self.reserve(kind="repair")

    def test_repeating_finish_current_preserves_closed_members_without_adding_excluded_tasks(self):
        for task_id in ("A", "B", "C"):
            self.admit(task_id)
        receipt = {**self.proof(), "authority": "canonical-ref", "owner": "tracker-actor",
                   "status": "closed", "criteria_met": True, "acceptance_ref": "/proof", "unpublished": False}
        self.apply("close", "C", receipt={**receipt, "task_id": "C"})
        self.apply("control", control="finish_current")
        self.apply("close", "A", receipt={**receipt, "task_id": "A"})
        self.apply("control", control="finish_current")
        self.assertEqual(Engine.read(self.run)["controls"]["frozen_tasks"], ["A", "B"])
        target = {"authority": "canonical-ref", "owner": "tracker-actor"}
        self.assert_error("admission", self.apply, "reopen_intent", "C", target=target, evidence=self.proof())
        intent = self.apply("reopen_intent", "A", target=target, evidence=self.proof())
        self.apply("reopen_outcome", "A", intent_id=intent["action_id"], target=target, status="succeeded",
                   receipt={**receipt, "task_id": "A", "status": "open"})
        self.reserve("A", kind="repair")

    def test_delegated_closure_intent_binds_target_and_completion_before_authorization(self):
        self.admit()
        reservation = self.reserve(kind="close")
        self.apply("delegate", "A", executor="worker-a", actions=["close"])
        target = {"authority": "canonical-ref", "task_id": "A", "owner": "tracker-actor"}
        proof = {**self.proof(True), "criteria_met": True, "acceptance_ref": "/proof"}
        def authorize(target=target, proof=proof):
            return self.apply("intent", "A", caller="worker-a", kind="close",
                              reservation_id=reservation["reservation_id"], target=target, evidence=proof)
        before = Engine.read(self.run)
        for field, bad in (("authority", "foreign-store"), ("task_id", "OUTSIDE-SCOPE"), ("owner", "other-owner")):
            with self.subTest(field=field):
                self.assert_error("identity", authorize, target={**target, field: bad})
                self.assert_error("identity", authorize, target={key: value for key, value in target.items() if key != field})
                self.assertEqual(Engine.read(self.run), before)
        for field, code in (("criteria_met", "closure"), ("acceptance_ref", "closure"), ("all_jobs_settled", "unsettled")):
            with self.subTest(field=field):
                self.assert_error(code, authorize, proof={key: value for key, value in proof.items() if key != field})
                self.assertEqual(Engine.read(self.run), before)
        intent = authorize()
        receipt = {**proof, **target, "status": "closed", "unpublished": False}
        self.apply("outcome", "A", caller="worker-a", intent_id=intent["action_id"], target=target,
                   status="succeeded", receipt=receipt)
        self.settle(reservation["reservation_id"])
        self.apply("close", "A", receipt=receipt)
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["phase"], "closed")

    def test_closure_intent_requires_settled_execution_and_released_staging(self):
        self.admit()
        work = self.reserve(kind="implement")
        target = {"authority": "canonical-ref", "task_id": "A", "owner": "tracker-actor"}
        proof = {**self.proof(True), "criteria_met": True, "acceptance_ref": "/proof"}
        self.assert_error("unsettled", self.apply, "intent", "A", kind="close", target=target, evidence=proof)
        self.settle(work["reservation_id"])
        self.apply("staging", "A", expected_owner=None, expected_generation=0, to_task="A",
                   purpose="acceptance", release_condition="cleanup", evidence=self.proof())
        self.assert_error("unsettled", self.apply, "intent", "A", kind="close", target=target, evidence=proof)
        self.apply("staging", "A", expected_owner="A", expected_generation=1, to_task=None, evidence=self.proof(True))
        self.apply("intent", "A", kind="close", target=target, evidence=proof)

    def test_relocation_requires_settlement_and_preserves_exact_prior_evidence(self):
        self.admit()
        refs = {"controller_id": "old-controller", "run_id": "old-run"}
        self.apply("observe", "A", fields={"refs": refs}, evidence=self.proof())
        execution = self.reserve(kind="repair", refs=refs)
        target = {"host": "remote", "driver": "coordinator", "worktree": "/remote-worktrees/A", "branch": "task/A",
                  "identity": {"session": "remote", "agent_id": "owned-remote"},
                  "source": {**self.proof(), "revision": "published-head", "published": True}, "evidence": self.proof(True)}
        self.assert_error("unsettled", self.apply, "handoff", "A", **target)
        self.settle(execution["reservation_id"], refs=refs)
        self.apply("park", "A", evidence=self.proof(True))
        self.apply("handoff", "A", **target)
        task = Engine.read(self.run)["tasks"]["A"]
        self.assertEqual(task["host"], "remote")
        self.assertEqual(task["counters"]["source_repair"], 1)
        self.assertEqual(task["refs"], refs)
        self.assertIsNone(task["delegation"])
        self.assertEqual(task["last_handoff"]["previous"]["host"], "local")

    def test_reconciled_tracker_handoff_preserves_state_and_uses_successor_for_closure(self):
        self.admit()
        refs = {"controller_id": "controller-A", "run_id": "run-A"}
        self.apply("observe", "A", fields={"refs": refs}, evidence=self.proof())
        reservation = self.reserve(kind="repair", refs=refs)
        self.settle(reservation["reservation_id"], refs=refs)
        self.apply("control", "A", control="hold", hold_id="merge", actions=["merge"], reason="keep hold")
        self.apply("delegate", "A", executor="worker-a", actions=["repair"])
        target = {"authority": "canonical-ref", "task_id": "A", "previous_owner": "tracker-actor", "owner": "successor"}
        proof = {**self.proof(), "authorized": True, "handoff_acknowledged": True}
        receipt = {**self.proof(), "authority": "canonical-ref", "task_id": "A", "owner": "successor",
                   "confirmed": True, "unpublished": False}
        before = Engine.read(self.run)["tasks"]["A"]
        self.apply("control", control="pause")
        self.apply("reconcile_claim", "A", target=target, evidence=proof, receipt=receipt)
        after = Engine.read(self.run)["tasks"]["A"]
        for key in ("host", "driver", "identity", "worktree", "branch", "refs", "slot", "counters", "holds", "findings"):
            self.assertEqual(after[key], before[key], key)
        self.assertEqual(after["claim_history"][0]["previous_claim"], before["claim"])
        self.assertEqual(after["claim"], receipt)
        self.assertIsNone(after["delegation"])
        self.apply("control", control="resume")
        closed = {**receipt, "status": "closed", "criteria_met": True, "acceptance_ref": "/proof/acceptance"}
        self.assert_error("closure", self.apply, "close", "A", receipt={**closed, "owner": "tracker-actor"})
        self.apply("close", "A", receipt=closed)
        reopen_target = {"authority": "canonical-ref", "owner": "successor"}
        intent = self.apply("reopen_intent", "A", target=reopen_target, evidence=self.proof())
        self.apply("reopen_outcome", "A", intent_id=intent["action_id"], target=reopen_target,
                   status="succeeded", receipt={**receipt, "status": "open"})
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["phase"], "admitted")

    def test_tracker_transfer_intent_fences_unknown_effect_and_reconciles_after_cancel(self):
        self.admit()
        target = {"authority": "canonical-ref", "task_id": "A", "previous_owner": "tracker-actor", "owner": "successor"}
        proof = {**self.proof(), "authorized": True, "previous_owner_stopped": True, "takeover_supported": True}
        intent = self.apply("claim_transfer_intent", "A", target=target, evidence=proof)
        self.apply("claim_transfer_outcome", "A", intent_id=intent["action_id"], target=target,
                   status="unknown", receipt=self.proof())
        self.assert_error("unsettled", self.reserve)
        self.assert_error("unsettled", self.apply, "claim_transfer_intent", "A", target=target, evidence=proof)
        self.assert_error("invalid", self.apply, "outcome", "A", intent_id=intent["action_id"], target=target,
                          status="succeeded", receipt=self.proof())
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["claim"]["owner"], "tracker-actor")
        receipt = {**self.proof(), "authority": "canonical-ref", "task_id": "A", "owner": "successor",
                   "confirmed": True, "unpublished": False}
        self.apply("control", control="cancel")
        self.apply("claim_transfer_outcome", "A", intent_id=intent["action_id"], target=target,
                   status="succeeded", receipt=receipt)
        task = Engine.read(self.run)["tasks"]["A"]
        self.assertEqual(task["claim"], receipt)
        self.assertIsNone(task["pending_intent"])
        self.assertTrue(Engine.read(self.run)["controls"]["cancel_requested"])

    def test_tracker_transfer_rejects_unverified_owners_receipts_and_active_jobs(self):
        self.admit()
        target = {"authority": "canonical-ref", "task_id": "A", "previous_owner": "tracker-actor", "owner": "successor"}
        proof = {**self.proof(), "authorized": True, "handoff_acknowledged": True}
        receipt = {**self.proof(), "authority": "canonical-ref", "task_id": "A", "owner": "successor",
                   "confirmed": True, "unpublished": False}
        before = Engine.read(self.run)
        for field, value in (("previous_owner", "foreign"), ("authority", "other"), ("task_id", "B"), ("owner", "tracker-actor")):
            self.assert_error("identity", self.apply, "reconcile_claim", "A", target={**target, field: value},
                              evidence=proof, receipt=receipt)
        for field in ("authorized", "handoff_acknowledged"):
            self.assert_error("authority", self.apply, "reconcile_claim", "A", target=target,
                              evidence={**proof, field: False}, receipt=receipt)
        for field, value in (("owner", "foreign"), ("unpublished", True), ("confirmed", False)):
            self.assert_error("claim", self.apply, "reconcile_claim", "A", target=target,
                              evidence=proof, receipt={**receipt, field: value})
        self.assert_error("forbidden", self.apply, "reconcile_claim", "A", caller="worker-a", target=target,
                          evidence=proof, receipt=receipt)
        self.assertEqual(Engine.read(self.run), before)
        reservation = self.reserve()
        self.assert_error("unsettled", self.apply, "reconcile_claim", "A", target=target, evidence=proof, receipt=receipt)
        self.settle(reservation["reservation_id"])
        intent = self.apply("claim_transfer_intent", "A", target=target, evidence=proof)
        self.apply("claim_transfer_outcome", "A", intent_id=intent["action_id"], target=target,
                   status="failed", receipt=self.proof())
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["claim"]["owner"], "tracker-actor")
        self.assertNotIn("claim_history", Engine.read(self.run)["tasks"]["A"])

    def test_session_recovery_preserves_surviving_execution_and_unknown_outcome(self):
        original = {"session": "owned", "native_id": "crashed"}
        replacement = {"session": "owned", "native_id": "replacement"}
        self.admit(identity=original)
        refs = {"controller_id": "controller-A", "run_id": "run-A", "job_id": "validation-A"}
        self.apply("observe", "A", fields={"refs": refs}, evidence=self.proof())
        reservation = self.reserve(kind="validate", refs=refs)
        target = {"job_id": "validation-A"}
        intent = self.apply("intent", "A", kind="validate", reservation_id=reservation["reservation_id"],
                            target=target, evidence=self.proof())
        self.apply("outcome", "A", intent_id=intent["action_id"], target=target, status="unknown", receipt=self.proof())
        proof = {**self.proof(), "previous_session_stopped": True, "replacement_verified": True,
                 "host": "local", "worktree": "/worktrees/A"}
        before = Engine.read(self.run)["tasks"]["A"]
        for field, value in (("host", "remote"), ("worktree", "/elsewhere"), ("previous_session_stopped", False),
                             ("replacement_verified", False)):
            self.assert_error("identity", self.apply, "recover_session", "A", previous_identity=original,
                              identity=replacement, evidence={**proof, field: value})
        self.assert_error("forbidden", self.apply, "recover_session", "A", caller="worker-a",
                          previous_identity=original, identity=replacement, evidence=proof)
        self.apply("recover_session", "A", previous_identity=original, identity=replacement, evidence=proof)
        after = Engine.read(self.run)["tasks"]["A"]
        for key in ("host", "driver", "worktree", "branch", "claim", "refs", "reservations", "pending_intent",
                    "slot", "counters", "holds", "paused", "cancel_requested", "findings"):
            self.assertEqual(after[key], before[key], key)
        self.assertEqual(after["identity"], replacement)
        self.assert_error("identity", self.apply, "recover_session", "A", previous_identity=original,
                          identity={"native_id": "duplicate"}, evidence=proof)
        self.assert_error("unsettled", self.reserve, kind="validate", refs=refs)
        self.apply("outcome", "A", intent_id=intent["action_id"], target=target, status="succeeded", receipt=self.proof())
        self.assert_error("unsettled", self.reserve, kind="validate", refs=refs)
        self.settle(reservation["reservation_id"], refs=refs)
        self.apply("park", "A", evidence=self.proof(True))
        self.assertIsNone(Engine.read(self.run)["tasks"]["A"]["slot"])

    def test_completed_close_reconciles_pause_and_cancel_but_requires_matching_receipt(self):
        for task_id, control in (("A", "pause"), ("B", "cancel")):
            self.admit(task_id)
            reservation = self.reserve(task_id, kind="close")
            target = {"authority": "canonical-ref", "task_id": task_id, "owner": "tracker-actor"}
            intent = self.apply("intent", task_id, kind="close", reservation_id=reservation["reservation_id"],
                                target=target, evidence={**self.proof(True), "criteria_met": True, "acceptance_ref": "/proof"})
            self.apply("control", control=control)
            receipt = {**self.proof(), "authority": "canonical-ref", "task_id": task_id, "owner": "tracker-actor",
                       "status": "closed", "criteria_met": True, "acceptance_ref": "/proof", "unpublished": False}
            self.apply("outcome", task_id, intent_id=intent["action_id"], target=target, status="succeeded", receipt=receipt)
            self.settle(reservation["reservation_id"], task_id)
            self.assert_error("paused", self.apply, "intent", task_id, kind="close", target=target, evidence=self.proof())
            self.assert_error("paused", self.apply, "close", task_id, receipt={**receipt, "acceptance_ref": "/other"})
            self.apply("control", control="hold", hold_id="close-hold", actions=["close"], reason="verify closure")
            self.assert_error("held", self.apply, "close", task_id, receipt=receipt)
            self.apply("control", control="unhold", hold_id="close-hold")
            self.apply("close", task_id, receipt=receipt)
            task = Engine.read(self.run)["tasks"][task_id]
            self.assertEqual(task["phase"], "closed")
            self.assertEqual(task["closure"], receipt)
            self.assertIsNone(task["slot"])
            self.apply("control", control="resume")
    def test_merge_gate_binds_exact_candidate_run_and_none_mode_applicability(self):
        self.admit()
        refs = {"controller_id": "controller", "run_id": "review-run", "review_base": "B0", "review_head": "H2"}
        self.apply("observe", "A", fields={"refs": refs}, evidence=self.proof())
        reservation = self.reserve(kind="review", refs=refs)
        self.settle(reservation["reservation_id"], refs=refs)
        target = {"repository": str(self.repo), "base": "main", "pr": 10, "head": "H2"}
        gates = {"complete": True, "validation": True, "checks": True, "feedback": True,
                 "findings": True, "target_current": True, "clean": True, **refs,
                 "review_head": "H1", "checkout_head": "H2", "pr_head": "H2", "review_base": "B0", "commit_mode": "per-round"}
        self.assert_error("gate", self.apply, "intent", "A", kind="merge", target=target, gates=gates, evidence=self.proof())
        gates.update(review_head="H2", run_id="some-other-run")
        self.assert_error("identity", self.apply, "intent", "A", kind="merge", target=target, gates=gates, evidence=self.proof())
        gates.update(run_id="review-run", review_base="different-base")
        self.assert_error("identity", self.apply, "intent", "A", kind="merge", target=target, gates=gates, evidence=self.proof())
        gates.update(review_base="B0", review_head="different-head", checkout_head="different-head", pr_head="different-head")
        self.assert_error("identity", self.apply, "intent", "A", kind="merge", target={**target, "head": "different-head"},
                          gates=gates, evidence=self.proof())
        gates.update(review_head="H2", checkout_head="H2", pr_head="H2")
        gates.update(run_id="review-run", commit_mode="none")
        self.assert_error("gate", self.apply, "intent", "A", kind="merge", target=target, gates=gates, evidence=self.proof())
        gates["source_mapping_applicable"] = True
        intent = self.apply("intent", "A", kind="merge", target=target, gates=gates, evidence=self.proof())
        self.apply("control", control="pause")
        self.apply("outcome", "A", intent_id=intent["action_id"], target=target, status="succeeded",
                   receipt={**self.proof(), "head": "H2", "merge_commit": "M3"})
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["phase"], "merged")
        self.apply("control", control="resume")
        self.reserve(kind="validate", refs=refs)
        task = Engine.read(self.run)["tasks"]["A"]
        self.assertEqual(task["phase"], "validate")
        self.assertEqual(task["merged_prs"]["10"]["head"], "H2")
        self.assertEqual(task["merged_prs"]["10"]["merge_commit"], "M3")


if __name__ == "__main__":
    unittest.main()
