"""Real socket and process tests for the enforced communication boundary."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

SCRIPTS = Path(os.environ.get("JIG_ORCHESTRATION_TEST_SCRIPTS",
                              Path(__file__).resolve().parents[1] / "skills/herdr-orchestrate/scripts")).resolve()
sys.path.insert(0, str(SCRIPTS))
import channel
import communicate
import gateway
import isolation
from state import Engine, StateError


class ChannelFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.servers = {}
        self.run = self.root / "run"
        self.repo = self.root / "main"
        self.repo.mkdir()
        self.trees = self.root / "trees"
        self.trees.mkdir()
        self.config = {
            "repository": {"path": str(self.repo), "target": "main", "host": "local"},
            "scope": {"task_ids": ["A", "B"]},
            "tracker": {"kind": "bead", "authority": "fixture"},
            "hosts": {"local": {"slots": 2, "worktree_root": str(self.trees), "endpoint": {"session": "fixture"}}},
            "actors": {f"driver-{task}": {"role": "driver", "task_ids": [task], "host": "local", "helper_route": True}
                       for task in ("A", "B")},
            "authority": sorted(Engine.ACTIONS), "integration": {"enabled": False}, "scheduler": {"enabled": False},
        }
        Engine.initialize(self.run, self.config)
        self.proof = {"ref": "fixture:channel", "observed_at": datetime.now(timezone.utc).isoformat()}
        for task_id in ("A", "B"):
            (self.trees / task_id).mkdir()
            Engine.apply(self.run, {"op": "admit", "action_id": "admit-" + task_id, "expected_policy": 1,
                                   "task_id": task_id, "driver": "driver-" + task_id, "host": "local",
                                   "identity": {"native_id": "native-" + task_id}, "worktree": str(self.trees / task_id),
                                   "branch": "task/" + task_id,
                                   "claim": {**self.proof, "authority": "fixture", "task_id": task_id,
                                             "owner": "driver-" + task_id, "confirmed": True, "ready": True, "unpublished": False}})

    def socket_server(self):
        context = gateway.server(self.run)
        server = context.__enter__()
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.servers[server] = (thread, context)
        self.addCleanup(self.stop_server, server)
        return server

    def verify_enforcement(self):
        """Upgrade only this disposable fixture, using the real host probe."""
        from state import locked, read_json, write_atomic
        import capabilities
        for task_id in ("A", "B"):
            if not (self.trees / task_id / ".git").exists():
                subprocess.run(["git", "init", "-q", "-b", "main", str(self.trees / task_id)], check=True)
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            state["config"].setdefault("communication", {})["mode"] = "enforced"
            state["config"]["hosts"]["local"]["execution"] = {"kind": "local"}
            write_atomic(path / "state.json", state)
            from storage import LEDGER, initialize
            if not (path / LEDGER).exists():
                initialize(path, state["config"])
        capabilities.verify(self.run, "local")

    def stop_server(self, server):
        if server in self.servers:
            thread, context = self.servers.pop(server)
            server.shutdown()
            thread.join(5)
            context.__exit__(None, None, None)

    def call(self, token, **payload):
        return communicate.request(payload, socket_path=str(self.run / "endpoint/gateway.sock"), credential=token, timeout=5)


class ChannelTests(ChannelFixture, unittest.TestCase):

    def test_real_socket_identity_scope_and_admin_rejection(self):
        self.socket_server()
        token = channel.issue(self.run, "driver-A")
        view = self.call(token, op="query", task_id="A")
        self.assertEqual(view["task"]["id"], "A")
        self.assertNotIn("communication", view)
        self.assertEqual(self.call(token, op="query", task_id="B")["error"], "wrong_task")
        self.assertEqual(self.call(token, op="query", task_id="A", caller="coordinator")["error"], "invalid")
        self.assertEqual(self.call(token, op="configure", task_id="A")["error"], "forbidden")
        self.assertEqual(self.call("invalid.token", op="query", task_id="A")["error"], "unauthenticated")

    def test_replacement_fences_idempotent_results_and_existing_watch(self):
        self.socket_server()
        token = channel.issue(self.run, "driver-A")
        initial = self.call(token, op="query", task_id="A")
        request = {"op": "observe", "task_id": "A", "action_id": "observation",
                   "expected_policy": initial["policy_version"], "expected_task": initial["task"]["version"],
                   "fields": {"next_action": "implement"}, "evidence": self.proof}
        result = self.call(token, **request)
        self.assertNotIn("error", result)
        self.assertEqual(self.call(token, **request), result)
        current = self.call(token, op="query", task_id="A")
        replies = []
        waiter = threading.Thread(target=lambda: replies.append(self.call(token, op="watch", task_id="A",
                                   after=current["change_token"], until_change=True)))
        waiter.start()
        replacement = channel.issue(self.run, "driver-A")
        waiter.join(5)
        self.assertFalse(waiter.is_alive())
        self.assertEqual(replies[0]["error"], "session_revoked")
        self.assertEqual(self.call(token, **request)["error"], "session_revoked")
        self.assertEqual(self.call(replacement, op="query", task_id="A")["task"]["id"], "A")

    def test_native_identity_change_fences_previous_session(self):
        token = channel.issue(self.run, "driver-A")
        task = Engine.read(self.run)["tasks"]["A"]
        Engine.apply(self.run, {"op": "recover_session", "action_id": "recover", "expected_policy": 1,
                               "task_id": "A", "expected_task": task["version"],
                               "previous_identity": task["identity"], "identity": {"native_id": "replacement"},
                               "evidence": {**self.proof, "previous_session_stopped": True, "replacement_verified": True,
                                            "host": "local", "worktree": task["worktree"]}})
        with self.assertRaisesRegex(StateError, "binding changed"):
            gateway.query(self.run, channel.parse_credential(token), "A")

    def test_parent_replacement_fences_children_and_cached_artifact_results(self):
        self.socket_server()
        parent = channel.parse_credential(channel.issue(self.run, "driver-A"))
        children = [channel.issue(self.run, "child-" + role, role=role, task_ids=["A"], parent_session=parent)
                    for role in ("reviewer", "executor")]
        requests = [{"op": "artifact_put", "task_id": "A", "action_id": "report-" + str(index),
                     "content": "original report"} for index in range(len(children))]
        for child, request in zip(children, requests):
            self.assertNotIn("error", self.call(child, **request))
        original_artifacts = Engine.read(self.run)["communication"]["artifacts"]
        channel.issue(self.run, "driver-A")
        for child, request in zip(children, requests):
            self.assertEqual(self.call(child, **request)["error"], "session_revoked")
            self.assertEqual(self.call(child, op="query", task_id="A")["error"], "session_revoked")
        self.assertEqual(Engine.read(self.run)["communication"]["artifacts"], original_artifacts)
        with self.assertRaisesRegex(StateError, "revoked or replaced"):
            channel.issue(self.run, "new-child", role="executor", task_ids=["A"], parent_session=parent)

    def test_child_authority_cannot_exceed_parent_or_survive_route_revocation(self):
        parent = channel.parse_credential(channel.issue(self.run, "driver-A"))
        with self.assertRaisesRegex(StateError, "cannot access this task"):
            channel.issue(self.run, "wrong-task", role="executor", task_ids=["B"], parent_session=parent)
        child = channel.parse_credential(channel.issue(self.run, "child", role="executor", task_ids=["A"],
                                                       parent_session=parent))
        state = Engine.read(self.run)
        state["config"]["actors"]["driver-A"]["helper_route"] = False
        with self.assertRaisesRegex(StateError, "route or scope was revoked"):
            channel.check(state, child, operation="artifact_put", task_id="A")

    def test_enforced_children_require_a_root_owner(self):
        from state import locked, read_json, write_atomic
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            state["config"]["communication"] = {"mode": "enforced"}
            write_atomic(path / "state.json", state)
            from storage import initialize
            initialize(path, state["config"])
        with self.assertRaisesRegex(StateError, "require an authorizing session"):
            channel.issue(self.run, "orphan", role="reviewer", task_ids=["A"])
        parent = channel.parse_credential(channel.issue(self.run, "driver-A"))
        child = channel.parse_credential(channel.issue(self.run, "child", role="executor", task_ids=["A"],
                                                       parent_session=parent))
        with self.assertRaises(StateError):
            channel.issue(self.run, "grandchild", role="reviewer", task_ids=["A"], parent_session=child)

    def test_coordinator_is_scoped_and_cannot_reconfigure_its_boundary(self):
        self.socket_server()
        token = channel.issue(self.run, "coordinator")
        self.assertEqual(set(self.call(token, op="query")["tasks"]), {"A", "B"})
        self.assertEqual(self.call(token, op="configure")["error"], "forbidden")
        identity = self.call(token, op="observe", task_id="A", action_id="identity-bypass",
                             fields={"identity": {"native_id": "unverified"}})
        self.assertEqual(identity["error"], "forbidden")
        paused = self.call(token, op="control", control="pause", action_id="pause", expected_policy=1)
        self.assertNotIn("error", paused)
        self.assertTrue(Engine.read(self.run)["controls"]["paused"])

    def test_running_coordinator_covers_a_task_added_after_its_launch(self):
        self.socket_server()
        token = channel.issue(self.run, "coordinator")
        driver = channel.issue(self.run, "driver-A")
        state = Engine.read(self.run)
        actors = {**state["config"]["actors"],
                  "driver-C": {"role": "driver", "task_ids": ["C"], "host": "local", "helper_route": True}}
        # Only host administration widens the run; the session cannot do this itself.
        Engine.apply(self.run, {"op": "configure", "action_id": "add-C", "expected_policy": state["policy_version"],
                                "fields": {"scope": {"task_ids": ["A", "B", "C"]}, "actors": actors},
                                "evidence": self.proof})
        (self.trees / "C").mkdir()
        admitted = self.call(token, op="admit", action_id="admit-C", task_id="C", driver="driver-C", host="local",
                             expected_policy=Engine.read(self.run)["policy_version"],
                             identity={"native_id": "native-C"}, worktree=str(self.trees / "C"), branch="task/C",
                             claim={**self.proof, "authority": "fixture", "task_id": "C", "owner": "driver-C",
                                    "confirmed": True, "ready": True, "unpublished": False})
        self.assertNotIn("error", admitted)
        self.assertEqual(set(self.call(token, op="query")["tasks"]), {"A", "B", "C"})
        sent = self.call(token, op="message", task_id="C", action_id="assign-C", recipient="driver-C",
                         kind="assignment", body="Implement the consumer")
        self.assertTrue(sent.get("accepted"), sent)
        # A driver keeps the tasks it was launched for.
        self.assertEqual(self.call(driver, op="query", task_id="C")["error"], "wrong_task")

    def test_reviewer_can_read_its_task_but_cannot_mutate(self):
        self.socket_server()
        task = Engine.read(self.run)["tasks"]["A"]
        Engine.apply(self.run, {"op": "observe", "action_id": "prior-review", "task_id": "A",
                               "expected_policy": 1, "expected_task": task["version"],
                               "fields": {"findings": [{"text": "private-prior-finding"}],
                                          "next_action": "private-prior-conclusion"}, "evidence": self.proof})
        token = channel.issue(self.run, "review-A", role="reviewer", task_ids=["A"])
        view = self.call(token, op="query", task_id="A")
        self.assertEqual(view["task"]["id"], "A")
        self.assertNotIn("private-prior", json.dumps(view))
        self.assertEqual(self.call(token, op="observe", task_id="A")["error"], "forbidden")
        self.assertEqual(self.call(token, op="query", task_id="B")["error"], "wrong_task")
        self.assertEqual(self.call(token, op="query")["error"], "wrong_task")

    def test_idle_connections_cannot_occupy_control_capacity(self):
        self.socket_server()
        token = channel.issue(self.run, "coordinator")
        for _ in range(64):
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.addCleanup(connection.close)
            connection.settimeout(2)
            connection.connect(str(self.run / "endpoint/gateway.sock"))
        result = self.call(token, op="control", control="pause", action_id="pause-under-load", expected_policy=1)
        self.assertNotIn("error", result)
        self.assertTrue(Engine.read(self.run)["controls"]["paused"])

    def test_one_actor_cannot_fill_all_wait_slots(self):
        server = self.socket_server()
        token = channel.issue(self.run, "driver-A")
        view = self.call(token, op="query", task_id="A")
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(connection.close)
        connection.connect(str(self.run / "endpoint/gateway.sock"))
        payload = {"op": "watch", "task_id": "A", "after": view["change_token"]}
        connection.sendall((json.dumps({"protocol": 1, "credential": token, "request": payload}) + "\n").encode())
        deadline = time.monotonic() + 2
        while not server.active.get(("driver-A", "watch")) and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(server.active.get(("driver-A", "watch")), 1)
        self.assertEqual(self.call(token, **payload)["error"], "busy")
        coordinator = channel.issue(self.run, "coordinator")
        self.assertNotIn("error", self.call(coordinator, op="control", control="pause",
                                          action_id="pause-with-watch", expected_policy=1))


class IsolationTests(ChannelFixture, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if sys.platform != "linux" or not shutil.which("bwrap"):
            if os.environ.get("JIG_ORCHESTRATION_REQUIRE_ISOLATION") == "1":
                raise AssertionError("required Linux/Bubblewrap isolation is unavailable")
            raise unittest.SkipTest("Linux/Bubblewrap isolation is unavailable")
        probe = subprocess.run(["bwrap", "--unshare-all", "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib",
                                "--symlink", "usr/lib64", "/lib64", "/usr/bin/true"], capture_output=True, text=True)
        if probe.returncode:
            if os.environ.get("JIG_ORCHESTRATION_REQUIRE_ISOLATION") == "1":
                raise AssertionError(probe.stderr)
            raise unittest.SkipTest("kernel denies required namespaces: " + probe.stderr.strip())

    def test_real_process_edits_builds_and_reports_without_host_access(self):
        self.socket_server()
        canary = self.root / "host-secret"
        canary.write_text("must stay outside")
        sibling = self.trees / "B" / "private"
        sibling.write_text("sibling data")
        directory = isolation.prepare(self.run, "driver-A", "A")
        program = """
import json, os, pathlib, socket, subprocess, sys
sys.path.insert(0, '/opt/orchestration')
import communicate
for target in json.loads(sys.argv[1]):
    assert not pathlib.Path(target).exists(), target
assert 'HOST_ONLY_SECRET' not in os.environ
assert not pathlib.Path('/run/docker.sock').exists()
assert not pathlib.Path('/home/aa').exists()
probe = socket.socket()
try:
    probe.settimeout(.1)
    probe.connect(('1.1.1.1', 443))
    raise AssertionError('network escaped')
except OSError:
    pass
pathlib.Path('main.c').write_text('int main(void) { return 0; }')
subprocess.run(['cc', 'main.c', '-o', 'program'], check=True)
subprocess.run(['./program'], check=True)
view = communicate.request({'op':'query','task_id':'A'})
assert view['task']['id'] == 'A', view
result = communicate.request({'op':'observe','task_id':'A','action_id':'from-isolation',
    'expected_policy':view['policy_version'],'expected_task':view['task']['version'],
    'fields':{'next_action':'review'},'evidence':{'ref':'fixture:build','observed_at':'2026-11-08T12:00:00Z'}})
assert 'error' not in result, result
print('built-and-reported')
"""
        targets = [str(canary), str(sibling), str(self.run / "state.json")]
        result = isolation.launch(directory, ["/usr/bin/python3", "-c", program, json.dumps(targets)],
                                  capture_output=True, text=True, timeout=30, env={**os.environ, "HOST_ONLY_SECRET": "private"})
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("built-and-reported", result.stdout)
        self.assertTrue((self.trees / "A" / "program").exists())
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["next_action"], "review")
        self.assertEqual(canary.read_text(), "must stay outside")

    def test_readonly_reviewer_and_private_git_requirement(self):
        self.socket_server()
        directory = isolation.prepare(self.run, "review-A", "A", role="reviewer")
        result = isolation.launch(directory, ["/bin/sh", "-c", "touch forbidden"], capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.trees / "A" / "forbidden").exists())
        (self.trees / "A" / ".git").write_text("gitdir: /other/worktree")
        with self.assertRaisesRegex(StateError, "private Git"):
            isolation.prepare(self.run, "driver-A", "A")

    def test_fixed_client_accepts_one_json_argument_without_shell_redirection(self):
        self.socket_server()
        directory = isolation.prepare(self.run, "driver-A", "A")
        result = isolation.launch(directory, ["/usr/bin/python3", "-B", "/opt/orchestration/communicate.py",
                                  "--json", json.dumps({"op": "query", "task_id": "A"})],
                                  capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["task"]["id"], "A")

    def test_context_attests_the_live_peer_namespace_and_survives_gateway_restart(self):
        self.verify_enforcement()
        server = self.socket_server()
        owner = channel.parse_credential(channel.issue(self.run, "driver-A"))
        directory = isolation.prepare(self.run, "review-context", "A", role="reviewer", parent_session=owner)
        spec = json.loads((directory / "launch.json").read_text())
        credential = Path(spec["credential"]).read_text().strip()
        home = Path(spec["home"])
        program = """
import json, os, pathlib, sys, time
sys.path.insert(0, '/opt/orchestration')
import communicate
home = pathlib.Path(os.environ['HOME'])
for number in range(2):
    context = communicate.request({'op':'context', 'task_id':'A'})
    assert context.get('source_access') == 'read', context
    assert context['role'] == 'reviewer', context
    assert context['boundary'] == 'linux-namespaces', context
    assert context['network'] == 'gateway-egress-only', context
    assert context['worktree'] == str(pathlib.Path.cwd()), context
    (home / ('context-' + str(number))).write_text(json.dumps(context))
    if number == 0:
        while not (home / 'continue').exists():
            time.sleep(.01)
"""
        results = []
        thread = threading.Thread(target=lambda: results.append(isolation.launch(
            directory, ["/usr/bin/python3", "-B", "-c", program], capture_output=True, text=True, timeout=15)))
        thread.start()
        try:
            deadline = time.monotonic() + 5
            while not (home / "context-0").exists() and thread.is_alive() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue((home / "context-0").exists(), str(results))
            # Possessing the credential is insufficient to attest a host process
            # as the confined reviewer, even while its actual namespace is live.
            self.assertEqual(self.call(credential, op="context", task_id="A")["error"], "boundary")
            self.assertEqual(self.call(credential, op="context", task_id="A", peer_pid=os.getpid())["error"], "invalid")
            self.stop_server(server)
            self.socket_server()
        finally:
            (home / "continue").touch()
            thread.join(17)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results[0].returncode, 0, results[0].stderr)
        self.assertTrue((home / "context-1").exists())
        self.assertEqual(self.call(credential, op="context", task_id="A")["error"], "boundary")

    def test_running_sandbox_reconnects_after_gateway_restart(self):
        server = self.socket_server()
        directory = isolation.prepare(self.run, "driver-A", "A")
        spec = json.loads((directory / "launch.json").read_text())
        program = """
import sys
sys.path.insert(0, '/opt/orchestration')
import communicate
print(communicate.request({'op':'query','task_id':'A'})['task']['id'], flush=True)
input()
print(communicate.request({'op':'query','task_id':'A'}, timeout=2)['task']['id'], flush=True)
"""
        child = subprocess.Popen(isolation.command(spec, ["/usr/bin/python3", "-c", program]),
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "A")
            self.stop_server(server)
            self.socket_server()
            out, err = child.communicate("\n", timeout=5)
            self.assertEqual(child.returncode, 0, err)
            self.assertEqual(out.strip(), "A")
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()

    def test_coordinator_runs_without_exposing_or_locking_task_checkout(self):
        self.socket_server()
        coordinator = isolation.prepare(self.run, "coordinator", "A")
        spec = json.loads((coordinator / "launch.json").read_text())
        results = []
        program = """
import os, pathlib, sys, time
sys.path.insert(0, '/opt/orchestration')
import communicate
assert len(communicate.request({'op':'query'})['tasks']) == 2
assert not pathlib.Path(sys.argv[1]).exists()
home = pathlib.Path(os.environ['HOME'])
(home / 'ready').touch()
while not (home / 'release').exists():
    time.sleep(.01)
"""
        thread = threading.Thread(target=lambda: results.append(isolation.launch(
            coordinator, ["/usr/bin/python3", "-c", program, str(self.trees / "A")],
            capture_output=True, text=True, timeout=10)))
        thread.start()
        try:
            ready = Path(spec["home"]) / "ready"
            deadline = time.monotonic() + 3
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(ready.exists())
            driver = isolation.prepare(self.run, "driver-A", "A")
            result = isolation.launch(driver, ["/usr/bin/touch", "written"])
            self.assertEqual(result.returncode, 0)
        finally:
            (Path(spec["home"]) / "release").touch()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results[0].returncode, 0, results[0].stderr)


if __name__ == "__main__":
    unittest.main()
