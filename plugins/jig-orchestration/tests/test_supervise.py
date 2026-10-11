"""Runtime checks with isolated state and fake Herdr; never access a live session."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "skills/herdr-orchestrate/scripts"
sys.path.insert(0, str(SCRIPTS))
import supervise as runtime
from state import Engine, StateError


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.run = self.root / "run"
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.now = datetime.now(timezone.utc)
        self.identity = {"name": "coordinator", "agent": "codex", "pane_id": "w1:p1",
                         "terminal_id": "terminal-1",
                         "agent_session": {"agent": "codex", "kind": "session_id", "value": "native-1"}}
        self.config = {
            "repository": {"path": str(self.repo), "target": "main"},
            "scope": {"task_ids": ["A", "B"]},
            "tracker": {"kind": "br", "authority": "fixture-db"},
            "hosts": {"local": {"slots": 2, "worktree_root": str(self.root / "trees"),
                                 "endpoint": {"session": "test-session"}, "roles": ["coordinator"]}},
            "actors": {"worker": {"role": "driver", "task_ids": ["A"], "host": "local", "helper_route": True}},
            "authority": ["implement", "review", "validate", "merge", "close"],
            "scheduler": {"enabled": True, "cadence_seconds": 60, "minimum_cadence_seconds": 60,
                          "session": "test-session", "control_pane_id": "w1:p2", "agent": self.identity},
        }
        Engine.initialize(self.run, self.config)
        self.env = patch.dict(os.environ, {"HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p2"}, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(self.temp.cleanup)

    def response(self, status="idle", identity=None):
        return {"agent": {**(identity or self.identity), "agent_status": status}}

    def schedule(self, **fields):
        return runtime.scheduler_patch(self.run, lambda _: fields)

    def control(self, value):
        state = Engine.read(self.run)
        return Engine.apply(self.run, {"action_id": value, "op": "control", "control": value,
                                     "expected_policy": state["policy_version"]})

    def configure_scheduler(self, settings):
        current = Engine.read(self.run)
        return Engine.apply(self.run, {"op": "configure", "action_id": "config-" + str(current["version"]),
                                      "expected_policy": current["policy_version"],
                                      "fields": {"scheduler": settings},
                                      "evidence": {"ref": "fixture:configuration", "observed_at": self.now.isoformat()}})

    def test_missing_managed_context_never_calls_herdr(self):
        with patch.dict(os.environ, {"HERDR_ENV": ""}), patch.object(runtime, "herdr_call") as call:
            with self.assertRaisesRegex(runtime.RuntimeErrorDetail, "genuine"):
                runtime.tick(self.run, self.now)
        call.assert_not_called()
        self.assertNotIn("pending_action_id", Engine.read(self.run)["scheduler"])

    def test_wrong_control_pane_and_self_target_are_rejected(self):
        with patch.dict(os.environ, {"HERDR_PANE_ID": "w9:p9"}), patch.object(runtime, "herdr_call") as call:
            with self.assertRaisesRegex(runtime.RuntimeErrorDetail, "registered scheduler"):
                runtime.tick(self.run, self.now)
        call.assert_not_called()
        self.config["scheduler"]["control_pane_id"] = "w1:p1"
        with self.assertRaisesRegex(runtime.RuntimeErrorDetail, "differ"):
            runtime.scheduler_config(self.config)

    def test_native_replacement_blocks_delivery(self):
        changed = {**self.identity, "agent_session": {**self.identity["agent_session"], "value": "replacement"}}
        with patch.object(runtime, "herdr_call", return_value=self.response(identity=changed)) as call:
            result = runtime.tick(self.run, self.now)
        self.assertEqual(result["status"], "endpoint_unavailable")
        self.assertEqual(call.call_count, 1)
        self.assertNotIn("pending_action_id", Engine.read(self.run)["scheduler"])

    def test_blocked_and_unknown_coordinator_raise_health_failure(self):
        for status in ("blocked", "unknown", None):
            with self.subTest(status=status):
                self.schedule(last_attempt_at=None, next_due_at=None)
                with patch.object(runtime, "herdr_call", return_value=self.response(status)) as call:
                    result = runtime.tick(self.run, self.now)
                self.assertEqual(result["status"], "endpoint_unavailable")
                self.assertEqual(call.call_count, 1)
                health = runtime.health(self.run, self.now)
                self.assertEqual(health["status"], "unhealthy")
                self.assertIn("w1:p1", health["failure"]["reason"])

    def test_changed_prompt_response_keeps_delivery_unconfirmed(self):
        changed = {**self.identity, "agent_session": {**self.identity["agent_session"], "value": "other-native"}}
        with patch.object(runtime, "herdr_call", side_effect=[self.response(), self.response(identity=changed)]) as call:
            result = runtime.tick(self.run, self.now)
        self.assertEqual(call.call_args.args[1][2], "w1:p1")
        self.assertEqual(result["status"], "delivery_unconfirmed")
        self.assertEqual(Engine.read(self.run)["scheduler"]["pending_action_id"], result["wake_id"])

    def test_concurrent_scheduler_rebind_cannot_dispatch_old_endpoint(self):
        def change_binding(settings, args):
            self.schedule(enabled=False)
            current = Engine.read(self.run)
            Engine.apply(self.run, {"op": "configure", "action_id": "new-endpoint",
                         "expected_policy": current["policy_version"],
                         "fields": {"scheduler": {**self.config["scheduler"], "session": "new-session"}},
                         "evidence": {"ref": "fixture:authorized-rebind", "observed_at": self.now.isoformat()}})
            self.schedule(enabled=True)
            return self.response()
        with patch.object(runtime, "herdr_call", side_effect=change_binding) as call:
            with self.assertRaisesRegex(runtime.RuntimeErrorDetail, "configuration changed"):
                runtime.tick(self.run, self.now)
        self.assertEqual(call.call_count, 1)
        self.assertNotIn("pending_action_id", Engine.read(self.run)["scheduler"])

    def test_uncertain_delivery_is_not_repeated(self):
        with patch.object(runtime, "herdr_call", side_effect=[self.response(), subprocess.TimeoutExpired("fake", 25)]) as call:
            first = runtime.tick(self.run, self.now)
            second = runtime.tick(self.run, self.now + timedelta(hours=2))
        self.assertEqual(first["status"], "delivery_unconfirmed")
        self.assertEqual(second["status"], "awaiting_reconciliation")
        self.assertEqual(call.call_count, 2)
        runtime.complete(self.run, first["wake_id"], self.now + timedelta(hours=2))
        self.assertIsNone(Engine.read(self.run)["scheduler"]["pending_action_id"])

    def test_busy_is_not_completion_and_minimum_cadence_holds(self):
        runtime.request_wake(self.run, now=self.now)
        with patch.object(runtime, "herdr_call", return_value=self.response("working")) as call:
            self.assertEqual(runtime.tick(self.run, self.now)["status"], "busy")
            self.assertEqual(runtime.tick(self.run, self.now + timedelta(seconds=1))["status"], "minimum_cadence")
        self.assertEqual(call.call_count, 1)
        self.assertNotIn("last_completed_at", Engine.read(self.run)["scheduler"])

    def test_busy_timeout_survives_ticks_and_deduplicates_until_completion(self):
        self.configure_scheduler({**self.config["scheduler"], "busy_timeout_seconds": 180,
                                  "notifier_argv": ["/bin/true"], "notification_authorized": True})
        accepted = subprocess.CompletedProcess(["/bin/true"], 0)
        with patch.object(runtime, "herdr_call", return_value=self.response("working")) as herdr:
            for elapsed in (0, 60, 120):
                at = self.now + timedelta(seconds=elapsed)
                self.assertEqual(runtime.tick(self.run, at)["status"], "busy")
                self.assertEqual(runtime.health(self.run, at)["status"], "healthy")
            with patch.object(runtime.subprocess, "run", return_value=accepted) as notify:
                first = None
                for elapsed in (180, 240, 300):
                    at = self.now + timedelta(seconds=elapsed)
                    runtime.tick(self.run, at)
                    result = runtime.health(self.run, at)
                    self.assertEqual(result["status"], "unhealthy")
                    if first is None:
                        first = result
                        self.assertEqual(result["alert"], "transport_accepted")
                    else:
                        self.assertEqual(result["failure"]["id"], first["failure"]["id"])
                        self.assertEqual(result["alert"], "already_attempted")
                self.assertEqual(notify.call_count, 1)
            self.assertTrue(all(call.args[1][1] == "get" for call in herdr.call_args_list))
        runtime.complete(self.run, "manual", self.now + timedelta(seconds=301))
        self.assertEqual(runtime.health(self.run, self.now + timedelta(seconds=301))["status"], "healthy")
        self.assertIsNone(Engine.read(self.run)["scheduler"]["busy_since_at"])
        with patch.object(runtime, "herdr_call", return_value=self.response()):
            self.assertEqual(runtime.tick(self.run, self.now + timedelta(seconds=361))["status"], "delivered")

    def test_busy_timeout_configuration_and_manual_completion_race(self):
        settings = runtime.scheduler_config(self.config)
        self.assertEqual(settings["busy_timeout_seconds"], 180)
        self.assertEqual(runtime.scheduler_config({"scheduler": {**self.config["scheduler"],
                         "minimum_cadence_seconds": 240}})["busy_timeout_seconds"], 720)
        for value in (0, -1, True, float("inf"), "180"):
            with self.assertRaises((StateError, ValueError)):
                self.configure_scheduler({**self.config["scheduler"], "busy_timeout_seconds": value})
            with self.assertRaises(runtime.RuntimeErrorDetail):
                runtime.scheduler_config({"scheduler": {**self.config["scheduler"], "busy_timeout_seconds": value}})
        def lookup(settings, args):
            runtime.complete(self.run, "manual", self.now + timedelta(seconds=1))
            return self.response("working")
        with patch.object(runtime, "herdr_call", side_effect=lookup):
            runtime.tick(self.run, self.now)
        schedule = Engine.read(self.run)["scheduler"]
        self.assertEqual(schedule["delivery_status"], "completed")
        self.assertIsNone(schedule["busy_since_at"])

    def test_busy_health_honors_custom_timeout_and_scheduler_stop(self):
        self.configure_scheduler({**self.config["scheduler"], "busy_timeout_seconds": 600})
        with patch.object(runtime, "herdr_call", return_value=self.response("working")):
            runtime.tick(self.run, self.now)
            runtime.tick(self.run, self.now + timedelta(seconds=599))
        self.assertEqual(runtime.health(self.run, self.now + timedelta(seconds=599))["status"], "healthy")
        self.control("pause")
        self.assertEqual(runtime.health(self.run, self.now + timedelta(seconds=600))["status"], "unhealthy")
        self.schedule(enabled=False)
        self.assertEqual(runtime.health(self.run, self.now + timedelta(seconds=600))["status"], "scheduler_stopped")

    def test_manual_full_pass_consumes_catchup(self):
        runtime.request_wake(self.run, now=self.now)
        runtime.complete(self.run, "manual", self.now)
        with patch.object(runtime, "herdr_call") as call:
            result = runtime.tick(self.run, self.now + timedelta(seconds=5))
        self.assertEqual(result["status"], "minimum_cadence")
        call.assert_not_called()
        schedule = Engine.read(self.run)["scheduler"]
        self.assertIsNone(schedule["wake_requested_at"])
        self.assertEqual(runtime.parse_time(schedule["next_due_at"]), self.now + timedelta(seconds=60))

    def test_manual_completion_during_lookup_suppresses_obsolete_wake(self):
        runtime.request_wake(self.run, now=self.now)
        completed_at = self.now + timedelta(seconds=2)
        def lookup(settings, args):
            runtime.complete(self.run, "manual", completed_at)
            return self.response()
        with patch.object(runtime, "herdr_call", side_effect=lookup) as call:
            result = runtime.tick(self.run, self.now)
        self.assertEqual(result["status"], "reconciliation_completed")
        self.assertEqual(call.call_count, 1)
        schedule = Engine.read(self.run)["scheduler"]
        self.assertIsNone(schedule["pending_action_id"])
        self.assertIsNone(schedule["wake_requested_at"])
        self.assertEqual(runtime.parse_time(schedule["next_due_at"]), completed_at + timedelta(seconds=60))
        with patch.object(runtime, "herdr_call", return_value=self.response()) as call:
            self.assertEqual(runtime.tick(self.run, completed_at + timedelta(seconds=30))["status"], "minimum_cadence")
            call.assert_not_called()
            self.assertEqual(runtime.tick(self.run, completed_at + timedelta(seconds=60))["status"], "delivered")

    def test_event_wake_respects_completed_pass_minimum_but_can_advance_normal_cadence(self):
        self.configure_scheduler({**self.config["scheduler"], "cadence_seconds": 120})
        runtime.complete(self.run, "manual", self.now)
        runtime.request_wake(self.run, now=self.now + timedelta(seconds=1))
        with patch.object(runtime, "herdr_call", return_value=self.response()) as call:
            self.assertEqual(runtime.tick(self.run, self.now + timedelta(seconds=1))["status"], "minimum_cadence")
            self.assertEqual(runtime.tick(self.run, self.now + timedelta(seconds=59))["status"], "minimum_cadence")
            call.assert_not_called()
            delivered = runtime.tick(self.run, self.now + timedelta(seconds=60))
            self.assertEqual(delivered["status"], "delivered")
            self.assertEqual(call.call_count, 2)
        # Automatic completion also anchors the minimum interval for later events.
        runtime.complete(self.run, delivered["wake_id"], self.now + timedelta(seconds=90))
        runtime.request_wake(self.run, now=self.now + timedelta(seconds=91))
        with patch.object(runtime, "herdr_call", return_value=self.response()) as call:
            self.assertEqual(runtime.tick(self.run, self.now + timedelta(seconds=120))["status"], "minimum_cadence")
            call.assert_not_called()
            self.assertEqual(runtime.tick(self.run, self.now + timedelta(seconds=150))["status"], "delivered")

    def test_idle_heartbeats_are_bounded_and_health_tracks_liveness(self):
        runtime.complete(self.run, "manual", self.now)
        before = Engine.read(self.run)
        records = set((self.run / "actions").iterdir())
        with patch.object(runtime, "herdr_call") as call:
            for seconds in range(5, 60, 5):
                self.assertEqual(runtime.tick(self.run, self.now + timedelta(seconds=seconds))["status"], "minimum_cadence")
        call.assert_not_called()
        after = Engine.read(self.run)
        self.assertEqual(after["version"], before["version"])
        self.assertEqual(after["scheduler"]["version"], before["scheduler"]["version"])
        self.assertEqual(set((self.run / "actions").iterdir()), records)
        self.assertEqual(runtime.parse_time(after["scheduler"]["heartbeat_at"]), self.now + timedelta(seconds=55))
        self.assertEqual(runtime.health(self.run, self.now + timedelta(seconds=170))["status"], "healthy")
        overdue = runtime.health(self.run, self.now + timedelta(seconds=176))
        self.assertEqual(overdue["status"], "unhealthy")
        self.assertIn("heartbeat", overdue["failure"]["reason"])

    def test_pending_wake_heartbeats_stay_bounded_and_do_not_hide_overdue_delivery(self):
        with patch.object(runtime, "herdr_call", return_value=self.response()) as call:
            first = runtime.tick(self.run, self.now)
            records = set((self.run / "actions").iterdir())
            for seconds in (5, 60, 121):
                self.assertEqual(runtime.tick(self.run, self.now + timedelta(seconds=seconds))["status"],
                                 "awaiting_reconciliation")
        self.assertEqual(call.call_count, 2)
        self.assertEqual(set((self.run / "actions").iterdir()), records)
        overdue = runtime.health(self.run, self.now + timedelta(seconds=121))
        self.assertEqual(overdue["failure"]["id"], "pending-" + first["wake_id"])

    def test_configure_enablement_controls_delivery_and_scheduler_stop_can_resume(self):
        self.configure_scheduler({**self.config["scheduler"], "enabled": False})
        with patch.object(runtime, "herdr_call") as call:
            self.assertEqual(runtime.tick(self.run, self.now)["status"], "scheduler_stopped")
            self.assertEqual(runtime.supervise(self.run)["status"], "scheduler_stopped")
            self.assertEqual(runtime.health(self.run, self.now)["status"], "scheduler_stopped")
        call.assert_not_called()
        self.configure_scheduler(self.config["scheduler"])
        with patch.object(runtime, "herdr_call", return_value=self.response()):
            self.assertEqual(runtime.tick(self.run, self.now)["status"], "delivered")
        self.schedule(enabled=False)
        self.assertFalse(Engine.read(self.run)["config"]["scheduler"]["enabled"])
        self.schedule(enabled=True)
        self.assertTrue(Engine.read(self.run)["config"]["scheduler"]["enabled"])
        # Resuming never replays an already delivered wake.
        with patch.object(runtime, "herdr_call") as call:
            self.assertEqual(runtime.tick(self.run, self.now)["status"], "awaiting_reconciliation")
        call.assert_not_called()

    def test_enablement_requires_identity_through_both_state_entrypoints(self):
        self.schedule(enabled=False)
        self.configure_scheduler({"enabled": False})
        before = Engine.read(self.run)
        with self.assertRaisesRegex(StateError, "scheduler.session"):
            self.schedule(enabled=True)
        with self.assertRaisesRegex(StateError, "scheduler.session"):
            self.configure_scheduler({"enabled": True})
        self.assertEqual(Engine.read(self.run), before)
        self.configure_scheduler(self.config["scheduler"])
        with patch.object(runtime, "herdr_call", return_value=self.response()):
            self.assertEqual(runtime.tick(self.run, self.now)["status"], "delivered")

    def test_fast_completion_not_overwritten_by_delivery_ack(self):
        def fake_call(settings, args):
            if args[1] == "get":
                return self.response()
            wake = Engine.read(self.run)["scheduler"]["pending_action_id"]
            runtime.complete(self.run, wake, self.now)
            return self.response()
        with patch.object(runtime, "herdr_call", side_effect=fake_call):
            runtime.tick(self.run, self.now)
        schedule = Engine.read(self.run)["scheduler"]
        self.assertIsNone(schedule["pending_action_id"])
        self.assertEqual(schedule["delivery_status"], "completed")
        self.assertEqual(schedule["last_delivered_action_id"], schedule["last_completed_action_id"])
        self.assertEqual(runtime.parse_time(schedule["last_delivered_at"]), self.now)
        self.assertEqual(runtime.parse_time(schedule["last_completed_at"]), self.now)

    def test_delivery_ack_after_manual_completion_retains_both_observations(self):
        def fake_call(settings, args):
            if args[1] == "prompt":
                runtime.complete(self.run, "manual", self.now + timedelta(seconds=1))
            return self.response()
        with patch.object(runtime, "herdr_call", side_effect=fake_call):
            wake = runtime.tick(self.run, self.now)["wake_id"]
        schedule = Engine.read(self.run)["scheduler"]
        self.assertEqual(schedule["last_delivered_action_id"], wake)
        self.assertEqual(runtime.parse_time(schedule["last_delivered_at"]), self.now)
        self.assertTrue(schedule["last_completed_action_id"].startswith("manual-"))
        self.assertEqual(schedule["delivery_status"], "completed")
        self.assertIsNone(schedule["pending_action_id"])
        before = Engine.read(self.run)
        runtime.complete(self.run, wake, self.now + timedelta(seconds=2))
        self.assertEqual(Engine.read(self.run), before)

    def test_consumed_wake_completion_preserves_later_manual_pass_and_new_pending_wake(self):
        with patch.object(runtime, "herdr_call", return_value=self.response()):
            first = runtime.tick(self.run, self.now)["wake_id"]
        runtime.complete(self.run, "manual", self.now + timedelta(seconds=1))
        runtime.complete(self.run, "manual", self.now + timedelta(seconds=2))
        before = Engine.read(self.run)
        runtime.complete(self.run, first, self.now + timedelta(seconds=3))
        self.assertEqual(Engine.read(self.run), before)
        with patch.object(runtime, "herdr_call", return_value=self.response()):
            second = runtime.tick(self.run, self.now + timedelta(seconds=62))["wake_id"]
        before = Engine.read(self.run)
        runtime.complete(self.run, first, self.now + timedelta(seconds=63))
        self.assertEqual(Engine.read(self.run), before)
        with self.assertRaises(runtime.RuntimeErrorDetail) as error:
            runtime.complete(self.run, "unknown", self.now + timedelta(seconds=63))
        self.assertEqual(error.exception.code, "wrong_wake")
        self.assertEqual(Engine.read(self.run), before)
        runtime.complete(self.run, second, self.now + timedelta(seconds=64))
        schedule = Engine.read(self.run)["scheduler"]
        self.assertIsNone(schedule["pending_action_id"])
        self.assertEqual(schedule["last_completed_wake_id"], second)
        self.assertEqual(schedule["last_completed_action_id"], second)

    def test_late_delivery_ack_cannot_replace_a_newer_wake_or_timestamp(self):
        later = self.now + timedelta(seconds=60)
        def fake_call(settings, args):
            if args[1] == "prompt":
                runtime.complete(self.run, "manual", self.now)
                self.schedule(last_dispatched_action_id="newer", pending_action_id="newer",
                              delivery_status="delivered", last_delivered_action_id="newer",
                              last_delivered_at=runtime.timestamp(later))
            return self.response()
        with patch.object(runtime, "herdr_call", side_effect=fake_call):
            runtime.tick(self.run, self.now)
        schedule = Engine.read(self.run)["scheduler"]
        self.assertEqual(schedule["last_delivered_action_id"], "newer")
        self.assertEqual(schedule["pending_action_id"], "newer")
        self.assertEqual(runtime.parse_time(schedule["last_delivered_at"]), later)

    def test_pause_keeps_supervision_but_scheduler_stop_prevents_delivery(self):
        self.control("pause")
        with patch.object(runtime, "herdr_call", return_value=self.response()) as call:
            self.assertEqual(runtime.tick(self.run, self.now)["status"], "delivered")
        self.assertEqual(call.call_count, 2)
        self.schedule(enabled=False)
        with patch.object(runtime, "herdr_call") as call:
            self.assertEqual(runtime.tick(self.run, self.now)["status"], "scheduler_stopped")
        call.assert_not_called()

    def test_health_without_notifier_reports_local_evidence(self):
        self.control("pause")
        with patch.object(runtime, "herdr_call") as call:
            result = runtime.health(self.run, self.now)
        self.assertEqual(result["alert"], "local_evidence_only")
        call.assert_not_called()

    def test_notification_authorization_is_required(self):
        self.config["scheduler"]["notifier_argv"] = ["/bin/true"]
        with self.assertRaisesRegex(runtime.RuntimeErrorDetail, "authorization"):
            runtime.scheduler_config(self.config)

    def test_health_alert_is_durable_and_deduplicated(self):
        other = self.root / "alerts"
        self.config["scheduler"].update(notifier_argv=["/bin/true"], notification_authorized=True)
        Engine.initialize(other, self.config)
        fake = subprocess.CompletedProcess(["/bin/true"], 0)
        with patch.object(runtime.subprocess, "run", return_value=fake) as call:
            first = runtime.health(other, self.now)
            second = runtime.health(other, self.now)
        self.assertEqual(first["alert"], "transport_accepted")
        self.assertEqual(second["alert"], "already_attempted")
        self.assertEqual(call.call_count, 1)
        self.assertEqual(Engine.read(other)["scheduler"]["last_alert"]["status"], "transport_accepted")

    def test_endpoint_alert_deduplicates_one_incident_and_recovers_between_health_polls(self):
        notifier = self.root / "notifier"
        notices = self.root / "notices"
        notifier.write_text('#!/bin/sh\ncat >> "' + str(notices) + '"\n')
        notifier.chmod(0o755)
        self.configure_scheduler({**self.config["scheduler"], "notifier_argv": [str(notifier)],
                                  "notification_authorized": True})
        def tick(status, seconds):
            with patch.object(runtime, "herdr_call", return_value=self.response(status)):
                return runtime.tick(self.run, self.now + timedelta(seconds=seconds))
        first = tick("blocked", 0)["failure"]
        self.assertEqual(runtime.health(self.run, self.now)["alert"], "transport_accepted")
        repeated = tick("blocked", 60)["failure"]
        self.assertEqual(repeated["id"], first["id"])
        self.assertEqual(repeated["at"], first["at"])
        self.assertEqual(runtime.health(self.run, self.now + timedelta(seconds=60))["alert"], "already_attempted")
        self.assertEqual(tick("working", 120)["status"], "busy")
        self.assertIsNone(Engine.read(self.run)["scheduler"]["failure"])
        second = tick("blocked", 180)["failure"]
        self.assertNotEqual(second["id"], first["id"])
        self.assertEqual(runtime.health(self.run, self.now + timedelta(seconds=180))["alert"], "transport_accepted")
        wake = tick("idle", 240)["wake_id"]
        runtime.complete(self.run, wake, self.now + timedelta(seconds=241))
        third = tick("blocked", 301)["failure"]
        self.assertNotIn(third["id"], (first["id"], second["id"]))
        self.assertEqual(runtime.health(self.run, self.now + timedelta(seconds=301))["alert"], "transport_accepted")
        received = [json.loads(line)["failure"]["id"] for line in notices.read_text().splitlines()]
        self.assertEqual(received, [first["id"], second["id"], third["id"]])

    def test_manual_completion_preserves_endpoint_incident_and_notification_history(self):
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                run = self.root / ("legacy-outage" if legacy else "outage")
                config = {**self.config, "scheduler": {**self.config["scheduler"],
                          "notifier_argv": ["/bin/true"], "notification_authorized": True}}
                Engine.initialize(run, config)
                with patch.object(runtime, "herdr_call", return_value=self.response("blocked")), \
                        patch.object(runtime.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as notify:
                    failure = runtime.tick(run, self.now)["failure"]
                    if legacy:
                        failure = {"id": "endpoint-coordinator_blocked", "at": failure["at"], "reason": failure["reason"]}
                        runtime.scheduler_patch(run, lambda _: {"failure": failure})
                    self.assertEqual(runtime.health(run, self.now)["alert"], "transport_accepted")
                    alert = Engine.read(run)["scheduler"]["last_alert"]
                    runtime.complete(run, "manual", self.now + timedelta(seconds=1))
                    self.assertEqual(Engine.read(run)["scheduler"]["failure"], failure)
                    self.assertEqual(runtime.health(run, self.now + timedelta(seconds=1))["alert"], "already_attempted")
                    repeated = runtime.tick(run, self.now + timedelta(seconds=61))["failure"]
                    self.assertEqual(repeated["id"], failure["id"])
                    runtime.complete(run, "manual", self.now + timedelta(seconds=62))
                    repeated = runtime.tick(run, self.now + timedelta(seconds=122))["failure"]
                    self.assertEqual(repeated["id"], failure["id"])
                    self.assertEqual(runtime.health(run, self.now + timedelta(seconds=122))["alert"], "already_attempted")
                    self.assertEqual(Engine.read(run)["scheduler"]["last_alert"], alert)
                    self.assertEqual(notify.call_count, 1)

    def test_verified_endpoint_recovery_survives_manual_completion_during_lookup(self):
        for status in ("working", "idle", "done"):
            with self.subTest(status=status):
                run = self.root / ("recovered-" + status)
                Engine.initialize(run, self.config)
                runtime.scheduler_patch(run, lambda _: {"failure": {
                    "id": "endpoint-outage", "code": "coordinator_blocked", "at": runtime.timestamp(self.now)}})
                def lookup(settings, args):
                    self.assertEqual(args[1], "get")
                    runtime.complete(run, "manual", self.now + timedelta(seconds=1))
                    return self.response(status)
                with patch.object(runtime, "herdr_call", side_effect=lookup) as call:
                    result = runtime.tick(run, self.now)
                self.assertEqual(call.call_count, 1)
                self.assertEqual(result["status"], "busy" if status == "working" else "reconciliation_completed")
                schedule = Engine.read(run)["scheduler"]
                self.assertIsNone(schedule["failure"])
                self.assertIsNone(schedule.get("pending_action_id"))
                self.assertEqual(schedule["delivery_status"], "completed")
                self.assertEqual(runtime.health(run, self.now + timedelta(seconds=1))["status"], "healthy")

    def test_health_notifier_nonstart_retries_after_repair_with_backoff(self):
        notifier = self.root / "notifier"
        delivered = self.root / "delivered"
        self.configure_scheduler({**self.config["scheduler"], "notifier_argv": [str(notifier)],
                                  "notification_authorized": True})
        first = runtime.health(self.run, self.now)
        self.assertEqual(first["alert"], "not_started")
        self.assertEqual(first["receipt"]["error"], "FileNotFoundError")
        notifier.write_text('#!/bin/sh\ncat > "' + str(delivered) + '"\n')
        notifier.chmod(0o755)
        self.assertEqual(runtime.health(self.run, self.now + timedelta(seconds=1))["alert"], "retry_pending")
        self.assertFalse(delivered.exists())
        sent = runtime.health(self.run, self.now + timedelta(seconds=60))
        self.assertEqual(sent["alert"], "transport_accepted")
        self.assertEqual(sent["receipt"]["attempts"], 2)
        self.assertEqual(json.loads(delivered.read_text())["failure"]["id"], first["failure"]["id"])
        self.assertEqual(runtime.health(self.run, self.now + timedelta(seconds=120))["alert"], "already_attempted")

    def test_health_notifier_nonstart_retry_budget_is_bounded(self):
        notifier = self.root / "not-executable"
        notifier.write_text("#!/bin/sh\nexit 0\n")
        notifier.chmod(0o644)
        self.configure_scheduler({**self.config["scheduler"], "notifier_argv": [str(notifier)],
                                  "notification_authorized": True})
        for attempt in range(1, 4):
            result = runtime.health(self.run, self.now + timedelta(seconds=(attempt - 1) * 60))
            self.assertEqual(result["alert"], "not_started")
            self.assertEqual(result["receipt"]["error"], "PermissionError")
            self.assertEqual(result["receipt"]["attempts"], attempt)
        self.assertEqual(runtime.health(self.run, self.now + timedelta(seconds=180))["alert"], "retry_exhausted")
        self.assertEqual(Engine.read(self.run)["scheduler"]["last_alert"]["attempts"], 3)

    def test_health_never_replays_a_notifier_that_may_have_sent(self):
        notifier = self.root / "notifier"
        delivered = self.root / "delivered"
        notifier.write_text('#!/bin/sh\ncat >> "' + str(delivered) + '"\nexit 1\n')
        notifier.chmod(0o755)
        self.configure_scheduler({**self.config["scheduler"], "notifier_argv": [str(notifier)],
                                  "notification_authorized": True})
        self.assertEqual(runtime.health(self.run, self.now)["alert"], "transport_failed")
        first = delivered.read_bytes()
        self.assertEqual(runtime.health(self.run, self.now + timedelta(seconds=60))["alert"], "already_attempted")
        self.assertEqual(delivered.read_bytes(), first)
        self.schedule(alerted_failure_id=None)
        with patch.object(runtime.subprocess, "run", side_effect=subprocess.TimeoutExpired("notifier", 20)) as call:
            self.assertEqual(runtime.health(self.run, self.now)["alert"], "transport_unconfirmed")
            self.assertEqual(runtime.health(self.run, self.now + timedelta(seconds=60))["alert"], "already_attempted")
            self.assertEqual(call.call_count, 1)

    def test_restricted_route_rejects_spoof_and_foreign_task(self):
        with patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": "sh -c unwanted"}):
            with self.assertRaisesRegex(runtime.RuntimeErrorDetail, "without a remote command"):
                runtime.serve(self.run, "worker", {"op": "query", "task_id": "A"})
        with patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": ""}):
            with self.assertRaisesRegex(runtime.RuntimeErrorDetail, "Caller identity"):
                runtime.serve(self.run, "worker", {"op": "query", "task_id": "A", "caller": "coordinator"})
            with self.assertRaisesRegex(runtime.RuntimeErrorDetail, "not assigned"):
                runtime.serve(self.run, "worker", {"op": "query", "task_id": "B"})
            self.assertEqual(runtime.serve(self.run, "worker", {"op": "action", "action_id": "absent"}), {"status": "not_found"})
            result = runtime.serve(self.run, "worker", {"op": "query", "task_id": "A"})
            self.assertEqual(result["policy_version"], 1)
            self.assertNotIn("config", result)

    def test_roles_require_installed_skills_and_no_auth_claim(self):
        self.config["hosts"]["local"].update(roles=["review"], profiles=[{
            "id": "custom", "agent_home": str(self.root / "custom-home"), "required_skills": []}])
        with patch.object(runtime.shutil, "which", return_value=None):
            result = runtime.preflight(self.config, "local")
        self.assertFalse(result["local_inventory_ok"])
        self.assertEqual(result["missing_role_skills"], ["comprehensive-review", "review-fix-loop"])
        self.assertIn("gh", [item["tool"] for item in result["tools"]])
        self.assertIn("reviewer authentication/model access", result["unchecked"])

    def test_review_pair_cannot_be_split_across_profiles(self):
        profiles = []
        for skill in ("comprehensive-review", "review-fix-loop"):
            directory = self.root / skill
            directory.mkdir()
            (directory / "SKILL.md").write_text("---\nname: " + skill + "\n---\n")
            profiles.append({"id": skill, "agent_home": str(directory), "required_skills": [skill],
                             "skill_paths": {skill: str(directory)}})
        self.config["hosts"]["local"].update(roles=["review"], profiles=profiles)
        with patch.object(runtime.shutil, "which", return_value="/fixture/tool"), patch.object(
                runtime.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "tool 99.0", "")):
            result = runtime.preflight(self.config, "local")
        self.assertFalse(result["local_inventory_ok"])
        self.assertEqual(sum(not item["ok"] for item in result["installations"]), 2)

    def test_coordinator_requires_herdr_skill_in_selected_profile(self):
        profile = {"id": "coordinator", "agent_home": str(self.root / "custom-home"), "skill_paths": {}}
        self.config["hosts"]["local"]["profiles"] = [profile]
        for skill in ("herdr-orchestrate", "herdr"):
            directory = self.root / skill
            directory.mkdir()
            (directory / "SKILL.md").write_text("---\nname: " + skill + "\n---\n")
            profile["skill_paths"][skill] = str(directory)
        with patch.object(runtime.shutil, "which", return_value="/fixture/tool"), patch.object(
                runtime.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "tool 99.0", "")):
            result = runtime.preflight(self.config, "local")
            self.assertTrue(result["local_inventory_ok"])
            del profile["skill_paths"]["herdr"]
            result = runtime.preflight(self.config, "local")
        self.assertFalse(result["local_inventory_ok"])
        self.assertEqual(result["missing_role_skills"], ["herdr"])
        self.assertEqual([item["skill"] for item in result["installations"] if not item["ok"]], ["herdr"])

    def test_cli_uses_fake_endpoint_and_restarts_without_duplicate_prompt(self):
        fake = self.root / "fake-herdr"
        log = self.root / "calls.jsonl"
        fake.write_text("#!/usr/bin/env python3\nimport json,sys\n"
                        f"with open({str(log)!r}, 'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\n"
                        f"print({json.dumps({'result': self.response()})!r})\n")
        fake.chmod(0o700)
        self.config["scheduler"]["herdr_binary"] = str(fake)
        run = self.root / "subprocess-run"
        Engine.initialize(run, self.config)
        command = [sys.executable, "-B", str(SCRIPTS / "supervise.py"), "tick", "--run-dir", str(run)]
        first = subprocess.run(command, capture_output=True, text=True, check=True)
        second = subprocess.run(command, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(first.stdout)["status"], "delivered")
        self.assertEqual(json.loads(second.stdout)["status"], "awaiting_reconciliation")
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][:4], ["--session", "test-session", "agent", "get"])
        self.assertEqual(calls[1][:4], ["--session", "test-session", "agent", "prompt"])
        self.assertNotIn("--current", calls[1])

    def test_single_instance_lock_and_state_cas(self):
        with runtime.exclusive(self.run, "delivery.lock"):
            with self.assertRaisesRegex(runtime.RuntimeErrorDetail, "Another process"):
                with runtime.exclusive(self.run, "delivery.lock"):
                    self.fail("duplicate lock")
        snapshot = Engine.read(self.run)
        self.schedule(wake_reason="first")
        with self.assertRaises(StateError) as caught:
            Engine.apply(self.run, {"action_id": "stale", "op": "scheduler", "expected_policy": 1,
                                   "expected_scheduler": snapshot["scheduler"]["version"],
                                   "fields": {"wake_reason": "overwrite"}})
        self.assertEqual(caught.exception.code, "stale_scheduler")


if __name__ == "__main__":
    unittest.main()
