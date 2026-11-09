"""Protocol rejection, legacy receipts and draining a run without losing jobs."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
import unittest

import test_channel
from test_channel import ChannelFixture, Engine, StateError, channel, communicate, isolation
import capabilities
from state import locked, read_json, write_atomic


class CompatibilityTests(ChannelFixture, unittest.TestCase):
    def test_legacy_long_action_ids_remain_replayable(self):
        task = Engine.read(self.run)["tasks"]["A"]
        request = {"op": "observe", "action_id": "historical-" + "é" * 200, "task_id": "A",
                   "expected_policy": 1, "expected_task": task["version"], "fields": {"next_action": "review"},
                   "evidence": self.proof}
        first = Engine.apply(self.run, request, "driver-A")
        self.assertEqual(Engine.apply(self.run, request, "driver-A"), first)
        self.assertEqual(Engine.action(self.run, request["action_id"])["result"], first)
        with self.assertRaises(StateError) as caught:
            Engine.apply(self.run, {**request, "fields": {"next_action": "changed"}}, "driver-A")
        self.assertEqual(caught.exception.code, "duplicate")

    def test_incompatible_request_cannot_mutate_state(self):
        self.socket_server()
        token = channel.issue(self.run, "coordinator")
        before = Engine.read(self.run)
        for version in (communicate.PROTOCOL + 1, True, float(communicate.PROTOCOL), None):
            with self.subTest(version=version), socket.socket(socket.AF_UNIX) as connection:
                connection.settimeout(5)
                connection.connect(str(self.run / "endpoint/gateway.sock"))
                connection.sendall((json.dumps({"protocol": version, "credential": token, "request": {
                    "op": "control", "control": "cancel", "action_id": "wrong-version", "expected_policy": 1}}) + "\n").encode())
                with connection.makefile("rb") as stream:
                    result = json.loads(stream.readline())
                self.assertEqual(result["error"], "protocol")
        self.assertEqual(Engine.read(self.run), before)
        self.assertNotIn("error", self.call(token, op="query"))

    def client_response(self, version, *, cli=False):
        endpoint = self.root / "incompatible.sock"
        failures = []
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(str(endpoint))
            server.listen()
            server.settimeout(5)

            def reply():
                try:
                    with server.accept()[0] as peer:
                        peer.settimeout(5)
                        with peer.makefile("rb") as stream:
                            stream.readline()
                        peer.sendall((json.dumps({"protocol": version, "accepted": True}) + "\n").encode())
                except Exception as error:
                    failures.append(error)

            worker = threading.Thread(target=reply)
            worker.start()
            try:
                if cli:
                    credential = self.root / "test-credential"
                    credential.write_text("fixture.token")
                    return subprocess.run([sys.executable, "-B", str(test_channel.SCRIPTS / "communicate.py"),
                                           "--json", '{"op":"query"}'], capture_output=True, text=True, timeout=10,
                                          env={**os.environ, "ORCHESTRATION_SOCKET": str(endpoint),
                                               "ORCHESTRATION_CREDENTIAL_FILE": str(credential)})
                return communicate.request({"op": "query"}, socket_path=str(endpoint), credential="fixture.token", timeout=2)
            finally:
                worker.join(6)
                endpoint.unlink()
                self.assertFalse(worker.is_alive())
                self.assertFalse(failures, failures)

    def test_client_rejects_noninteger_and_unknown_response_versions(self):
        for version in (True, float(communicate.PROTOCOL), communicate.PROTOCOL + 1, None):
            with self.subTest(version=version), self.assertRaisesRegex(ValueError, "Incompatible orchestration protocol"):
                self.client_response(version)

    def test_installed_client_reports_protocol_error_without_fallback(self):
        result = self.client_response(communicate.PROTOCOL + 1, cli=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)["error"], "protocol")

    def test_old_delivery_without_position_preserves_evidence_and_stop_controls(self):
        self.socket_server()
        coordinator = channel.issue(self.run, "coordinator")
        driver = channel.issue(self.run, "driver-A")
        self.assertTrue(self.call(driver, op="message", task_id="A", action_id="old-question",
                                 recipient="coordinator", kind="question", body="Keep the original evidence")["accepted"])
        artifact = self.call(driver, op="artifact_put", task_id="A", action_id="old-artifact", content="original evidence")
        identifier = artifact["artifact"]["id"]
        # The first protocol implementation retained records without sequence
        # numbers. Once their events are gone their position cannot be guessed.
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            current = state["communication"]
            current["messages"]["old-question"].pop("sequence")
            current["artifacts"][identifier].pop("sequence")
            current["floor"] = current["sequence"]
            current["events"] = []
            write_atomic(path / "state.json", state)
        before = (self.run / "state.json").read_bytes()
        refused = self.call(coordinator, op="inbox", task_id="A")
        self.assertEqual(refused["error"], "incompatible")
        self.assertEqual((self.run / "state.json").read_bytes(), before)
        self.assertEqual(self.call(coordinator, op="message_read", task_id="A", message_id="old-question")["message"]["body"],
                         "Keep the original evidence")
        self.assertEqual(self.call(coordinator, op="artifact_read", task_id="A", artifact_id=identifier)["content"], "original evidence")
        self.assertNotIn("error", self.call(coordinator, op="control", control="pause", action_id="stop-old-run", expected_policy=1))


class RollbackTests(ChannelFixture, unittest.TestCase):
    setUpClass = classmethod(test_channel.IsolationTests.setUpClass.__func__)

    def setUp(self):
        super().setUp()
        self.run = self.root / "enforced-run"
        self.config["communication"] = {"mode": "enforced"}
        self.config["hosts"]["local"]["execution"] = {"kind": "local"}
        Engine.initialize(self.run, self.config)
        for name in ("A", "B"):
            subprocess.run(["git", "init", "-q", "-b", "main", str(self.trees / name)], check=True)
        capabilities.verify(self.run, "local")

    def admit(self, name):
        return Engine.apply(self.run, {"op": "admit", "action_id": "admit-" + name,
            "expected_policy": Engine.read(self.run)["policy_version"],
            "task_id": name, "driver": "driver-" + name, "host": "local", "worktree": str(self.trees / name),
            "branch": "task/" + name, "claim": {**self.proof, "authority": "fixture", "task_id": name,
            "owner": "driver-" + name, "confirmed": True, "ready": True, "unpublished": False}})

    def test_historical_long_receipt_replay_still_checks_authentication(self):
        # Construct an old receipt in the original legacy fixture, then enable
        # enforcement only in this disposable test fixture. This does not add
        # an upgrade path to the production API.
        self.run = self.root / "run"
        token = channel.issue(self.run, "driver-A")
        session = channel.parse_credential(token)
        task = Engine.read(self.run)["tasks"]["A"]
        request = {"op": "observe", "action_id": "historical-" + "é" * 200, "task_id": "A",
                   "expected_policy": 1, "expected_task": task["version"], "fields": {"next_action": "review"},
                   "evidence": self.proof}
        original = Engine.apply(self.run, request, "driver-A", session=session)
        self.verify_enforcement()
        self.socket_server()
        replay = self.call(token, **request)
        self.assertEqual({key: value for key, value in replay.items() if key != "protocol"}, original)
        fresh = self.call(token, **{**request, "action_id": "new-" + "é" * 200})
        self.assertEqual(fresh["error"], "invalid")
        self.assertIsNone(Engine.action(self.run, "new-" + "é" * 200))
        channel.issue(self.run, "driver-A")
        self.assertEqual(self.call(token, **request)["error"], "session_revoked")

    def test_old_child_without_parent_binding_requires_new_authority(self):
        self.admit("A")
        parent = channel.parse_credential(channel.issue(self.run, "driver-A"))
        token = channel.issue(self.run, "executor-A", role="executor", task_ids=["A"], parent_session=parent)
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            state["communication"]["sessions"][channel.parse_credential(token).id].pop("parent_session")
            write_atomic(path / "state.json", state)
        self.socket_server()
        denied = self.call(token, op="query", task_id="A")
        self.assertEqual(denied.get("error"), "incompatible", denied)
        replacement = channel.issue(self.run, "executor-A", role="executor", task_ids=["A"], parent_session=parent)
        self.assertNotIn("error", self.call(replacement, op="query", task_id="A"))
        self.assertEqual(self.call(token, op="query", task_id="A")["error"], "session_revoked")

    def test_finish_current_preserves_running_boundary_across_gateway_restart(self):
        self.admit("A")
        server = self.socket_server()
        coordinator = channel.issue(self.run, "coordinator")
        prepared = isolation.prepare(self.run, "driver-A", "A")
        spec = (prepared / "launch.json").read_bytes()
        results, failures = [], []
        source = """from pathlib import Path
import sys, time
sys.path.insert(0, '/opt/orchestration')
import communicate
Path('started').touch()
while not Path('continue').exists(): time.sleep(.02)
assert not Path(HOST_STATE).exists()
assert communicate.request({'op':'query','task_id':'A'})['task']['id'] == 'A'
assert communicate.request({'op':'message','task_id':'A','action_id':'after-restart',
    'recipient':'coordinator','kind':'update','body':'completed in original boundary'})['accepted']
Path('completed').write_text('one effect')
""".replace("HOST_STATE", repr(str(self.run / "state.json")))

        def launch():
            try:
                results.append(isolation.launch(prepared, ["/usr/bin/python3", "-B", "-c", source],
                                                capture_output=True, text=True, timeout=15))
            except Exception as error:
                failures.append(error)

        worker = threading.Thread(target=launch)
        worker.start()
        try:
            deadline = time.monotonic() + 5
            while not (self.trees / "A/started").exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue((self.trees / "A/started").exists(), failures)
            stopped = self.call(coordinator, op="control", control="finish_current", action_id="rollback-admissions", expected_policy=1)
            self.assertNotIn("error", stopped)
            with self.assertRaises(StateError) as caught:
                self.admit("B")
            self.assertEqual(caught.exception.code, "admission")
            with self.assertRaises(StateError) as caught:
                Engine.apply(self.run, {"op":"configure", "action_id":"unsafe-downgrade",
                                       "expected_policy":Engine.read(self.run)["policy_version"],
                                       "fields":{"communication":{"mode":"legacy"}}, "evidence":self.proof})
            self.assertEqual(caught.exception.code, "invalid")
            self.stop_server(server)
            self.socket_server()
            self.assertEqual((prepared / "launch.json").read_bytes(), spec)
        finally:
            (self.trees / "A/continue").touch()
            worker.join(17)
        self.assertFalse(worker.is_alive())
        self.assertFalse(failures, failures)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].returncode, 0, results[0].stderr)
        self.assertEqual((self.trees / "A/completed").read_text(), "one effect")
        state = Engine.read(self.run)
        self.assertEqual(state["config"]["communication"]["mode"], "enforced")
        self.assertEqual(state["controls"]["admission"], "finish_current")
        self.assertTrue(state["communication"]["jobs"][prepared.name]["local_settled"])
        inbox = self.call(coordinator, op="inbox", task_id="A")
        self.assertIn("completed in original boundary", json.dumps(inbox))
