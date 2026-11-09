"""Provider-only HTTPS tunnels through the authenticated orchestration gateway.

The host checks exact destinations and resolves addresses before opening a socket.
Inside the private network namespace a small CONNECT proxy adapts standard CLI
HTTPS proxy support to that protocol. It cannot grant another destination.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import select
import socket
import socketserver
import subprocess
import threading
import time

import channel
from communicate import PROTOCOL
from state import Engine, StateError, canonical, require


def destination(host):
    require(isinstance(host, str) and 0 < len(host) <= 253 and host == host.lower()
            and all(label and len(label) <= 63 and label[0].isalnum() and label[-1].isalnum()
                    and all(char.isascii() and (char.isalnum() or char == "-") for char in label)
                    for label in host.split(".")), "egress", "destination must be an exact lowercase DNS name")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return host
    raise StateError("egress", "IP literal destinations are not permitted")


def connect(host):
    destination(host)
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    require(addresses and all(ipaddress.ip_address(item[4][0]).is_global for item in addresses),
            "egress", "destination resolved to a non-public address")
    last_error = None
    for family, kind, protocol, _, address in addresses:
        connection = socket.socket(family, kind, protocol)
        try:
            connection.settimeout(10)
            connection.connect(address)  # Use this validated address; do not resolve again.
            return connection
        except OSError as error:
            connection.close()
            last_error = error
    raise StateError("egress", "provider connection failed") from last_error


def pump(left, right, *, check=None, idle_seconds=300):
    """Bounded backpressure in both directions; no unbounded output buffering."""
    sockets = (left, right)
    pending = {left: bytearray(), right: bytearray()}
    reading = set(sockets)
    closing = set()
    for connection in sockets:
        connection.setblocking(False)
    progress = time.monotonic()
    checked = 0
    while time.monotonic() - progress < idle_seconds:
        if check is not None and time.monotonic() - checked >= .25:
            deadline = time.monotonic() + 5
            while True:
                try:
                    check()
                    break
                except StateError as error:
                    if error.code != "state_busy" or time.monotonic() >= deadline:
                        raise
                    # Authorization is unknown. Pause forwarding, retain bounded
                    # buffers, and retry; definite revocation still closes now.
                    time.sleep(.05)
            checked = time.monotonic()
        for target in list(closing):
            if not pending[target]:
                target.shutdown(socket.SHUT_WR)
                closing.remove(target)
        if not reading and not any(pending.values()):
            return
        readable = [source for source, target in ((left, right), (right, left))
                    if source in reading and len(pending[target]) < 65536]
        writable = [connection for connection in sockets if pending[connection]]
        ready_read, ready_write, _ = select.select(readable, writable, sockets, .1)
        for connection in ready_write:
            sent = connection.send(pending[connection])
            del pending[connection][:sent]
            progress = time.monotonic()
        for source in ready_read:
            target = right if source is left else left
            chunk = source.recv(65536 - len(pending[target]))
            if not chunk:
                reading.remove(source)
                closing.add(target)
                continue
            pending[target].extend(chunk)
            progress = time.monotonic()


def serve(run_dir, session, request, connection, stopping):
    host, task_id = request.get("host"), request.get("task_id")
    destination(host)
    require(request.get("port", 443) == 443, "egress", "only HTTPS port 443 is permitted")
    def authorized():
        require(not stopping.is_set(), "restarting", "gateway is stopping")
        principal = channel.check(Engine.read(run_dir), session, operation="egress", task_id=task_id)
        require(host in principal.get("egress_hosts", []), "egress", "provider destination is not granted to this session")
    authorized()
    with connect(host) as upstream:
        authorized()
        connection.settimeout(2)
        connection.sendall((canonical({"protocol": PROTOCOL, "connected": True}) + "\n").encode())
        try:
            pump(connection, upstream, check=authorized)
        except (OSError, StateError):
            pass  # After CONNECT, close the stream; do not inject JSON into TLS.


def gateway_tunnel(host):
    credential = Path(os.environ["ORCHESTRATION_CREDENTIAL_FILE"]).read_text().strip()
    envelope = {"protocol": PROTOCOL, "credential": credential,
                "request": {"op": "egress", "task_id": os.environ.get("ORCHESTRATION_TASK"), "host": host, "port": 443}}
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        connection.settimeout(15)
        connection.connect(os.environ["ORCHESTRATION_SOCKET"])
        connection.sendall((canonical(envelope) + "\n").encode())
        # No buffered file reader: TLS bytes after the handshake must not be lost.
        response = bytearray()
        while len(response) < 4096:
            char = connection.recv(1)
            if not char:
                break
            response.extend(char)
            if char == b"\n":
                break
        result = json.loads(response)
        require(result.get("protocol") == PROTOCOL and result.get("connected") is True,
                "egress", "gateway did not permit the provider tunnel")
        return connection
    except BaseException:
        connection.close()
        raise


class ProxyHandler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(10)
        connected = False
        try:
            line = self.rfile.readline(2049)
            require(len(line) <= 2048, "egress", "oversized proxy request")
            method, target, version = line.decode("ascii").strip().split(" ")
            require(method == "CONNECT" and version in {"HTTP/1.0", "HTTP/1.1"}, "egress", "HTTPS CONNECT required")
            host, port = target.rsplit(":", 1)
            require(port == "443", "egress", "only HTTPS port 443 is permitted")
            destination(host)
            size = 0
            while True:
                line = self.rfile.readline(2049)
                size += len(line)
                require(line and size <= 8192, "egress", "invalid proxy headers")
                if line in {b"\r\n", b"\n"}:
                    break
            with gateway_tunnel(host) as tunnel:
                self.connection.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                connected = True
                pump(self.connection, tunnel)
        except (OSError, ValueError, KeyError):
            if not connected:
                try:
                    self.connection.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                except OSError:
                    pass


class Proxy(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = False

    def __init__(self):
        self.capacity = threading.BoundedSemaphore(8)
        super().__init__(("127.0.0.1", 0), ProxyHandler)

    def process_request(self, request, client_address):
        if not self.capacity.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.capacity.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.capacity.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("argv", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
    require(command, "invalid", "provider command is required")
    with Proxy() as proxy:
        thread = threading.Thread(target=proxy.serve_forever, kwargs={"poll_interval": .1}, daemon=True)
        thread.start()
        address = "http://127.0.0.1:" + str(proxy.server_address[1])
        environment = {**os.environ, "HTTPS_PROXY": address, "HTTP_PROXY": address,
                       "https_proxy": address, "http_proxy": address, "NO_PROXY": "", "no_proxy": ""}
        try:
            return subprocess.run(command, env=environment).returncode
        finally:
            proxy.shutdown()
            thread.join(2)


if __name__ == "__main__":
    raise SystemExit(main())
