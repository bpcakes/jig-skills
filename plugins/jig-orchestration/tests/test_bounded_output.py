"""Real process output limits and honest completeness for retained logs."""
import json
import fcntl
import os
from pathlib import Path
import subprocess
import resource
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

import test_channel
import bounded_output
from bounded_output import bounded_logs, drain
import review_controller


class BoundedOutputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.out, self.err = self.root / "stdout", self.root / "stderr"

    def test_both_streams_are_drained_without_unbounded_retention(self):
        with bounded_logs(self.out, self.err, limit=32768) as logs:
            subprocess.run([sys.executable, "-c",
                            "import os; os.write(1,b'x'*2097152); os.write(2,b'y'*3145728)"],
                           stdout=logs.streams[0], stderr=logs.streams[1], check=True, timeout=5)
        self.assertEqual(self.out.read_bytes(), b"x" * 32768)
        self.assertEqual(self.err.read_bytes(), b"y" * 32768)
        self.assertEqual(logs.records["stdout"]["bytes_seen"], 2097152)
        self.assertEqual(logs.records["stderr"]["bytes_seen"], 3145728)
        self.assertFalse(logs.complete)
        self.assertTrue(all(record["truncated"] for record in logs.records.values()))
        self.assertEqual(self.out.stat().st_mode & 0o777, 0o600)

    def test_complete_output_preserves_input_and_utf8_bytes(self):
        data = "žluťoučký\n".encode()
        with bounded_logs(self.out, self.err, limit=128) as logs:
            subprocess.run([sys.executable, "-c", "import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())"],
                           input=data, stdout=logs.streams[0], stderr=logs.streams[1], check=True, timeout=5)
        self.assertTrue(logs.complete)
        self.assertEqual(self.out.read_bytes(), data)
        self.assertEqual(logs.records["stdout"]["retained_bytes"], len(data))
        self.assertEqual(self.err.read_bytes(), b"")

    def test_child_cannot_seek_past_the_log_limit(self):
        program = '''
import errno, os
try:
    os.lseek(1, 16777216, os.SEEK_SET)
except OSError as error:
    assert error.errno == errno.ESPIPE
else:
    raise AssertionError('child received the log file descriptor')
os.write(1, b'bounded')
'''
        with bounded_logs(self.out, self.err, limit=128) as logs:
            subprocess.run([sys.executable, "-c", program], stdout=logs.streams[0], stderr=logs.streams[1],
                           check=True, timeout=5)
        self.assertTrue(logs.complete)
        self.assertEqual(self.out.read_bytes(), b"bounded")

    def test_surviving_writer_is_incomplete_and_capture_returns(self):
        process = None
        try:
            with bounded_logs(self.out, self.err, limit=128) as logs:
                process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],
                                           stdout=logs.streams[0], stderr=logs.streams[1])
            self.assertFalse(logs.complete)
            self.assertIsNone(process.poll())
        finally:
            if process is not None:
                process.kill()
                process.wait(timeout=5)

    def test_write_failure_keeps_draining_but_never_claims_complete(self):
        class FailedDisk:
            def write(self, data):
                raise OSError("injected disk-full error")
        reader, writer = os.pipe()
        record = {"bytes_seen": 0, "retained_bytes": 0, "truncated": False, "complete": False}
        worker = threading.Thread(target=drain, args=(reader, FailedDisk(), record, threading.Event(), 32768))
        worker.start()
        try:
            with os.fdopen(writer, "wb") as stream:
                stream.write(b"x" * 1048576)
        finally:
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(record["bytes_seen"], 1048576)
        self.assertFalse(record["complete"])
        self.assertIn("disk-full", record["error"])

    def test_high_numbered_descriptor_can_be_drained(self):
        if resource.getrlimit(resource.RLIMIT_NOFILE)[0] <= 1100:
            self.skipTest("host descriptor limit cannot exercise descriptors above select's ceiling")
        reader, writer = os.pipe()
        high_reader = fcntl.fcntl(reader, fcntl.F_DUPFD, 1100)
        os.close(reader)
        os.write(writer, b"complete")
        os.close(writer)
        record = {"bytes_seen": 0, "retained_bytes": 0, "truncated": False, "complete": False}
        with self.out.open("wb", buffering=0) as sink:
            drain(high_reader, sink, record, threading.Event(), 128)
        self.assertTrue(record["complete"], record)
        self.assertEqual(self.out.read_bytes(), b"complete")

    def test_failed_log_sync_is_reported_as_incomplete(self):
        with patch.object(bounded_output.os, "fsync", side_effect=OSError("injected log sync failure")):
            with bounded_logs(self.out, self.err) as logs:
                subprocess.run([sys.executable, "-c", "print('complete response')"],
                               stdout=logs.streams[0], stderr=logs.streams[1], check=True, timeout=5)
        self.assertFalse(logs.complete)
        self.assertIn("sync failure", logs.records["stdout"]["error"])
        self.assertEqual(self.out.read_bytes(), b"complete response\n")

    def test_controller_rejects_a_valid_json_prefix_when_output_was_truncated(self):
        program = self.root / "controller.py"
        program.write_text("import sys,time; sys.stdout.write('{\"preflight\":true}'+' '*2097152); sys.stdout.flush(); time.sleep(.1)")
        manifest = self.root / "manifest.json"
        manifest.write_text(json.dumps({"node": sys.executable, "entry": str(program), "id": "fixture",
                                        "directory": str(self.root), "binding": {"runtime_sha256": "fixture"}}))
        manifest.chmod(0o600)
        with (self.root / "lock").open("wb") as lock:
            result, receipt = review_controller.run(manifest, "preflight", lock.fileno(), 5)
        self.assertIsNone(result)
        self.assertEqual(Path(receipt["ref"]).stat().st_size, 1048576)
        self.assertTrue(receipt["output"]["stdout"]["truncated"])
        self.assertFalse(receipt["output"]["stdout"]["complete"])


if __name__ == "__main__":
    unittest.main()
