"""The message protocol in an unconfined run: no gateway, credential or sandbox.

The local command is the coordinator and the forced-command route names each
driver. Herdr is always a fake; no live pane is contacted.
"""
from datetime import datetime, timedelta, timezone
from contextlib import redirect_stdout
import io
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
    def handoff(self, task_id, driver):
        for operation, fields in (("park", {}), ("handoff", {
                "host": "local", "driver": driver, "worktree": str(self.trees / task_id),
                "branch": "task/" + task_id, "identity": {"native_id": "native-" + driver + "-" + task_id},
                "source": {**self.proof, "published": True, "revision": "H1"}})):
            state = Engine.read(self.run)
            Engine.apply(self.run, {"op": operation, "action_id": operation + "-" + driver + "-" + task_id,
                                   "task_id": task_id, "expected_policy": state["policy_version"],
                                   "expected_task": state["tasks"][task_id]["version"],
                                   "evidence": {**self.proof, "all_jobs_settled": True}, **fields})

    def bind_shared_driver(self):
        state = Engine.read(self.run)
        actors = {**state["config"]["actors"],
                  "driver-A": {**state["config"]["actors"]["driver-A"], "task_ids": ["A", "B"]}}
        Engine.apply(self.run, {"op": "configure", "action_id": "share-B", "expected_policy": state["policy_version"],
                               "fields": {"actors": actors}, "evidence": self.proof})
        self.handoff("B", "driver-A")
        pane = endpoint("driver-A", "p3")
        notify.bind(self.run, "driver-A", None, pane)
        return pane

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
    def test_concurrent_watch_and_message_share_transport_renewal_after_handoff(self):
        self.bind_shared_driver()
        cursor = self.driver("A", op="inbox", task_id="A")["cursor"]
        previous = self.active("driver-A")
        self.handoff("B", "driver-B")
        barrier = threading.Barrier(2)
        issue = channel.issue
        results, errors = {}, []
        message_done = threading.Event()

        def simultaneous(*args, **kwargs):
            old = kwargs.get("transport_from")
            if old is not None and old.id == previous:
                barrier.wait(5)
            return issue(*args, **kwargs)

        def request(name, **fields):
            try:
                results[name] = self.driver("A", **fields)
            except Exception as error:
                errors.append(error)
            finally:
                if name == "message":
                    message_done.set()

        message = {"op": "message", "task_id": "A", "action_id": "renewal-question",
                   "recipient": "coordinator", "kind": "question", "body": "Continue A?"}
        with patch.object(channel, "issue", side_effect=simultaneous):
            workers = [threading.Thread(target=request, args=("watch",), kwargs={
                "op": "watch", "task_id": "A", "view": "inbox", "after": cursor, "timeout_seconds": 5}),
                threading.Thread(target=request, args=("message",), kwargs=message)]
            for worker in workers:
                worker.start()
            finished = message_done.wait(10)
            self.coordinator(op="message", task_id="A", action_id="renewal-answer", recipient="driver-A",
                             kind="assignment", body="Continue A")
            for worker in workers:
                worker.join(10)
            self.assertTrue(finished)
            self.assertFalse(any(worker.is_alive() for worker in workers))
        self.assertEqual(errors, [])
        self.assertTrue(results["watch"]["changed"])
        self.assertEqual(results["watch"]["events"][-1]["message_id"], "renewal-answer")
        self.assertNotEqual(self.active("driver-A"), previous)
        self.assertEqual(self.driver("A", **message), results["message"])
        inbox = self.coordinator(op="inbox", task_id="A")
        self.assertEqual(sum(event.get("message_id") == "renewal-question" for event in inbox["events"]), 1)

    def test_transport_resolution_retries_only_once(self):
        with patch.object(channel, "transport_session", side_effect=StateError("session_revoked", "changed")) as resolve:
            self.refused("session_revoked", self.driver, "A", op="inbox", task_id="A")
        self.assertEqual(resolve.call_count, 2)

    def test_handoff_keeps_the_remaining_tasks_verified_driver_endpoint(self):
        pane = self.bind_shared_driver()
        previous_target = notify.target(Engine.read(self.run), "driver-A")
        previous = self.active("driver-A")
        self.handoff("B", "driver-B")
        self.driver("A", op="inbox", task_id="A")
        state = Engine.read(self.run)
        current = self.active("driver-A")
        self.assertNotEqual(current, previous)
        self.assertEqual(state["communication"]["sessions"][current]["task_ids"], ["A"])
        self.assertEqual(notify.target(state, "driver-A"), previous_target)
        self.coordinator(op="message", task_id="A", action_id="continue-A", recipient="driver-A",
                         kind="assignment", body="Continue A")
        prompts = []
        def herdr(target, argv):
            if argv[1] == "prompt":
                prompts.append(target["agent"]["pane_id"])
            return {"agent": {**target["agent"], "agent_status": "idle"}}
        with patch.object(supervise, "herdr_call", side_effect=herdr):
            self.assertEqual(notify.deliver(self.run, actor="driver-A")["status"], "delivered")
        self.assertEqual(prompts, [pane["agent"]["pane_id"]])

    def assert_driver_change_during_hint(self, stage="prompt", change="renewal", unread=False,
                                         acknowledge=False, old_format=False):
        pane = self.bind_shared_driver()
        if old_format:
            with locked(self.run) as path:
                state = read_json(path / "state.json")
                sid = state["communication"]["active"]["driver-A"]
                state["communication"]["sessions"][sid].pop("endpoint_binding", None)
                write_atomic(path / "state.json", state)
        previous = self.active("driver-A")
        self.handoff("B", "driver-B")
        self.coordinator(op="message", task_id="A", action_id="continue-A", recipient="driver-A",
                         kind="assignment", body="Continue A")
        now = datetime(2026, 11, 11, tzinfo=timezone.utc)
        prompts, changed = [], False

        def herdr(target, argv):
            nonlocal changed
            if argv[1] == "prompt":
                prompts.append(target["agent"]["pane_id"])
            if argv[1] == stage and not changed:
                changed = True
                if change == "revocation":
                    channel.revoke(self.run, "driver-A")
                elif change == "identity":
                    self.handoff("A", "driver-A")
                elif change == "replacement":
                    channel.issue(self.run, "driver-A", task_ids=["A"], endpoint=pane)
                self.driver("A", op="inbox", task_id="A")
                if change == "rebind":
                    notify.bind(self.run, "driver-A", None, pane)
                if unread or acknowledge:
                    self.coordinator(op="message", task_id="A", action_id="newer-A", recipient="driver-A",
                                     kind="update", body="A newer update")
                if acknowledge:
                    page = self.driver("A", op="inbox", task_id="A")
                    self.driver("A", op="ack", task_id="A", action_id="ack-A", cursor=page["cursor"])
            return {"agent": {**target["agent"], "agent_status": "idle"}}

        with patch.object(supervise, "herdr_call", side_effect=herdr):
            first = notify.deliver(self.run, "driver-A", now=now)
            wake = Engine.read(self.run)["communication"]["wakes"]["driver-A"]
            later = notify.deliver(self.run, "driver-A", now=now + timedelta(seconds=6))
        self.assertTrue(changed)
        self.assertNotEqual(self.active("driver-A"), previous)
        if change == "renewal":
            self.assertEqual(first["status"], "delivered")
            self.assertEqual(wake["delivered"], not unread)
            self.assertEqual(later["status"], "delivered" if unread else "quiet")
            self.assertEqual(len(prompts), 2 if unread else 1)
            if unread:
                self.assertGreater(later["sequence"], first["sequence"])
        else:
            self.assertEqual(first["status"], "session_changed")
            self.assertFalse(wake["delivered"])
            rebound = change in {"replacement", "rebind"}
            self.assertEqual(later["status"], "delivered" if rebound else "unbound")
            self.assertEqual(len(prompts), 2 if rebound else 1)

    def test_driver_renewal_during_lookup_preserves_hint_authority(self):
        self.assert_driver_change_during_hint(stage="get")

    def test_driver_renewal_during_prompt_does_not_repeat_hint(self):
        self.assert_driver_change_during_hint()

    def test_driver_renewal_during_prompt_preserves_newer_unread_event(self):
        self.assert_driver_change_during_hint(unread=True)

    def test_driver_renewal_during_prompt_preserves_newer_acknowledgement(self):
        self.assert_driver_change_during_hint(acknowledge=True)

    def test_driver_renewal_during_prompt_accepts_older_session_records(self):
        self.assert_driver_change_during_hint(old_format=True)

    def test_driver_revocation_during_prompt_drops_endpoint(self):
        self.assert_driver_change_during_hint(change="revocation")

    def test_driver_identity_change_during_prompt_drops_endpoint(self):
        self.assert_driver_change_during_hint(change="identity")

    def test_explicit_driver_replacement_during_prompt_fences_confirmation(self):
        self.assert_driver_change_during_hint(change="replacement")

    def test_explicit_driver_rebind_during_prompt_fences_confirmation(self):
        self.assert_driver_change_during_hint(change="rebind")

    def test_retained_task_identity_change_still_drops_the_driver_endpoint(self):
        self.bind_shared_driver()
        self.handoff("A", "driver-A")  # Same actor, different native task identity.
        with patch.object(supervise, "herdr_call", side_effect=AssertionError("prompted the replaced driver")):
            self.assertEqual(notify.deliver(self.run, actor="driver-A")["status"], "unbound")
        self.assertFalse(Engine.read(self.run)["communication"]["wakes"]["driver-A"]["delivered"])
        self.driver("A", op="inbox", task_id="A")
        self.assertIsNone(notify.target(Engine.read(self.run), "driver-A"))

    def test_handoff_can_hint_remaining_tasks_before_transport_renewal(self):
        pane = self.bind_shared_driver()
        previous = self.active("driver-A")
        self.handoff("B", "driver-B")
        self.coordinator(op="message", task_id="A", action_id="continue-A", recipient="driver-A",
                         kind="assignment", body="Continue A")
        prompts = []
        def herdr(target, argv):
            if argv[1] == "prompt":
                prompts.append(target["agent"]["pane_id"])
            return {"agent": {**target["agent"], "agent_status": "idle"}}
        with patch.object(supervise, "herdr_call", side_effect=herdr):
            self.assertEqual(notify.deliver(self.run, actor="driver-A")["status"], "delivered")
        self.assertEqual(self.active("driver-A"), previous)
        self.assertEqual(prompts, [pane["agent"]["pane_id"]])

    def test_driver_identity_change_during_lookup_prevents_the_prompt(self):
        self.bind_shared_driver()
        prompts = []
        def replace(target, argv):
            if argv[1] == "get":
                self.handoff("A", "driver-A")
            else:
                prompts.append(argv)
            return {"agent": {**target["agent"], "agent_status": "idle"}}
        with patch.object(supervise, "herdr_call", side_effect=replace):
            self.assertEqual(notify.deliver(self.run, actor="driver-A")["status"], "session_changed")
        self.assertEqual(prompts, [])
        self.assertFalse(Engine.read(self.run)["communication"]["wakes"]["driver-A"]["delivered"])

    def test_explicit_revocation_does_not_restore_a_driver_endpoint(self):
        self.bind_shared_driver()
        channel.revoke(self.run, "driver-A")
        self.driver("A", op="inbox", task_id="A")
        self.assertIsNone(notify.target(Engine.read(self.run), "driver-A"))

    def test_ack_after_handoff_retires_inaccessible_positions_but_keeps_new_mail(self):
        self.bind_shared_driver()
        self.coordinator(op="message", task_id="B", action_id="old-B", recipient="driver-A",
                         kind="assignment", body="Earlier B assignment")
        self.handoff("B", "driver-B")
        self.coordinator(op="message", task_id="A", action_id="first-A", recipient="driver-A",
                         kind="assignment", body="First A assignment")
        page = self.driver("A", op="inbox", task_id="A")
        self.coordinator(op="message", task_id="A", action_id="new-A", recipient="driver-A",
                         kind="assignment", body="Newer unread A assignment")
        self.driver("A", op="ack", task_id="A", action_id="ack-first-A", cursor=page["cursor"])
        wake = Engine.read(self.run)["communication"]["wakes"]["driver-A"]
        self.assertNotIn("B", wake["tasks"])
        self.assertIn("A", wake["tasks"])
        self.assertFalse(wake["delivered"])
        page = self.driver("A", op="inbox", task_id="A")
        self.assertEqual(page["events"][-1]["message"]["id"], "new-A")
        self.driver("A", op="ack", task_id="A", action_id="ack-new-A", cursor=page["cursor"])
        wake = Engine.read(self.run)["communication"]["wakes"]["driver-A"]
        self.assertEqual(wake["tasks"], {})
        self.assertTrue(wake["delivered"])

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

    def assert_transport_change_during_hint(self, stage, renew):
        self.prepare_hint()
        if renew:
            self.coordinator(op="inbox", task_id="A")
        previous = self.active("coordinator")

        def change_session(target, argv):
            if argv[1] == stage:
                if renew:
                    channel.revoke(self.run, "coordinator")
                self.coordinator(op="inbox", task_id="A")
            return self.herdr(target, argv)

        with patch.object(supervise, "herdr_call", side_effect=change_session):
            delivered = self.tick(90)
        self.assertNotEqual(self.active("coordinator"), previous)
        self.assertEqual(delivered["channel_hint"]["status"], "delivered")
        self.assertTrue(Engine.read(self.run)["communication"]["wakes"]["coordinator"]["delivered"])
        self.tick(151)
        self.assertEqual(self.prompts, [("coordinator", "reconciliation"), ("coordinator", "hint")])

    def test_first_coordinator_transport_during_lookup_does_not_cancel_hint(self):
        self.assert_transport_change_during_hint("get", False)

    def test_first_coordinator_transport_during_prompt_does_not_repeat_hint(self):
        self.assert_transport_change_during_hint("prompt", False)

    def test_coordinator_transport_renewal_during_lookup_does_not_cancel_hint(self):
        self.assert_transport_change_during_hint("get", True)

    def test_coordinator_transport_renewal_during_prompt_does_not_repeat_hint(self):
        self.assert_transport_change_during_hint("prompt", True)

    def notify_cli(self, seconds):
        output = io.StringIO()
        with patch.object(sys, "argv", ["notify.py", "--run-dir", str(self.run), "--actor", "coordinator"]), \
                patch.object(notify, "datetime") as clock, redirect_stdout(output):
            clock.now.return_value = self.now + timedelta(seconds=seconds)
            notify.main()
        return json.loads(output.getvalue())

    def test_standalone_delivery_obeys_pending_cadence_and_stop(self):
        self.ask("first")
        wake = self.tick(0)
        self.assertEqual(self.notify_cli(90)["status"], "quiet")  # Reconciliation is pending.
        supervise.complete(self.run, wake["wake_id"], self.now + timedelta(seconds=95))
        self.assertEqual(self.notify_cli(100)["status"], "quiet")
        self.assertEqual(self.notify_cli(160)["status"], "delivered")
        self.ask("second")
        self.assertEqual(self.notify_cli(165)["status"], "quiet")
        supervise.scheduler_patch(self.run, lambda _: {"enabled": False})
        self.assertEqual(self.notify_cli(230)["status"], "quiet")
        self.assertEqual(self.prompts, [("coordinator", "reconciliation"), ("coordinator", "hint")])

    def test_standalone_delivery_holds_dispatch_ownership_and_rechecks_stop(self):
        self.prepare_hint()
        errors = []
        def compete(target, argv):
            response = self.herdr(target, argv)
            if argv[1] == "get":
                try:
                    self.tick(91)
                except supervise.RuntimeErrorDetail as error:
                    errors.append(error.code)
                supervise.scheduler_patch(self.run, lambda _: {"enabled": False})
            return response
        with patch.object(supervise, "herdr_call", side_effect=compete):
            self.notify_cli(90)
        self.assertEqual(errors, ["already_running"])
        self.assertEqual(self.prompts, [("coordinator", "reconciliation")])
        self.assertFalse(Engine.read(self.run)["communication"]["wakes"]["coordinator"]["delivered"])

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

    def prepare_hint(self):
        supervise.complete(self.run, self.tick(0)["wake_id"], self.now + timedelta(seconds=5))
        self.ask("pending-question")

    def test_stop_during_hint_lookup_suppresses_dispatch(self):
        self.prepare_hint()
        def stop(target, argv):
            response = self.herdr(target, argv)
            if argv[1] == "get":
                supervise.scheduler_patch(self.run, lambda _: {"enabled": False})
            return response
        with patch.object(supervise, "herdr_call", side_effect=stop):
            self.tick(90)
        self.assertFalse(Engine.read(self.run)["scheduler"]["enabled"])
        self.assertEqual(self.prompts, [("coordinator", "reconciliation")])

    def test_rebind_during_hint_lookup_never_prompts_the_old_endpoint(self):
        self.prepare_hint()
        notify.bind(self.run, "coordinator", None, endpoint("coordinator", "p1"))
        def rebind(target, argv):
            response = self.herdr(target, argv)
            if argv[1] == "get":
                self.rebind_coordinator()
            return response
        with patch.object(supervise, "herdr_call", side_effect=rebind):
            self.tick(90)
        self.assertEqual(self.prompts, [("coordinator", "reconciliation")])
        self.assertEqual(self.tick(100)["channel_hint"]["status"], "delivered")
        self.assertEqual(self.prompts[-1], ("replacement", "hint"))

    def rebind_coordinator(self):
        supervise.scheduler_patch(self.run, lambda _: {"enabled": False})
        state = Engine.read(self.run)
        settings = {**state["config"]["scheduler"], **endpoint("replacement", "p4"), "enabled": True}
        Engine.apply(self.run, {"op": "configure", "action_id": "rebind", "expected_policy": state["policy_version"],
                               "fields": {"scheduler": settings}, "evidence": self.proof})

    def test_saved_coordinator_endpoint_cannot_override_scheduler_rebinding(self):
        self.prepare_hint()
        session = notify.bind(self.run, "coordinator", None, endpoint("coordinator", "p1"))
        self.rebind_coordinator()
        self.assertEqual(self.notify_cli(90)["status"], "delivered")
        self.assertEqual(self.prompts[-1], ("replacement", "hint"))
        self.assertEqual(Engine.read(self.run)["communication"]["sessions"][session]["endpoint"],
                         endpoint("coordinator", "p1"))

    def test_hint_holds_dispatch_ownership_against_a_competing_tick(self):
        self.prepare_hint()
        errors = []
        def compete(target, argv):
            response = self.herdr(target, argv)
            if argv[1] == "get":
                # Control writes remain available while the dispatch owner is
                # outside the state lock performing an external lookup.
                supervise.request_wake(self.run, "concurrent", self.now + timedelta(seconds=91))
                try:
                    self.tick(91)
                except supervise.RuntimeErrorDetail as error:
                    errors.append(error.code)
            return response
        with patch.object(supervise, "herdr_call", side_effect=compete):
            self.assertEqual(self.tick(90)["channel_hint"]["status"], "delivered")
        self.assertEqual(errors, ["already_running"])
        self.assertIsNone(Engine.read(self.run)["scheduler"].get("pending_action_id"))
        self.assertEqual(self.tick(95)["status"], "minimum_cadence")
        self.assertEqual(self.tick(151)["status"], "delivered")
        self.assertEqual(self.prompts, [("coordinator", "reconciliation"), ("coordinator", "hint"),
                                       ("coordinator", "reconciliation")])

    def test_completed_reconciliation_during_hint_lookup_rechecks_cadence(self):
        self.prepare_hint()
        def complete(target, argv):
            response = self.herdr(target, argv)
            if argv[1] == "get":
                supervise.complete(self.run, "manual", self.now + timedelta(seconds=89))
            return response
        with patch.object(supervise, "herdr_call", side_effect=complete):
            self.tick(90)
        self.assertEqual(self.prompts, [("coordinator", "reconciliation")])
        self.assertEqual(self.tick(151)["channel_hint"]["status"], "delivered")

    def test_crash_after_prompt_counts_toward_minimum_cadence(self):
        self.prepare_hint()
        class Interrupted(BaseException):
            pass
        def interrupt(target, argv):
            response = self.herdr(target, argv)
            if argv[1] == "prompt":
                raise Interrupted()
            return response
        with patch.object(supervise, "herdr_call", side_effect=interrupt):
            with self.assertRaises(Interrupted):
                self.tick(90)
        wake = Engine.read(self.run)["communication"]["wakes"]["coordinator"]
        self.assertIsNone(wake.get("last_hint_at"))
        self.assertEqual(wake["last_hint_attempt_at"], (self.now + timedelta(seconds=90)).isoformat())
        self.assertEqual(self.tick(95)["status"], "minimum_cadence")
        self.assertEqual(self.notify_cli(95)["status"], "quiet")
        self.assertEqual(self.prompts, [("coordinator", "reconciliation"), ("coordinator", "hint")])
        self.assertEqual(self.tick(151)["channel_hint"]["status"], "delivered")

    def test_crash_before_lookup_does_not_consume_prompt_cadence(self):
        self.prepare_hint()
        with patch.object(supervise, "herdr_call", side_effect=RuntimeError("interrupted before lookup")):
            with self.assertRaisesRegex(RuntimeError, "interrupted before lookup"):
                self.tick(90)
        self.assertEqual(self.tick(95)["channel_hint"]["status"], "delivered")
        self.assertEqual(self.prompts, [("coordinator", "reconciliation"), ("coordinator", "hint")])


if __name__ == "__main__":
    unittest.main()
