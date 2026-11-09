#!/usr/bin/env python3
"""The agent-facing client: one JSON request in, one JSON response out."""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import socket
import sys
import time

MAX_FRAME = 1024 * 1024
PROTOCOL = 1
DEFAULT_TIMEOUT = 30
WATCH_TIMEOUT = 35
EXECUTE_TIMEOUT = 3600


class ProtocolError(ValueError):
    code = "protocol"


class RequestTimeout(TimeoutError):
    code = "request_timeout"


def remaining(deadline):
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise RequestTimeout("Gateway request deadline exceeded; no operation was cancelled. "
                             "Inspect or retry a mutation using its original action_id.")
    return seconds


def _request_once(payload, *, socket_path=None, credential=None, deadline):
    socket_path = socket_path or os.environ["ORCHESTRATION_SOCKET"]
    if credential is None:
        credential = Path(os.environ["ORCHESTRATION_CREDENTIAL_FILE"]).read_text().strip()
    wire = json.dumps({"protocol": PROTOCOL, "credential": credential, "request": payload},
                      separators=(",", ":"), allow_nan=False).encode() + b"\n"
    if len(wire) > MAX_FRAME:
        raise ValueError("Request exceeds one MiB")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(remaining(deadline))
        connection.connect(socket_path)
        connection.settimeout(remaining(deadline))
        connection.sendall(wire)
        response = bytearray()
        while len(response) <= MAX_FRAME and b"\n" not in response:
            # A trickle of bytes must not renew the whole request's deadline.
            connection.settimeout(remaining(deadline))
            chunk = connection.recv(min(65536, MAX_FRAME + 1 - len(response)))
            if not chunk:
                break
            response.extend(chunk)
        response = bytes(response).split(b"\n", 1)[0] + (b"\n" if b"\n" in response else b"")
    if not response.endswith(b"\n"):
        raise ConnectionError("Gateway disconnected before a complete response")
    if len(response) > MAX_FRAME:
        raise ValueError("Oversized gateway response")
    result = json.loads(response)
    if (not isinstance(result, dict) or type(result.get("protocol")) is not int
            or result["protocol"] != PROTOCOL):
        raise ProtocolError("Incompatible orchestration protocol")
    return result


def request(payload, *, socket_path=None, credential=None, timeout=None):
    # Reconnect only reads or requests carrying their original durable action id.
    # A protocol/authentication error never selects a weaker transport.
    safe = payload.get("op") in {"context", "query", "watch", "inbox", "message_read", "artifact_read", "view_read", "result"} or bool(payload.get("action_id"))
    if timeout is None:
        timeout = {"watch": WATCH_TIMEOUT, "execute": EXECUTE_TIMEOUT}.get(payload.get("op"), DEFAULT_TIMEOUT)
    if type(timeout) not in {int, float} or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("Request timeout must be a finite positive number of seconds")
    started = time.monotonic()
    deadline, retry_deadline = started + timeout, started + min(5, timeout)
    while True:
        try:
            result = _request_once(payload, socket_path=socket_path, credential=credential, deadline=deadline)
            if result.get("error") != "restarting" or not safe or time.monotonic() >= retry_deadline:
                return result
        except OSError:
            remaining(deadline)
            if not safe or time.monotonic() >= retry_deadline:
                raise
        time.sleep(min(.1, remaining(deadline)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, help="Total seconds per request, including reconnection; does not cancel work")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--request", default="-", help="JSON file, or - for stdin")
    source.add_argument("--json", help="One JSON request argument, without shell input redirection")
    args = parser.parse_args()
    if args.json is not None:
        raw = args.json
    elif args.request == "-":
        raw = sys.stdin.read(MAX_FRAME + 1)
    else:
        with open(args.request, encoding="utf-8") as stream:
            raw = stream.read(MAX_FRAME + 1)
    if len(raw.encode()) > MAX_FRAME:
        raise ValueError("Request exceeds one MiB")
    payload = json.loads(raw)
    while True:
        result = request(payload, timeout=args.timeout)
        if payload.get("op") != "watch" or not payload.get("until_change") or result.get("changed") or "error" in result:
            break
        if payload.get("view") == "inbox":
            payload["after"] = result["cursor"]
    print(json.dumps(result, sort_keys=True))
    return 1 if "error" in result else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError) as error:
        print(json.dumps({"error": getattr(error, "code", "channel_unavailable"), "message": str(error)}))
        raise SystemExit(1)
