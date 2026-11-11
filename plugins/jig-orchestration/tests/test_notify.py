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
        self.endpoints, self.sessions = {}, {}
        for actor, pane in (("coordinator", "p1"), ("driver-B", "p3")):
            token = channel.issue(self.run, actor)
            self.sessions[actor] = channel.parse_credential(token)
            endpoint = {"session": "fixture", "control_pane_id": "w1:p2", "agent": {
                "name": actor, "agent": "codex", "pane_id": "w1:" + pane,
                "terminal_id": "terminal-" + pane,
                "agent_session": {"agent": "codex", "kind": "session_id", "value": "native-" + actor}}}
            self.endpoints[actor] = endpoint
            notify.bind(self.run, actor, channel.parse_credential(token).id, endpoint)

    def publish(self, readers, task="B"):
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            protocol.event(state, task, "state_changed", readers)
            write_atomic(path / "state.json", state)

    def response(self, endpoint, argv, status="idle"):
        return {"agent": {**endpoint["agent"], "agent_status": status}}

    def settle(self):
        """Start from quiet: binding itself leaves one recovery hint pending."""
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            for wake in state["communication"]["wakes"].values():
                wake["delivered"] = True
            write_atomic(path / "state.json", state)

    def pending(self):
        return sorted(name for name, wake in Engine.read(self.run)["communication"]["wakes"].items()
                      if not wake["delivered"])

    def act(self, actor, **request):
        """A session-authenticated request, as the gateway would apply it."""
        state = Engine.read(self.run)
        if request["op"] not in protocol.MUTATIONS:
            request.setdefault("expected_policy", state["policy_version"])
            if "task_id" in request:
                request.setdefault("expected_task", state["tasks"][request["task_id"]]["version"])
        return channel.apply(self.run, self.sessions[actor], request)

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
        self.enable()
        def call(endpoint, argv):
            channel.issue(self.run, "coordinator")
            return self.response(endpoint, argv)

        with patch.object(supervise, "herdr_call", side_effect=call) as call:
            result = notify.deliver(self.run, "coordinator", now=self.now)
        self.assertEqual(result["status"], "session_changed")
        self.assertEqual(call.call_count, 1)

    def test_acknowledgement_of_new_event_during_prompt_stays_retired(self):
        self.settle()
        self.publish(["coordinator"])

        def acknowledge(endpoint, argv):
            if argv[1] == "prompt":
                self.publish(["coordinator"])
                page = protocol.read(self.run, self.sessions["coordinator"], {"op": "inbox", "task_id": "B"})
                self.act("coordinator", op="ack", task_id="B", action_id="ack-during-prompt", cursor=page["cursor"])
                self.assertEqual(self.pending(), [])
            return self.response(endpoint, argv)

        with patch.object(supervise, "herdr_call", side_effect=acknowledge):
            self.assertEqual(notify.deliver(self.run, "coordinator", now=self.now)["status"], "delivered")
        self.assertEqual(self.pending(), [])
        with patch.object(supervise, "herdr_call") as call:
            later = notify.deliver(self.run, now=self.now + timedelta(seconds=notify.MAX_RETRY_SECONDS))
        self.assertEqual(later["status"], "quiet")
        call.assert_not_called()

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

    def test_sender_and_actor_are_not_hinted_about_their_own_events(self):
        self.settle()
        sent = self.act("driver-B", op="message", task_id="B", action_id="question", recipient="coordinator",
                        kind="question", body="Which interface?")
        self.assertTrue(sent["accepted"])
        self.assertEqual(self.pending(), ["coordinator"])
        self.settle()
        self.act("coordinator", op="control", task_id="B", action_id="pause-B", control="pause")
        self.assertEqual(self.pending(), ["driver-B"])
        # Both remain in the originator's own inbox history.
        own = protocol.read(self.run, self.sessions["driver-B"], {"op": "inbox", "task_id": "B"})
        self.assertEqual([item.get("origin") for item in own["events"]], ["driver-B", "coordinator"])

    def host_apply(self, **request):
        state = Engine.read(self.run)
        request.setdefault("expected_policy", state["policy_version"])
        if "task_id" in request:
            request.setdefault("expected_task", state["tasks"][request["task_id"]]["version"])
        return Engine.apply(self.run, request)

    def test_enforced_host_control_hints_coordinator_without_changing_receipt_identity(self):
        self.enable()
        self.settle()
        result = self.host_apply(op="control", task_id="B", action_id="host-pause", control="pause")
        self.assertEqual(self.pending(), ["coordinator", "driver-B"])
        self.assertIsNone(Engine.read(self.run)["communication"]["events"][-1].get("origin"))
        receipt = Engine.action(self.run, "host-pause")
        self.assertEqual(receipt["caller"], "coordinator")
        self.assertEqual(Engine.apply(self.run, receipt["request"]), result)
        self.settle()
        self.act("coordinator", op="control", task_id="B", action_id="agent-resume", control="resume")
        self.assertEqual(self.pending(), ["driver-B"])
        self.assertEqual(Engine.read(self.run)["communication"]["events"][-1]["origin"], "coordinator")

    def test_enforced_host_recovery_hints_coordinator(self):
        self.enable()
        self.settle()
        task = Engine.read(self.run)["tasks"]["B"]
        self.host_apply(op="recover_session", task_id="B", action_id="host-recovery",
                        previous_identity=task["identity"], identity={"native_id": "replacement"},
                        evidence={**self.proof, "previous_session_stopped": True, "replacement_verified": True,
                                  "host": "local", "worktree": task["worktree"]})
        self.assertEqual(self.pending(), ["coordinator", "driver-B"])
        with patch.object(supervise, "herdr_call", side_effect=self.response):
            self.assertEqual(notify.deliver(self.run, "coordinator", now=self.now)["status"], "delivered")

    def test_unconfined_host_control_keeps_coordinator_origin(self):
        self.settle()
        self.host_apply(op="control", task_id="B", action_id="local-pause", control="pause")
        self.assertEqual(self.pending(), ["driver-B"])
        self.assertEqual(Engine.read(self.run)["communication"]["events"][-1]["origin"], "coordinator")

    def test_acknowledged_inbox_retires_the_hint_without_a_prompt(self):
        self.settle()
        earlier = protocol.read(self.run, self.sessions["coordinator"], {"op": "inbox", "task_id": "B"})["cursor"]
        self.act("driver-B", op="message", task_id="B", action_id="update", recipient="coordinator",
                 kind="update", body="Interface published")
        self.publish(["coordinator"], task="A")
        # Neither an older cursor nor another task's acknowledgement is enough.
        self.act("coordinator", op="ack", task_id="B", action_id="ack-old", cursor=earlier)
        self.assertEqual(self.pending(), ["coordinator"])
        page = protocol.read(self.run, self.sessions["coordinator"], {"op": "inbox", "task_id": "B"})
        self.act("coordinator", op="ack", task_id="B", action_id="ack-B", cursor=page["cursor"])
        self.assertEqual(self.pending(), ["coordinator"])
        self.act("coordinator", op="ack", task_id="A", action_id="ack-A", cursor=page["cursor"])
        self.assertEqual(self.pending(), [])
        with patch.object(supervise, "herdr_call") as call:
            self.assertEqual(notify.deliver(self.run, now=self.now)["status"], "quiet")
        call.assert_not_called()
        # A later addressed message is news again.
        self.act("driver-B", op="message", task_id="B", action_id="update-2", recipient="coordinator",
                 kind="update", body="Second revision")
        self.assertEqual(self.pending(), ["coordinator"])

    def test_only_attention_changes_hint_the_other_party(self):
        self.settle()
        self.act("driver-B", op="observe", task_id="B", action_id="routine", evidence=self.proof,
                 fields={"refs": {"pr": "17"}, "next_action": "open the pull request"})
        self.assertEqual(self.pending(), [])
        self.act("driver-B", op="observe", task_id="B", action_id="blocked", evidence=self.proof,
                 fields={"blocker": "needs the interface decision"})
        self.assertEqual(self.pending(), ["coordinator"])
        self.settle()
        # A run-wide stop concerns every driver, registered or not, never its author.
        self.act("coordinator", op="control", action_id="pause-run", control="pause")
        self.assertEqual(self.pending(), ["driver-A", "driver-B"])
        events = Engine.read(self.run)["communication"]["events"]
        self.assertEqual([item["action_id"] for item in events if item["kind"] == "state_changed"][:2],
                         ["routine", "blocked"])

    def test_artifact_publication_alone_hints_nobody(self):
        self.settle()
        stored = self.act("driver-B", op="artifact_put", task_id="B", action_id="evidence", content="check output")
        self.assertEqual(self.pending(), [])
        listed = protocol.read(self.run, self.sessions["coordinator"], {"op": "inbox", "task_id": "B"})
        self.assertEqual([item.get("artifact_id") for item in listed["events"]], [stored["artifact"]["id"]])
        self.act("driver-B", op="message", task_id="B", action_id="evidence-note", recipient="coordinator",
                 kind="update", body="Evidence attached", artifacts=[stored["artifact"]["id"]])
        self.assertEqual(self.pending(), ["coordinator"])

    def test_working_agent_is_deferred_without_a_prompt_or_failure(self):
        calls = []

        def call(endpoint, argv):
            calls.append(argv[1])
            return self.response(endpoint, argv, "working" if len(calls) == 1 else "idle")

        with patch.object(supervise, "herdr_call", side_effect=call):
            busy = notify.deliver(self.run, "coordinator", now=self.now)
            waiting = notify.deliver(self.run, "coordinator", now=self.now)
            later = notify.deliver(self.run, "coordinator", now=self.now + timedelta(seconds=notify.RETRY_SECONDS))
        self.assertEqual((busy["status"], waiting["status"], later["status"]), ("busy", "backoff", "delivered"))
        self.assertEqual(calls, ["get", "get", "prompt"])
        wake = Engine.read(self.run)["communication"]["wakes"]["coordinator"]
        self.assertEqual((wake["failures"], wake["delivered"]), (0, True))

    def test_blocked_or_unknown_pane_is_never_prompted(self):
        for hour, status in enumerate(("blocked", "unknown")):
            with self.subTest(status=status):
                calls = []

                def call(endpoint, argv, status=status):
                    calls.append(argv[1])
                    return self.response(endpoint, argv, status)

                at = self.now + timedelta(hours=hour)
                with patch.object(supervise, "herdr_call", side_effect=call):
                    result = notify.deliver(self.run, "coordinator", now=at)
                self.assertEqual((result["status"], calls), ("unconfirmed", ["get"]))
                wake = Engine.read(self.run)["communication"]["wakes"]["coordinator"]
                self.assertEqual(wake["attempt"]["failure"]["code"], "agent_" + status)
                self.assertFalse(wake["delivered"])



if __name__ == "__main__":
    unittest.main()
