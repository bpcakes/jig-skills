"""Real host verification, enforced admission and profile exposure checks."""
import copy
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch

import test_channel
from test_channel import ChannelFixture, Engine, StateError, channel, isolation
import capabilities


class CapabilityTests(ChannelFixture, unittest.TestCase):
    setUpClass = classmethod(test_channel.IsolationTests.setUpClass.__func__)

    def setUp(self):
        super().setUp()
        self.run = self.root / "enforced-run"
        self.config["communication"] = {"mode": "enforced"}
        self.config["hosts"]["local"]["execution"] = {"kind": "local"}
        Engine.initialize(self.run, self.config)
        for name in ("A", "B"):
            subprocess.run(["git", "init", "-q", "-b", "main", str(self.trees / name)], check=True)

    def admission(self, name="A", **changes):
        return {"op": "admit", "action_id": "admit-" + name, "expected_policy": Engine.read(self.run)["policy_version"],
                "task_id": name, "driver": "driver-" + name, "host": "local", "worktree": str(self.trees / name),
                "branch": "task/" + name, "claim": {**self.proof, "authority": "fixture", "task_id": name,
                "owner": "driver-" + name, "confirmed": True, "ready": True, "unpublished": False}, **changes}

    def test_cli_probe_gates_admission_and_allows_real_coordinator_and_worker(self):
        with self.assertRaisesRegex(StateError, "verify this host"):
            Engine.apply(self.run, self.admission())
        self.assertFalse(Engine.read(self.run)["tasks"])
        with self.assertRaisesRegex(StateError, "verify this host"):
            isolation.prepare(self.run, "coordinator")
        result = subprocess.run([sys.executable, "-B", str(test_channel.SCRIPTS / "supervise.py"), "verify-host",
                                 "--run-dir", str(self.run), "--host", "local"], capture_output=True, text=True, check=True)
        self.assertTrue(json.loads(result.stdout)["verified"])
        self.socket_server()
        coordinator = isolation.prepare(self.run, "coordinator")
        observed = isolation.launch(coordinator, ["/usr/bin/python3", "-B", "-c",
            "import sys;sys.path.insert(0,'/opt/orchestration');import communicate;assert communicate.request({'op':'query'})['tasks']=={}"],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(observed.returncode, 0, observed.stderr)
        Engine.apply(self.run, self.admission())
        launch = isolation.prepare(self.run, "driver-A", "A")
        completed = isolation.launch(launch, ["/usr/bin/python3", "-B", "-c",
            "import subprocess,sys;from pathlib import Path;"
            "Path('implemented').write_text('usable');Path('program.c').write_text('int main(void) {return 0;}');"
            "subprocess.run(['cc','program.c','-o','program'],check=True);subprocess.run(['./program'],check=True);"
            "assert not Path('/run/docker.sock').exists();sys.path.insert(0,'/opt/orchestration');import communicate;"
            "assert communicate.request({'op':'message','task_id':'A','action_id':'built','recipient':'coordinator',"
            "'kind':'update','body':'built and ran'})['accepted']"],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual((self.trees / "A/implemented").read_text(), "usable")
        self.assertTrue((self.trees / "A/program").is_file())

    def test_reverification_invalidates_prepared_launch_without_starting_job(self):
        capabilities.verify(self.run, "local")
        Engine.apply(self.run, self.admission())
        prepared = isolation.prepare(self.run, "driver-A", "A")
        capabilities.verify(self.run, "local")
        with self.assertRaisesRegex(StateError, "earlier host verification"):
            isolation.launch(prepared, ["/usr/bin/touch", "must-not-run"])
        self.assertFalse((self.trees / "A/must-not-run").exists())
        self.assertFalse(Engine.read(self.run)["communication"].get("jobs"))

    def test_failed_real_probe_removes_prior_verification(self):
        capabilities.verify(self.run, "local")
        binaries = self.root / "broken-tools"
        binaries.mkdir()
        binary = binaries / "bwrap"
        binary.write_text("#!/bin/sh\necho isolation-unavailable >&2\nexit 9\n")
        binary.chmod(0o700)
        result = subprocess.run([sys.executable, "-B", str(test_channel.SCRIPTS / "supervise.py"), "verify-host",
            "--run-dir", str(self.run), "--host", "local"], capture_output=True, text=True,
            env={**os.environ, "PATH": str(binaries) + os.pathsep + os.environ.get("PATH", "")})
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("isolation-unavailable", result.stdout)
        self.assertFalse((self.run / capabilities.RECEIPT).exists())
        with self.assertRaisesRegex(StateError, "verify this host"):
            Engine.apply(self.run, self.admission())

    def test_local_probe_cannot_certify_a_remote_or_ambiguous_host(self):
        with self.assertRaisesRegex(StateError, "explicitly local host"):
            capabilities.verify(self.run, "remote")
        hosts = copy.deepcopy(self.config["hosts"])
        hosts["other"] = {**hosts["local"], "worktree_root": str(self.root / "other")}
        Engine.apply(self.run, {"op": "configure", "action_id": "ambiguous", "expected_policy": 1,
                               "fields": {"hosts": hosts}, "evidence": self.proof})
        with self.assertRaisesRegex(StateError, "explicitly local host"):
            capabilities.verify(self.run, "local")

    def test_config_change_fences_admission_until_verified_but_slot_change_does_not(self):
        capabilities.verify(self.run, "local")
        hosts = copy.deepcopy(self.config["hosts"])
        hosts["local"]["slots"] = 3
        Engine.apply(self.run, {"op": "configure", "action_id": "slots", "expected_policy": 1,
                               "fields": {"hosts": hosts}, "evidence": self.proof})
        Engine.apply(self.run, self.admission())
        hosts["local"]["endpoint"] = {"session": "changed"}
        Engine.apply(self.run, {"op": "configure", "action_id": "host", "expected_policy": 2,
                               "fields": {"hosts": hosts}, "evidence": self.proof})
        with self.assertRaisesRegex(StateError, "stale"):
            Engine.apply(self.run, self.admission("B"))
        with self.assertRaisesRegex(StateError, "stale"):
            isolation.prepare(self.run, "driver-A", "A")
        capabilities.verify(self.run, "local")
        Engine.apply(self.run, self.admission("B"))

    def test_changed_runtime_cannot_consume_an_existing_host_receipt(self):
        capabilities.verify(self.run, "local")
        runtime = self.root / "changed-runtime"
        runtime.mkdir()
        for path in test_channel.SCRIPTS.glob("*.py"):
            shutil.copyfile(path, runtime / path.name)
        with (runtime / "capabilities.py").open("a") as stream:
            stream.write("\n# changed candidate\n")
        request = self.root / "admit.json"
        request.write_text(json.dumps(self.admission()))
        result = subprocess.run([sys.executable, "-B", str(runtime / "supervise.py"), "apply", "--run-dir", str(self.run),
                                 "--request", str(request)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "host_unverified")
        self.assertFalse(Engine.read(self.run)["tasks"])

    def test_admission_rejects_nonprivate_git_and_aliases(self):
        capabilities.verify(self.run, "local")
        metadata = self.trees / "A/.git"
        saved = self.root / "saved-git"
        metadata.rename(saved)
        for kind in ("missing", "gitfile", "symlink"):
            with self.subTest(kind=kind):
                if kind == "gitfile":
                    metadata.write_text("gitdir: " + str(saved))
                elif kind == "symlink":
                    metadata.symlink_to(saved, target_is_directory=True)
                with self.assertRaisesRegex(StateError, "private Git"):
                    Engine.apply(self.run, self.admission())
                if metadata.is_symlink() or metadata.is_file():
                    metadata.unlink()
        saved.rename(metadata)
        (metadata / "commondir").write_text(str(saved))
        with self.assertRaisesRegex(StateError, "private Git"):
            Engine.apply(self.run, self.admission())
        (metadata / "commondir").unlink()
        (metadata / "alias").hardlink_to(metadata / "HEAD")
        with self.assertRaisesRegex(StateError, "shared hardlinks"):
            Engine.apply(self.run, self.admission())
        (metadata / "alias").unlink()
        alias = self.trees / "alias"
        alias.symlink_to(self.trees / "A", target_is_directory=True)
        with self.assertRaisesRegex(StateError, "canonical directory"):
            Engine.apply(self.run, self.admission(worktree=str(alias)))
        Engine.apply(self.run, self.admission())

    def test_long_lived_host_cannot_certify_edited_runtime_files(self):
        runtime = self.root / "runtime-during-change"
        runtime.mkdir()
        for path in test_channel.SCRIPTS.glob("*.py"):
            shutil.copyfile(path, runtime / path.name)
        source = '''
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import capabilities
from state import StateError
with (Path(sys.argv[1])/'isolation.py').open('a') as stream:
    stream.write('\\n# changed after startup\\n')
try:
    capabilities.verify(sys.argv[2], 'local')
except StateError as error:
    assert error.code == 'runtime_changed', error
    print('restart-required')
else:
    raise AssertionError('certified disk code while running old modules')
'''
        completed = subprocess.run([sys.executable, "-B", "-c", source, str(runtime), str(self.run)],
                                   capture_output=True, text=True, check=True)
        self.assertEqual(completed.stdout.strip(), "restart-required")
        self.assertFalse((self.run / capabilities.RECEIPT).exists())

    def test_profile_rejects_private_mounts_and_copies_without_replacing_owner(self):
        capabilities.verify(self.run, "local")
        Engine.apply(self.run, self.admission())
        token = channel.issue(self.run, "driver-A")
        for source in (self.run, self.root, self.repo, self.trees / "B", Path("/")):
            with self.subTest(source=source), self.assertRaisesRegex(StateError, "profile source overlaps"):
                isolation.prepare(self.run, "driver-A", "A", profile={"schema": 1,
                    "mounts": [{"source": str(source), "target": "/opt/tools/bundle"}]})
        with self.assertRaisesRegex(StateError, "profile source overlaps"):
            isolation.prepare(self.run, "driver-A", "A", profile={"schema": 1,
                "files": [{"source": str(self.run / "state.json"), "target": "state"}]})
        self.assertEqual(channel.caller(self.run, channel.parse_credential(token), "query", "A"), "driver-A")
        self.assertFalse((self.run / "launches").exists())

    def test_handoff_cannot_bypass_private_checkout_admission(self):
        capabilities.verify(self.run, "local")
        Engine.apply(self.run, self.admission())
        destination = self.trees / "moved-A"
        destination.mkdir()
        (destination / ".git").write_text("gitdir: " + str(self.trees / "A/.git"))
        task = Engine.read(self.run)["tasks"]["A"]
        request = {"op": "handoff", "action_id": "move", "expected_policy": 1, "expected_task": task["version"],
                   "task_id": "A", "host": "local", "driver": "driver-A", "worktree": str(destination),
                   "branch": "task/moved-A", "identity": {"native_id": "moved-A"},
                   "evidence": {**self.proof, "all_jobs_settled": True},
                   "source": {**self.proof, "published": True, "revision": "published-fixture"}}
        with self.assertRaisesRegex(StateError, "private Git"):
            Engine.apply(self.run, request)
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["worktree"], str(self.trees / "A"))
        (destination / ".git").unlink()
        subprocess.run(["git", "init", "-q", "-b", "main", str(destination)], check=True)
        Engine.apply(self.run, request)
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["worktree"], str(destination))

    def test_nested_socket_and_changed_mount_are_rejected_before_execution(self):
        capabilities.verify(self.run, "local")
        Engine.apply(self.run, self.admission())
        bundle = self.root / "tools"
        bundle.mkdir()
        with socket.socket(socket.AF_UNIX) as service:
            service.bind(str(bundle / "service.sock"))
            with self.assertRaisesRegex(StateError, "host socket"):
                isolation.prepare(self.run, "driver-A", "A", profile={"schema": 1,
                    "mounts": [{"source": str(bundle), "target": "/opt/tools/bundle"}]})
        (bundle / "service.sock").unlink()
        launch = isolation.prepare(self.run, "driver-A", "A", profile={"schema": 1,
            "mounts": [{"source": str(bundle), "target": "/opt/tools/bundle"}]})
        bundle.rmdir()
        bundle.symlink_to(self.run, target_is_directory=True)
        with self.assertRaisesRegex(StateError, "profile source overlaps"):
            isolation.launch(launch, ["/usr/bin/touch", "must-not-run"])
        self.assertFalse((self.trees / "A/must-not-run").exists())

    def pause_during_check(self, operation, stage):
        capabilities.verify(self.run, "local")
        Engine.apply(self.run, self.admission())
        launch = isolation.prepare(self.run, "driver-A", "A")
        self.socket_server()
        coordinator = channel.issue(self.run, "coordinator")
        entered, release = threading.Event(), threading.Event()
        failures = []
        admission = self.admission("B")
        def perform():
            try:
                if operation == "admit":
                    Engine.apply(self.run, admission)
                else:
                    isolation.launch(launch, ["/usr/bin/touch", "must-not-start"])
            except Exception as error:
                failures.append(error)
        worker = threading.Thread(target=perform)
        original = getattr(capabilities, stage)
        def slow(*args, **kwargs):
            if threading.current_thread() is worker:
                entered.set()
                if not release.wait(5):
                    raise RuntimeError("test did not release the slow filesystem check")
            return original(*args, **kwargs)
        with patch.object(capabilities, stage, side_effect=slow):
            worker.start()
            try:
                self.assertTrue(entered.wait(3), failures)
                from jobs import lease
                target = self.trees / ("B" if operation == "admit" else "A")
                with self.assertRaisesRegex(StateError, "still owns the workspace"):
                    with lease(self.run, str(target), False):
                        self.fail("another writer entered during the filesystem check")
                paused = self.call(coordinator, op="control", control="pause", action_id="pause-during-check",
                                   expected_policy=1)
                self.assertNotIn("error", paused)
                self.assertTrue(Engine.read(self.run)["controls"]["paused"])
            finally:
                release.set()
                worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(failures), 1, failures)
        self.assertIsInstance(failures[0], StateError)
        self.assertIn(failures[0].code, {"paused", "stale_policy"})
        self.assertNotIn("B", Engine.read(self.run)["tasks"])
        self.assertFalse((self.trees / "A/must-not-start").exists())
        self.assertFalse(Engine.read(self.run)["communication"].get("jobs"))

    def test_pause_takes_effect_during_admission_git_scan(self):
        self.pause_during_check("admit", "checkout")

    def test_pause_takes_effect_during_admission_runtime_hashing(self):
        self.pause_during_check("admit", "digest_file")

    def test_pause_takes_effect_during_launch_git_scan(self):
        self.pause_during_check("launch", "checkout")

    def test_pause_takes_effect_during_launch_runtime_hashing(self):
        self.pause_during_check("launch", "digest_file")

    def test_reverification_during_scan_invalidates_launch_before_job_creation(self):
        capabilities.verify(self.run, "local")
        Engine.apply(self.run, self.admission())
        launch = isolation.prepare(self.run, "driver-A", "A")
        entered, release = threading.Event(), threading.Event()
        failures = []
        def perform():
            try:
                isolation.launch(launch, ["/usr/bin/touch", "must-not-start"])
            except Exception as error:
                failures.append(error)
        worker = threading.Thread(target=perform)
        checkout = capabilities.checkout
        def slow(*args, **kwargs):
            result = checkout(*args, **kwargs)
            entered.set()
            if not release.wait(5):
                raise RuntimeError("test did not release the verified checkout")
            return result
        with patch.object(capabilities, "checkout", side_effect=slow):
            worker.start()
            try:
                self.assertTrue(entered.wait(3), failures)
                capabilities.verify(self.run, "local")
            finally:
                release.set()
                worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(failures), 1, failures)
        self.assertIsInstance(failures[0], StateError)
        self.assertEqual(failures[0].code, "host_unverified")
        self.assertFalse((self.trees / "A/must-not-start").exists())
        self.assertFalse(Engine.read(self.run)["communication"].get("jobs"))

    def test_admission_replay_needs_no_new_filesystem_authority(self):
        capabilities.verify(self.run, "local")
        request = self.admission()
        result = Engine.apply(self.run, request)
        (self.trees / "A/.git/commondir").write_text("invalid-for-new-work")
        with patch.object(capabilities, "check", side_effect=AssertionError("replay scanned host")):
            self.assertEqual(Engine.apply(self.run, request), result)
            with self.assertRaisesRegex(StateError, "different input"):
                Engine.apply(self.run, {**request, "branch": "changed"})


if __name__ == "__main__":
    unittest.main()
