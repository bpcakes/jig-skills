"""The message protocol in an unconfined run: no gateway, credential or sandbox.

The local command is the coordinator and the forced-command route names each
driver. Herdr is always a fake; no live pane is contacted.
"""
from datetime import datetime, timedelta, timezone
import json
import os
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

import test_channel
from test_channel import ChannelFixture, Engine, StateError, channel
from state import locked, read_json, write_atomic
import notify
import supervise


def endpoint(actor, pane):
    return {"session": "fixture", "control_pane_id": "w1:p2", "agent": {
        "name": actor, "agent": "codex", "pane_id": "w1:" + pane, "terminal_id": "terminal-" + pane,
        "agent_session": {"agent": "codex", "kind": "session_id", "value": "native-" + actor}}}


class LegacyChannelFixture(ChannelFixture):
    def coordinator(self, **request):
        return supervise.channel_request(self.run, "coordinator", request)

    def driver(self, task, **request):
        return supervise.serve(self.run, "driver-" + task, request)

    def active(self, actor):
        return Engine.read(self.run)["communication"]["active"].get(actor)

    def refused(self, code, call, *args, **kwargs):
        with self.assertRaises((StateError, supervise.RuntimeErrorDetail)) as raised:
            call(*args, **kwargs)
        self.assertEqual(raised.exception.code, code, str(raised.exception))


class LegacyChannelTests(LegacyChannelFixture, unittest.TestCase):
    def test_question_reply_and_evidence_cross_both_transports(self):
        question = {"op": "message", "task_id": "A", "action_id": "question", "recipient": "coordinator",
                    "kind": "question", "body": "Which interface?"}
        asked = self.driver("A", **question)
        self.assertTrue(asked["accepted"])
        inbox = self.coordinator(op="inbox", task_id="A")
        self.assertEqual([item["message"]["body"] for item in inbox["events"]], ["Which interface?"])
        self.assertEqual(inbox["open_questions"], ["question"])
        stored = self.coordinator(op="artifact_put", task_id="A", action_id="contract", content="amount_minor: int\n",
                                  readers=["coordinator", "driver-A"])
        self.coordinator(op="message", task_id="A", action_id="answer", recipient="driver-A", kind="reply",
                         body="Use interface v2", reply_to="question", artifacts=[stored["artifact"]["id"]])
        received = self.driver("A", op="inbox", task_id="A")
        answer = received["events"][-1]["message"]
        self.assertEqual((answer["body"], received["open_questions"]), ("Use interface v2", []))
        evidence = self.driver("A", op="artifact_read", task_id="A", artifact_id=answer["artifacts"][0])
        self.assertEqual((evidence["content"], evidence["complete"]), ("amount_minor: int\n", True))
        # A lost reply is recovered with the original action ID, not a second message.
        self.assertEqual(self.driver("A", **question), asked)
        self.driver("A", op="ack", task_id="A", action_id="read-answer", cursor=received["cursor"])
        self.assertEqual(self.driver("A", op="inbox", task_id="A")["events"], [])
        # Nothing here needed the gateway endpoint that isolated agents use.
        self.assertFalse((self.run / "endpoint").exists())

    def test_request_cannot_choose_its_identity_or_reach_another_task(self):
        update = {"op": "message", "task_id": "A", "action_id": "note", "kind": "update", "body": "progress"}
        self.refused("wrong_task", self.driver, "A", op="inbox", task_id="B")
        self.refused("scope", self.driver, "A", **update, recipient="driver-B")
        self.refused("forbidden", self.driver, "A", **{**update, "kind": "assignment"}, recipient="coordinator")
        self.refused("caller_spoof", self.driver, "A", op="inbox", task_id="A", caller="coordinator")
        self.refused("caller_spoof", self.coordinator, op="inbox", task_id="A", session="chosen")
        self.refused("unknown_caller", supervise.serve, self.run, "driver-Z", {"op": "inbox", "task_id": "A"})
        self.refused("unknown_caller", supervise.serve, self.run, "coordinator", {"op": "inbox", "task_id": "A"})
        self.refused("invalid_input", self.coordinator, op="query", task_id="A")
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            state["config"]["actors"]["driver-A"]["helper_route"] = False
            write_atomic(path / "state.json", state)
        self.refused("unknown_caller", self.driver, "A", op="inbox", task_id="A")
        # A message nobody could read is refused, not left in an unreachable inbox.
        self.refused("unreachable", self.coordinator, **{**update, "kind": "assignment"}, recipient="driver-A")
        # The record its earlier requests left behind authorizes nothing by itself.
        state = Engine.read(self.run)
        identifier = state["communication"]["active"]["driver-A"]
        leftover = channel.Session(identifier, state["communication"]["sessions"][identifier]["digest"])
        self.refused("session_revoked", channel.check, state, leftover)

    def test_one_record_serves_a_caller_and_follows_its_scope(self):
        self.coordinator(op="inbox", task_id="A")
        first = self.active("coordinator")
        self.coordinator(op="inbox", task_id="B")
        self.assertEqual(self.active("coordinator"), first)
        bound = endpoint("coordinator", "p1")
        self.assertEqual(notify.bind(self.run, "coordinator", None, bound), first)
        self.driver("A", op="inbox", task_id="A")
        driver, pane = self.active("driver-A"), endpoint("driver-A", "p3")
        self.assertEqual(notify.bind(self.run, "driver-A", None, pane), driver)
        state = Engine.read(self.run)
        actors = {**state["config"]["actors"],
                  "driver-A": {**state["config"]["actors"]["driver-A"], "task_ids": ["A", "C"]}}
        Engine.apply(self.run, {"op": "configure", "action_id": "add-C", "expected_policy": state["policy_version"],
                                "fields": {"scope": {"task_ids": ["A", "B", "C"]}, "actors": actors},
                                "evidence": self.proof})
        self.refused("wrong_task", self.driver, "A", op="inbox", task_id="C")
        (self.trees / "C").mkdir()
        Engine.apply(self.run, {"op": "admit", "action_id": "admit-C", "task_id": "C", "driver": "driver-A",
                                "expected_policy": Engine.read(self.run)["policy_version"], "host": "local",
                                "identity": {"native_id": "native-C"}, "worktree": str(self.trees / "C"),
                                "branch": "task/C", "claim": {**self.proof, "authority": "fixture", "task_id": "C",
                                                             "owner": "driver-A", "confirmed": True, "ready": True,
                                                             "unpublished": False}})
        # A split or scope change needs no relaunch: the next request covers it.
        self.coordinator(op="message", task_id="C", action_id="assign-C", recipient="driver-A", kind="assignment",
                         body="Implement the consumer")
        self.assertEqual(self.driver("A", op="inbox", task_id="C")["events"][-1]["message"]["kind"], "assignment")
        sessions = Engine.read(self.run)["communication"]["sessions"]
        # The coordinator's record always covers the run, so it keeps its
        # binding and any wait in flight. A driver's record names its tasks:
        # it is replaced, and the pane binding moves with the same agent.
        self.assertEqual((self.active("coordinator"), sessions[first]["endpoint"]), (first, bound))
        current = self.active("driver-A")
        self.assertNotEqual(current, driver)
        self.assertEqual((sessions[current]["task_ids"], sessions[current]["endpoint"]), (["A", "C"], pane))

    def test_enforced_run_refuses_both_unconfined_transports(self):
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            state["config"]["communication"] = {"mode": "enforced"}
            write_atomic(path / "state.json", state)
            from storage import initialize
            initialize(path, state["config"])
        request = {"op": "inbox", "task_id": "A"}
        self.refused("authenticated_channel_required", self.coordinator, **request)
        self.refused("authenticated_channel_required", self.driver, "A", **request)
        self.refused("invalid", notify.bind, self.run, "coordinator", None, endpoint("coordinator", "p1"))
        self.assertNotIn("communication", Engine.read(self.run))

    def test_inbox_watch_ends_on_another_partys_message_not_the_callers_own(self):
        cursor = self.driver("A", op="inbox", task_id="A")["cursor"]
        self.driver("A", op="message", task_id="A", action_id="status", recipient="coordinator", kind="update",
                    body="starting")
        started = time.monotonic()
        quiet = self.driver("A", op="watch", task_id="A", view="inbox", after=cursor, timeout_seconds=0.6)
        self.assertFalse(quiet["changed"])
        self.assertGreaterEqual(time.monotonic() - started, 0.5)
        replies = []
        waiter = threading.Thread(target=lambda: replies.append(
            self.driver("A", op="watch", task_id="A", view="inbox", after=cursor, timeout_seconds=10)))
        waiter.start()
        time.sleep(0.3)
        self.coordinator(op="message", task_id="A", action_id="go", recipient="driver-A", kind="assignment",
                         body="Proceed with v2")
        waiter.join(5)
        self.assertFalse(waiter.is_alive())
        self.assertTrue(replies[0]["changed"])
        self.assertEqual(replies[0]["events"][-1]["message_id"], "go")
        self.refused("invalid_input", self.driver, "A", op="watch", task_id="A", view="inbox", after=cursor, timeout=5)
        # The existing task-state watch keeps its own token and route.
        token = self.driver("A", op="query", task_id="A")["change_token"]
        self.assertFalse(self.driver("A", op="watch", task_id="A", after=token, timeout_seconds=0)["changed"])

    def test_cli_commands_bind_the_coordinator_locally_and_the_driver_by_forced_command(self):
        script = [sys.executable, "-B", str(test_channel.SCRIPTS / "supervise.py")]
        environment = {key: value for key, value in os.environ.items() if key != "SSH_ORIGINAL_COMMAND"}

        def run(arguments, request, **overrides):
            return subprocess.run([*script, *arguments, "--run-dir", str(self.run)], input=json.dumps(request),
                                  capture_output=True, text=True, env={**environment, **overrides}, timeout=30)

        sent = run(["channel"], {"op": "message", "task_id": "A", "action_id": "assign", "recipient": "driver-A",
                                 "kind": "assignment", "body": "Implement the interface"})
        self.assertEqual((sent.returncode, json.loads(sent.stdout)["accepted"]), (0, True), sent.stderr)
        inbox = run(["serve", "--caller", "driver-A"], {"op": "inbox", "task_id": "A"})
        self.assertEqual(json.loads(inbox.stdout)["events"][-1]["message"]["body"], "Implement the interface")
        # A forced-command route can never become the local coordinator.
        remote = run(["channel"], {"op": "inbox", "task_id": "A"}, SSH_ORIGINAL_COMMAND="anything")
        self.assertEqual((remote.returncode, json.loads(remote.stdout)["error"]["code"]), (1, "remote_command_rejected"))

    def test_cli_initialization_leaves_isolation_opt_in(self):
        config = self.root / "config.json"
        for name, document, arguments, expected in (
                ("default", self.config, [], "legacy"),
                ("stated", {**self.config, "communication": {"mode": "legacy"}}, [], "legacy"),
                ("flag", self.config, ["--communication-mode", "enforced"], "enforced"),
                ("configured", {**self.config, "communication": {"mode": "enforced", "storage": {"max_files": 4096}}},
                 [], "enforced")):
            with self.subTest(name=name):
                config.write_text(json.dumps(document))
                run = self.root / ("fresh-" + name)
                result = subprocess.run([sys.executable, "-B", str(test_channel.SCRIPTS / "supervise.py"), "init",
                                         "--run-dir", str(run), "--config", str(config), *arguments],
                                        capture_output=True, text=True, check=True)
                self.assertEqual(json.loads(result.stdout)["communication_mode"], expected)
                self.assertEqual(Engine.read(run)["config"]["communication"]["mode"], expected)
                self.assertEqual((run / "protocol-storage.json").exists(), expected == "enforced")
        self.assertEqual(Engine.read(self.root / "fresh-configured")["config"]["communication"]["storage"],
                         {"max_files": 4096})


class LegacyHintTests(LegacyChannelFixture, unittest.TestCase):
    """Scheduled supervision delivers hints beside its reconciliation wake.

    The fixture allows a coordinator prompt every 60 seconds and schedules a
    full reconciliation every hour, so a hint has room to arrive in between.
    """

    def setUp(self):
        super().setUp()
        self.now = datetime(2026, 11, 9, tzinfo=timezone.utc)
        self.status, self.prompts = {}, []
        state = Engine.read(self.run)
        Engine.apply(self.run, {"op": "configure", "action_id": "schedule", "expected_policy": state["policy_version"],
                                "fields": {"scheduler": {**endpoint("coordinator", "p1"), "enabled": True,
                                                         "cadence_seconds": 3600, "minimum_cadence_seconds": 60}},
                                "evidence": self.proof})
        for patcher in (patch.dict(os.environ, {"HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p2"}),
                        patch.object(supervise, "herdr_call", side_effect=self.herdr)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def herdr(self, target, argv):
        agent = target["agent"]
        if argv[1] == "prompt":
            self.prompts.append((agent["name"], "hint" if argv[-1] == notify.HINT else "reconciliation"))
        return {"agent": {**agent, "agent_status": self.status.get(agent["name"], "idle")}}

    def tick(self, seconds):
        return supervise.tick(self.run, self.now + timedelta(seconds=seconds))

    def ask(self, identifier):
        return self.driver("A", op="message", task_id="A", action_id=identifier, recipient="coordinator",
                           kind="question", body="Which interface?")

    def test_hint_reaches_the_registered_coordinator_between_reconciliation_wakes(self):
        self.ask("first")
        # The coordinator has never used the channel; its scheduler identity is enough.
        self.assertNotIn("coordinator", Engine.read(self.run)["communication"]["active"])
        woken = self.tick(0)
        self.assertEqual((woken["status"], self.prompts), ("delivered", [("coordinator", "reconciliation")]))
        self.assertNotIn("channel_hint", woken)
        # A pending full pass already covers the inbox: no second prompt is stacked on it.
        self.assertNotIn("channel_hint", self.tick(10))
        supervise.complete(self.run, woken["wake_id"], self.now + timedelta(seconds=20))
        # A hint is a prompt too: it waits out the user's minimum interval.
        self.assertEqual(self.tick(30), {"status": "minimum_cadence"})
        hinted = self.tick(90)
        self.assertEqual((hinted["status"], hinted["channel_hint"]["status"], hinted["channel_hint"]["actor"]),
                         ("not_due", "delivered", "coordinator"))
        self.assertEqual(self.prompts[-1], ("coordinator", "hint"))
        # And it spaces the next reconciliation wake by that same interval.
        supervise.request_wake(self.run, "event", self.now + timedelta(seconds=95))
        self.assertEqual((self.tick(100), len(self.prompts)), ({"status": "minimum_cadence"}, 2))
        self.assertEqual((self.tick(151)["status"], self.prompts[-1]), ("delivered", ("coordinator", "reconciliation")))

    def test_read_and_acknowledged_message_costs_no_prompt(self):
        supervise.complete(self.run, self.tick(0)["wake_id"], self.now + timedelta(seconds=5))
        self.ask("handled")
        page = self.coordinator(op="inbox", task_id="A")
        self.coordinator(op="ack", task_id="A", action_id="ack", cursor=page["cursor"])
        self.assertEqual(self.tick(90)["status"], "not_due")
        self.assertNotIn("channel_hint", self.tick(100))
        self.assertEqual(self.prompts, [("coordinator", "reconciliation")])

    def test_working_coordinator_is_left_alone_until_its_turn_ends(self):
        supervise.complete(self.run, self.tick(0)["wake_id"], self.now + timedelta(seconds=5))
        self.ask("later")
        self.status["coordinator"] = "working"
        self.assertEqual(self.tick(90)["channel_hint"]["status"], "busy")
        self.assertEqual(len(self.prompts), 1)
        self.status["coordinator"] = "idle"
        self.assertEqual(self.tick(100)["channel_hint"]["status"], "delivered")
        self.assertEqual(self.prompts[-1], ("coordinator", "hint"))

    def test_driver_is_hinted_only_through_a_bound_endpoint(self):
        supervise.complete(self.run, self.tick(0)["wake_id"], self.now + timedelta(seconds=5))
        self.coordinator(op="message", task_id="A", action_id="assign", recipient="driver-A", kind="assignment",
                         body="Implement v2")
        # Without a verified pane the driver finds it through its inbox watch.
        self.assertEqual(self.tick(30), {"status": "minimum_cadence"})
        session = notify.bind(self.run, "driver-A", None, endpoint("driver-A", "p3"))
        self.assertEqual(session, self.active("driver-A"))
        # The coordinator's interval does not delay a bound driver.
        hinted = self.tick(40)["channel_hint"]
        self.assertEqual((hinted["status"], hinted["actor"], self.prompts[-1]), ("delivered", "driver-A", ("driver-A", "hint")))

    def test_scheduler_stop_suppresses_hints(self):
        supervise.complete(self.run, self.tick(0)["wake_id"], self.now + timedelta(seconds=5))
        self.ask("stopped")
        supervise.scheduler_patch(self.run, lambda _: {"enabled": False})
        self.assertEqual(self.tick(30), {"status": "scheduler_stopped"})
        self.assertEqual(len(self.prompts), 1)


if __name__ == "__main__":
    unittest.main()
