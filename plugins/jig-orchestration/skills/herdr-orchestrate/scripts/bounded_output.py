"""Drain process output to bounded private logs without accepting partial evidence."""
from contextlib import contextmanager, ExitStack
import os
from pathlib import Path
import selectors
import threading
import time

from state import require


LIMIT = 1024 * 1024


class Logs:
    def __init__(self):
        self.streams = []
        self.records = {}

    @property
    def complete(self):
        return all(record["complete"] for record in self.records.values())


def drain(reader, sink, record, stop, limit):
    eof = False
    selector = None
    try:
        os.set_blocking(reader, False)
        selector = selectors.DefaultSelector()
        selector.register(reader, selectors.EVENT_READ)
        while not stop.is_set():
            if not selector.select(.1):
                continue
            try:
                chunk = os.read(reader, 65536)
            except BlockingIOError:
                continue
            if not chunk:
                eof = True
                break
            record["bytes_seen"] += len(chunk)
            room = max(0, limit - record["retained_bytes"])
            record["truncated"] |= len(chunk) > room
            if record.get("error"):
                continue  # Keep draining after a disk error so the child can settle.
            remaining = memoryview(chunk)[:room]
            try:
                while remaining:
                    written = sink.write(remaining)
                    if not written:
                        raise OSError("log write made no progress")
                    record["retained_bytes"] += written
                    remaining = remaining[written:]
            except OSError as error:
                record["error"] = str(error)[:256]
    except (OSError, ValueError) as error:
        record["error"] = str(error)[:256]
    finally:
        record["complete"] = eof and not record["truncated"] and not record.get("error")
        if selector is not None:
            selector.close()
        os.close(reader)


@contextmanager
def bounded_logs(stdout, stderr, *, limit=LIMIT):
    """Keep file-backed prefixes, drain both streams, and disclose any data loss.

    Writers inherit pipes, never the log file descriptors. Parent loss can lose
    in-flight bytes; a completed capture is therefore required before parsing.
    """
    require(type(limit) is int and limit > 0, "output", "log limit must be a positive byte count")
    logs, workers, sinks, stop = Logs(), [], [], threading.Event()
    with ExitStack() as resources:
        try:
            for name, path in (("stdout", stdout), ("stderr", stderr)):
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                sink = resources.enter_context(os.fdopen(fd, "wb", buffering=0))
                reader, writer = os.pipe()
                stream = os.fdopen(writer, "wb", buffering=0)
                logs.streams.append(stream)
                record = {"path": str(path), "limit_bytes": limit, "bytes_seen": 0,
                          "retained_bytes": 0, "truncated": False, "complete": False}
                logs.records[name] = record
                sinks.append((sink, record))
                worker = threading.Thread(target=drain, args=(reader, sink, record, stop, limit), daemon=True)
                worker.start()
                workers.append(worker)
            yield logs
        finally:
            for stream in logs.streams:
                stream.close()
            deadline = time.monotonic() + 2
            for worker in workers:
                worker.join(max(0, deadline - time.monotonic()))
            stop.set()  # A surviving descendant may still hold a writer open.
            for worker in workers:
                worker.join(1)
            require(not any(worker.is_alive() for worker in workers),
                    "output", "log capture could not settle; output completeness is unknown")
            for sink, record in sinks:
                try:
                    os.fsync(sink.fileno())
                except OSError as error:
                    record["error"] = str(error)[:256]
                    record["complete"] = False
            for parent in {Path(stdout).parent, Path(stderr).parent}:
                try:
                    fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
                    try:
                        os.fsync(fd)
                    finally:
                        os.close(fd)
                except OSError as error:
                    for record in logs.records.values():
                        record["error"] = str(error)[:256]
                        record["complete"] = False
