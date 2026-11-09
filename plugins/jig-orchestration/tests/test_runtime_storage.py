"""Aggregate admission capacity over retained runtime data and source checkouts."""
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_channel
from test_channel import ChannelFixture, Engine, StateError, isolation, channel
import capabilities
import runtime_storage


MIB = 1024 * 1024


class RuntimeStorageTests(ChannelFixture, unittest.TestCase):
    setUpClass = classmethod(test_channel.IsolationTests.setUpClass.__func__)

    def setUp(self):
        super().setUp()
        self.run = self.root / "enforced-run"
        self.config["communication"] = {"mode": "enforced", "runtime_storage": {
            "max_bytes": 8 * MIB, "reserved_bytes": MIB,
            "max_files": 5000, "reserved_files": 128, "min_free_bytes": 1}}
        self.config["hosts"]["local"]["execution"] = {"kind": "local"}
        Engine.initialize(self.run, self.config)
        for name in ("A", "B"):
            subprocess.run(["git", "init", "-q", "-b", "main", str(self.trees / name)], check=True)
        capabilities.verify(self.run, "local")

    def admission(self, name="A"):
        return {"op": "admit", "action_id": "admit-" + name,
                "expected_policy": Engine.read(self.run)["policy_version"], "task_id": name,
                "driver": "driver-" + name, "host": "local", "worktree": str(self.trees / name),
                "branch": "task/" + name, "claim": {**self.proof, "authority": "fixture", "task_id": name,
                "owner": "driver-" + name, "confirmed": True, "ready": True, "unpublished": False}}

    def test_retained_job_home_blocks_new_admission(self):
        home = self.run / "launches/old/home"
        home.mkdir(parents=True)
        with (home / "retained-data").open("wb") as stream:
            stream.truncate(8 * MIB)
        with self.assertRaisesRegex(StateError, "runtime storage capacity"):
            Engine.apply(self.run, self.admission())
        self.assertFalse(Engine.read(self.run)["tasks"])
        self.assertEqual((home / "retained-data").stat().st_size, 8 * MIB)

    def fill(self, relative="retained"):
        path = self.run / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as stream:
            stream.truncate(8 * MIB)
        return path

    def test_candidate_checkout_counts_toward_aggregate_capacity(self):
        with (self.trees / "A/generated").open("wb") as stream:
            stream.truncate(8 * MIB)
        with self.assertRaisesRegex(StateError, "runtime storage capacity"):
            Engine.apply(self.run, self.admission())
        self.assertFalse(Engine.read(self.run)["tasks"])

    def test_separate_runtime_directories_are_counted_together(self):
        for relative in ("client-runtimes/old/data", "execution-old/stdout", "launches/old/home/data"):
            path = self.run / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("wb") as stream:
                stream.truncate(3 * MIB)
        with self.assertRaisesRegex(StateError, "runtime storage capacity"):
            Engine.apply(self.run, self.admission())

    def test_capacity_preserves_read_control_and_admission_replay(self):
        request = self.admission()
        admitted = Engine.apply(self.run, request)
        self.socket_server()
        coordinator = channel.issue(self.run, "coordinator")
        driver = channel.issue(self.run, "driver-A")
        evidence = self.call(driver, op="artifact_put", task_id="A", action_id="evidence", content="retained evidence")
        self.fill("execution-old/log")
        self.assertEqual(Engine.apply(self.run, request), admitted)
        with self.assertRaisesRegex(StateError, "runtime storage capacity"):
            Engine.apply(self.run, self.admission("B"))
        result = self.call(driver, op="artifact_read", task_id="A", artifact_id=evidence["artifact"]["id"])
        self.assertEqual(result["content"], "retained evidence")
        paused = self.call(coordinator, op="control", control="pause", action_id="stop-at-capacity", expected_policy=1)
        self.assertNotIn("error", paused)
        self.assertTrue(Engine.read(self.run)["controls"]["paused"])

    def test_full_runtime_cannot_replace_credential_or_provision_another_home(self):
        Engine.apply(self.run, self.admission())
        original = channel.issue(self.run, "driver-A")
        self.fill()
        with self.assertRaisesRegex(StateError, "runtime storage capacity"):
            isolation.prepare(self.run, "driver-A", "A")
        channel.check(Engine.read(self.run), channel.parse_credential(original), task_id="A")
        self.assertFalse((self.run / "launches").exists())

    def test_coordinator_can_use_reserved_capacity_to_recover_control(self):
        self.run = self.root / "recovery-run"
        self.config["communication"]["runtime_storage"]["reserved_bytes"] = 4 * MIB
        Engine.initialize(self.run, self.config)
        original = capabilities.verify(self.run, "local")
        with (self.run / "retained").open("wb") as stream:
            stream.truncate(4 * MIB)
        with self.assertRaisesRegex(StateError, "runtime storage capacity"):
            Engine.apply(self.run, self.admission())
        verified = capabilities.verify(self.run, "local")
        self.assertTrue(verified["verified"])
        self.assertNotEqual(verified["receipt_id"], original["receipt_id"])
        self.socket_server()
        prepared = isolation.prepare(self.run, "coordinator")
        result = isolation.launch(prepared, ["/usr/bin/python3", "-c", "print('recovered')"],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "recovered")

    def test_free_space_shortage_refuses_work_without_deleting_evidence(self):
        retained = self.run / "evidence"
        retained.write_text("must survive")
        with patch.object(runtime_storage.os, "statvfs", return_value=SimpleNamespace(f_bavail=0, f_frsize=4096)):
            with self.assertRaisesRegex(StateError, "insufficient free filesystem headroom"):
                Engine.apply(self.run, self.admission())
        self.assertFalse(Engine.read(self.run)["tasks"])
        self.assertEqual(retained.read_text(), "must survive")

    def test_growth_after_provisioning_fences_prepared_command(self):
        Engine.apply(self.run, self.admission())
        self.socket_server()
        prepared = isolation.prepare(self.run, "driver-A", "A")
        # Exceed only the ordinary budget: spare control capacity must not
        # allow this already-provisioned worker to allocate its environment.
        used = runtime_storage.check(self.run, control=True).charged_bytes
        self.assertLess(used, 7 * MIB)
        with (self.run / "retained").open("wb") as stream:
            stream.truncate(7 * MIB - used + 4096)
        runtime_storage.check(self.run, control=True)
        with self.assertRaisesRegex(StateError, "runtime storage capacity"):
            isolation.launch(prepared, ["/usr/bin/touch", "must-not-start"])
        self.assertFalse((self.trees / "A/must-not-start").exists())
        self.assertFalse(Engine.read(self.run)["communication"].get("jobs"))

    def test_slow_capacity_scan_does_not_hold_the_state_lock(self):
        Engine.apply(self.run, self.admission())
        self.socket_server()
        coordinator = channel.issue(self.run, "coordinator")
        entered, release = threading.Event(), threading.Event()
        failures = []
        request = self.admission("B")
        footprint = runtime_storage.footprint

        def slow(*args, **kwargs):
            if threading.current_thread() is worker:
                entered.set()
                if not release.wait(5):
                    raise RuntimeError("test did not release capacity scan")
            return footprint(*args, **kwargs)

        def admit():
            try:
                Engine.apply(self.run, request)
            except Exception as error:
                failures.append(error)

        worker = threading.Thread(target=admit)
        with patch.object(runtime_storage, "footprint", side_effect=slow):
            worker.start()
            try:
                self.assertTrue(entered.wait(5), failures)
                result = self.call(coordinator, op="control", control="pause", action_id="pause-scan", expected_policy=1)
                self.assertNotIn("error", result)
            finally:
                release.set()
                worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(failures), 1)
        self.assertIsInstance(failures[0], StateError)
        self.assertIn(failures[0].code, {"paused", "stale_policy"})
        self.assertNotIn("B", Engine.read(self.run)["tasks"])

    def test_concurrent_trusted_allocations_cannot_both_spend_the_same_headroom(self):
        entered, release = threading.Event(), threading.Event()
        outcomes = []

        def allocate(name):
            try:
                with runtime_storage.allocation(self.run, additional_bytes=4 * MIB, additional_files=1):
                    if name == "first":
                        entered.set()
                        if not release.wait(5):
                            raise RuntimeError("test did not release first allocation")
                    with (self.run / name).open("wb") as stream:
                        stream.truncate(4 * MIB)
                outcomes.append(name)
            except Exception as error:
                outcomes.append(error)

        first = threading.Thread(target=allocate, args=("first",))
        second = threading.Thread(target=allocate, args=("second",))
        first.start()
        try:
            self.assertTrue(entered.wait(5))
            second.start()
        finally:
            release.set()
            first.join(5)
            if second.ident is not None:
                second.join(5)
        self.assertFalse(first.is_alive() or second.is_alive())
        self.assertIn("first", outcomes)
        self.assertEqual(sum(isinstance(result, StateError) for result in outcomes), 1, outcomes)
        self.assertFalse((self.run / "second").exists())


class FootprintTests(unittest.TestCase):
    def test_symlinks_do_not_charge_external_data_and_nested_roots_count_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "root"
            root.mkdir()
            data = root / "small"
            data.write_text("small")
            external = Path(directory) / "external"
            with external.open("wb") as stream:
                stream.truncate(16 * MIB)
            (root / "link").symlink_to(external)
            size, count = runtime_storage.footprint([root, data], max_bytes=MIB, max_files=10)
            self.assertLess(size, MIB)
            self.assertEqual(count, 3)

    def test_directory_swapped_for_symlink_is_not_followed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "root"
            root.mkdir()
            nested = root / "nested"
            nested.mkdir()
            external = Path(directory) / "external"
            external.mkdir()
            opened = os.open
            swapped = False

            def swap(name, flags, *args, **kwargs):
                nonlocal swapped
                if name == "nested" and kwargs.get("dir_fd") is not None and not swapped:
                    swapped = True
                    nested.rename(root / "moved")
                    nested.symlink_to(external, target_is_directory=True)
                return opened(name, flags, *args, **kwargs)

            with patch.object(runtime_storage.os, "open", side_effect=swap):
                with self.assertRaises(StateError) as caught:
                    runtime_storage.footprint([root], max_bytes=MIB, max_files=10)
            self.assertTrue(swapped)
            self.assertEqual(caught.exception.code, "runtime_capacity_unknown")

    def test_many_empty_files_exhaust_entry_capacity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for number in range(5):
                (root / str(number)).touch()
            with self.assertRaises(StateError) as caught:
                runtime_storage.footprint([root], max_bytes=MIB, max_files=5)
            self.assertEqual(caught.exception.code, "runtime_capacity")


if __name__ == "__main__":
    unittest.main()
