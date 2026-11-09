"""Real sandbox/proxy transport checks and destination rejection."""
import json
import socket
import threading
import time
import unittest
from unittest.mock import patch

import test_channel
from test_channel import ChannelFixture, channel, isolation, StateError, Engine
import egress


class DestinationTests(unittest.TestCase):
    def test_rejects_ip_literals_and_mixed_public_private_dns(self):
        for host in ("127.0.0.1", "[::1]", "user@api.example.com", "api.example.com/path", "*.example.com"):
            with self.subTest(host=host), self.assertRaises(StateError):
                egress.destination(host)
        addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (host, 443))
                     for host in ("1.1.1.1", "127.0.0.1")]
        with patch.object(socket, "getaddrinfo", return_value=addresses), self.assertRaisesRegex(StateError, "non-public"):
            egress.connect("api.example.com")


class EgressTests(ChannelFixture, unittest.TestCase):
    setUpClass = classmethod(test_channel.IsolationTests.setUpClass.__func__)

    def test_isolated_proxy_uses_only_granted_destination(self):
        self.proxy_roundtrip("driver-A", "A")

    def test_taskless_coordinator_proxy_works_before_task_admission(self):
        self.run = self.root / "before-admission"
        Engine.initialize(self.run, self.config)
        self.assertFalse(Engine.read(self.run)["tasks"])
        self.proxy_roundtrip("coordinator", None)

    def proxy_roundtrip(self, actor, task_id):
        self.socket_server()
        directory = isolation.prepare(self.run, actor, task_id, egress_hosts=["api.example.com"])
        accepted = []
        def upstream(host):
            accepted.append(host)
            client, server = socket.socketpair()
            def echo():
                with server:
                    server.settimeout(3)
                    server.recv(4)
                    server.sendall(b"pong")
            thread = threading.Thread(target=echo, daemon=True)
            thread.start()
            return client
        program = """
import os, socket, urllib.parse
proxy = urllib.parse.urlsplit(os.environ['HTTPS_PROXY'])
for destination in ('api.example.com', 'ungranted.example.com'):
    with socket.create_connection((proxy.hostname, proxy.port), timeout=3) as connection:
        connection.sendall(('CONNECT ' + destination + ':443 HTTP/1.1\\r\\nHost: ' + destination + '\\r\\n\\r\\n').encode())
        header = b''
        while not header.endswith(b'\\r\\n\\r\\n'):
            header += connection.recv(1)
        if destination == 'api.example.com':
            assert b'200' in header, header
            connection.sendall(b'ping')
            assert connection.recv(4) == b'pong'
        else:
            assert b'403' in header, header
print('granted-only')
"""
        with patch.object(egress, "connect", side_effect=upstream):
            result = isolation.launch(directory, ["/usr/bin/python3", "-c", program],
                                      capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "granted-only")
        self.assertEqual(accepted, ["api.example.com"])

    def test_revocation_closes_existing_tunnel(self):
        self.tunnel_revocation(contended=False)

    def test_state_contention_pauses_traffic_then_recovers_and_still_revokes(self):
        self.tunnel_revocation(contended=True)

    def tunnel_revocation(self, *, contended):
        self.socket_server()
        token = channel.issue(self.run, "driver-A", egress_hosts=["api.example.com"])
        upstream, held = socket.socketpair()
        self.addCleanup(held.close)
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(connection.close)
        connection.settimeout(3)
        connection.connect(str(self.run / "endpoint/gateway.sock"))
        with patch.object(egress, "connect", return_value=upstream):
            envelope = {"protocol": 1, "credential": token,
                        "request": {"op": "egress", "task_id": "A", "host": "api.example.com"}}
            connection.sendall((json.dumps(envelope) + "\n").encode())
            response = bytearray()
            while not response.endswith(b"\n"):
                response.extend(connection.recv(1))
            self.assertTrue(json.loads(response)["connected"])
            if contended:
                from state import locked
                with locked(self.run):
                    time.sleep(.8)  # Exceed the gateway's state-read timeout.
                    connection.sendall(b"after-lock")
                    held.settimeout(.7)
                    with self.assertRaises(socket.timeout):
                        held.recv(10)
                held.settimeout(3)
                self.assertEqual(held.recv(10), b"after-lock")
                held.sendall(b"recovered")
                self.assertEqual(connection.recv(9), b"recovered")
            channel.revoke(self.run, "driver-A")
            self.assertEqual(connection.recv(1), b"")


if __name__ == "__main__":
    unittest.main()
