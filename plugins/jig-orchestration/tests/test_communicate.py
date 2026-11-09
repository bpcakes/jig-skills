"""Client deadlines against real stalled, trickling and interrupted sockets."""
import json
import os
import socket
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

from test_channel import ChannelFixture, Engine, SCRIPTS, channel, communicate, gateway


class ClientDeadlineTests(ChannelFixture, unittest.TestCase):
    def responder(self, respond):
        endpoint = str(self.root / ("delayed-" + str(time.monotonic_ns()) + ".sock"))
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(endpoint)
        server.listen()
        server.settimeout(2)
        stopped = threading.Event()
        failures = []

        def serve():
            try:
                with server.accept()[0] as peer:
                    peer.settimeout(2)
                    with peer.makefile("rb") as stream:
                        request = json.loads(stream.readline())
                    respond(peer, request, stopped)
            except (BrokenPipeError, ConnectionResetError):
                pass  # The deadline intentionally closes the client connection.
            except Exception as error:
                failures.append(error)

        worker = threading.Thread(target=serve)
        worker.start()

        def cleanup():
            stopped.set()
            worker.join(3)
            server.close()
            self.assertFalse(worker.is_alive())
            self.assertFalse(failures, failures)

        self.addCleanup(cleanup)
        return endpoint

    def test_default_query_deadline_bounds_a_stalled_response(self):
        endpoint = self.responder(lambda peer, request, stopped: stopped.wait(2))
        started = time.monotonic()
        with patch.object(communicate, "DEFAULT_TIMEOUT", .15), self.assertRaises(communicate.RequestTimeout):
            communicate.request({"op": "query"}, socket_path=endpoint, credential="fixture.token")
        self.assertLess(time.monotonic() - started, 1)

    def test_partial_response_cannot_extend_the_total_deadline(self):
        def trickle(peer, request, stopped):
            for byte in b'{"protocol":1,"content":"' + b'x' * 100 + b'"}\n':
                peer.sendall(bytes([byte]))
                if stopped.wait(.025):
                    break

        endpoint = self.responder(trickle)
        started = time.monotonic()
        with self.assertRaises(communicate.RequestTimeout):
            communicate.request({"op": "query"}, socket_path=endpoint, credential="fixture.token", timeout=.2)
        self.assertLess(time.monotonic() - started, 1)

    def test_cli_reports_a_deadline_without_claiming_cancellation(self):
        endpoint = self.responder(lambda peer, request, stopped: stopped.wait(2))
        credential = self.root / "probe-credential"
        credential.write_text("fixture.token")
        result = subprocess.run([sys.executable, "-B", str(SCRIPTS / "communicate.py"),
                                 "--timeout", ".15", "--json", '{"op":"query"}'],
                                capture_output=True, text=True, timeout=2,
                                env={**os.environ, "ORCHESTRATION_SOCKET": endpoint,
                                     "ORCHESTRATION_CREDENTIAL_FILE": str(credential)})
        self.assertEqual(result.returncode, 1, result.stderr)
        response = json.loads(result.stdout)
        self.assertEqual(response["error"], "request_timeout")
        self.assertIn("no operation was cancelled", response["message"])

    def test_execute_and_watch_allow_a_longer_response_than_an_ordinary_query(self):
        def delayed(peer, request, stopped):
            stopped.wait(.15)
            peer.sendall(b'{"protocol":1,"completed":true}\n')

        for operation in ("execute", "watch"):
            with self.subTest(operation=operation):
                endpoint = self.responder(delayed)
                with patch.object(communicate, "DEFAULT_TIMEOUT", .02):
                    result = communicate.request({"op": operation, "action_id": "original"},
                                                 socket_path=endpoint, credential="fixture.token")
                self.assertTrue(result["completed"])

    def test_lost_mutation_reply_replays_the_original_effect_once(self):
        self.socket_server()
        token = channel.issue(self.run, "driver-A")
        state = Engine.read(self.run)
        request = {"op": "observe", "task_id": "A", "action_id": "lost-response",
                   "expected_policy": state["policy_version"], "expected_task": state["tasks"]["A"]["version"],
                   "fields": {"next_action": "review"}, "evidence": self.proof}
        original_reply, accepted = gateway.reply, []

        def drop_first(peer, result):
            accepted.append(result)
            if len(accepted) == 1:
                peer.close()
            else:
                original_reply(peer, result)

        with patch.object(gateway, "reply", side_effect=drop_first):
            result = communicate.request(request, socket_path=str(self.run / "endpoint/gateway.sock"),
                                         credential=token, timeout=2)
        self.assertNotIn("error", result)
        self.assertEqual(len(accepted), 2)
        self.assertEqual(accepted[0], accepted[1])
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["version"], state["tasks"]["A"]["version"] + 1)

    def test_invalid_deadlines_are_rejected_before_connecting(self):
        for timeout in (0, -1, True, float("inf"), float("nan")):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                communicate.request({"op": "query"}, timeout=timeout)
