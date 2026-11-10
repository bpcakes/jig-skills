"""Behavioral and crash-boundary checks for durable scoped communication."""
from concurrent.futures import ThreadPoolExecutor
import json
import threading
import time
import unittest
from unittest.mock import patch

from test_channel import ChannelFixture, channel, Engine, gateway
import protocol
import state as state_module


class ProtocolTests(ChannelFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.server = self.socket_server()
        self.coordinator = channel.issue(self.run, "coordinator")
        self.drivers = {task: channel.issue(self.run, "driver-" + task) for task in ("A", "B")}

    def message(self, task="A", action_id="question", **fields):
        return self.call(self.drivers[task], op="message", task_id=task, action_id=action_id,
                         recipient="coordinator", kind="question", body="Which interface?", **fields)

    def test_two_tasks_exchange_private_questions_and_replies(self):
        versions = {task: Engine.read(self.run)["tasks"][task]["version"] for task in ("A", "B")}
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda task: self.message(task, "question-" + task), ("A", "B")))
        self.assertTrue(all(result.get("accepted") for result in results), results)
        for task in ("A", "B"):
            inbox = self.call(self.coordinator, op="inbox", task_id=task)
            messages = [item["message"] for item in inbox["events"] if item["kind"] == "message"]
            self.assertEqual([item["id"] for item in messages], ["question-" + task])
            reply = self.call(self.coordinator, op="message", task_id=task, action_id="reply-" + task,
                              recipient="driver-" + task, kind="reply", body="Use interface v2", reply_to="question-" + task)
            self.assertTrue(reply.get("accepted"), reply)
            received = self.call(self.drivers[task], op="inbox", task_id=task)
            self.assertEqual(received["open_questions"], [])
            self.assertEqual(received["events"][-1]["message"]["body"], "Use interface v2")
            self.assertEqual(Engine.read(self.run)["tasks"][task]["version"], versions[task])
        denied = self.call(self.drivers["A"], op="message", task_id="A", action_id="cross-task",
                           recipient="driver-B", kind="update", body="secret")
        self.assertEqual(denied["error"], "scope")

    def test_acknowledgement_survives_restart_without_claiming_effect(self):
        result = self.message()
        self.assertTrue(result.get("accepted"), result)
        first = self.call(self.coordinator, op="inbox", task_id="A")
        self.stop_server(self.server)
        self.server = self.socket_server()
        second = self.call(self.coordinator, op="inbox", task_id="A")
        self.assertEqual(first, second)
        acknowledged = self.call(self.coordinator, op="ack", task_id="A", action_id="ack-question", cursor=first["cursor"])
        self.assertFalse(acknowledged["effect_confirmed"])
        self.assertEqual(self.call(self.coordinator, op="inbox", task_id="A")["events"], [])
        self.assertEqual(self.call(self.coordinator, op="inbox", task_id="A")["open_questions"], ["question"])
        self.assertEqual(self.message(), result)
        self.assertEqual(self.call(self.coordinator, op="inbox", task_id="A")["events"], [])

    def test_outstanding_wait_reconnects_after_gateway_restart(self):
        cursor = self.call(self.coordinator, op="inbox", task_id="A")["cursor"]
        results = []
        thread = threading.Thread(target=lambda: results.append(self.call(
            self.coordinator, op="watch", task_id="A", view="inbox", after=cursor, timeout_seconds=3)))
        thread.start()
        deadline = time.monotonic() + 2
        while not self.server.active.get(("coordinator", "watch")) and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(self.server.active.get(("coordinator", "watch")), 1)
        self.stop_server(self.server)
        self.server = self.socket_server()
        self.message()
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertTrue(results[0]["changed"], results)
        self.assertEqual(results[0]["events"][0]["message"]["id"], "question")

    def test_inbox_continuation_drains_pages_then_waits_for_a_message(self):
        self.message(action_id="first")
        self.message(action_id="second")
        first = self.call(self.coordinator, op="inbox", task_id="A", limit=1)
        self.assertTrue(first["more"])
        second = self.call(self.coordinator, **first["next_request"])
        self.assertEqual([item["message_id"] for item in second["events"]], ["second"])
        self.assertFalse(second["more"])
        task_token = self.call(self.drivers["A"], op="query", task_id="A")["change_token"]
        replies = []
        waiter = threading.Thread(target=lambda: replies.append(self.call(
            self.coordinator, **{**second["next_request"], "timeout_seconds": 2})))
        waiter.start()
        deadline = time.monotonic() + 2
        while not self.server.active.get(("coordinator", "watch")) and time.monotonic() < deadline:
            time.sleep(.01)
        self.message(action_id="third")
        waiter.join(4)
        self.assertFalse(waiter.is_alive())
        self.assertTrue(replies[0]["changed"])
        self.assertEqual([item["message_id"] for item in replies[0]["events"]], ["third"])
        # Messages are deliberately independent of authoritative task versions.
        self.assertEqual(self.call(self.drivers["A"], op="query", task_id="A")["change_token"], task_token)

    def test_inbox_watch_steps_over_the_watchers_own_history(self):
        cursor = self.call(self.drivers["A"], op="inbox", task_id="A")["cursor"]
        # More of the watcher's own events than one inbox page holds.
        for index in range(20):
            self.message(action_id=f"own-{index}")
        started = time.monotonic()
        quiet = self.call(self.drivers["A"], op="watch", task_id="A", view="inbox", after=cursor, timeout_seconds=1)
        self.assertFalse(quiet["changed"])
        self.assertGreaterEqual(time.monotonic() - started, 0.9)
        replies = []
        waiter = threading.Thread(target=lambda: replies.append(self.call(
            self.drivers["A"], op="watch", task_id="A", view="inbox", after=cursor, timeout_seconds=4)))
        waiter.start()
        time.sleep(0.3)
        self.call(self.coordinator, op="message", task_id="A", action_id="answer", recipient="driver-A",
                  kind="reply", body="Use interface v2", reply_to="own-0")
        waiter.join(5)
        self.assertFalse(waiter.is_alive())
        self.assertTrue(replies[0]["changed"])
        self.assertEqual([item["message_id"] for item in replies[0]["events"]], ["answer"])
        # An explicit read still lists the sender's own messages as history.
        listed = self.call(self.drivers["A"], op="inbox", task_id="A", after=cursor, limit=32)
        self.assertEqual(len(listed["events"]), 21)

    def test_watch_rejects_misspelled_timeout_fields_without_waiting(self):
        token = self.call(self.drivers["A"], op="query", task_id="A")["change_token"]
        for spelling in ("timeout", "timeout_ms", "wait"):
            with self.subTest(spelling=spelling):
                result = self.call(self.drivers["A"], op="watch", task_id="A", after=token, **{spelling: 5})
                self.assertEqual(result["error"], "invalid")
                self.assertIn("timeout_seconds", result["message"])
                self.assertIn('view:"inbox"', result["message"])

    def test_artifact_privacy_immutability_and_complete_chunked_read(self):
        original = "alpha 🐏\n" * 5000
        uploaded = self.call(self.drivers["A"], op="artifact_put", task_id="A", action_id="artifact-a", content=original)
        identifier = uploaded["artifact"]["id"]
        read = {"op": "artifact_read", "task_id": "A", "artifact_id": identifier, "limit": 701}
        reconstructed, offset = [], 0
        while True:
            result = self.call(self.coordinator, **read, offset=offset)
            reconstructed.append(result["content"])
            offset = result["next_offset"]
            if result["complete"]:
                break
        self.assertEqual("".join(reconstructed), original)
        self.assertEqual(self.call(self.drivers["B"], **read)["error"], "wrong_task")
        reviewer = channel.issue(self.run, "review-A", role="reviewer", task_ids=["A"])
        self.assertEqual(self.call(reviewer, **read)["error"], "artifact")
        changed = self.call(self.drivers["A"], op="artifact_put", task_id="A", action_id="artifact-a", content="replacement")
        self.assertEqual(changed["error"], "duplicate")
        self.assertEqual(self.call(self.drivers["A"], op="artifact_put", task_id="A", action_id="artifact-a", content=original), uploaded)
        self.assertNotIn(original, json.dumps(self.call(self.coordinator, op="inbox", task_id="A")))

    def test_reviewers_cannot_read_peers_or_prior_session_reports(self):
        first = channel.issue(self.run, "review-one", role="reviewer", task_ids=["A"])
        second = channel.issue(self.run, "review-two", role="reviewer", task_ids=["A"])
        uploaded = self.call(first, op="artifact_put", task_id="A", action_id="review-report", content="independent findings")
        request = {"op": "artifact_read", "task_id": "A", "artifact_id": uploaded["artifact"]["id"]}
        self.assertEqual(self.call(first, **request)["content"], "independent findings")
        self.assertEqual(self.call(second, **request)["error"], "artifact")
        replacement = channel.issue(self.run, "review-one", role="reviewer", task_ids=["A"])
        self.assertEqual(self.call(replacement, **request)["error"], "artifact")
        self.assertEqual(self.call(replacement, op="inbox", task_id="A")["events"], [])

    def test_message_and_notice_commit_together_at_each_crash_boundary(self):
        for index, fail_name in enumerate(("state.json", "action")):
            request = {"op": "message", "task_id": "A", "action_id": "crash-" + str(index),
                       "recipient": "coordinator", "kind": "question", "body": "retain me"}
            write = state_module.write_atomic
            def crash(path, value, **options):
                if (fail_name == "state.json" and path.name == fail_name
                        or fail_name == "action" and path.parent.name == "actions"):
                    raise RuntimeError("simulated process crash")
                return write(path, value, **options)
            with patch.object(state_module, "write_atomic", side_effect=crash):
                with self.assertRaisesRegex(RuntimeError, "simulated process crash"):
                    channel.apply(self.run, channel.parse_credential(self.drivers["A"]), request)
            recovered = self.call(self.drivers["A"], **request)
            self.assertTrue(recovered.get("accepted"), recovered)
            inbox = self.call(self.coordinator, op="inbox", task_id="A")
            events = [item for item in inbox["events"] if item.get("message_id") == request["action_id"]]
            self.assertEqual(len(events), 1)
            self.assertTrue(Engine.read(self.run)["communication"]["wakes"]["coordinator"])

    def test_state_transition_and_notice_recover_in_same_transaction(self):
        task = Engine.read(self.run)["tasks"]["A"]
        request = {"op": "observe", "task_id": "A", "action_id": "state-crash", "expected_policy": 1,
                   "expected_task": task["version"], "fields": {"blocker": "waiting for contract"}, "evidence": self.proof}
        write = state_module.write_atomic
        def crash(path, value, **options):
            if path.name == "state.json":
                raise RuntimeError("simulated crash after journal")
            return write(path, value, **options)
        with patch.object(state_module, "write_atomic", side_effect=crash):
            with self.assertRaises(RuntimeError):
                channel.apply(self.run, channel.parse_credential(self.drivers["A"]), request)
        result = self.call(self.drivers["A"], **request)
        recovered = Engine.read(self.run)
        self.assertEqual(recovered["tasks"]["A"]["blocker"], "waiting for contract")
        notices = [item for item in recovered["communication"]["events"] if item.get("action_id") == "state-crash"]
        self.assertEqual(len(notices), 1)
        self.assertEqual(notices[0]["task_version"], result["task_version"])

    def test_evicted_cursor_requires_resync_and_keeps_unanswered_question(self):
        original = self.call(self.coordinator, op="inbox", task_id="A")["cursor"]
        self.message()
        with patch.object(protocol, "EVENT_LIMIT", 2):
            for index in range(3):
                self.call(self.drivers["A"], op="message", task_id="A", action_id="update-" + str(index),
                          recipient="coordinator", kind="update", body="still working")
        result = self.call(self.coordinator, op="inbox", task_id="A", after=original)
        self.assertTrue(result["resync_required"])
        self.assertEqual(result["open_questions"], ["question"])
        original = self.call(self.coordinator, op="message_read", task_id="A", message_id="question")
        self.assertEqual(original["message"]["body"], "Which interface?")

    def test_offline_recipient_recovers_updates_and_answers_after_other_task_eviction(self):
        before = self.call(self.drivers["A"], op="inbox", task_id="A")["cursor"]
        self.message("A", "interface-question")
        for identifier, kind, extra in (("interface-answer", "reply", {"reply_to": "interface-question"}),
                                        ("interface-update", "update", {}),
                                        ("interface-assignment", "assignment", {})):
            accepted = self.call(self.coordinator, op="message", task_id="A", action_id=identifier,
                                 recipient="driver-A", kind=kind, body="Use interface revision 2", **extra)
            self.assertTrue(accepted.get("accepted"), accepted)
        # Use the production retention window: unrelated traffic must not lose
        # an offline recipient's discoverability of already accepted messages.
        for index in range(protocol.EVENT_LIMIT + 1):
            accepted = self.call(self.drivers["B"], op="message", task_id="B", action_id=f"noise-{index}",
                                 recipient="coordinator", kind="update", body="Task B is progressing")
            self.assertTrue(accepted.get("accepted"), accepted)
        first = self.call(self.drivers["A"], op="inbox", task_id="A", after=before, limit=1)
        self.assertTrue(first["resync_required"])
        self.assertTrue(first["more"])
        self.assertEqual(first["open_questions"], [])
        self.assertEqual([item["message_id"] for item in first["events"]], ["interface-question"])
        self.stop_server(self.server)
        self.server = self.socket_server()
        previous = self.drivers["A"]
        self.drivers["A"] = channel.issue(self.run, "driver-A")
        self.assertEqual(self.call(previous, op="inbox", task_id="A", after=first["cursor"])["error"], "session_revoked")
        messages, page = [], first
        while page["more"]:
            page = self.call(self.drivers["A"], op="inbox", task_id="A", after=page["cursor"], limit=1)
            messages.extend(item["message"] for item in page["events"])
        self.assertEqual([item["id"] for item in messages],
                         ["interface-answer", "interface-update", "interface-assignment"])
        self.assertTrue(all(item["body"] == "Use interface revision 2" for item in messages))
        acknowledged = self.call(self.drivers["A"], op="ack", task_id="A", action_id="recovered-inbox", cursor=page["cursor"])
        self.assertFalse(acknowledged["effect_confirmed"])
        self.assertEqual(self.call(self.drivers["A"], op="inbox", task_id="A")["events"], [])

    def test_evicted_artifact_notices_preserve_reviewer_privacy(self):
        reviewer = channel.issue(self.run, "review-A", role="reviewer", task_ids=["A"])
        peer = channel.issue(self.run, "review-peer", role="reviewer", task_ids=["A"])
        before = self.call(reviewer, op="inbox", task_id="A")["cursor"]
        with patch.object(protocol, "EVENT_LIMIT", 2):
            own = self.call(reviewer, op="artifact_put", task_id="A", action_id="own-report", content="own finding")
            other = self.call(peer, op="artifact_put", task_id="A", action_id="peer-report", content="peer finding")
            for index in range(3):
                self.call(self.drivers["B"], op="message", task_id="B", action_id=f"noise-{index}",
                          recipient="coordinator", kind="update", body="other task")
        page = self.call(reviewer, op="inbox", task_id="A", after=before)
        self.assertTrue(page["resync_required"])
        self.assertEqual([item["artifact_id"] for item in page["events"]], [own["artifact"]["id"]])
        self.assertNotIn(other["artifact"]["id"], json.dumps(page))
        replacement = channel.issue(self.run, "review-A", role="reviewer", task_ids=["A"])
        self.assertEqual(self.call(replacement, op="inbox", task_id="A", after=before)["events"], [])


if __name__ == "__main__":
    unittest.main()
