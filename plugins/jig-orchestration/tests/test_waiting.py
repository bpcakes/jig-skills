"""Waiting costs no state reads while nothing is written, and still notices every write."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

from test_channel import ChannelFixture, Engine, channel
import jobs
import state as state_module
from state import StateWatch, locked, read_json, write_atomic
import supervise


@contextmanager
def state_reads():
    """Count this process's full parses of state.json, the gateway's threads included."""
    count = [0]

    def counted(path):
        count[0] += path.name == "state.json"
        return read_json(path)

    with patch.object(state_module, "read_json", counted), patch.object(jobs, "read_json", counted):
        yield lambda: count[0]


class GatewayWaitingTests(ChannelFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.socket_server()
        self.coordinator = channel.issue(self.run, "coordinator")
        self.driver = channel.issue(self.run, "driver-A")
        time.sleep(0.4)  # Let maintenance absorb the writes above.

    def test_idle_gateway_and_its_waiters_stop_rereading_state(self):
        cursor = self.call(self.driver, op="inbox", task_id="A")["cursor"]
        token = self.call(self.driver, op="query", task_id="A")["change_token"]
        with state_reads() as reads:
            time.sleep(1)
        # Maintenance alone used to parse the state eight times a second.
        self.assertLessEqual(reads(), 1)
        for request in ({"view": "inbox", "after": cursor}, {"after": token}):
            with state_reads() as reads:
                result = self.call(self.driver, op="watch", task_id="A", timeout_seconds=1, **request)
            self.assertFalse(result["changed"], result)
            # One second of waiting used to cost about twenty more.
            self.assertLessEqual(reads(), 5, request)

    def test_waiters_return_on_a_write_without_relying_on_the_refresh_interval(self):
        cursor = self.call(self.driver, op="inbox", task_id="A")["cursor"]
        token = self.call(self.coordinator, op="query", task_id="A")["change_token"]
        results = {}

        def wait(name, credential, **request):
            results[name] = self.call(credential, op="watch", task_id="A", timeout_seconds=4, **request)

        with patch.object(StateWatch, "interval", 60):
            waiters = [threading.Thread(target=wait, args=("inbox", self.driver), kwargs={"view": "inbox", "after": cursor}),
                       threading.Thread(target=wait, args=("task", self.coordinator), kwargs={"after": token})]
            for waiter in waiters:
                waiter.start()
            time.sleep(0.4)
            sent = self.call(self.coordinator, op="message", task_id="A", action_id="go", recipient="driver-A",
                             kind="assignment", body="Proceed")
            self.assertTrue(sent.get("accepted"), sent)
            task = Engine.read(self.run)["tasks"]["A"]
            Engine.apply(self.run, {"op": "observe", "task_id": "A", "action_id": "progress", "expected_policy": 1,
                                   "expected_task": task["version"], "fields": {"next_action": "review"},
                                   "evidence": self.proof})
            for waiter in waiters:
                waiter.join(6)
        self.assertTrue(results["inbox"]["changed"], results["inbox"])
        self.assertIn("go", [item.get("message_id") for item in results["inbox"]["events"]])
        self.assertTrue(results["task"]["changed"], results["task"])

    @unittest.skipUnless(sys.platform == "linux", "namespace evidence is read from procfs")
    def test_gateway_settles_a_job_that_exits_while_state_is_quiet(self):
        process = subprocess.Popen(["/usr/bin/sleep", "30"])
        self.addCleanup(process.wait)
        self.addCleanup(process.kill)
        directory = self.root / "job"
        directory.mkdir(mode=0o700)
        evidence = directory / "namespace.json"
        evidence.write_text(json.dumps({"child-pid": process.pid,
                                        "pid-namespace": os.stat(f"/proc/{process.pid}/ns/pid").st_ino}))
        evidence.chmod(0o600)
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            jobs.records(state)["job"] = {
                "id": "job", "role": "coordinator", "task_id": "A", "workspace": str(directory), "readonly": True,
                "directory": str(directory), "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip()}
            write_atomic(path / "state.json", state)
        time.sleep(0.6)
        self.assertNotIn("local_settled", Engine.read(self.run)["communication"]["jobs"]["job"])
        with patch.object(StateWatch, "interval", 60), state_reads() as reads:
            time.sleep(0.6)
            self.assertLessEqual(reads(), 1)  # A job that is verifiably running needs no state read.
            process.kill()
            process.wait()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                job = Engine.read(self.run)["communication"]["jobs"]["job"]
                if job.get("local_settled"):
                    break
                time.sleep(0.05)
        self.assertTrue(job.get("local_settled"), job)


class UnconfinedWaitingTests(ChannelFixture, unittest.TestCase):
    def test_idle_unconfined_waiters_read_state_once(self):
        cursor = supervise.serve(self.run, "driver-A", {"op": "inbox", "task_id": "A"})["cursor"]
        token = supervise.serve(self.run, "driver-A", {"op": "query", "task_id": "A"})["change_token"]
        # Each used to read on every quarter-second poll, the inbox wait twice.
        for request, limit in (({"view": "inbox", "after": cursor}, 5), ({"after": token}, 4)):
            with state_reads() as reads:
                result = supervise.serve(self.run, "driver-A", {"op": "watch", "task_id": "A", "timeout_seconds": 1,
                                                               **request})
            self.assertFalse(result["changed"], result)
            self.assertLessEqual(reads(), limit, request)


class StateWatchTests(ChannelFixture, unittest.TestCase):
    def test_every_write_and_an_interrupted_transaction_are_due(self):
        watch = StateWatch(self.run)
        self.assertTrue(watch.due())
        self.assertFalse(watch.due())
        target = self.run / "state.json"
        # A clock that stands still or steps back must not make a new state
        # look like the one it replaced, even at the same size and inode.
        ahead = time.time_ns() + 60 * 10 ** 9
        os.utime(target, ns=(ahead, ahead))
        self.assertTrue(watch.due())
        with locked(self.run) as path:
            state = read_json(target)
            for _ in range(10):
                write_atomic(target, state)
                write_atomic(target, state)
                self.assertTrue(watch.due())
                self.assertFalse(watch.due())
        self.assertGreaterEqual(os.stat(target).st_mtime_ns, ahead + 20)
        journal = self.run / "transaction.json"
        journal.write_text("{}")
        self.assertTrue(watch.due())
        journal.unlink()
        self.assertTrue(watch.due())
        self.assertFalse(watch.due())
        watch.retry()
        self.assertTrue(watch.due())

    def test_unchanged_state_is_read_again_after_the_interval(self):
        watch = StateWatch(self.run)
        self.assertTrue(watch.due())
        with patch.object(StateWatch, "interval", 0.5):
            self.assertFalse(watch.due())
            time.sleep(0.6)
            self.assertTrue(watch.due())


if __name__ == "__main__":
    unittest.main()
