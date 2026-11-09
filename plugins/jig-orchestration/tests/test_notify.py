"""Durable wake delivery uses fake endpoints, never a live Herdr pane."""
from datetime import datetime, timedelta, timezone
import os
import subprocess
import unittest
from unittest.mock import patch

from test_channel import ChannelFixture, channel, Engine
from state import locked, read_json, write_atomic
import notify
import protocol
import supervise


class NotifyTests(ChannelFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.now = datetime(2026, 11, 8, tzinfo=timezone.utc)
        self.endpoints = {}
        for actor, pane in (("coordinator", "p1"), ("driver-B", "p3")):
            token = channel.issue(self.run, actor)
            endpoint = {"session": "fixture", "control_pane_id": "w1:p2", "agent": {
                "name": actor, "agent": "codex", "pane_id": "w1:" + pane,
                "terminal_id": "terminal-" + pane,
                "agent_session": {"agent": "codex", "kind": "session_id", "value": "native-" + actor}}}
            self.endpoints[actor] = endpoint
            notify.bind(self.run, actor, channel.parse_credential(token).id, endpoint)

    def publish(self, readers):
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            protocol.event(state, "B", "state_changed", readers)
            write_atomic(path / "state.json", state)

    def response(self, endpoint, argv):
        return {"agent": endpoint["agent"]}

    def enable(self):
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            state["config"]["communication"] = {"mode": "enforced"}
            state["config"]["scheduler"] = {**self.endpoints["coordinator"], "enabled": True}
            state["scheduler"]["enabled"] = True
            write_atomic(path / "state.json", state)
            from storage import initialize
            initialize(path, state["config"])

    def test_unavailable_recipient_and_new_events_cannot_starve_healthy_recipient(self):
        calls = []

        def call(endpoint, argv):
            actor = endpoint["agent"]["name"]
            calls.append((actor, argv))
            if actor == "coordinator":
                raise supervise.RuntimeErrorDetail("unavailable", "fixture endpoint down")
            return self.response(endpoint, argv)

        with patch.object(supervise, "herdr_call", side_effect=call):
            failed = notify.deliver(self.run, now=self.now)
            self.publish(["coordinator"])
            delivered = notify.deliver(self.run, now=self.now)
            waiting = notify.deliver(self.run, now=self.now)
        self.assertEqual((failed["status"], delivered["actor"], delivered["status"], waiting["status"]),
                         ("unconfirmed", "driver-B", "delivered", "backoff"))
        self.assertEqual([name for name, _ in calls], ["coordinator", "driver-B", "driver-B"])
        self.assertEqual(calls[-1][1][-1], notify.HINT)
        wake = Engine.read(self.run)["communication"]["wakes"]["coordinator"]
        self.assertEqual(wake["attempt"]["failure"]["code"], "unavailable")
        # A fresh invocation reads the deadline from durable state.
        with patch.object(supervise, "herdr_call", side_effect=self.response):
            self.assertEqual(notify.deliver(self.run, now=self.now + timedelta(seconds=5))["actor"], "coordinator")

    def test_crash_before_lookup_preserves_retry_bound_and_other_recipient_progress(self):
        with patch.object(supervise, "herdr_call", side_effect=RuntimeError("simulated process loss")):
            with self.assertRaisesRegex(RuntimeError, "process loss"):
                notify.deliver(self.run, now=self.now)
        with patch.object(supervise, "herdr_call", side_effect=self.response):
            resumed = notify.deliver(self.run, now=self.now)
        self.assertEqual((resumed["actor"], resumed["status"]), ("driver-B", "delivered"))
        self.assertEqual(Engine.read(self.run)["communication"]["wakes"]["coordinator"]["attempt"]["status"],
                         "dispatching")

    def test_endpoint_timeout_is_durable_and_does_not_stop_delivery(self):
        with patch.object(supervise, "herdr_call", side_effect=subprocess.TimeoutExpired(["herdr"], 25)):
            failed = notify.deliver(self.run, now=self.now)
        self.assertEqual(failed["status"], "unconfirmed")
        with patch.object(supervise, "herdr_call", side_effect=self.response):
            self.assertEqual(notify.deliver(self.run, now=self.now)["actor"], "driver-B")

    def test_event_during_prompt_remains_pending_without_immediate_duplicate_hint(self):
        def call(endpoint, argv):
            if argv[1] == "prompt":
                self.publish(["coordinator"])
            return self.response(endpoint, argv)

        with patch.object(supervise, "herdr_call", side_effect=call):
            self.assertEqual(notify.deliver(self.run, "coordinator", now=self.now)["status"], "delivered")
        self.assertFalse(Engine.read(self.run)["communication"]["wakes"]["coordinator"]["delivered"])
        with patch.object(supervise, "herdr_call") as call:
            self.assertEqual(notify.deliver(self.run, "coordinator", now=self.now)["status"], "backoff")
        call.assert_not_called()

    def test_session_replacement_during_lookup_prevents_prompt(self):
        def call(endpoint, argv):
            channel.issue(self.run, "coordinator")
            return self.response(endpoint, argv)

        with patch.object(supervise, "herdr_call", side_effect=call) as call:
            result = notify.deliver(self.run, "coordinator", now=self.now)
        self.assertEqual(result["status"], "session_changed")
        self.assertEqual(call.call_count, 1)

    def test_enforced_tick_honors_scheduler_stop_and_maintains_heartbeat(self):
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            state["config"]["communication"] = {"mode": "enforced"}
            write_atomic(path / "state.json", state)
            from storage import initialize
            initialize(path, state["config"])
        with patch.object(supervise, "herdr_call") as call:
            self.assertEqual(supervise.tick(self.run, self.now)["status"], "scheduler_stopped")
        call.assert_not_called()
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            state["config"]["scheduler"] = {**self.endpoints["coordinator"], "enabled": True}
            state["scheduler"]["enabled"] = True
            write_atomic(path / "state.json", state)
        with patch.dict(os.environ, {"HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p2"}), \
                patch.object(supervise, "herdr_call", side_effect=self.response):
            self.assertEqual(supervise.tick(self.run, self.now)["status"], "delivered")
        self.assertEqual(Engine.read(self.run)["scheduler"]["heartbeat_at"], self.now.isoformat())
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            state["scheduler"]["enabled"] = False
            write_atomic(path / "state.json", state)
        with patch.object(supervise, "herdr_call") as call:
            self.assertEqual(supervise.tick(self.run, self.now)["status"], "scheduler_stopped")
        call.assert_not_called()

    def test_enforced_scan_is_periodic_and_failure_does_not_starve_delivery(self):
        import integration
        self.enable()
        with patch.dict(os.environ, {"HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p2"}), \
                patch.object(supervise, "herdr_call", side_effect=self.response), \
                patch.object(integration, "refresh", side_effect=OSError("fixture failed scan")) as scan:
            self.assertEqual(supervise.tick(self.run, self.now)["status"], "delivered")
            self.assertEqual(supervise.tick(self.run, self.now)["actor"], "driver-B")
        self.assertEqual(scan.call_count, 1)
        self.assertEqual(Engine.read(self.run)["scheduler"]["channel_scan_status"], "failed")
        with patch.dict(os.environ, {"HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p2"}), \
                patch.object(supervise, "herdr_call", side_effect=self.response), \
                patch.object(integration, "refresh", return_value={"status": "observed"}) as scan:
            supervise.tick(self.run, self.now + timedelta(days=1))
        self.assertEqual(scan.call_count, 1)
        self.assertEqual(Engine.read(self.run)["scheduler"]["channel_scan_completed_at"],
                         (self.now + timedelta(days=1)).isoformat())

    def test_stop_during_scan_suppresses_hint(self):
        import integration
        self.enable()

        def scan(_):
            with locked(self.run) as path:
                state = read_json(path / "state.json")
                state["scheduler"]["enabled"] = False
                write_atomic(path / "state.json", state)
            return {"status": "observed"}

        with patch.dict(os.environ, {"HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p2"}), \
                patch.object(supervise, "herdr_call") as call, patch.object(integration, "refresh", side_effect=scan):
            self.assertEqual(supervise.tick(self.run, self.now)["status"], "scheduler_stopped")
        call.assert_not_called()

    def test_channel_health_distinguishes_delivery_scan_and_agent_progress(self):
        self.enable()
        state = Engine.read(self.run)
        settings = supervise.scheduler_config(state["config"], state["scheduler"])
        state["scheduler"].update(heartbeat_at=self.now.isoformat(), channel_scan_completed_at=self.now.isoformat())
        for wake in state["communication"]["wakes"].values():
            wake["delivered"] = True
        # Legacy wake-completion fields are intentionally absent in enforced mode.
        self.assertEqual(supervise.channel_health_failures(state, settings, self.now), [])
        old = (self.now - timedelta(days=1)).isoformat()
        state["scheduler"]["channel_scan_completed_at"] = old
        state["communication"]["wakes"]["coordinator"].update(delivered=False, pending_since=old)
        failures = supervise.channel_health_failures(state, settings, self.now)
        self.assertEqual([failure["id"].split("-")[1] for failure in failures], ["scan", "delivery"])



if __name__ == "__main__":
    unittest.main()
