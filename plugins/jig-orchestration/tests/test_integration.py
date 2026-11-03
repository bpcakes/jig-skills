"""Real Git observations and delivery gates, with no network or live agents."""
import copy
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_state as fixtures
from state import Engine, canonical, write_atomic
import integration
import supervise
import execute as runner


class IntegrationTests(unittest.TestCase):
    setUpState = fixtures.EngineTests.setUp
    proof = fixtures.EngineTests.proof
    request = fixtures.EngineTests.request
    apply = fixtures.EngineTests.apply
    admit = fixtures.EngineTests.admit
    settle = fixtures.EngineTests.settle
    assert_error = fixtures.EngineTests.assert_error

    def git(self, *args, cwd=None):
        result = subprocess.run(["git", "-C", str(cwd or self.repo), *args], capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        return result.stdout.decode().strip()

    def setUp(self):
        self.setUpState()
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Integration fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        (self.repo / "shared.txt").write_text("base\n")
        (self.repo / "other.txt").write_text("base\n")
        self.git("add", ".")
        self.git("commit", "-m", "base")
        self.base_oid = self.git("rev-parse", "HEAD")
        self.heads = {}
        for task, filename in (("A", "shared.txt"), ("B", "shared.txt"), ("C", "other.txt")):
            self.git("checkout", "-b", "task/" + task, self.base_oid)
            (self.repo / filename).write_text(task + "\n")
            self.git("commit", "-am", task)
            self.heads[task] = self.git("rev-parse", "HEAD")
        self.git("checkout", "main")
        hosts = copy.deepcopy(self.config["hosts"])
        hosts["local"]["slots"] = 3
        hosts["local"]["worktree_root"] = str(self.base / "worktrees")
        self.config["hosts"] = hosts
        self.apply("configure", fields={"hosts": hosts, "integration": {
            "enabled": True, "source": str(self.repo), "timeout_seconds": 30}}, evidence=self.proof())
        for task in self.heads:
            self.admit(task, actions=sorted(Engine.ACTIONS), acceptance_ref="/acceptance")

    def refresh(self):
        result = integration.refresh(self.run)
        self.assertEqual(result["status"], "observed", result)
        return Engine.read(self.run)["integration"]

    def observation(self, task):
        return Engine.read(self.run)["integration"]["observations"][task]["branch"]

    def advance(self, task="A"):
        self.git("update-ref", "refs/heads/main", self.heads[task])

    def reserve(self, task, kind="review", **fields):
        return self.apply("reserve", task, kind=kind, unit=Engine.UNITS[kind],
                          target={"head": self.heads[task]}, **fields)

    def test_conflict_detected_without_touching_busy_dirty_writer_or_frozen_refs(self):
        self.refresh()
        self.assertEqual(self.observation("B")["status"], "clean")
        worker = self.base / "worktrees" / "B"
        self.git("worktree", "add", str(worker), "task/B")
        (worker / "shared.txt").write_text("staged\n")
        self.git("add", "shared.txt", cwd=worker)
        (worker / "shared.txt").write_text("unstaged\n")
        (worker / "scratch.txt").write_text("untracked\n")
        self.apply("observe", "B", fields={"refs": {"run_id": "active-review", "review_base": self.base_oid}}, evidence=self.proof())
        reservation = self.reserve("B")
        self.advance()
        before = Engine.read(self.run)["tasks"]["B"]
        index = Path(self.git("rev-parse", "--git-path", "index", cwd=worker))
        snapshot = (index.read_bytes(), self.git("status", "--porcelain", cwd=worker),
                    self.git("show-ref"), {p.name: p.read_bytes() for p in worker.iterdir() if p.is_file()})
        self.refresh()
        self.assertEqual(self.observation("B")["status"], "conflicted")
        self.assertEqual(self.observation("B")["conflict_paths"], ["shared.txt"])
        self.assertEqual(self.observation("C")["status"], "clean")
        self.assertEqual(Engine.read(self.run)["tasks"]["B"], before)
        self.assertEqual(snapshot, (index.read_bytes(), self.git("status", "--porcelain", cwd=worker),
                         self.git("show-ref"), {p.name: p.read_bytes() for p in worker.iterdir() if p.is_file()}))
        incident = Engine.read(self.run)["integration"]["incidents"][canonical(["B", "branch"])]
        self.assertIn(reservation["reservation_id"], incident["active_executions"])

    def test_unchanged_scans_reuse_results_and_only_conflicted_driver_wakes(self):
        self.refresh()
        before_b = supervise.task_view(self.run, "B")["change_token"]
        before_c = supervise.task_view(self.run, "C")["change_token"]
        unchanged = integration.refresh(self.run)
        self.assertEqual(unchanged["counts"]["probes"], 0)
        self.assertEqual(unchanged["counts"]["fetches"], 0)
        self.assertEqual(supervise.task_view(self.run, "B")["change_token"], before_b)
        self.advance()
        self.refresh()
        first_b = supervise.task_view(self.run, "B")["change_token"]
        self.assertNotEqual(first_b, before_b)
        self.assertEqual(supervise.task_view(self.run, "C")["change_token"], before_c)
        self.refresh()
        self.assertEqual(supervise.task_view(self.run, "B")["change_token"], first_b)

    def test_known_conflict_blocks_final_stages_without_spending_but_allows_repairs(self):
        self.advance()
        self.refresh()
        before = Engine.read(self.run)["tasks"]["B"]
        for kind in ("review", "validate"):
            self.assert_error("integration", self.reserve, "B", kind)
        after = Engine.read(self.run)["tasks"]["B"]
        self.assertEqual(after, before)
        self.assertEqual(after["counters"], {})
        repair = self.reserve("B", "validate", purpose="repair")
        self.settle(repair["reservation_id"], "B")
        independent = self.reserve("C")
        self.assertTrue(independent["reservation_id"])

    def test_unknown_on_missing_ref_does_not_block_other_candidates(self):
        self.git("update-ref", "-d", "refs/heads/task/B")
        self.refresh()
        self.assertEqual(self.observation("B")["status"], "unknown")
        self.assertEqual(self.observation("B")["reason"], "candidate_unavailable")
        self.assertEqual(self.observation("C")["status"], "clean")
        self.assert_error("integration", self.reserve, "B")
        self.reserve("C")

    def test_missing_object_and_malformed_merge_output_are_unknown(self):
        self.refresh()
        directory = self.run / "integration"
        git = integration.Git(directory, 10)
        with self.assertRaises(integration.ProbeError):
            integration.probe(git, directory / "objects.git", "f" * 40, self.base_oid, [])
        real = git.run
        def malformed(*args, **kwargs):
            return (1, b"") if "merge-tree" in args else real(*args, **kwargs)
        with patch.object(git, "run", side_effect=malformed), self.assertRaises(integration.ProbeError):
            integration.probe(git, directory / "objects.git", self.heads["B"], self.base_oid, [])

    def test_stale_scan_cannot_clear_a_current_conflict(self):
        self.refresh()
        state = Engine.read(self.run)
        stale = integration.scan(self.run / "integration", state)
        self.advance()
        self.apply("candidate", "B", candidate={"id": "branch", "ref": "refs/heads/task/B", "pr": 12}, evidence=self.proof())
        self.refresh()
        self.assertFalse(Engine.publish_integration(self.run, integration.binding(state), stale))
        self.assertEqual(self.observation("B")["status"], "conflicted")

    def test_persistent_unknown_is_silent_until_a_stage_waits_then_readiness_wakes(self):
        self.refresh()
        token = supervise.task_view(self.run, "C")["change_token"]
        real = integration.Git.run
        def unavailable(git, *args, **kwargs):
            return (1, b"") if "ls-remote" in args else real(git, *args, **kwargs)
        with patch.object(integration.Git, "run", unavailable):
            self.refresh()
        self.assertEqual(self.observation("C")["status"], "unknown")
        self.assertEqual(supervise.task_view(self.run, "C")["change_token"], token)
        self.assert_error("integration", self.reserve, "C")
        waiting = supervise.task_view(self.run, "C")["change_token"]
        self.refresh()
        self.assertNotEqual(supervise.task_view(self.run, "C")["change_token"], waiting)

    def test_private_probe_configuration_does_not_assume_custom_driver_semantics(self):
        self.git("config", "merge.fixture.driver", "false")
        self.refresh()
        self.assertEqual(self.observation("C")["status"], "unknown")
        self.assertEqual(self.observation("C")["reason"], "custom_merge_policy")

    def test_configured_environment_policy_is_inspected_and_policy_changes_invalidate_cache(self):
        self.refresh()
        self.git("config", "diff.renames", "false")
        result = integration.refresh(self.run)
        self.assertGreater(result["counts"]["probes"], 0)
        custom = self.base / "custom-gitconfig"
        custom.write_text('[merge "fixture"]\n driver = false\n')
        with patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": str(custom)}):
            self.refresh()
        self.assertEqual(self.observation("C")["status"], "unknown")
        self.assertEqual(self.observation("C")["reason"], "custom_merge_policy")

    def test_probe_honors_committed_attributes_from_target(self):
        for task in ("A", "B"):
            self.git("checkout", "task/" + task)
            (self.repo / ".gitattributes").write_text("*.txt merge=union\n")
            self.git("add", ".gitattributes")
            self.git("commit", "-m", "union policy")
            self.heads[task] = self.git("rev-parse", "HEAD")
        self.git("checkout", "main")
        self.advance()
        self.refresh()
        self.assertEqual(self.observation("B")["status"], "clean")

    def test_alternate_attribute_sources_cannot_reuse_clean_evidence_or_reserved_policy(self):
        for task in ("A", "B"):
            self.git("checkout", "task/" + task)
            (self.repo / ".gitattributes").write_text("*.txt merge=union\n")
            self.git("add", ".gitattributes")
            self.git("commit", "-m", "union policy")
            self.heads[task] = self.git("rev-parse", "HEAD")
        self.git("checkout", "-b", "attribute-policy", self.base_oid)
        (self.repo / ".gitattributes").write_text("*.txt -merge\n")
        self.git("add", ".gitattributes")
        self.git("commit", "-m", "binary policy")
        attributes = self.git("rev-parse", "HEAD")
        self.git("checkout", "main")
        self.advance()
        self.refresh()
        self.assertEqual(self.observation("B")["status"], "clean")
        reserved = self.reserve("B")
        before = Engine.read(self.run)["tasks"]["B"]
        for source in ("config", "environment"):
            with self.subTest(source=source):
                if source == "config":
                    self.git("config", "attr.tree", attributes)
                with patch.dict(os.environ, {"GIT_ATTR_SOURCE": attributes} if source == "environment" else {}):
                    actual = subprocess.run(["git", "-C", str(self.repo), "merge-tree", "--write-tree",
                                             self.heads["A"], self.heads["B"]], capture_output=True)
                    self.assertEqual(actual.returncode, 1, actual.stderr)
                    self.refresh()
                    self.assertEqual(self.observation("B")["status"], "unknown")
                    self.assertEqual(self.observation("B")["reason"], "custom_merge_policy")
                    self.assert_error("integration", self.apply, "intent", "B", kind="review",
                        reservation_id=reserved["reservation_id"], target={"head": self.heads["B"]}, evidence=self.proof())
                    self.assertEqual(Engine.read(self.run)["tasks"]["B"], before)
                if source == "config":
                    self.git("config", "--unset", "attr.tree")
                self.refresh()
                self.assertEqual(self.observation("B")["status"], "clean")

    def test_git_with_unfixed_attribute_source_merge_is_rejected_before_cached_admission(self):
        self.refresh()
        original = integration.Git.run
        def old_version(git, *args, **kwargs):
            return (0, b"git version 2.42.0\n") if args == ("--version",) else original(git, *args, **kwargs)
        with patch.object(integration.Git, "run", old_version):
            self.refresh()
        self.assertEqual(self.observation("C")["status"], "unknown")
        self.assertEqual(self.observation("C")["reason"], "git_2_43_required")
        self.assert_error("integration", self.reserve, "C")
        self.assertEqual(Engine.read(self.run)["tasks"]["C"]["counters"], {})
        self.refresh()
        self.assertEqual(self.observation("C")["status"], "clean")

    def test_renormalization_uses_git_boolean_semantics_without_running_filters(self):
        self.git("checkout", "task/B")
        (self.repo / ".gitattributes").write_text("*.txt filter=fixture\n")
        self.git("add", ".gitattributes")
        self.git("commit", "-m", "filtered path")
        self.heads["B"] = self.git("rev-parse", "HEAD")
        self.git("checkout", "main")
        marker = self.base / "filter-ran"
        self.git("config", "filter.fixture.clean", "touch " + str(marker))
        self.git("config", "filter.fixture.smudge", "touch " + str(marker))
        for value in ("2", "-1", "true", "invalid", "0", "false"):
            with self.subTest(value=value):
                self.git("config", "merge.renormalize", value)
                self.refresh()
                if value in {"0", "false"}:
                    self.assertEqual(self.observation("B")["status"], "clean")
                else:
                    self.assertEqual(self.observation("B")["status"], "unknown")
                    self.assert_error("integration", self.reserve, "B")
                    self.assertEqual(Engine.read(self.run)["tasks"]["B"]["counters"], {})
                self.assertFalse(marker.exists())

    def test_explicit_bootstrap_finishes_a_cold_fetch_that_exceeds_normal_scan_budget(self):
        config = Engine.read(self.run)["config"]["integration"]
        self.apply("configure", fields={"integration": {**config, "timeout_seconds": 2,
                   "bootstrap_timeout_seconds": 15}}, evidence=self.proof())
        executable = shutil.which("git")
        binaries = self.base / "slow-git"
        binaries.mkdir()
        log = self.base / "fetches"
        shim = binaries / "git"
        shim.write_text(f'''#!{sys.executable}
import os, sys, time
if "fetch" in sys.argv[1:]:
    with open({str(log)!r}, "a") as stream: stream.write("fetch\\n")
    time.sleep(3)
os.execv({executable!r}, [{executable!r}, *sys.argv[1:]])
''')
        shim.chmod(0o700)
        before = (self.git("status", "--porcelain"), (self.repo / ".git/index").read_bytes(), self.git("show-ref"))
        with patch.dict(os.environ, {"PATH": str(binaries) + os.pathsep + os.environ["PATH"]}):
            failed = integration.refresh(self.run)
            self.assertEqual(failed["status"], "timeout")
            self.assertIn("--bootstrap", failed["next_action"])
            self.assertEqual(self.git("--git-dir", str(self.run / "integration/objects.git"), "for-each-ref"), "")
            command = subprocess.run([sys.executable, "-B", str(fixtures.SCRIPTS / "supervise.py"),
                "integration", "--run-dir", str(self.run), "--bootstrap"], capture_output=True, text=True, timeout=20)
            self.assertEqual(command.returncode, 0, command.stdout + command.stderr)
            self.assertEqual(json.loads(command.stdout)["status"], "observed")
            self.assertEqual(self.observation("C")["status"], "clean")
            warmed = integration.refresh(self.run)
            self.assertEqual(warmed["status"], "observed")
            self.assertEqual(warmed["counts"]["fetches"], 0)
            self.assertEqual(warmed["counts"]["cache_hits"], 3)
            self.reserve("C")
        self.assertEqual(log.read_text().splitlines(), ["fetch", "fetch"])
        self.assertEqual(before, (self.git("status", "--porcelain"), (self.repo / ".git/index").read_bytes(), self.git("show-ref")))

    def test_bootstrap_budget_is_bounded_and_restricted_to_the_coordinator(self):
        config = Engine.read(self.run)["config"]["integration"]
        for invalid in (0, -1, 3601, True):
            self.assert_error("invalid", self.apply, "configure", fields={"integration": {
                **config, "bootstrap_timeout_seconds": invalid}}, evidence=self.proof())
        self.assert_error("forbidden", supervise.serve, self.run, "worker-a",
                          {"op": "integration", "task_id": "A", "bootstrap": True})
        self.assertFalse((self.run / "integration").exists())

    def test_multiple_candidates_and_migration_group_warning(self):
        for task in ("B", "C"):
            self.git("checkout", "task/" + task)
            (self.repo / "migrations").mkdir(exist_ok=True)
            (self.repo / "migrations" / (task + ".sql")).write_text("-- independent files\n")
            self.git("add", ".")
            self.git("commit", "-m", "migration " + task)
            self.heads[task] = self.git("rev-parse", "HEAD")
        self.git("checkout", "main")
        self.apply("candidate", "B", candidate={"id": "second", "ref": "refs/heads/task/C", "pr": 13}, evidence=self.proof())
        self.refresh()
        result = self.observation("C")
        self.assertEqual(result["status"], "clean")
        self.assertTrue(any(w["kind"] == "group" and w["name"] == "migrations" for w in result["overlaps"]))
        self.assert_error("integration", self.reserve, "B")
        self.reserve("B", candidate_id="branch")

    def test_restricted_route_cannot_probe_or_query_other_task(self):
        self.assert_error("forbidden", integration.refresh, self.run, "B", "worker-a")
        result = supervise.serve(self.run, "worker-a", {"op": "integration", "task_id": "A"})
        self.assertEqual(result["status"], "observed")
        self.assertNotIn("B", result.get("integration", {}))

    def adapter(self, kind):
        script = self.base / "adapter.py"
        script.write_text('''import json, pathlib, subprocess, sys
p = json.load(sys.stdin)
repo, effects = sys.argv[1:]
with open(effects + ".requests", "a") as stream: stream.write(json.dumps(p) + "\\n")
if p["mode"] == "dispatch":
    with open(effects, "a") as stream: stream.write(p["operation_id"] + "\\n")
if p["kind"] == "merge" and p["mode"] == "dispatch":
    subprocess.run(["git", "-C", repo, "update-ref", "refs/heads/main", p["target"]["head"]], check=True)
receipt = {"ref": effects, "observed_at": "2026-11-03T12:00:00Z", "all_jobs_settled": True,
           "head": p["target"]["head"], "merge_commit": p["target"]["head"]}
print(json.dumps({"status": "succeeded", "receipt": receipt}))
''')
        argv = [sys.executable, "-B", str(script), str(self.repo), str(self.base / "effects")]
        self.apply("configure", fields={"adapters": {"fixture": {
            "kind": kind, "host": "local", "argv": argv, "inspect_argv": argv}}}, evidence=self.proof())

    def merge_request(self):
        self.adapter("merge")
        self.apply("candidate", "A", candidate={"id": "branch", "ref": "refs/heads/task/A", "pr": 42}, evidence=self.proof())
        refs = {"controller_id": "fixture-controller", "run_id": "A-review", "review_head": self.heads["A"], "review_base": self.base_oid}
        self.apply("observe", "A", fields={"refs": refs}, evidence=self.proof())
        gates = {**{k: True for k in ("complete", "validation", "checks", "feedback", "findings", "target_current", "clean")},
                 **refs, "checkout_head": self.heads["A"], "pr_head": self.heads["A"], "commit_mode": "per-round"}
        return self.request("execute", "A", kind="merge", adapter="fixture", candidate_id="branch",
            target={"repository": str(self.repo), "base": "main", "pr": 42, "head": self.heads["A"]},
            gates=gates, refs=refs, evidence=self.proof())

    def test_confirmed_merge_invalidates_before_scan_and_completed_retry_does_not_merge_twice(self):
        request = self.merge_request()
        with patch.object(integration, "after_transition", side_effect=OSError("simulated stop after receipt")):
            with self.assertRaises(OSError):
                runner.execute(self.run, request, "worker-a")
        state = Engine.read(self.run)
        self.assertEqual(state["integration"]["pending_refresh"], "merge_succeeded")
        self.assertIsNone(state["tasks"]["A"]["pending_intent"])
        self.assertFalse(state["tasks"]["A"]["candidates"]["branch"]["active"])
        self.assert_error("integration", self.reserve, "B")
        before_c = supervise.task_view(self.run, "C")["change_token"]
        result = runner.execute(self.run, {"op": "execute", "action_id": request["action_id"], "task_id": "A"}, "worker-a")
        self.assertEqual(result["outcome"], "succeeded")
        self.assertEqual((self.base / "effects").read_text().splitlines(), [request["action_id"]])
        self.assertEqual(self.observation("B")["status"], "conflicted")
        self.assertEqual(supervise.task_view(self.run, "C")["change_token"], before_c)
        self.reserve("C")

    def test_successful_push_and_pr_outcomes_detect_conflicts_without_an_explicit_refresh(self):
        self.advance()
        for kind in ("push", "pr"):
            with self.subTest(kind=kind):
                self.git("update-ref", "refs/heads/task/C", self.heads["C"])
                self.refresh()
                self.assertEqual(self.observation("C")["status"], "clean")
                reserved = self.reserve("C", kind)
                target = {"repository": str(self.repo), "head": self.heads["B"]}
                intent = self.apply("intent", "C", kind=kind, reservation_id=reserved["reservation_id"],
                                    target=target, evidence=self.proof())
                # The external publication changes the registered remote head.
                self.git("update-ref", "refs/heads/task/C", self.heads["B"])
                refresh = integration.refresh
                def observe_invalidation(*args, **kwargs):
                    self.assertEqual(Engine.read(self.run)["integration"]["pending_refresh"], kind + "_succeeded")
                    return refresh(*args, **kwargs)
                request = self.request("outcome", "C", intent_id=intent["intent"]["id"], target=target,
                                       status="succeeded", receipt=self.proof(True))
                with patch.object(integration, "refresh", side_effect=observe_invalidation) as scanning:
                    self.assertEqual(supervise.apply_request(self.run, request)["outcome"], "succeeded")
                    scanning.assert_called_once()
                self.assertEqual(self.observation("C")["head"], self.heads["B"])
                self.assertEqual(self.observation("C")["status"], "conflicted")
                self.assertTrue(supervise.task_view(self.run, "C")["integration"]["candidates"]["branch"]["incident_id"])
                self.assertIsNone(Engine.read(self.run)["integration"]["pending_refresh"])
                self.settle(reserved["reservation_id"], "C")

    def test_prepared_review_is_fenced_when_target_moves_before_dispatch(self):
        self.adapter("review")
        self.refresh()
        req = self.request("prepare", "B", kind="review", adapter="fixture", target={"head": self.heads["B"]}, evidence=self.proof())
        Engine.apply(self.run, req)
        self.advance()
        # Resuming an unissued preparation performs fresh observations in code.
        self.assert_error("integration", runner.execute, self.run,
                          {"op": "execute", "action_id": req["action_id"], "task_id": "B"})
        state = Engine.read(self.run)
        self.assertIsNone(state["tasks"]["B"]["pending_intent"]["execution"]["dispatched_at"])
        self.assertFalse((self.base / "effects").exists())
        self.assertEqual(state["tasks"]["B"]["counters"]["review"], 1)

    def test_stage_runner_refreshes_before_reserving_and_validation_purpose_cannot_change(self):
        self.adapter("review")
        self.refresh()
        self.advance()
        req = self.request("execute", "B", kind="review", adapter="fixture", target={"head": self.heads["B"]}, evidence=self.proof())
        self.assert_error("integration", runner.execute, self.run, req)
        self.assertEqual(Engine.read(self.run)["tasks"]["B"]["counters"], {})
        reservation = self.reserve("B", "validate", purpose="repair")
        intent = self.request("intent", "B", kind="validate", purpose="acceptance", reservation_id=reservation["reservation_id"],
                              target={"head": self.heads["B"]}, evidence=self.proof())
        self.assert_error("integration", Engine.apply, self.run, intent)

    def test_conflict_repair_preserves_grant_findings_budget_and_successor_review_scope(self):
        old = {"controller_id": "fixture", "run_id": "old", "review_base": self.base_oid}
        self.apply("observe", "B", fields={"refs": old, "findings": [{"id": "carry", "status": "unresolved"}]}, evidence=self.proof())
        self.refresh()
        review = self.reserve("B")
        grant = Engine.read(self.run)["tasks"]["B"]["delegation"]
        self.advance()
        self.refresh()
        incident = supervise.task_view(self.run, "B")["integration"]["candidates"]["branch"]["incident_id"]
        self.apply("integration_ack", "B", candidate_id="branch", incident_id=incident, evidence=self.proof())
        self.settle(review["reservation_id"], "B")
        repair = self.reserve("B", "repair")
        self.git("checkout", "-f", "task/B")
        merged = subprocess.run(["git", "-C", str(self.repo), "merge", "--no-edit", "main"], capture_output=True)
        self.assertEqual(merged.returncode, 1)
        (self.repo / "shared.txt").write_text("A and B\n")
        self.git("add", "shared.txt")
        self.git("commit", "-m", "integrate both task changes")
        self.heads["B"] = self.git("rev-parse", "HEAD")
        self.settle(repair["reservation_id"], "B")
        self.apply("observe", "B", fields={"refs": {"run_id": "successor", "review_base": self.heads["A"]}},
                   successor={"previous_refs": old, "evidence": self.proof(True)}, evidence=self.proof())
        self.refresh()
        self.reserve("B")
        task = Engine.read(self.run)["tasks"]["B"]
        self.assertEqual(task["refs"]["review_base"], self.heads["A"])
        self.assertEqual(task["counters"]["review"], 2)
        self.assertEqual(task["counters"]["source_repair"], 1)
        self.assertEqual(task["delegation"], grant)
        self.assertEqual(task["findings"][0]["id"], "carry")
        recorded = Engine.read(self.run)["integration"]["incidents"][canonical(["B", "branch"])]
        self.assertFalse(recorded["active"])
        self.assertIn("acknowledged_at", recorded)
        self.assertIn("resolved_at", recorded)

    def test_out_of_order_scan_is_rejected_even_without_configuration_change(self):
        self.refresh()
        state = Engine.read(self.run)
        report = integration.scan(self.run / "integration", state)
        self.advance()
        self.refresh()
        self.assertFalse(Engine.publish_integration(self.run, integration.binding(state), report))
        self.assertEqual(self.observation("B")["status"], "conflicted")

    def test_failed_refresh_does_not_erase_conflict_or_repeat_overlap_notice(self):
        self.refresh()
        before_b = supervise.task_view(self.run, "B")["change_token"]
        with patch.object(integration.Git, "run", return_value=(1, b"")):
            self.refresh()
        self.assertEqual(supervise.task_view(self.run, "B")["change_token"], before_b)
        self.advance()
        self.refresh()
        conflict_token = supervise.task_view(self.run, "B")["change_token"]
        with patch.object(integration.Git, "run", return_value=(1, b"")):
            self.refresh()
        self.assertEqual(supervise.task_view(self.run, "B")["change_token"], conflict_token)
        self.assert_error("integration", self.reserve, "B")

    def test_completed_reconciliation_observes_external_target_movement(self):
        self.refresh()
        self.advance()
        self.assertEqual(supervise.complete(self.run, "manual")["status"], "completed")
        self.assertEqual(self.observation("B")["status"], "conflicted")

    def test_intervening_target_updates_keep_one_conflict_handoff_with_latest_evidence(self):
        self.advance()
        self.refresh()
        first = supervise.task_view(self.run, "B")
        self.git("checkout", "-f", "main")
        (self.repo / "later.txt").write_text("another merged task\n")
        self.git("add", "later.txt")
        self.git("commit", "-m", "later target")
        latest = self.git("rev-parse", "HEAD")
        self.refresh()
        second = supervise.task_view(self.run, "B")
        self.assertEqual(second["change_token"], first["change_token"])
        self.assertEqual(second["integration"]["candidates"]["branch"]["target"], latest)
        self.assertEqual(second["integration"]["candidates"]["branch"]["incident_id"],
                         first["integration"]["candidates"]["branch"]["incident_id"])

    def test_expired_evidence_waits_for_refresh_and_idempotent_reserve_stays_historical(self):
        self.refresh()
        request = self.request("reserve", "C", kind="review", unit="review", target={"head": self.heads["C"]})
        original = supervise.apply_request(self.run, request)
        self.settle(original["reservation_id"], "C")
        with patch.object(integration, "datetime") as clock:
            clock.now.return_value = datetime.now(timezone.utc) + timedelta(seconds=180)
            self.assert_error("integration", self.reserve, "C")
            waiting = supervise.task_view(self.run, "C")["change_token"]
            self.assertEqual(supervise.apply_request(self.run, request), original)
        self.refresh()
        self.assertNotEqual(supervise.task_view(self.run, "C")["change_token"], waiting)

    def test_quiet_watch_ignores_timeout_and_freshness_but_returns_for_control_change(self):
        self.refresh()
        token = supervise.task_view(self.run, "C")["change_token"]
        calls = []
        def next_poll(_):
            calls.append(True)
            if len(calls) == 1:
                self.refresh()
            else:
                self.apply("control", "C", control="pause")
        clock = SimpleNamespace(monotonic=supervise.time.monotonic, sleep=next_poll)
        with patch.object(supervise, "time", clock):
            result = supervise.watch_task(self.run, "C", token, timeout_seconds=0, until_change=True)
        self.assertEqual(len(calls), 2)
        self.assertTrue(result["changed"])
        self.assertTrue(result["task"]["paused"])

    def test_busy_probe_leaves_a_wait_predicate_that_wakes_when_the_shared_scan_finishes(self):
        self.adapter("review")
        self.refresh()
        request = self.request("execute", "C", kind="review", adapter="fixture", target={"head": self.heads["C"]}, evidence=self.proof())
        for count, status in enumerate(("busy", "superseded", "timeout", "busy"), 1):
            with self.subTest(status=status, count=count), patch.object(integration, "refresh", return_value={"status": status}):
                self.assert_error("integration", runner.execute, self.run, request)
            self.assertEqual(Engine.read(self.run)["integration"]["stats"]["blocked_stage_requests"], count)
        waiting = supervise.task_view(self.run, "C")["change_token"]
        self.assertEqual(Engine.read(self.run)["tasks"]["C"]["counters"], {})
        self.refresh()
        self.assertNotEqual(supervise.task_view(self.run, "C")["change_token"], waiting)
        self.assertEqual(runner.execute(self.run, request)["outcome"], "succeeded")
        self.assertEqual(Engine.read(self.run)["integration"]["stats"]["blocked_stage_requests"], 4)
        self.assertEqual(Engine.read(self.run)["tasks"]["C"]["counters"]["review"], 1)

    def test_timeout_does_not_rescan_routine_worker_updates_but_new_publication_does(self):
        self.adapter("implement")
        self.refresh()
        def routed(op, **fields):
            return supervise.serve(self.run, "worker-a", self.request(op, "A", **fields))
        with patch.object(integration, "scan", side_effect=integration.ProbeTimeout()) as scan:
            self.assertEqual(integration.refresh(self.run)["status"], "timeout")
            for index in range(2):
                routed("observe", fields={"next_action": "record " + str(index)}, evidence=self.proof())
            routed("candidate", candidate={"id": "branch", "ref": "refs/heads/task/A"}, evidence=self.proof())
            reservation = routed("reserve", kind="implement", unit="implementation")
            target = {"head": self.heads["A"]}
            intent = routed("intent", kind="implement", reservation_id=reservation["reservation_id"],
                            target=target, evidence=self.proof())
            routed("outcome", intent_id=intent["intent"]["id"], target=target, status="succeeded", receipt=self.proof(True))
            self.settle(reservation["reservation_id"], "A")
            request = self.request("execute", "A", kind="implement", adapter="fixture", target=target, evidence=self.proof())
            self.assertEqual(supervise.serve(self.run, "worker-a", request)["outcome"], "succeeded")
            self.assertEqual(supervise.serve(self.run, "worker-a", request)["outcome"], "succeeded")
            self.assertEqual(scan.call_count, 1)
            self.assertEqual((self.base / "effects").read_text().splitlines(), [request["action_id"]])
            # New registration still merits an immediate attempt during an outage.
            routed("candidate", candidate={"id": "second", "ref": "refs/heads/task/C"}, evidence=self.proof())
            self.assertEqual(scan.call_count, 2)
            routed("observe", fields={"next_action": "record after timeout"}, evidence=self.proof())
            self.assertEqual(scan.call_count, 2)
        self.assertEqual(Engine.read(self.run)["integration"]["pending_refresh"], "scan_timeout")
        self.advance("B")
        reservation = routed("reserve", kind="push", unit=Engine.UNITS["push"])
        target = {"repository": str(self.repo), "head": self.heads["A"]}
        intent = routed("intent", kind="push", reservation_id=reservation["reservation_id"], target=target, evidence=self.proof())
        routed("outcome", intent_id=intent["intent"]["id"], target=target, status="succeeded", receipt=self.proof(True))
        self.assertEqual(self.observation("A")["status"], "conflicted")
        self.assertIsNone(Engine.read(self.run)["integration"]["pending_refresh"])

    def test_clean_target_update_keeps_reserved_assignment_and_frozen_review_scope(self):
        refs = {"run_id": "reserved-review", "review_base": self.base_oid}
        self.apply("observe", "C", fields={"refs": refs}, evidence=self.proof())
        self.refresh()
        reserved = self.reserve("C", refs=refs)
        before = Engine.read(self.run)["tasks"]["C"]
        self.advance()
        intent = supervise.apply_request(self.run, self.request("intent", "C", kind="review", refs=refs,
            reservation_id=reserved["reservation_id"], target={"head": self.heads["C"]}, evidence=self.proof()))
        after = Engine.read(self.run)["tasks"]["C"]
        self.assertEqual(intent["intent"]["integration"]["target"], self.heads["A"])
        self.assertEqual(after["counters"], before["counters"])
        self.assertEqual(after["refs"], refs)
        self.assertEqual(after["delegation"], before["delegation"])
        self.assertEqual(set(after["reservations"]), {reserved["reservation_id"]})

    def test_clean_target_update_reaches_adapter_without_recounting_prepared_review(self):
        self.adapter("review")
        self.refresh()
        req = self.request("prepare", "C", kind="review", adapter="fixture", target={"head": self.heads["C"]}, evidence=self.proof())
        Engine.apply(self.run, req)
        self.advance()
        result = runner.execute(self.run, {"op": "execute", "action_id": req["action_id"], "task_id": "C"})
        self.assertEqual(result["outcome"], "succeeded")
        payload = json.loads((self.base / "effects.requests").read_text())
        self.assertEqual(payload["integration"]["target"], self.heads["A"])
        self.assertEqual(payload["integration"]["head"], self.heads["C"])
        self.assertEqual(Engine.read(self.run)["tasks"]["C"]["counters"]["review"], 1)
        self.assertEqual((self.base / "effects").read_text().splitlines(), [req["action_id"]])

    def test_prepared_candidate_survives_registration_growth_and_busy_wait(self):
        self.adapter("review")
        self.refresh()
        request = self.request("prepare", "C", kind="review", adapter="fixture",
                               target={"head": self.heads["C"]}, evidence=self.proof())
        Engine.apply(self.run, request)
        original = Engine.read(self.run)["tasks"]["C"]["pending_intent"]
        self.apply("candidate", "C", candidate={"id": "second", "ref": "refs/heads/task/B"}, evidence=self.proof())
        resume = {"op": "execute", "action_id": request["action_id"], "task_id": "C"}
        with patch.object(integration, "refresh", return_value={"status": "busy"}):
            self.assert_error("integration", runner.execute, self.run, resume)
        waiting = supervise.task_view(self.run, "C")
        candidates = waiting["integration"]["candidates"]
        self.assertEqual(candidates["branch"]["waiting"]["status"], "pending")
        self.assertIsNone(candidates["second"]["waiting"])
        self.refresh()
        ready = supervise.task_view(self.run, "C")
        self.assertNotEqual(ready["change_token"], waiting["change_token"])
        self.assertEqual(ready["integration"]["candidates"]["branch"]["waiting"]["status"], "ready")
        self.assertEqual(runner.execute(self.run, resume)["outcome"], "succeeded")
        payload = json.loads((self.base / "effects.requests").read_text())
        self.assertEqual(payload["operation_id"], original["id"])
        self.assertEqual(payload["integration"]["candidate_id"], "branch")
        self.assertEqual(payload["integration"]["head"], self.heads["C"])
        self.assertEqual(Engine.read(self.run)["tasks"]["C"]["counters"]["review"], 1)
        self.assertEqual((self.base / "effects").read_text().splitlines(), [request["action_id"]])
        self.assert_error("integration", self.reserve, "C")  # New work must still disambiguate.

    def test_implicit_reserved_merge_survives_registration_growth_at_intent(self):
        request = self.merge_request()
        request.pop("candidate_id")
        self.refresh()
        reserved = self.apply("reserve", "A", kind="merge", unit=Engine.UNITS["merge"],
                              target=request["target"], refs=request["refs"])
        before = Engine.read(self.run)["tasks"]["A"]
        self.apply("candidate", "A", candidate={"id": "second", "ref": "refs/heads/task/C", "pr": 43}, evidence=self.proof())
        result = supervise.apply_request(self.run, self.request("intent", "A", kind="merge",
            reservation_id=reserved["reservation_id"], target=request["target"], gates=request["gates"],
            refs=request["refs"], evidence=self.proof()))
        self.assertEqual(result["intent"]["integration"]["candidate_id"], "branch")
        after = Engine.read(self.run)["tasks"]["A"]
        self.assertEqual(after["counters"], before["counters"])
        self.assertEqual(after["refs"], before["refs"])
        self.assertEqual(set(after["reservations"]), {reserved["reservation_id"]})

    def test_implicit_prepared_merge_dispatches_original_candidate_after_registration_growth(self):
        request = self.merge_request()
        request.pop("candidate_id")
        self.refresh()
        Engine.apply(self.run, {**request, "op": "prepare"}, "worker-a")
        self.apply("candidate", "A", candidate={"id": "second", "ref": "refs/heads/task/C", "pr": 43}, evidence=self.proof())
        resume = {"op": "execute", "action_id": request["action_id"], "task_id": "A"}
        self.assertEqual(runner.execute(self.run, resume, "worker-a")["outcome"], "succeeded")
        payload = json.loads((self.base / "effects.requests").read_text())
        self.assertEqual(payload["operation_id"], request["action_id"])
        self.assertEqual(payload["integration"]["candidate_id"], "branch")
        self.assertEqual(payload["target"]["pr"], 42)
        self.assertEqual(payload["integration"]["head"], self.heads["A"])
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["counters"]["merge"], 1)
        self.assertEqual((self.base / "effects").read_text().splitlines(), [request["action_id"]])

    def test_changed_merge_policy_still_fences_a_reserved_final_stage(self):
        self.refresh()
        reserved = self.reserve("C")
        self.git("config", "diff.renames", "false")
        request = self.request("intent", "C", kind="review", reservation_id=reserved["reservation_id"],
                               target={"head": self.heads["C"]}, evidence=self.proof())
        self.assert_error("integration", supervise.apply_request, self.run, request)
        task = Engine.read(self.run)["tasks"]["C"]
        self.assertIsNone(task["pending_intent"])
        self.assertEqual(task["counters"]["review"], 1)
        self.assertEqual(supervise.task_view(self.run, "C")["integration"]["candidates"]["branch"]["waiting"]["status"], "policy_changed")

    def test_observation_settings_do_not_invalidate_cached_merges_or_reserved_scope(self):
        self.refresh()
        reserved = self.reserve("C")
        config = Engine.read(self.run)["config"]["integration"]
        self.apply("configure", fields={"integration": {**config, "max_age_seconds": 180,
                   "overlap_groups": {}}}, evidence=self.proof())
        refreshed = integration.refresh(self.run)
        self.assertEqual(refreshed["counts"]["probes"], 0)
        self.assertEqual(refreshed["counts"]["cache_hits"], 3)
        self.apply("intent", "C", kind="review", reservation_id=reserved["reservation_id"],
                   target={"head": self.heads["C"]}, evidence=self.proof())
        self.assertEqual(Engine.read(self.run)["tasks"]["C"]["counters"]["review"], 1)

    def test_reserved_head_change_requires_settlement_without_retry_or_recount(self):
        self.refresh()
        reserved = self.reserve("C")
        before = Engine.read(self.run)["tasks"]["C"]
        self.git("update-ref", "refs/heads/task/C", self.base_oid)
        token = None
        for head in (self.base_oid, self.heads["C"], self.base_oid):
            request = self.request("intent", "C", kind="review", reservation_id=reserved["reservation_id"],
                                   target={"head": head}, evidence=self.proof())
            self.assert_error("integration", supervise.apply_request, self.run, request)
            self.assertEqual(Engine.read(self.run)["tasks"]["C"], before)
            view = supervise.task_view(self.run, "C")
            candidate = view["integration"]["candidates"]["branch"]
            self.assertEqual(candidate["waiting"]["status"], "head_changed")
            self.assertIn("settle", candidate["next_action"].lower())
            if token is not None:
                self.assertEqual(view["change_token"], token)
            token = view["change_token"]
        self.settle(reserved["reservation_id"], "C")
        self.heads["C"] = self.base_oid
        replacement = self.reserve("C")
        self.assertNotEqual(replacement["reservation_id"], reserved["reservation_id"])
        self.assertEqual(Engine.read(self.run)["tasks"]["C"]["counters"]["review"], 2)
        self.assertIsNone(supervise.task_view(self.run, "C")["integration"]["candidates"]["branch"]["waiting"])

    def test_reserved_candidate_change_requires_settlement_even_at_the_same_head(self):
        for cid in ("branch", "other"):
            self.apply("candidate", "C", candidate={"id": cid, "ref": "refs/heads/task/C"}, evidence=self.proof())
        self.refresh()
        reserved = self.reserve("C", candidate_id="branch")
        before = Engine.read(self.run)["tasks"]["C"]
        token = None
        for _ in range(2):
            request = self.request("intent", "C", kind="review", candidate_id="other",
                                   reservation_id=reserved["reservation_id"], target={"head": self.heads["C"]},
                                   evidence=self.proof())
            self.assert_error("integration", supervise.apply_request, self.run, request)
            self.assertEqual(Engine.read(self.run)["tasks"]["C"], before)
            view = supervise.task_view(self.run, "C")
            candidate = view["integration"]["candidates"]["other"]
            self.assertEqual(candidate["waiting"]["status"], "candidate_changed")
            self.assertIn("settle", candidate["next_action"].lower())
            if token is not None:
                self.assertEqual(view["change_token"], token)
            token = view["change_token"]
        self.settle(reserved["reservation_id"], "C")
        self.reserve("C", candidate_id="other")
        self.assertEqual(Engine.read(self.run)["tasks"]["C"]["counters"]["review"], 2)
        self.assertIsNone(supervise.task_view(self.run, "C")["integration"]["candidates"]["other"]["waiting"])

    def test_busy_prepared_stage_preserves_binding_until_explicit_unstarted_settlement(self):
        self.adapter("review")
        self.refresh()
        request = self.request("prepare", "C", kind="review", adapter="fixture",
                               target={"head": self.heads["C"]}, evidence=self.proof())
        Engine.apply(self.run, request)
        before = Engine.read(self.run)["tasks"]["C"]
        resume = {"op": "execute", "action_id": request["action_id"], "task_id": "C"}
        self.git("update-ref", "refs/heads/task/C", self.base_oid)
        with patch.object(integration, "refresh", return_value={"status": "busy"}):
            self.assert_error("integration", runner.execute, self.run, resume)
        waiting = supervise.task_view(self.run, "C")["change_token"]
        self.refresh()
        view = supervise.task_view(self.run, "C")
        self.assertNotEqual(view["change_token"], waiting)
        candidate = view["integration"]["candidates"]["branch"]
        self.assertEqual(candidate["waiting"]["status"], "head_changed")
        self.assertIn("settle", candidate["next_action"].lower())
        self.assert_error("integration", runner.execute, self.run, resume)
        self.assertEqual(supervise.task_view(self.run, "C")["change_token"], view["change_token"])
        self.assertEqual(Engine.read(self.run)["tasks"]["C"], before)
        self.assertFalse((self.base / "effects").exists())
        self.apply("finish", "C", operation_id=request["action_id"], status="not_started",
                   receipt={**self.proof(True), "no_effects": True})
        replacement = self.request("execute", "C", kind="review", adapter="fixture",
                                   target={"head": self.base_oid}, evidence=self.proof())
        self.assertEqual(runner.execute(self.run, replacement)["outcome"], "succeeded")
        self.assertEqual((self.base / "effects").read_text().splitlines(), [replacement["action_id"]])
        self.assertEqual(Engine.read(self.run)["tasks"]["C"]["counters"]["review"], 2)

    def test_post_merge_acceptance_runs_with_retired_candidate_and_unavailable_integration(self):
        merge = self.merge_request()
        self.assertEqual(runner.execute(self.run, merge, "worker-a")["outcome"], "succeeded")
        self.adapter("validate")
        config = Engine.read(self.run)["config"]["integration"]
        self.apply("configure", fields={"integration": {**config, "source": str(self.base / "missing-source")}},
                   evidence=self.proof())
        self.refresh()
        before = Engine.read(self.run)
        self.assertFalse(integration.registrations(before)["A"])
        self.assertEqual(before["tasks"]["A"]["merged_prs"]["42"]["head"], self.heads["A"])
        self.assertEqual(self.observation("C")["status"], "unknown")
        request = self.request("execute", "A", kind="validate", adapter="fixture",
                               target={"head": self.heads["A"]}, evidence=self.proof())
        self.assert_error("integration", runner.execute, self.run, request, "worker-a")
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["counters"], before["tasks"]["A"]["counters"])
        scans = Engine.read(self.run)["integration"]["stats"]["scans"]
        request = self.request("execute", "A", kind="validate", purpose="acceptance", adapter="fixture",
                               target={"head": self.heads["A"]}, evidence=self.proof())
        result = supervise.serve(self.run, "worker-a", request)
        self.assertEqual(result["outcome"], "succeeded")
        after = Engine.read(self.run)
        self.assertEqual(after["integration"]["stats"]["scans"], scans)
        self.assertEqual(after["tasks"]["A"]["counters"], {**before["tasks"]["A"]["counters"], "validation": 1})
        payload = json.loads((self.base / "effects.requests").read_text().splitlines()[-1])
        self.assertEqual(payload["purpose"], "acceptance")
        self.assertIsNone(payload["integration"])
        self.assertEqual((self.base / "effects").read_text().splitlines(), [merge["action_id"], request["action_id"]])

    def test_acceptance_without_a_recorded_merge_is_rejected_before_counting_or_dispatch(self):
        self.adapter("validate")
        self.git("update-ref", "-d", "refs/heads/task/C")
        self.refresh()
        before = Engine.read(self.run)
        request = self.request("execute", "C", kind="validate", purpose="acceptance", adapter="fixture",
                               target={"head": self.heads["C"]}, evidence=self.proof())
        with self.assertRaises(integration.StateError) as caught:
            runner.execute(self.run, request)
        self.assertEqual(caught.exception.code, "integration")
        self.assertIn("recorded merge", str(caught.exception))
        after = Engine.read(self.run)
        self.assertEqual(after["tasks"]["C"], before["tasks"]["C"])
        self.assertEqual(after["integration"]["stats"], before["integration"]["stats"])
        self.assertFalse((self.base / "effects").exists())

    def test_busy_waiter_wakes_once_for_changed_head_or_unavailable_candidate(self):
        self.adapter("review")
        for missing in (False, True):
            with self.subTest(missing=missing):
                self.git("update-ref", "refs/heads/task/C", self.heads["C"])
                self.refresh()
                request = self.request("execute", "C", kind="review", adapter="fixture",
                                       target={"head": self.heads["C"]}, evidence=self.proof())
                with patch.object(integration, "refresh", return_value={"status": "busy"}):
                    self.assert_error("integration", runner.execute, self.run, request)
                waiting = supervise.task_view(self.run, "C")["change_token"]
                if missing:
                    self.git("update-ref", "-d", "refs/heads/task/C")
                else:
                    self.git("update-ref", "refs/heads/task/C", self.base_oid)
                self.refresh()
                changed = supervise.task_view(self.run, "C")
                self.assertNotEqual(changed["change_token"], waiting)
                candidate = changed["integration"]["candidates"]["branch"]
                self.assertEqual(candidate["waiting"]["status"], "unknown" if missing else "head_changed")
                self.assertTrue(candidate["next_action"])
                self.refresh()
                self.assertEqual(supervise.task_view(self.run, "C")["change_token"], changed["change_token"])
                self.assertEqual(Engine.read(self.run)["tasks"]["C"]["counters"], {})

    def test_ready_waiter_ignores_clock_expiry_and_unrelated_publication(self):
        self.refresh()
        Engine.wait_for_integration(self.run, {"task_id": "C", "target": {"head": self.heads["C"]}},
                                    "coordinator", Engine.read(self.run)["integration"]["checked_at"])
        self.refresh()
        ready = supervise.task_view(self.run, "C")["change_token"]
        with patch.object(integration, "datetime") as clock:
            clock.now.return_value = datetime.now(timezone.utc) + timedelta(seconds=180)
            self.assertEqual(supervise.task_view(self.run, "C")["change_token"], ready)
        current = Engine.read(self.run)
        integration.invalidate(current, "other_task_published")
        write_atomic(self.run / "state.json", current)
        self.assertEqual(supervise.task_view(self.run, "C")["change_token"], ready)
        self.refresh()
        self.assertEqual(supervise.task_view(self.run, "C")["change_token"], ready)

    def test_successful_unreserved_merge_intent_resolves_its_waiter(self):
        request = self.merge_request()
        reserved = self.reserve("A", "implement")
        self.settle(reserved["reservation_id"], "A")
        self.refresh()
        Engine.wait_for_integration(self.run, {"task_id": "A", "target": request["target"]},
                                    "coordinator", Engine.read(self.run)["integration"]["checked_at"])
        self.refresh()
        self.apply("intent", "A", kind="merge", candidate_id="branch", target=request["target"],
                   gates=request["gates"], refs=request["refs"], evidence=self.proof())
        self.assertNotIn(canonical(["A", "branch"]), Engine.read(self.run)["integration"]["waiters"])

    def test_same_task_candidates_receive_path_and_migration_advice_without_blocking(self):
        for task in ("A", "B"):
            self.git("checkout", "task/" + task)
            (self.repo / "migrations").mkdir(exist_ok=True)
            (self.repo / "migrations" / (task + ".sql")).write_text("-- independent migration\n")
            self.git("add", ".")
            self.git("commit", "-m", "migration")
            self.heads[task] = self.git("rev-parse", "HEAD")
        self.git("checkout", "main")
        for task in ("A", "C"):
            self.apply("candidate", task, candidate={"id": "branch", "ref": "refs/heads/task/" + task, "active": False}, evidence=self.proof())
        self.apply("candidate", "B", candidate={"id": "second", "ref": "refs/heads/task/A", "pr": 13}, evidence=self.proof())
        self.refresh()
        warnings = self.observation("B")["overlaps"]
        self.assertTrue(any(w["kind"] == "path" and w["name"] == "shared.txt" for w in warnings))
        self.assertTrue(any(w["kind"] == "group" and w["name"] == "migrations" for w in warnings))
        self.assertTrue(all(w["owners"] == [["B", "branch"], ["B", "second"]] for w in warnings))
        self.reserve("B", candidate_id="branch")

    def test_partial_observation_failure_preserves_healthy_partner_advice_until_retirement(self):
        self.refresh()
        before = supervise.task_view(self.run, "B")
        self.assertTrue(before["integration"]["candidates"]["branch"]["overlaps"])
        self.git("update-ref", "-d", "refs/heads/task/A")
        for _ in range(2):
            self.refresh()
            failed = supervise.task_view(self.run, "B")
            self.assertEqual(failed["change_token"], before["change_token"])
            advice = failed["integration"]["candidates"]["branch"]
            self.assertTrue(advice["overlaps_stale"])
            self.assertTrue(advice["overlap_evidence"])
        self.git("update-ref", "refs/heads/task/A", self.heads["A"])
        self.refresh()
        restored = supervise.task_view(self.run, "B")
        self.assertEqual(restored["change_token"], before["change_token"])
        self.assertFalse(restored["integration"]["candidates"]["branch"]["overlaps_stale"])
        self.apply("candidate", "A", candidate={"id": "branch", "ref": "refs/heads/task/A", "active": False}, evidence=self.proof())
        self.refresh()
        self.assertEqual(self.observation("B")["overlaps"], [])

    def test_reconciliation_waits_for_the_shared_scan_without_another_probe_or_prompt(self):
        self.refresh()
        supervise.scheduler_patch(self.run, lambda _: {"pending_action_id": "shared-scan-wake"})
        entered, release = threading.Event(), threading.Event()
        original = integration.scan
        outcomes, errors = [], []
        def paused_scan(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise AssertionError("test did not release its scanner")
            return original(*args, **kwargs)
        def scanner():
            try:
                outcomes.append(integration.refresh(self.run))
            except Exception as exc:
                errors.append(exc)
        with patch.object(integration, "scan", side_effect=paused_scan) as scanning:
            thread = threading.Thread(target=scanner)
            thread.start()
            self.assertTrue(entered.wait(5))
            timer = threading.Timer(0.15, release.set)
            timer.start()
            try:
                result = supervise.complete(self.run, "shared-scan-wake")
            finally:
                release.set()
                thread.join(5)
                timer.join(5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(outcomes[0]["status"], "observed")
            self.assertEqual(result["status"], "completed")
            self.assertEqual(scanning.call_count, 1)
        self.assertIsNone(Engine.read(self.run)["scheduler"]["pending_action_id"])

    def test_timed_out_completion_is_resumed_by_scheduler_without_model_prompt(self):
        import fcntl
        self.refresh()
        config = Engine.read(self.run)["config"]["integration"]
        self.apply("configure", fields={"integration": {**config, "timeout_seconds": 0.1}}, evidence=self.proof())
        supervise.scheduler_patch(self.run, lambda _: {"pending_action_id": "timeout-wake"})
        with (self.run / "integration" / "lock").open("r+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(supervise.complete(self.run, "timeout-wake")["status"], "integration_pending")
        self.apply("configure", fields={"integration": config}, evidence=self.proof())
        with patch.object(supervise, "managed_guard"), patch.object(supervise, "herdr_call") as herdr:
            self.assertEqual(supervise.tick(self.run)["status"], "completed")
            herdr.assert_not_called()
        schedule = Engine.read(self.run)["scheduler"]
        self.assertIsNone(schedule["pending_action_id"])
        self.assertIsNone(schedule["integration_completion"])

    def test_expired_scan_preserves_observations_and_waiters_until_scheduler_retries(self):
        original = integration.Git.run
        for boundary in ("--version", "merge-tree"):
            with self.subTest(boundary=boundary):
                self.advance()
                self.refresh()
                self.assertEqual(self.observation("B")["status"], "conflicted")
                Engine.wait_for_integration(self.run, {"task_id": "C", "target": {"head": self.heads["C"]}},
                                            "coordinator", None)
                before = Engine.read(self.run)["integration"]
                token = supervise.task_view(self.run, "C")["change_token"]
                # A new target forces a real probe even with cached pairs.
                target = self.git("commit-tree", self.git("rev-parse", self.heads["A"] + "^{tree}"),
                                  "-p", self.heads["A"], "-m", "advance for " + boundary)
                self.git("update-ref", "refs/heads/main", target)
                wake = "scan-budget-" + boundary
                supervise.scheduler_patch(self.run, lambda _: {"pending_action_id": wake})
                reached = []
                def expire_budget(git, *args, **kwargs):
                    if boundary in args:
                        reached.append(True)
                        git.deadline = 0
                    return original(git, *args, **kwargs)
                with patch.object(integration.Git, "run", expire_budget):
                    self.assertEqual(supervise.complete(self.run, wake)["status"], "integration_pending")
                self.assertTrue(reached)
                after = Engine.read(self.run)
                self.assertEqual(after["integration"], {**before, "pending_refresh": "scan_timeout"})
                self.assertEqual(after["scheduler"]["integration_completion"], wake)
                self.assertEqual(supervise.task_view(self.run, "C")["change_token"], token)
                self.assertFalse(integration.fresh(after))
                self.assert_error("integration", self.reserve, "C")
                self.assertEqual(Engine.read(self.run)["tasks"]["C"]["counters"], {})
                with patch.object(supervise, "managed_guard"), patch.object(supervise, "herdr_call") as herdr:
                    self.assertEqual(supervise.tick(self.run)["status"], "completed")
                    herdr.assert_not_called()
                self.assertEqual(Engine.read(self.run)["integration"]["target"], target)
                self.assertTrue(integration.fresh(Engine.read(self.run)))
                self.assertIsNone(Engine.read(self.run)["scheduler"]["integration_completion"])

    def test_git_process_timeout_is_distinct_from_an_observed_command_failure(self):
        self.refresh()
        git = integration.Git(self.run / "integration", 0.1)
        with self.assertRaises(integration.ProbeTimeout):
            git.run("-c", "alias.delayed=!sleep 5", "delayed")
        git = integration.Git(self.run / "integration", 5)
        with patch.dict(os.environ, {"PATH": str(self.base / "missing-bin")}):
            with self.assertRaisesRegex(integration.ProbeError, "git_unavailable"):
                git.run("--version")

    def test_cache_lock_survives_scanner_death_and_interrupt_reaps_git(self):
        executable = shutil.which("git")
        binaries = self.base / "held-git"
        binaries.mkdir()
        pid_file, entered, release = (self.base / name for name in ("git-pid", "upload-entered", "upload-release"))
        upload = binaries / "upload"
        upload.write_text(f'''#!{sys.executable}
import os, pathlib, sys, time
pathlib.Path({str(entered)!r}).touch()
while not pathlib.Path({str(release)!r}).exists(): time.sleep(0.02)
os.execv({executable!r}, [{executable!r}, "upload-pack", *sys.argv[1:]])
''')
        upload.chmod(0o700)
        shim = binaries / "git"
        shim.write_text(f'''#!{sys.executable}
import os, pathlib, sys
args = sys.argv[1:]
if "fetch" in args:
    pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid()))
    args.insert(args.index("fetch") + 1, "--upload-pack=" + {str(upload)!r})
os.execv({executable!r}, [{executable!r}, *args])
''')
        shim.chmod(0o700)
        for interruption in (signal.SIGKILL, signal.SIGINT):
            with self.subTest(interruption=interruption):
                for path in (pid_file, entered, release):
                    path.unlink(missing_ok=True)
                head = self.git("commit-tree", self.git("rev-parse", self.heads["C"] + "^{tree}"),
                                "-p", self.heads["C"], "-m", "fetch for " + str(interruption))
                self.git("update-ref", "refs/heads/task/C", head)
                child = None
                parent = subprocess.Popen([sys.executable, "-B", str(fixtures.SCRIPTS / "supervise.py"),
                    "integration", "--run-dir", str(self.run)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    env={**os.environ, "PATH": str(binaries) + os.pathsep + os.environ["PATH"]})
                try:
                    deadline = time.monotonic() + 10
                    while not entered.exists() and parent.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertTrue(entered.exists(), "Git did not enter the held fetch")
                    child = int(pid_file.read_text())
                    parent.send_signal(interruption)
                    parent.wait(timeout=5)
                    if interruption == signal.SIGKILL:
                        os.kill(child, 0)
                        self.assertEqual(integration.refresh(self.run)["status"], "busy")
                        release.touch()
                        deadline = time.monotonic() + 10
                        while True:
                            result = integration.refresh(self.run)
                            if result["status"] != "busy" or time.monotonic() >= deadline:
                                break
                            time.sleep(0.02)
                        self.assertEqual(result["status"], "observed")
                    else:
                        with self.assertRaises(ProcessLookupError):
                            os.kill(child, 0)
                        self.assertEqual(integration.refresh(self.run)["status"], "observed")
                    self.assertEqual(self.observation("C")["head"], head)
                finally:
                    release.touch()
                    if parent.poll() is None:
                        parent.kill()
                        parent.wait(timeout=5)
                    if child is not None:
                        try:
                            os.killpg(child, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    parent.stdout.close()
                    parent.stderr.close()

    def test_tick_discards_completion_for_a_manually_cleared_or_replaced_wake(self):
        self.refresh()
        for replacement in (None, "new-wake"):
            with self.subTest(replacement=replacement):
                supervise.scheduler_patch(self.run, lambda _: {"pending_action_id": "old-wake",
                    "integration_completion": "old-wake", "next_due_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()})
                self.apply("scheduler", fields={"pending_action_id": replacement},
                           expected_scheduler=Engine.read(self.run)["scheduler"]["version"])
                with patch.object(supervise, "managed_guard"), patch.object(supervise, "herdr_call") as herdr:
                    result = supervise.tick(self.run)
                    herdr.assert_not_called()
                self.assertEqual(result["status"], "not_due" if replacement is None else "awaiting_reconciliation")
                schedule = Engine.read(self.run)["scheduler"]
                self.assertIsNone(schedule["integration_completion"])
                self.assertEqual(schedule["pending_action_id"], replacement)
                with self.assertRaisesRegex(supervise.RuntimeErrorDetail, "pending wake"):
                    supervise.complete(self.run, "old-wake")

    def test_repeated_timeouts_retain_completion_until_source_recovery(self):
        self.refresh()
        supervise.scheduler_patch(self.run, lambda _: {"pending_action_id": "repeated-timeout"})
        original = integration.Git.run
        def expired(git, *args, **kwargs):
            git.deadline = 0
            return original(git, *args, **kwargs)
        with patch.object(integration.Git, "run", expired):
            first = supervise.complete(self.run, "repeated-timeout")
            self.assertEqual(first["status"], "integration_pending")
            self.assertIn("--bootstrap", first["integration"]["next_action"])
            with patch.object(supervise, "managed_guard"), patch.object(supervise, "herdr_call") as herdr:
                for _ in range(2):
                    self.assertEqual(supervise.tick(self.run)["status"], "integration_pending")
                    self.assertEqual(Engine.read(self.run)["scheduler"]["integration_completion"], "repeated-timeout")
                herdr.assert_not_called()
            self.assert_error("integration", self.reserve, "C")
        with patch.object(supervise, "managed_guard"), patch.object(supervise, "herdr_call") as herdr:
            self.assertEqual(supervise.tick(self.run)["status"], "completed")
            herdr.assert_not_called()
        self.assertTrue(integration.fresh(Engine.read(self.run)))
        self.assertIsNone(Engine.read(self.run)["scheduler"]["integration_completion"])

    def test_source_failure_retains_completion_and_recovers_with_individual_unknowns(self):
        self.advance()
        self.refresh()
        Engine.wait_for_integration(self.run, {"task_id": "C", "target": {"head": self.heads["C"]}},
                                    "coordinator", None)
        ready = supervise.task_view(self.run, "C")["change_token"]
        config = Engine.read(self.run)["config"]["integration"]
        self.apply("configure", fields={"integration": {**config, "source": str(self.base / "missing-source")}},
                   evidence=self.proof())
        supervise.scheduler_patch(self.run, lambda _: {"pending_action_id": "source-failure"})
        result = supervise.complete(self.run, "source-failure")
        self.assertEqual(result["status"], "integration_pending")
        self.assertEqual(result["integration"]["reason"], "scan_failed")
        self.assertTrue(result["integration"]["next_action"])
        failed = Engine.read(self.run)
        self.assertEqual(failed["scheduler"]["integration_completion"], "source-failure")
        self.assertEqual(failed["scheduler"]["pending_action_id"], "source-failure")
        self.assertIsNone(failed["scheduler"].get("last_completed_at"))
        unknown = supervise.task_view(self.run, "C")
        self.assertNotEqual(unknown["change_token"], ready)
        self.assertEqual(unknown["integration"]["candidates"]["branch"]["waiting"]["status"], "unknown")
        with patch.object(supervise, "managed_guard"), patch.object(supervise, "herdr_call") as herdr:
            self.assertEqual(supervise.tick(self.run)["status"], "integration_pending")
            herdr.assert_not_called()
        self.assertEqual(supervise.task_view(self.run, "C")["change_token"], unknown["change_token"])
        self.apply("configure", fields={"integration": config}, evidence=self.proof())
        self.apply("candidate", "A", candidate={"id": "draft", "ref": "refs/heads/unpublished"}, evidence=self.proof())
        with patch.object(supervise, "managed_guard"), patch.object(supervise, "herdr_call") as herdr:
            self.assertEqual(supervise.tick(self.run)["status"], "completed")
            herdr.assert_not_called()
        recovered = Engine.read(self.run)
        self.assertIsNone(recovered["scheduler"]["integration_completion"])
        self.assertEqual(recovered["integration"]["observations"]["A"]["draft"]["status"], "unknown")
        self.assertEqual(self.observation("B")["status"], "conflicted")
        self.assertNotIn("failed_scans", recovered["integration"]["counts"])

    def test_completion_rechecks_whole_scan_failure_at_acknowledgement(self):
        self.refresh()
        supervise.scheduler_patch(self.run, lambda _: {"pending_action_id": "racing-source-failure"})
        refresh, git_run = integration.refresh, integration.Git.run
        def unavailable(git, *args, **kwargs):
            return (1, b"") if "ls-remote" in args else git_run(git, *args, **kwargs)
        def failure_after_clean(*args, **kwargs):
            result = refresh(*args, **kwargs)
            with patch.object(integration.Git, "run", unavailable):
                self.assertEqual(refresh(self.run)["status"], "observed")
            return result
        with patch.object(integration, "refresh", side_effect=failure_after_clean):
            self.assertEqual(supervise.complete(self.run, "racing-source-failure")["status"], "integration_pending")
        self.assertTrue(integration.fresh(Engine.read(self.run)))  # Fresh failure is not a completed target observation.
        self.assertEqual(Engine.read(self.run)["scheduler"]["integration_completion"], "racing-source-failure")
        with patch.object(supervise, "managed_guard"), patch.object(supervise, "herdr_call") as herdr:
            self.assertEqual(supervise.tick(self.run)["status"], "completed")
            herdr.assert_not_called()

    def test_reconciliation_retries_superseded_snapshots_inside_its_time_budget(self):
        original = Engine.publish_integration
        publications = []
        def competing_publication(run_dir, snapshot, report):
            publications.append(True)
            if len(publications) <= 3:
                self.apply("candidate", "C", candidate={"id": "branch", "ref": "refs/heads/task/C", "pr": len(publications)}, evidence=self.proof())
            return original(run_dir, snapshot, report)
        with patch.object(Engine, "publish_integration", side_effect=competing_publication):
            self.assertEqual(supervise.complete(self.run, "manual")["status"], "completed")
        self.assertEqual(len(publications), 4)
        self.assertTrue(integration.fresh(Engine.read(self.run)))

    def test_completion_rechecks_invalidation_after_scan_and_resumes_on_next_tick(self):
        supervise.scheduler_patch(self.run, lambda _: {"pending_action_id": "late-invalidation"})
        refresh = integration.refresh
        def invalidated_after_scan(*args, **kwargs):
            result = refresh(*args, **kwargs)
            self.apply("candidate", "C", candidate={"id": "branch", "ref": "refs/heads/task/C", "pr": 99}, evidence=self.proof())
            return result
        with patch.object(integration, "refresh", side_effect=invalidated_after_scan):
            self.assertEqual(supervise.complete(self.run, "late-invalidation")["status"], "integration_pending")
        self.assertEqual(Engine.read(self.run)["scheduler"]["pending_action_id"], "late-invalidation")
        with patch.object(supervise, "managed_guard"), patch.object(supervise, "herdr_call") as herdr:
            self.assertEqual(supervise.tick(self.run)["status"], "completed")
            herdr.assert_not_called()

    def test_quiet_restricted_watch_exits_on_pipe_and_socket_disconnect_not_request_eof(self):
        self.refresh()
        token = supervise.task_view(self.run, "A", "worker-a")["change_token"]
        request = json.dumps({"op": "watch", "task_id": "A", "after": token, "until_change": True}).encode()
        argv = [sys.executable, "-B", str(fixtures.SCRIPTS / "supervise.py"), "serve", "--run-dir", str(self.run), "--caller", "worker-a"]
        for transport in ("pipe", "socket"):
            with self.subTest(transport=transport):
                parent = child = None
                if transport == "socket":
                    parent, child = socket.socketpair()
                process = subprocess.Popen(argv, stdin=child if child else subprocess.PIPE,
                    stdout=child if child else subprocess.PIPE, stderr=subprocess.PIPE,
                    env={**os.environ, "SSH_ORIGINAL_COMMAND": ""})
                try:
                    if child:
                        child.close()
                        parent.sendall(request)
                        parent.shutdown(socket.SHUT_WR)
                    else:
                        process.stdin.write(request)
                        process.stdin.close()
                    with self.assertRaises(subprocess.TimeoutExpired):
                        process.wait(timeout=0.3)
                    if parent:
                        parent.close()
                    else:
                        process.stdout.close()
                    status = process.wait(timeout=5)
                    stderr = process.stderr.read()
                    self.assertEqual(status, 0, stderr.decode())
                    self.assertEqual(stderr, b"")
                finally:
                    if parent:
                        parent.close()
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)
                    for stream in (process.stdin, process.stdout, process.stderr):
                        if stream:
                            stream.close()

    def legacy_execution(self, issued):
        self.adapter("review")
        self.apply("configure", fields={"integration": {"enabled": False}}, evidence=self.proof())
        refs = {"run_id": "legacy-review", "review_base": self.base_oid}
        self.apply("observe", "C", fields={"refs": refs, "findings": [{"id": "carry", "status": "unresolved"}]}, evidence=self.proof())
        request = self.request("execute" if issued else "prepare", "C", kind="review", adapter="fixture", refs=refs,
                               target={"head": self.heads["C"]}, evidence=self.proof())
        if issued:
            transition = runner.transition
            def interrupted(*args, **kwargs):
                if args[3] == "finish":
                    raise OSError("fixture lost acknowledgement after dispatch")
                return transition(*args, **kwargs)
            with patch.object(runner, "transition", side_effect=interrupted), self.assertRaises(OSError):
                runner.execute(self.run, request)
        else:
            Engine.apply(self.run, request)
        saved = Engine.read(self.run)
        # Representative persisted pre-0.5 shape: no feature configuration,
        # candidates, observation state or per-execution integration bindings.
        saved["config"].pop("integration", None)
        saved.pop("integration", None)
        for task in saved["tasks"].values():
            task.pop("candidates", None)
            for reservation in task["reservations"].values():
                reservation.pop("integration", None)
                reservation.pop("purpose", None)
            pending = task.get("pending_intent")
            if pending:
                pending.pop("integration", None)
                pending.pop("purpose", None)
        write_atomic(self.run / "state.json", saved)
        self.git("remote", "add", "origin", str(self.repo))
        return request, saved["tasks"]["C"]

    def test_adopt_issued_legacy_execution_inspects_without_redispatch_and_keeps_evidence(self):
        request, before = self.legacy_execution(issued=True)
        result = runner.execute(self.run, {"op": "execute", "action_id": request["action_id"], "task_id": "C"})
        self.assertEqual(result["outcome"], "succeeded")
        after = Engine.read(self.run)["tasks"]["C"]
        for field in ("claim", "delegation", "refs", "findings", "counters"):
            self.assertEqual(after[field], before[field])
        self.assertFalse(after["reservations"])
        self.assertIsNone(after["pending_intent"])
        payloads = [json.loads(line) for line in (self.base / "effects.requests").read_text().splitlines()]
        self.assertEqual([p["mode"] for p in payloads], ["dispatch", "inspect"])
        self.assertEqual((self.base / "effects").read_text().splitlines(), [request["action_id"]])
        self.git("update-ref", "-d", "refs/heads/task/C")
        self.assert_error("integration", supervise.apply_request, self.run,
            self.request("reserve", "C", kind="review", unit="review", target={"head": self.heads["C"]}))
        self.assertEqual(Engine.read(self.run)["tasks"]["C"]["counters"], before["counters"])

    def test_adopt_unissued_legacy_preparation_checks_current_target_without_recounting(self):
        request, before = self.legacy_execution(issued=False)
        self.advance()
        result = runner.execute(self.run, {"op": "execute", "action_id": request["action_id"], "task_id": "C"})
        self.assertEqual(result["outcome"], "succeeded")
        after = Engine.read(self.run)["tasks"]["C"]
        for field in ("claim", "delegation", "refs", "findings", "counters"):
            self.assertEqual(after[field], before[field])
        payload = json.loads((self.base / "effects.requests").read_text())
        self.assertEqual(payload["mode"], "dispatch")
        self.assertEqual(payload["integration"]["target"], self.heads["A"])

    def test_adopted_branch_survives_registration_growth_and_bound_dispatch(self):
        self.adapter("review")
        refs = {"run_id": "adopted-review", "review_base": self.base_oid}
        self.apply("observe", "C", fields={"refs": refs, "findings": [{"id": "carry", "status": "unresolved"}]}, evidence=self.proof())
        saved = Engine.read(self.run)
        saved["config"].pop("integration")
        saved.pop("integration")
        for task in saved["tasks"].values():
            task.pop("candidates")
        write_atomic(self.run / "state.json", saved)
        self.git("remote", "add", "origin", str(self.repo))
        self.refresh()
        request = self.request("prepare", "C", kind="review", adapter="fixture", refs=refs,
                               target={"head": self.heads["C"]}, evidence=self.proof())
        Engine.apply(self.run, request)
        before = Engine.read(self.run)["tasks"]["C"]
        self.apply("candidate", "C", candidate={"id": "second", "ref": "refs/heads/task/A"}, evidence=self.proof())
        self.refresh()
        self.assertEqual(set(Engine.read(self.run)["integration"]["observations"]["C"]), {"branch", "second"})
        self.assertEqual(self.observation("C")["head"], self.heads["C"])
        self.assertEqual(runner.execute(self.run, {"op": "execute", "action_id": request["action_id"], "task_id": "C"})["outcome"], "succeeded")
        after = Engine.read(self.run)["tasks"]["C"]
        for field in ("claim", "delegation", "refs", "findings", "counters"):
            self.assertEqual(after[field], before[field])
        payload = json.loads((self.base / "effects.requests").read_text())
        self.assertEqual(payload["operation_id"], request["action_id"])
        self.assertEqual(payload["integration"]["candidate_id"], "branch")
        self.assertEqual(payload["integration"]["head"], self.heads["C"])
        self.assertEqual((self.base / "effects").read_text().splitlines(), [request["action_id"]])

    def test_candidate_materialization_honors_replacement_retirement_and_explicit_empty_map(self):
        saved = Engine.read(self.run)
        for task in ("A", "B"):
            saved["tasks"][task].pop("candidates")
        saved["tasks"]["C"]["candidates"] = {}
        write_atomic(self.run / "state.json", saved)
        self.apply("candidate", "A", candidate={"id": "branch", "ref": "refs/heads/task/B", "pr": 42}, evidence=self.proof())
        self.apply("candidate", "B", candidate={"id": "branch", "ref": "refs/heads/task/B", "active": False}, evidence=self.proof())
        for task in ("B", "C"):
            self.apply("candidate", task, candidate={"id": "second", "ref": "refs/heads/task/A"}, evidence=self.proof())
        self.refresh()
        state = Engine.read(self.run)
        self.assertEqual(state["tasks"]["A"]["candidates"]["branch"], {"ref": "refs/heads/task/B", "pr": 42, "active": True})
        self.assertEqual(self.observation("A")["head"], self.heads["B"])
        self.assertFalse(state["tasks"]["B"]["candidates"]["branch"]["active"])
        self.assertNotIn("branch", state["tasks"]["C"]["candidates"])
        for task in ("B", "C"):
            self.assertEqual(set(state["integration"]["observations"][task]), {"second"})


if __name__ == "__main__":
    unittest.main()
