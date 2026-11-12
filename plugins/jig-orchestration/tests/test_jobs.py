"""Real process lifetime, replacement and cancellation under the launch boundary."""
import errno
import json
import fcntl
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import test_channel
from test_channel import ChannelFixture, channel, isolation, Engine, StateError
import jobs
from state import execution_guard


class JobTests(ChannelFixture, unittest.TestCase):
    setUpClass = classmethod(test_channel.IsolationTests.setUpClass.__func__)

    def await_file(self, path):
        deadline = time.monotonic() + 5
        while not path.exists() and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(path.exists(), str(path))

    def pending_start(self, change):
        self.verify_enforcement()
        self.socket_server()
        coordinator = channel.issue(self.run, "coordinator")
        if change == "replace-parent":
            parent = channel.parse_credential(channel.issue(self.run, "driver-A"))
            directory = isolation.prepare(self.run, "worker-A", "A", role="executor", parent_session=parent)
        else:
            directory = isolation.prepare(self.run, "driver-A", "A")
        entered, release = threading.Event(), threading.Event()
        results, failures = [], []
        popen = subprocess.Popen

        def delayed_start(*args, **kwargs):
            process = popen(*args, **kwargs)
            if threading.current_thread() is not worker:
                return process
            entered.set()
            if not release.wait(5):
                process.kill()
                process.communicate()
                raise RuntimeError("test did not release process startup")
            return process

        def launch():
            try:
                results.append(isolation.launch(directory, ["/usr/bin/touch", "must-not-start"],
                                                capture_output=True, timeout=5))
            except Exception as error:
                failures.append(error)

        worker = threading.Thread(target=launch)
        with patch.object(jobs.subprocess, "Popen", side_effect=delayed_start):
            worker.start()
            try:
                self.assertTrue(entered.wait(5), failures)
                with self.assertRaisesRegex(StateError, "still owns the workspace"):
                    with jobs.lease(self.run, str(self.trees / "A"), False):
                        self.fail("startup released its source lease")
                if change in {"pause", "cancel"}:
                    controlled = self.call(coordinator, op="control", control=change,
                                           action_id="control-startup", expected_policy=1)
                    self.assertNotIn("error", controlled)
                    self.assertTrue(Engine.read(self.run)["controls"]["paused"])
                elif change in {"replace", "replace-parent"}:
                    channel.issue(self.run, "driver-A")
                else:
                    import capabilities
                    capabilities.verify(self.run, "local")
                self.assertFalse((self.trees / "A/must-not-start").exists())
            finally:
                release.set()
                worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertFalse(results)
        self.assertEqual(len(failures), 1, failures)
        self.assertIsInstance(failures[0], StateError)
        expected = "paused" if change in {"pause", "cancel"} else (
            "session_revoked" if change in {"replace", "replace-parent"} else "host_unverified")
        self.assertEqual(failures[0].code, expected)
        self.assertFalse((self.trees / "A/must-not-start").exists())
        job = Engine.read(self.run)["communication"]["jobs"][directory.name]
        self.assertEqual(job["outcome"], "not_started")
        self.assertTrue(job["local_settled"], job)

    def test_pause_can_commit_during_process_startup_and_prevents_command(self):
        self.pending_start("pause")

    def test_cancel_during_process_startup_prevents_command(self):
        self.pending_start("cancel")

    def test_replacement_during_process_startup_prevents_command(self):
        self.pending_start("replace")

    def test_parent_replacement_during_process_startup_prevents_command(self):
        self.pending_start("replace-parent")

    def test_reverification_during_process_startup_prevents_command(self):
        self.pending_start("reverify")

    def test_unknown_namespace_settles_only_after_exclusive_lease_proves_exit(self):
        from state import locked, read_json, write_atomic
        directory = isolation.prepare(self.run, "driver-A", "A")
        workspace = str(self.trees / "A")
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            jobs.records(state)["unknown"] = {"id": "unknown", "directory": str(directory),
                "workspace": workspace, "readonly": True, "role": "reviewer", "task_id": "A",
                "local_settled": False, "status": "running"}
            write_atomic(path / "state.json", state)
        Engine.apply(self.run, {"op": "control", "action_id": "cancel", "control": "cancel", "expected_policy": 1})
        with jobs.lease(self.run, workspace, True):
            jobs.cancel_requested(self.run)
            self.assertFalse(Engine.read(self.run)["communication"]["jobs"]["unknown"]["local_settled"])
            with self.assertRaises(StateError):
                Engine.apply(self.run, {"op": "control", "action_id": "resume-held", "control": "resume", "expected_policy": 1})
        jobs.cancel_requested(self.run)
        record = Engine.read(self.run)["communication"]["jobs"]["unknown"]
        self.assertTrue(record["local_settled"])
        self.assertEqual(record["outcome"], "unknown")
        state = Engine.read(self.run)
        Engine.apply(self.run, {"op": "control", "action_id": "resume-gone", "control": "resume",
                              "expected_policy": state["policy_version"]})

    def test_profile_secret_stays_out_of_live_host_process_arguments(self):
        self.socket_server()
        directory = isolation.prepare(self.run, "driver-A", "A")
        spec = json.loads((directory / "launch.json").read_text())
        secret = "synthetic-secret-not-for-process-arguments"
        reader, writer = os.pipe()
        process = None
        try:
            command = isolation.command(spec, ["/usr/bin/python3", "-c", "import os; print(os.environ['PROFILE_SECRET'])"],
                                        environment={"PROFILE_SECRET": secret}, start_fd=reader)
            self.assertNotIn(secret, json.dumps(command))
            process = subprocess.Popen(command, pass_fds=(reader,), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            deadline = time.monotonic() + 5
            observed = False
            while not observed and time.monotonic() < deadline:
                pending = [process.pid]
                while pending:
                    pid = pending.pop()
                    arguments = Path(f"/proc/{pid}/cmdline").read_bytes()
                    self.assertNotIn(secret.encode(), arguments)
                    observed |= b"/opt/orchestration/startup.py\0" in arguments and arguments.startswith(b"/usr/bin/python3\0")
                    pending.extend(int(value) for value in Path(f"/proc/{pid}/task/{pid}/children").read_text().split())
                time.sleep(.01)
            self.assertTrue(observed, "did not observe the waiting bootstrap")
            os.write(writer, b"S")
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertEqual(stdout.decode().strip(), secret)
        finally:
            os.close(reader)
            os.close(writer)
            if process and process.poll() is None:
                process.kill()
                process.communicate()
            elif process:
                process.communicate()

    def test_gate_rejects_eof_and_wrong_token_without_loading_project_python(self):
        self.socket_server()
        directory = isolation.prepare(self.run, "driver-A", "A")
        spec = json.loads((directory / "launch.json").read_text())
        (self.trees / "A/sitecustomize.py").write_text("from pathlib import Path; Path('early-hook').touch()")
        for token in (b"", b"N", b"S"):
            with self.subTest(token=token):
                reader, writer = os.pipe()
                try:
                    if token:
                        os.write(writer, token)
                finally:
                    os.close(writer)
                try:
                    command = isolation.command(spec, ["/usr/bin/touch", "gate-passed"], start_fd=reader,
                                                environment={"PYTHONPATH": str(self.trees / "A")})
                    result = subprocess.run(command, pass_fds=(reader,), capture_output=True, timeout=5)
                finally:
                    os.close(reader)
                self.assertEqual(result.returncode, 0 if token == b"S" else 125, result.stderr)
                self.assertEqual((self.trees / "A/gate-passed").exists(), token == b"S")
                self.assertFalse((self.trees / "A/early-hook").exists())

    def test_failed_start_authorization_write_never_executes_command(self):
        self.socket_server()
        directory = isolation.prepare(self.run, "driver-A", "A")
        write = jobs.write_atomic
        failed = False

        def fail_authorization(path, state, **options):
            nonlocal failed
            job = state.get("communication", {}).get("jobs", {}).get(directory.name, {})
            if job.get("status") == "running" and not failed:
                failed = True
                raise OSError("injected start authorization persistence failure")
            return write(path, state, **options)

        with patch.object(jobs, "write_atomic", side_effect=fail_authorization):
            with self.assertRaisesRegex(OSError, "injected start authorization"):
                isolation.launch(directory, ["/usr/bin/touch", "must-not-start"], capture_output=True, timeout=5)
        self.assertTrue(failed)
        self.assertFalse((self.trees / "A/must-not-start").exists())
        record = Engine.read(self.run)["communication"]["jobs"][directory.name]
        self.assertEqual(record["outcome"], "not_started")
        # Killing a launcher before its namespace record exists can leave
        # settlement unknown. A new exclusive lease must prove recovery.
        replacement = isolation.prepare(self.run, "driver-A", "A")
        result = isolation.launch(replacement, ["/usr/bin/touch", "recovered"], capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.trees / "A/recovered").exists())
        self.assertFalse((self.trees / "A/must-not-start").exists())
        recovered = Engine.read(self.run)["communication"]["jobs"][directory.name]
        self.assertTrue(recovered["local_settled"])
        self.assertEqual(recovered["outcome"], "not_started")

    def test_loader_environment_cannot_execute_before_authorization(self):
        compiler = shutil.which("cc")
        if not compiler:
            self.skipTest("a C compiler is needed for the LD_PRELOAD constructor probe")
        self.socket_server()
        directory = isolation.prepare(self.run, "driver-A", "A")
        spec = json.loads((directory / "launch.json").read_text())
        library = self.trees / "A/early.so"
        source = '#include <fcntl.h>\n#include <unistd.h>\n__attribute__((constructor)) void early(void) {close(open("loader-ran", O_WRONLY|O_CREAT, 0600));}\n'
        subprocess.run([compiler, "-shared", "-fPIC", "-x", "c", "-", "-o", str(library)],
                       input=source, text=True, capture_output=True, check=True)
        for token in (b"", b"S"):
            reader, writer = os.pipe()
            try:
                if token:
                    os.write(writer, token)
            finally:
                os.close(writer)
            try:
                command = isolation.command(spec, ["/usr/bin/touch", "gate-passed"], start_fd=reader,
                                            environment={"LD_PRELOAD": str(library)})
                result = subprocess.run(command, pass_fds=(reader,), capture_output=True, timeout=5)
            finally:
                os.close(reader)
            self.assertEqual(result.returncode, 0 if token else 125, result.stderr)
            self.assertEqual((self.trees / "A/loader-ran").exists(), bool(token))
            self.assertEqual((self.trees / "A/gate-passed").exists(), bool(token))

    def test_parent_loss_before_start_authorization_prevents_command_and_allows_recovery(self):
        self.socket_server()
        directory = isolation.prepare(self.run, "driver-A", "A")
        entered = self.root / "launcher-pending"
        program = '''
import sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import isolation, jobs
popen = jobs.subprocess.Popen
def pending(*args, **kwargs):
    process = popen(*args, **kwargs)
    Path(sys.argv[3]).touch()
    while True: time.sleep(.01)
jobs.subprocess.Popen = pending
isolation.launch(sys.argv[2], ['/usr/bin/touch', 'must-not-start'], capture_output=True)
'''
        launcher = subprocess.Popen([sys.executable, "-B", "-c", program, str(test_channel.SCRIPTS),
                                     str(directory), str(entered)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.await_file(entered)
            record = Engine.read(self.run)["communication"]["jobs"][directory.name]
            self.assertEqual(record["status"], "prepared")
            self.assertFalse((self.trees / "A/must-not-start").exists())
            launcher.kill()
            launcher.communicate(timeout=5)
            deadline = time.monotonic() + 5
            while jobs.namespace(record) not in (None, False) and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertFalse((self.trees / "A/must-not-start").exists())
            replacement = isolation.prepare(self.run, "driver-A", "A")
            result = isolation.launch(replacement, ["/usr/bin/touch", "recovered"], capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((self.trees / "A/recovered").exists())
            self.assertTrue(Engine.read(self.run)["communication"]["jobs"][directory.name]["local_settled"])
        finally:
            if launcher.poll() is None:
                launcher.kill()
                launcher.communicate(timeout=5)

    def test_replacement_cannot_overlap_writer_and_old_job_can_settle(self):
        self.socket_server()
        old = isolation.prepare(self.run, "driver-A", "A")
        results = []
        program = """
from pathlib import Path
import time
Path('started').touch()
while not Path('release').exists():
    time.sleep(.01)
Path('old-finished').touch()
"""
        thread = threading.Thread(target=lambda: results.append(isolation.launch(
            old, ["/usr/bin/python3", "-c", program], capture_output=True, text=True, timeout=10)))
        thread.start()
        try:
            self.await_file(self.trees / "A/started")
            replacement = isolation.prepare(self.run, "driver-A", "A")
            with self.assertRaisesRegex(StateError, "still owns the workspace"):
                isolation.launch(replacement, ["/usr/bin/touch", "new-started"])
            self.assertFalse((self.trees / "A/new-started").exists())
        finally:
            (self.trees / "A/release").touch()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results[0].returncode, 0, results[0].stderr)
        record = Engine.read(self.run)["communication"]["jobs"][old.name]
        self.assertTrue(record["local_settled"], record)
        result = isolation.launch(replacement, ["/usr/bin/touch", "new-started"])
        self.assertEqual(result.returncode, 0)

    def test_cancel_stops_sandbox_before_resume(self):
        self.socket_server()
        coordinator = channel.issue(self.run, "coordinator")
        directory = isolation.prepare(self.run, "driver-A", "A")
        results = []
        program = "from pathlib import Path; import time; Path('started').touch(); time.sleep(30)"
        thread = threading.Thread(target=lambda: results.append(isolation.launch(
            directory, ["/usr/bin/python3", "-c", program], capture_output=True, text=True, timeout=10)))
        thread.start()
        self.await_file(self.trees / "A/started")
        cancelled = self.call(coordinator, op="control", control="cancel", action_id="cancel-live", expected_policy=1)
        self.assertNotIn("error", cancelled)
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertNotEqual(results[0].returncode, 0)
        record = Engine.read(self.run)["communication"]["jobs"][directory.name]
        self.assertTrue(record["local_settled"], record)
        resumed = self.call(coordinator, op="control", control="resume", action_id="resume-settled",
                            expected_policy=cancelled["policy_version"])
        self.assertNotIn("error", resumed)

    def test_replaced_parent_fences_writer_requests_without_losing_settlement(self):
        self.socket_server()
        parent = channel.parse_credential(channel.issue(self.run, "driver-A"))
        directory = isolation.prepare(self.run, "worker-A", "A", role="executor", parent_session=parent)
        results = []
        program = """
from pathlib import Path
import json, sys, time
sys.path.insert(0, '/opt/orchestration')
import communicate
Path('started').touch()
while not Path('release').exists(): time.sleep(.01)
print(json.dumps(communicate.request({'op':'artifact_put','task_id':'A','action_id':'late','content':'old result'})))
Path('settled').touch()
"""
        thread = threading.Thread(target=lambda: results.append(isolation.launch(
            directory, ["/usr/bin/python3", "-B", "-c", program], capture_output=True, text=True, timeout=10)))
        thread.start()
        try:
            self.await_file(self.trees / "A/started")
            replacement = isolation.prepare(self.run, "driver-A", "A")
            with self.assertRaisesRegex(StateError, "still owns the workspace"):
                isolation.launch(replacement, ["/usr/bin/touch", "new-started"])
        finally:
            (self.trees / "A/release").touch()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results[0].returncode, 0, results[0].stderr)
        self.assertEqual(json.loads(results[0].stdout)["error"], "session_revoked")
        state = Engine.read(self.run)["communication"]
        self.assertTrue(state["jobs"][directory.name]["local_settled"])
        self.assertFalse(state["artifacts"])
        self.assertEqual(isolation.launch(replacement, ["/usr/bin/touch", "new-started"]).returncode, 0)

    def test_launcher_loss_retains_job_and_releases_only_dead_namespace(self):
        self.socket_server()
        launcher = subprocess.Popen([sys.executable, str(test_channel.SCRIPTS / "isolation.py"),
                                     "--run-dir", str(self.run), "--actor", "driver-A", "--task", "A", "--",
                                     "/usr/bin/python3", "-c",
                                     "from pathlib import Path; import time; Path('started').touch(); time.sleep(30)"],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.await_file(self.trees / "A/started")
            old_record = next(iter(Engine.read(self.run)["communication"]["jobs"].values()))
            self.assertTrue(jobs.namespace(old_record))
            launcher.kill()
            launcher.communicate(timeout=5)
            deadline = time.monotonic() + 5
            while jobs.namespace(old_record) is not None and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertIsNone(jobs.namespace(old_record))
            replacement = isolation.prepare(self.run, "driver-A", "A")
            result = isolation.launch(replacement, ["/usr/bin/touch", "recovered"])
            self.assertEqual(result.returncode, 0)
            state = Engine.read(self.run)
            self.assertTrue(state["communication"]["jobs"][old_record["id"]]["local_settled"])
            self.assertEqual(state["communication"]["jobs"][old_record["id"]]["outcome"], "unknown")
        finally:
            if launcher.poll() is None:
                launcher.kill()
                launcher.communicate(timeout=5)

    def test_private_workspace_job_retains_borrowed_task_source_lease(self):
        self.socket_server()
        directory = isolation.prepare(self.run, "driver-A", "A", profile={"schema": 1, "workspace_access": "none"})
        private_workspace = directory / "workspace"
        results = []
        program = "from pathlib import Path; import time; Path('started').touch();\nwhile not Path('finish').exists(): time.sleep(.01)"
        with jobs.lease(self.run, str(self.trees / "A"), True) as held:
            worker = threading.Thread(target=lambda: results.append(isolation.launch(
                directory, ["/usr/bin/python3", "-c", program], source_lease=held,
                capture_output=True, timeout=10)))
            worker.start()
            self.await_file(private_workspace / "started")
        # Even loss of the host's descriptor cannot expose source to a writer
        # while the command authorized against that source can still act.
        try:
            with self.assertRaisesRegex(StateError, "still owns the workspace"):
                with jobs.lease(self.run, str(self.trees / "A"), False):
                    self.fail("private-workspace command lost its task source lease")
        finally:
            (private_workspace / "finish").touch()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results[0].returncode, 0, results[0].stderr)
        with jobs.lease(self.run, str(self.trees / "A"), False):
            pass

    def test_child_cannot_unlock_host_execution_or_source_lease(self):
        self.socket_server()
        directory = isolation.prepare(self.run, "driver-A", "A")
        program = '''
import fcntl, time
from pathlib import Path
for entry in list(Path('/proc/self/fd').iterdir()):
    fd = int(entry.name)
    if fd < 3: continue
    try: fcntl.flock(fd, fcntl.LOCK_UN)
    except OSError: pass
Path('unlock-attempted').touch()
while not Path('finish').exists(): time.sleep(.01)
'''
        results, failures = [], []
        with execution_guard(self.run, "protected-operation") as guard:
            def run():
                try:
                    results.append(isolation.launch(directory, ["/usr/bin/python3", "-c", program],
                                                    execution=guard, capture_output=True, text=True, timeout=10))
                except Exception as error:
                    failures.append(error)
            worker = threading.Thread(target=run)
            worker.start()
            try:
                self.await_file(self.trees / "A/unlock-attempted")
                with execution_guard(self.run, "protected-operation") as second:
                    self.assertIsNone(second, "child released the host's execution guard")
                with self.assertRaisesRegex(StateError, "still owns the workspace"):
                    with jobs.lease(self.run, str(self.trees / "A"), False):
                        self.fail("child released the source lease")
            finally:
                (self.trees / "A/finish").touch()
                worker.join(5)
            self.assertFalse(worker.is_alive())
            self.assertFalse(failures, failures)
            self.assertEqual(results[0].returncode, 0, results[0].stderr)

    def test_reaper_retains_every_lock_after_original_descriptors_close(self):
        self.socket_server()
        directory = isolation.prepare(self.run, "driver-A", "A")
        spec = json.loads((directory / "launch.json").read_text())
        locks = [self.root / "first.lock", self.root / "second.lock"]
        fds = [os.open(path, os.O_RDWR | os.O_CREAT, 0o600) for path in locks]
        for fd in fds:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        program = "from pathlib import Path; import time; Path('started').touch();\nwhile not Path('finish').exists(): time.sleep(.01)"
        command = isolation.command(spec, ["/usr/bin/python3", "-c", program])
        process = None
        info_fd = os.open(directory / "namespace.json", os.O_CREAT | os.O_WRONLY, 0o600)
        try:
            with jobs.retained_locks(fds) as retained:
                command[1:1] = ["--sync-fd", str(retained.fileno()), "--info-fd", str(info_fd)]
                process = subprocess.Popen(command, pass_fds=(retained.fileno(), info_fd),
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            for fd in fds:
                os.close(fd)
            fds.clear()
            self.await_file(self.trees / "A/started")
            for path in locks:
                with path.open("rb") as probe:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
            (self.trees / "A/finish").touch()
            _, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, stderr)
            job = {"directory": str(directory),
                   "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip()}
            deadline = time.monotonic() + 2
            while jobs.namespace(job) is not None and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertIsNone(jobs.namespace(job), "namespace did not exit after its monitor")
            for path in locks:
                with path.open("rb") as probe:
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(info_fd)
            for fd in fds:
                os.close(fd)
            if process is not None and process.poll() is None:
                process.kill()
                process.communicate(timeout=5)


@unittest.skipUnless(sys.platform == "linux", "namespace evidence is read from procfs")
class NamespaceEvidenceTests(unittest.TestCase):
    def test_process_that_exits_while_its_namespace_is_inspected_is_gone(self):
        with tempfile.TemporaryDirectory() as root:
            evidence = Path(root) / "namespace.json"
            evidence.write_text(json.dumps({"child-pid": os.getpid(), "pid-namespace": 1}))
            evidence.chmod(0o600)
            job = {"directory": root, "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip()}
            stat = Path.stat

            def exits_first(path, *args, **kwargs):
                # procfs still lists the process, then fails to follow its link.
                if str(path).endswith("/ns/pid"):
                    raise ProcessLookupError(errno.ESRCH, "No such process")
                return stat(path, *args, **kwargs)

            with patch.object(Path, "stat", exits_first):
                self.assertIsNone(jobs.namespace(job))


if __name__ == "__main__":
    unittest.main()
