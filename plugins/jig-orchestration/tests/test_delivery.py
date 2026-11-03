"""Delivery authority and real adapter-process recovery in disposable state."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

import test_state as fixtures
from state import Engine, StateError, execution_guard, write_atomic
SCRIPTS = fixtures.SCRIPTS
import execute as runner
import supervise


class DeliveryTests(unittest.TestCase):
    setUp = fixtures.EngineTests.setUp
    proof = fixtures.EngineTests.proof
    request = fixtures.EngineTests.request
    apply = fixtures.EngineTests.apply
    admit = fixtures.EngineTests.admit
    reserve = fixtures.EngineTests.reserve
    settle = fixtures.EngineTests.settle
    assert_error = fixtures.EngineTests.assert_error

    def adapter(self, kind="implement"):
        script = self.base / "adapter.py"
        script.write_text('''import json, pathlib, sys, time
p = json.load(sys.stdin)
root = pathlib.Path(sys.argv[1])
effect = root / "effects"
target = p["target"]
with (root / "references").open("a") as f: f.write(json.dumps(p["refs"]) + "\\n")
if p["mode"] == "dispatch":
    if target.get("before"):
        (root / "started").write_text("started")
        time.sleep(1)
    if target.get("reject"):
        print(json.dumps({"status": "not_started", "receipt": {"ref": str(effect), "observed_at": "2026-11-03T12:00:00Z", "all_jobs_settled": True, "no_effects": True}}))
        sys.exit(0)
    with effect.open("a") as f: f.write(p["operation_id"] + "\\n")
    if target.get("lost"): sys.exit(17)
    if target.get("malformed"):
        print("not json")
        sys.exit(0)
    if target.get("slow"): time.sleep(5)
done = effect.exists() and p["operation_id"] in effect.read_text().splitlines()
receipt = {"ref": str(effect), "observed_at": "2026-11-03T12:00:00Z", "all_jobs_settled": True,
           "no_effects": not done, **target, "merge_commit": "merged-H", "status": "closed", "unpublished": False,
           "criteria_met": True, "acceptance_ref": "/acceptance"}
print(json.dumps({"status": "succeeded" if done else "not_started", "receipt": receipt}))
''')
        argv = [sys.executable, "-B", str(script), str(self.base)]
        adapter = {"kind": kind, "host": "local", "argv": argv, "inspect_argv": argv, "timeout_seconds": 1}
        self.apply("configure", fields={"adapters": {"test": adapter}}, evidence=self.proof())
        return adapter

    def start(self, kind="implement", **target):
        self.adapter(kind)
        self.admit(acceptance_ref="/acceptance", actions=[kind])
        return self.request("execute", "A", kind=kind, adapter="test", target=target or {"agent": "owned"},
                            refs={}, evidence={**self.proof(True), "criteria_met": True, "acceptance_ref": "/acceptance"})

    def run_action(self, request):
        return runner.execute(self.run, request, "worker-a")

    def resume(self, request):
        return self.run_action({"op": "execute", "action_id": request["action_id"], "task_id": "A"})

    def effects(self):
        path = self.base / "effects"
        return path.read_text().splitlines() if path.exists() else []

    def test_cadence_and_other_task_hold_do_not_interrupt_stale_policy_request(self):
        self.admit(actions=["implement"])
        self.admit("B")
        request = self.request("reserve", "A", kind="implement", unit="implementation", refs={})
        self.apply("configure", fields={"scheduler": {**self.config["scheduler"], "cadence_seconds": 600}}, evidence=self.proof())
        self.apply("control", "B", control="hold", hold_id="deployment", reason="inspect", actions=["deploy"])
        Engine.apply(self.run, request, "worker-a")
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["counters"]["implementation"], 1)

    def test_revoked_action_does_not_return_when_run_authority_restored(self):
        self.admit(actions=["implement", "review"])
        self.apply("configure", fields={"authority": sorted(Engine.ACTIONS - {"implement"})}, evidence=self.proof())
        self.apply("configure", fields={"authority": sorted(Engine.ACTIONS)}, evidence=self.proof())
        self.assert_error("authority", self.reserve, caller="worker-a")
        self.reserve(kind="review", caller="worker-a")

    def test_driver_scope_can_expand_without_interrupting_existing_execution(self):
        self.admit(actions=["implement"])
        reservation = self.reserve(caller="worker-a")
        actors = copy.deepcopy(self.config["actors"])
        actors["worker-a"]["task_ids"].append("B")
        self.apply("configure", fields={"actors": actors}, evidence=self.proof())
        self.settle(reservation["reservation_id"])
        self.reserve(caller="worker-a")

    def test_pending_grant_can_be_narrowed_without_blocking_retained_action(self):
        request = self.start()
        self.apply("delegate", "A", executor="worker-a", actions=["implement", "review"])
        request.update(expected_task=Engine.read(self.run)["tasks"]["A"]["version"])
        Engine.apply(self.run, {**request, "op": "prepare"}, "worker-a")
        self.apply("delegate", "A", executor="worker-a", actions=["implement"])
        self.assertEqual(self.resume(request)["outcome"], "succeeded")

    def test_revoking_all_pending_actions_fences_dispatch_without_erasing_recovery(self):
        request = self.start()
        Engine.apply(self.run, {**request, "op": "prepare"}, "worker-a")
        self.apply("delegate", "A", executor="worker-a", actions=[])
        self.assert_error("authority", self.resume, request)
        task = Engine.read(self.run)["tasks"]["A"]
        self.assertTrue(task["reservations"])
        self.assertFalse(self.effects())
        self.apply("finish", "A", caller="worker-a", operation_id=request["action_id"], status="not_started",
                   receipt={**self.proof(True), "no_effects": True})
        self.assertFalse(Engine.read(self.run)["tasks"]["A"]["reservations"])

    def test_changed_native_identity_revokes_only_affected_grant(self):
        self.admit(actions=["implement"], identity={"native": "old"})
        self.apply("observe", "A", fields={"identity": {"native": "new"}}, evidence=self.proof())
        self.assert_error("authority", self.reserve, caller="worker-a")

    def test_old_grant_keeps_revision_fence_until_renewed(self):
        self.admit()
        # Simulate a saved pre-upgrade run; no runtime migration of old grants.
        from state import write_atomic
        state = Engine.read(self.run)
        state["tasks"]["A"]["delegation"] = {"executor": "worker-a", "actions": ["implement"],
                                               "policy_version": state["policy_version"]}
        write_atomic(self.run / "state.json", state)
        self.apply("control", control="finish_current")
        self.assert_error("authority", self.reserve, caller="worker-a")
        self.apply("delegate", "A", executor="worker-a", actions=["implement"])
        self.reserve(caller="worker-a")

    def test_atomic_prepare_rolls_back_reservation_when_merge_gate_fails(self):
        request = self.start("merge")
        before = Engine.read(self.run)
        self.assert_error("identity", self.run_action, request)
        self.assertEqual(Engine.read(self.run), before)
        self.assertFalse(self.effects())

    def test_prepared_launch_rechecks_pause_budget_and_revocation(self):
        request = self.start()
        Engine.apply(self.run, {**request, "op": "prepare"}, "worker-a")
        self.apply("control", control="pause")
        self.assert_error("paused", self.resume, request)
        self.apply("control", control="resume")
        self.apply("configure", fields={"limits": [{"id": "attempts", "unit": "implementation", "scope": "task", "max": 0, "enforced": True}]}, evidence=self.proof())
        self.assert_error("budget", self.resume, request)
        self.apply("configure", fields={"limits": []}, evidence=self.proof())
        self.apply("configure", fields={"authority": sorted(Engine.ACTIONS - {"implement"})}, evidence=self.proof())
        self.assert_error("authority", self.resume, request)
        self.assertFalse(self.effects())

    def test_caller_ids_cannot_occupy_runner_subrecords(self):
        request = self.start()
        self.admit("B")
        self.apply("observe", "B", fields={"next_action": "private"}, evidence=self.proof(),
                   action_id=request["action_id"] + "/complete")
        self.apply("observe", "B", fields={"next_action": "private"}, evidence=self.proof(),
                   action_id=request["action_id"] + "/dispatch")
        self.assertEqual(self.run_action(request)["outcome"], "succeeded")
        self.assertEqual(self.resume(request)["outcome"], "succeeded")
        self.assertEqual(self.effects(), [request["action_id"]])
        self.assertEqual(Engine.action(self.run, request["action_id"] + "/complete")["request"]["task_id"], "B")
        self.assertEqual(Engine.action(self.run, request["action_id"] + "/complete", runner=True)["request"]["task_id"], "A")

    def test_collision_after_issuance_cannot_prevent_inspection(self):
        request = self.start(lost=True)
        self.run_action(request)
        self.admit("B")
        self.apply("observe", "B", fields={"next_action": "private"}, evidence=self.proof(),
                   action_id=request["action_id"] + "/complete")
        self.assertEqual(self.resume(request)["outcome"], "succeeded")
        self.assertEqual(self.effects(), [request["action_id"]])

    def test_watch_ignores_cadence_and_wakes_for_task_hold(self):
        self.admit(actions=["implement"])
        view = supervise.task_view(self.run, "A", "worker-a")
        self.apply("configure", fields={"scheduler": {**self.config["scheduler"], "cadence_seconds": 300}}, evidence=self.proof())
        self.assertFalse(supervise.watch_task(self.run, "A", view["change_token"], 0, "worker-a")["changed"])
        self.apply("control", "A", control="hold", hold_id="inspect", reason="inspection", actions=["implement"])
        changed = supervise.watch_task(self.run, "A", view["change_token"], 0, "worker-a")
        self.assertTrue(changed["changed"])
        self.assertIn("inspect", changed["task"]["holds"])

    def test_watch_returns_on_state_change_and_rechecks_driver_access(self):
        self.admit(actions=["implement"])
        view = supervise.task_view(self.run, "A", "worker-a")
        def change(_):
            self.apply("observe", "A", fields={"next_action": "ready"}, evidence=self.proof())
        with patch.object(supervise.time, "sleep", side_effect=change):
            self.assertTrue(supervise.watch_task(self.run, "A", view["change_token"], 1, "worker-a")["changed"])
        with self.assertRaises(supervise.RuntimeErrorDetail):
            supervise.watch_task(self.run, "B", view["change_token"], 0, "worker-a")

    def test_driver_completes_tracker_closure_without_coordinator(self):
        request = self.start("close", authority="canonical-ref", task_id="A", owner="tracker-actor")
        result = self.run_action(request)
        self.assertEqual(result["closed"], "A")
        state = Engine.read(self.run)
        self.assertEqual(Engine.summary(state)["done"], ["A"])
        self.assertIsNone(state["tasks"]["A"]["slot"])
        self.assertEqual(self.resume(request), result)
        self.assertEqual(self.effects(), [request["action_id"]])

    def test_driver_advances_whole_delivery_pipeline_after_one_admission(self):
        adapter = self.adapter()
        kinds = ["implement", "review", "push", "pr", "merge", "deploy", "validate", "close"]
        self.apply("configure", fields={"adapters": {kind: {**adapter, "kind": kind} for kind in kinds}}, evidence=self.proof())
        self.admit(acceptance_ref="/acceptance", actions=kinds)
        refs = {"run_id": "review-1", "controller_id": "controller-1", "review_head": "H", "review_base": "B"}
        # All subsequent transitions are made through the driver identity.
        for kind in kinds:
            target, extra = {"head": "H"}, {}
            if kind == "merge":
                self.apply("observe", "A", caller="worker-a", fields={"refs": refs}, evidence=self.proof())
                target = {"repository": str(self.repo), "base": "main", "pr": 12, "head": "H"}
                extra["gates"] = {**{key: True for key in ("complete", "validation", "checks", "feedback", "findings", "target_current", "clean")},
                                  **refs, "checkout_head": "H", "pr_head": "H", "commit_mode": "per-round"}
            if kind == "deploy":
                staging = Engine.read(self.run)["staging"]
                self.apply("staging", "A", caller="worker-a", expected_owner=None, expected_generation=staging["generation"],
                           to_task="A", purpose="acceptance", release_condition="journey settled", evidence=self.proof())
                target = {"environment": "shared-staging", "staging_generation": Engine.read(self.run)["staging"]["generation"]}
            if kind == "close":
                staging = Engine.read(self.run)["staging"]
                self.apply("staging", "A", caller="worker-a", expected_owner="A", expected_generation=staging["generation"],
                           to_task=None, evidence=self.proof(True))
                target = {"authority": "canonical-ref", "task_id": "A", "owner": "tracker-actor"}
            request = self.request("execute", "A", kind=kind, adapter=kind, target=target,
                                   refs=Engine.read(self.run)["tasks"]["A"]["refs"],
                                   evidence={**self.proof(True), "criteria_met": True, "acceptance_ref": "/acceptance"}, **extra)
            with patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": ""}):
                result = supervise.serve(self.run, "worker-a", request)
            self.assertEqual(result["outcome"], "succeeded")
        state = Engine.read(self.run)
        self.assertEqual(Engine.summary(state)["done"], ["A"])
        self.assertEqual(len(self.effects()), len(kinds))
        self.assertEqual(state["tasks"]["A"]["merged_prs"]["12"]["head"], "H")
        self.assertFalse(state["tasks"]["A"]["reservations"])
        self.assertIsNone(state["staging"]["owner"])

    def test_driver_cannot_close_from_a_free_standing_receipt(self):
        self.admit(acceptance_ref="/acceptance", actions=["close"])
        receipt = {**self.proof(True), "authority": "canonical-ref", "task_id": "A", "owner": "tracker-actor",
                   "status": "closed", "unpublished": False, "criteria_met": True, "acceptance_ref": "/acceptance"}
        self.assert_error("closure", self.apply, "close", "A", caller="worker-a", receipt=receipt)

    def test_lost_acknowledgement_is_inspected_once_without_redispatch(self):
        request = self.start(lost=True)
        result = self.run_action(request)
        self.assertEqual(result["outcome"], "unknown")
        task = Engine.read(self.run)["tasks"]["A"]
        self.assertTrue(task["reservations"])
        self.assertIsNotNone(task["slot"])
        self.apply("control", control="pause")
        result = self.resume(request)
        self.assertEqual(result["outcome"], "succeeded")
        self.assertEqual(self.effects(), [request["action_id"]])
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["counters"]["implementation"], 1)
        self.assertFalse(Engine.read(self.run)["tasks"]["A"]["reservations"])

    def test_crash_between_dispatch_record_and_process_launch_never_replays(self):
        request = self.start()
        with patch.object(runner, "invoke", side_effect=RuntimeError("process died")):
            with self.assertRaises(RuntimeError):
                self.run_action(request)
        self.assertEqual(self.resume(request)["outcome"], "not_started")
        self.assertFalse(self.effects())

    def test_coordinator_can_reconcile_issued_work_after_driver_route_is_revoked(self):
        request = self.start(lost=True)
        self.assertEqual(self.run_action(request)["outcome"], "unknown")
        actors = copy.deepcopy(self.config["actors"])
        actors["worker-a"]["helper_route"] = False
        self.apply("configure", fields={"actors": actors}, evidence=self.proof())
        recovery = {"op": "execute", "action_id": request["action_id"], "task_id": "A"}
        self.assert_error("forbidden", self.resume, request)
        result = runner.execute(self.run, recovery)
        self.assertEqual(result["outcome"], "succeeded")
        self.assertEqual(runner.execute(self.run, recovery), result)
        self.assertEqual(self.effects(), [request["action_id"]])

    def test_adapter_keeps_operation_lock_after_runner_is_killed(self):
        request = self.start(before=True)
        command = [sys.executable, "-B", str(SCRIPTS / "supervise.py"), "serve", "--run-dir", str(self.run), "--caller", "worker-a"]
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, env={**os.environ, "SSH_ORIGINAL_COMMAND": ""})
        process.stdin.write(json.dumps(request))
        process.stdin.close()
        process.stdin = None
        try:
            deadline = time.monotonic() + 5
            while not (self.base / "started").exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue((self.base / "started").exists())
            for op in ("finish", "outcome"):
                fields = {"operation_id": request["action_id"]} if op == "finish" else {
                    "intent_id": request["action_id"], "target": request["target"]}
                self.assert_error("execution", self.apply, op, "A", caller="worker-a", status="not_started",
                                  receipt={**self.proof(True), "no_effects": True}, **fields)
            self.assertTrue(Engine.read(self.run)["tasks"]["A"]["reservations"])
            process.kill()
            process.communicate(timeout=5)
            self.assertEqual(self.resume(request)["status"], "busy")
            while time.monotonic() < deadline:
                result = self.resume(request)
                if result.get("status") != "busy":
                    break
                time.sleep(0.02)
            self.assertEqual(result["outcome"], "succeeded")
            self.assertEqual(self.effects(), [request["action_id"]])
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)

    def test_coordinator_cannot_start_a_workers_prepared_action(self):
        request = self.start()
        Engine.apply(self.run, {**request, "op": "prepare"}, "worker-a")
        self.assert_error("authority", runner.execute, self.run,
                          {"op": "execute", "action_id": request["action_id"], "task_id": "A"})
        self.apply("delegate", "A", executor="worker-a", actions=[])
        self.assert_error("forbidden", self.apply, "dispatch", "A", operation_id=request["action_id"])
        with execution_guard(self.run, request["action_id"]) as guard:
            req = self.request("dispatch", "A", operation_id=request["action_id"])
            self.assert_error("forbidden", Engine.apply, self.run, req, execution=guard)
        self.assertFalse(self.effects())

    def test_new_execution_references_reach_dispatch_and_inspection(self):
        request = self.start(lost=True)
        request["refs"] = {"run_id": "new-run", "job": "new-job"}
        self.assertEqual(self.run_action(request)["outcome"], "unknown")
        self.assertEqual(self.resume(request)["outcome"], "succeeded")
        received = [json.loads(line) for line in (self.base / "references").read_text().splitlines()]
        self.assertEqual(received, [request["refs"], request["refs"]])

    def test_task_reference_drift_is_still_fenced(self):
        request = self.start()
        request["refs"] = {"job": "new-job"}
        Engine.apply(self.run, {**request, "op": "prepare"}, "worker-a")
        self.apply("observe", "A", fields={"refs": {"run_id": "new-task-run"}}, evidence=self.proof())
        self.assert_error("identity", self.resume, request)
        self.assertFalse(self.effects())

    def test_issued_runner_outcomes_require_private_execution_guard(self):
        request = self.start(lost=True)
        self.run_action(request)
        before = Engine.read(self.run)
        for caller in ("coordinator", "worker-a"):
            for op in ("finish", "outcome"):
                fields = {"operation_id": request["action_id"]} if op == "finish" else {
                    "intent_id": request["action_id"], "target": request["target"]}
                # JSON fields cannot manufacture the process-local authority.
                req = self.request(op, "A", status="not_started", receipt={**self.proof(True), "no_effects": True},
                                   execution={"active": True}, runner=True, **fields)
                self.assert_error("execution", Engine.apply, self.run, req, caller)
        self.assertEqual(Engine.read(self.run), before)
        self.assertEqual(self.resume(request)["outcome"], "succeeded")

    def test_acceptance_pin_is_required_and_only_coordinator_can_bind_legacy_task(self):
        self.assert_error("closure", self.admit, actions=["close"])
        for reference in ("", [], 42):
            self.assert_error("closure", self.admit, acceptance_ref=reference)
        self.admit()
        self.assert_error("closure", self.apply, "delegate", "A", executor="worker-a", actions=["close"])
        self.assert_error("forbidden", self.apply, "pin_acceptance", "A", caller="worker-a",
                          acceptance_ref="/acceptance", evidence=self.proof())
        self.apply("pin_acceptance", "A", acceptance_ref="/acceptance", evidence=self.proof())
        self.assert_error("closure", self.apply, "pin_acceptance", "A", acceptance_ref="/other", evidence=self.proof())
        self.apply("delegate", "A", executor="worker-a", actions=["close"])

    def test_closure_receipt_cannot_change_authorized_contract(self):
        request = self.start("close", authority="canonical-ref", task_id="A", owner="tracker-actor")
        original = runner.invoke
        def changed(*args):
            result = original(*args)
            result["receipt"]["acceptance_ref"] = "/other"
            return result
        with patch.object(runner, "invoke", side_effect=changed):
            self.assert_error("closure", self.run_action, request)
        self.assertTrue(Engine.read(self.run)["tasks"]["A"]["reservations"])
        self.assertEqual(self.resume(request)["closed"], "A")
        self.assertEqual(self.effects(), [request["action_id"]])

    def test_closure_pending_preserves_success_and_reconciles_without_repeating_effect(self):
        request = self.start("close", authority="canonical-ref", task_id="A", owner="tracker-actor")
        original = runner.invoke
        def held(*args):
            result = original(*args)
            self.apply("control", "A", control="hold", hold_id="acceptance", reason="inspect", actions=["close"])
            return result
        with patch.object(runner, "invoke", side_effect=held):
            result = self.run_action(request)
        self.assertEqual(result["closure_pending"]["code"], "held")
        task = Engine.read(self.run)["tasks"]["A"]
        self.assertEqual(task["last_outcome"]["status"], "succeeded")
        self.assertFalse(task["reservations"])
        self.assertNotEqual(task["phase"], "closed")
        self.assertEqual(self.resume(request), result)
        self.apply("control", "A", control="unhold", hold_id="acceptance")
        self.apply("close", "A", caller="worker-a", receipt=result["receipt"])
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["phase"], "closed")
        self.assertEqual(self.effects(), [request["action_id"]])

    def deferred_closure(self):
        request = self.start("close", authority="canonical-ref", task_id="A", owner="tracker-actor")
        self.apply("delegate", "A", executor="worker-a", actions=["close", "validate", "repair"])
        self.apply("configure", fields={"limits": [
            {"id": "one-close", "unit": "closure", "scope": "task", "max": 1, "enforced": True}
        ]}, evidence=self.proof())
        request["expected_task"] = Engine.read(self.run)["tasks"]["A"]["version"]
        original = runner.invoke
        def held(*args):
            result = original(*args)
            self.apply("control", "A", control="hold", hold_id="acceptance", reason="inspect", actions=["close"])
            return result
        with patch.object(runner, "invoke", side_effect=held):
            result = self.run_action(request)
        self.assertEqual(result["closure_pending"]["code"], "held")
        return request, result

    def reconcile_after_validation(self, caller, legacy=False):
        request, result = self.deferred_closure()
        if legacy:
            state = Engine.read(self.run)
            task = state["tasks"]["A"]
            task.pop("closure_outcome")
            task["last_outcome"].pop("closure_binding")
            write_atomic(self.run / "state.json", state)
        self.adapter("validate")
        validation = self.request("execute", "A", kind="validate", adapter="test", target={"head": "H"},
                                  refs={}, evidence=self.proof())
        self.run_action(validation)
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["last_outcome"]["kind"], "validate")
        self.assert_error("held", self.apply, "close", "A", caller=caller, receipt=result["receipt"])
        self.apply("control", "A", control="unhold", hold_id="acceptance")
        self.assert_error("budget", self.reserve, kind="close", caller="worker-a")
        self.assert_error("closure" if caller != "coordinator" else "budget", self.apply, "close", "A", caller=caller,
                          receipt={**result["receipt"], "ref": "/different-observation"})
        self.apply("control", control="pause")
        self.apply("close", "A", caller=caller, receipt=result["receipt"])
        task = Engine.read(self.run)["tasks"]["A"]
        self.assertEqual(task["phase"], "closed")
        self.assertEqual(task["counters"]["closure"], 1)
        self.assertEqual(self.effects(), [request["action_id"], validation["action_id"]])
        self.assertEqual(self.resume(request), result)

    def test_driver_reconciles_closure_after_validation_with_exhausted_budget(self):
        self.reconcile_after_validation("worker-a")

    def test_coordinator_reconciles_closure_after_validation_with_exhausted_budget(self):
        self.reconcile_after_validation("coordinator")

    def test_legacy_successful_closure_survives_intervening_validation(self):
        self.reconcile_after_validation("worker-a", legacy=True)

    def test_coordinator_can_reconcile_closure_after_driver_route_revocation(self):
        request, result = self.deferred_closure()
        actors = copy.deepcopy(self.config["actors"])
        actors["worker-a"]["helper_route"] = False
        self.apply("configure", fields={"actors": actors}, evidence=self.proof())
        self.apply("control", "A", control="unhold", hold_id="acceptance")
        self.apply("control", control="pause")
        self.apply("close", "A", receipt=result["receipt"])
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["phase"], "closed")
        self.assertEqual(self.effects(), [request["action_id"]])

    def test_source_repair_invalidates_previous_closure_evidence(self):
        _, result = self.deferred_closure()
        self.adapter("repair")
        request = self.request("execute", "A", kind="repair", adapter="test", target={"head": "new"},
                               refs={}, evidence=self.proof())
        self.run_action(request)
        self.apply("control", "A", control="unhold", hold_id="acceptance")
        self.assert_error("closure", self.apply, "close", "A", caller="worker-a", receipt=result["receipt"])
        self.assert_error("budget", self.apply, "close", "A", receipt=result["receipt"])

    def test_reference_change_invalidates_previous_closure_evidence(self):
        _, result = self.deferred_closure()
        self.apply("observe", "A", fields={"refs": {"review_head": "new"}}, evidence=self.proof())
        self.apply("control", "A", control="unhold", hold_id="acceptance")
        self.assert_error("closure", self.apply, "close", "A", caller="worker-a", receipt=result["receipt"])

    def test_reopening_invalidates_previous_closure_evidence(self):
        request = self.start("close", authority="canonical-ref", task_id="A", owner="tracker-actor")
        result = self.run_action(request)
        target = {"authority": "canonical-ref", "owner": "tracker-actor"}
        intent = self.apply("reopen_intent", "A", target=target, evidence=self.proof())["intent"]
        self.apply("reopen_outcome", "A", intent_id=intent["id"], target=target, status="succeeded",
                   receipt={**self.proof(), **target, "task_id": "A", "status": "open", "unpublished": False})
        self.assert_error("closure", self.apply, "close", "A", caller="worker-a", receipt=result["receipt"])
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["phase"], "admitted")

    def test_legacy_completed_receipt_is_replayed_without_another_effect(self):
        import hashlib
        request = self.start()
        result = self.run_action(request)
        operation_id = request["action_id"]
        filename = hashlib.sha256(operation_id.encode()).hexdigest() + ".json"
        prepare = Engine.action(self.run, operation_id)
        prepare["result"]["intent"]["execution"].pop("record_namespace")
        write_atomic(self.run / "actions" / filename, prepare)
        complete_id = operation_id + "/complete"
        filename = hashlib.sha256(complete_id.encode()).hexdigest() + ".json"
        complete = Engine.action(self.run, complete_id, runner=True)
        write_atomic(self.run / "actions" / filename, complete)
        (self.run / "execution-actions" / filename).unlink()
        self.assertEqual(self.resume(request), result)
        self.assertEqual(self.effects(), [operation_id])

    def test_legacy_unknown_operation_ignores_unrelated_completion_collision(self):
        import hashlib
        request = self.start(lost=True)
        request["refs"] = {"job": "legacy-job"}
        self.run_action(request)
        state = Engine.read(self.run)
        saved = state["tasks"]["A"]["pending_intent"]["execution"]
        saved.pop("record_namespace")
        saved["refs"] = saved.pop("task_refs")
        write_atomic(self.run / "state.json", state)
        prepare = Engine.action(self.run, request["action_id"])
        prepare["result"]["intent"]["execution"].pop("record_namespace")
        filename = hashlib.sha256(request["action_id"].encode()).hexdigest() + ".json"
        write_atomic(self.run / "actions" / filename, prepare)
        self.admit("B")
        self.apply("observe", "B", action_id=request["action_id"] + "/complete", fields={"next_action": "unrelated"}, evidence=self.proof())
        self.assertEqual(self.resume(request)["outcome"], "succeeded")
        self.assertEqual(json.loads((self.base / "references").read_text().splitlines()[-1]), request["refs"])
        self.assertEqual(self.effects(), [request["action_id"]])

    def test_crash_after_effect_before_recording_result_is_recovered(self):
        request = self.start()
        original = runner.transition
        def crash(run_dir, caller, task_id, op, action_id, **fields):
            if op == "finish":
                raise OSError("storage unavailable")
            return original(run_dir, caller, task_id, op, action_id, **fields)
        with patch.object(runner, "transition", side_effect=crash):
            with self.assertRaises(OSError):
                self.run_action(request)
        self.assertEqual(self.resume(request)["outcome"], "succeeded")
        self.assertEqual(self.effects(), [request["action_id"]])

    def test_malformed_and_timed_out_adapter_results_retain_ownership(self):
        for field in ("malformed", "slow"):
            with self.subTest(field=field):
                if field == "malformed":
                    request = self.start(**{field: True})
                else:
                    request = self.request("execute", "A", kind="implement", adapter="test", target={field: True}, refs={}, evidence=self.proof())
                self.assertEqual(self.run_action(request)["outcome"], "unknown")
                self.assertEqual(self.resume(request)["outcome"], "succeeded")
        self.assertEqual(len(self.effects()), 2)

    def test_duplicate_cli_requests_execute_only_once(self):
        request = self.start(slow=True)
        command = [sys.executable, "-B", str(SCRIPTS / "supervise.py"), "serve", "--run-dir", str(self.run), "--caller", "worker-a"]
        env = {**os.environ, "SSH_ORIGINAL_COMMAND": ""}
        first = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        second = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        # Give both processes their input before awaiting either.
        for process in (first, second):
            process.stdin.write(json.dumps(request))
            process.stdin.close()
            process.stdin = None
        results = [json.loads(process.communicate(timeout=10)[0]) for process in (first, second)]
        self.assertTrue(any(result.get("status") == "busy" for result in results))
        self.assertEqual(self.effects(), [request["action_id"]])
        self.assertEqual(self.resume(request)["outcome"], "succeeded")

    def test_restricted_route_rejects_wrong_task_and_mutation_of_registered_adapter(self):
        request = self.start()
        self.admit("B")
        self.assert_error("forbidden", self.run_action, {**request, "task_id": "B"})
        Engine.apply(self.run, {**request, "op": "prepare"}, "worker-a")
        adapter = copy.deepcopy(Engine.read(self.run)["config"]["adapters"]["test"])
        adapter["argv"] = ["/bin/false"]
        self.apply("configure", fields={"adapters": {"test": adapter}}, evidence=self.proof())
        self.assert_error("adapter", self.resume, request)
        self.assertFalse(self.effects())


if __name__ == "__main__":
    unittest.main()
