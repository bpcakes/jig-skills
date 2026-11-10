"""Execute configured adapters through the real isolated gateway path."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

import test_channel
from test_channel import ChannelFixture, channel, Engine, isolation
from state import locked, read_json, write_atomic
import jobs


ADAPTER = '''import json, pathlib, sys
sys.path.insert(0, '/opt/orchestration')
import communicate
p = json.load(sys.stdin)
root = pathlib.Path.cwd()
assert not pathlib.Path(sys.argv[1]).exists(), 'host canary exposed'
assert not pathlib.Path(sys.argv[2]).exists(), 'run state exposed'
assert communicate.request({'op': 'query', 'task_id': 'B'})['error'] == 'wrong_task'
effect = root / 'effect'
if p['mode'] == 'dispatch':
    if p['kind'] == 'review':
        assert effect.read_text() == 'applied'
        try:
            effect.write_text('reviewer mutation')
        except PermissionError:
            pass
        except OSError as error:
            assert error.errno == 30
        else:
            raise AssertionError('reviewer could write source')
    else:
        assert not effect.exists(), 'duplicate external effect'
        effect.write_text('applied')
        result = communicate.request({'op': 'message', 'task_id': 'A', 'action_id': p['operation_id'] + '-message',
                                      'recipient': 'driver-A', 'kind': 'update', 'body': 'implementation complete'})
        assert result['accepted'], result
        if p['target'].get('lost'):
            sys.exit(17)
assert effect.read_text() == 'applied'
print(json.dumps({'status': 'succeeded', 'receipt': {'ref': str(effect),
                  'observed_at': '2026-11-08T00:00:00Z', 'all_jobs_settled': True}}))
'''


class EnforcedExecutionTests(ChannelFixture, unittest.TestCase):
    setUpClass = classmethod(test_channel.IsolationTests.setUpClass.__func__)

    def setUp(self):
        super().setUp()
        self.socket_server()
        self.token = channel.issue(self.run, "driver-A")
        task = Engine.read(self.run)["tasks"]["A"]
        Engine.apply(self.run, {"op": "delegate", "action_id": "grant", "task_id": "A",
                               "expected_policy": 1, "expected_task": task["version"],
                               "executor": "driver-A", "actions": ["implement", "review"]})
        self.canary = self.root / "host-private"
        self.canary.write_text("must not be exposed")
        self.adapter_source = self.root / "adapter.py"
        self.adapter_source.write_text(ADAPTER)

    def configure(self, *, kind="implement", profile=True):
        argv = ["/usr/bin/python3", "-B", "/opt/tools/adapter.py", str(self.canary), str(self.run / "state.json")]
        adapter = {"kind": kind, "host": "local", "argv": argv, "inspect_argv": argv, "timeout_seconds": 10}
        if profile:
            adapter["profile"] = {"schema": 1, "mounts": [{"source": str(self.adapter_source), "target": "/opt/tools/adapter.py"}]}
        state = Engine.read(self.run)
        Engine.apply(self.run, {"op": "configure", "action_id": "configure-" + str(state["version"]),
                               "expected_policy": state["policy_version"], "fields": {"adapters": {"fixture": adapter}},
                               "evidence": self.proof})

    def request(self, *, action_id="execute", kind="implement", lost=False):
        state = Engine.read(self.run)
        return {"op": "execute", "action_id": action_id, "task_id": "A", "kind": kind,
                "adapter": "fixture", "target": {"agent": "fixture", "lost": lost}, "refs": {},
                "evidence": self.proof, "expected_policy": state["policy_version"],
                "expected_task": state["tasks"]["A"]["version"]}

    def test_real_adapter_uses_scoped_protocol_and_completed_operation_is_not_repeated(self):
        self.configure()
        request = self.request()
        first = self.call(self.token, **request)
        self.assertEqual(first.get("outcome"), "succeeded", first)
        repeated = self.call(self.token, **request)
        self.assertEqual(repeated, first)
        state = Engine.read(self.run)
        self.assertFalse(state["tasks"]["A"]["reservations"])
        self.assertEqual(state["tasks"]["A"]["counters"]["implementation"], 1)
        self.assertEqual(len(state["communication"]["jobs"]), 1)
        self.assertTrue(next(iter(state["communication"]["jobs"].values()))["local_settled"])
        inbox = self.call(self.token, op="inbox", task_id="A")
        self.assertIn("implementation complete", json.dumps(inbox))

    def test_lost_adapter_reply_is_inspected_readonly_without_repeating_effect(self):
        self.configure()
        request = self.request(lost=True)
        first = self.call(self.token, **request)
        self.assertEqual(first.get("outcome"), "unknown", first)
        resumed = self.call(self.token, op="execute", task_id="A", action_id=request["action_id"])
        self.assertEqual(resumed.get("outcome"), "succeeded", resumed)
        state = Engine.read(self.run)
        self.assertEqual(state["tasks"]["A"]["counters"]["implementation"], 1)
        self.assertEqual(sorted(job["readonly"] for job in state["communication"]["jobs"].values()), [False, True])

    def cancelled_inspection(self, *, second_control=None, task_control=False):
        self.adapter_source.write_text(ADAPTER.replace("sys.exit(17)", "__import__('time').sleep(10); sys.exit(17)")
            .replace("assert effect.read_text() == 'applied'\nprint", """assert effect.read_text() == 'applied'
if p['mode'] == 'inspect':
    try: effect.write_text('duplicate')
    except OSError: pass
    else: raise AssertionError('inspection must be read-only')
    __import__('time').sleep(1.5)
print"""))
        self.configure()
        self.verify_enforcement()
        current = Engine.read(self.run)
        Engine.apply(self.run, {"op": "delegate", "action_id": "verified-grant", "task_id": "A",
            "expected_policy": current["policy_version"], "expected_task": current["tasks"]["A"]["version"],
            "executor": "driver-A", "actions": ["implement"]})
        coordinator = channel.issue(self.run, "coordinator")
        def control(name, action, *, scoped=False):
            state = Engine.read(self.run)
            scope = {"task_id": "A", "expected_task": state["tasks"]["A"]["version"]} if scoped else {}
            return self.call(coordinator, op="control", control=name, action_id=action,
                             expected_policy=state["policy_version"], **scope)
        request = self.request(lost=True)
        replies = []
        worker = threading.Thread(target=lambda: replies.append(self.call(self.token, **request)))
        worker.start()
        deadline = time.monotonic() + 5
        while not (self.trees / "A/effect").exists() and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue((self.trees / "A/effect").exists())
        self.assertNotIn("error", control("cancel", "cancel-issued"))
        worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(replies[0].get("outcome"), "unknown", replies)
        self.assertEqual(control("resume", "resume-pending").get("error"), "unsettled")
        ordinary = isolation.prepare(self.run, "ordinary-reader", "A", role="executor",
                                     parent_session=channel.parse_credential(self.token),
                                     profile={"schema": 1, "workspace_access": "read"})
        with self.assertRaisesRegex(test_channel.StateError, "paused"):
            isolation.launch(ordinary, ["/usr/bin/true"])
        with self.assertRaisesRegex(test_channel.StateError, "execution guard"):
            isolation.launch(ordinary, ["/usr/bin/true"], inspection=True)
        replies.clear()
        retry = {"op": "execute", "task_id": "A", "action_id": request["action_id"]}
        worker = threading.Thread(target=lambda: replies.append(self.call(self.token, **retry)))
        worker.start()
        deadline = time.monotonic() + 5
        inspector = None
        while time.monotonic() < deadline:
            inspector = next((job for job in jobs.records(Engine.read(self.run)).values()
                              if job.get("inspection") and job["status"] == "running"), None)
            if inspector:
                break
            time.sleep(.02)
        self.assertIsNotNone(inspector)
        jobs.cancel_requested(self.run)
        self.assertTrue(jobs.namespace(inspector), "the old cancellation must permit its recovery inspection")
        if second_control:
            self.assertNotIn("error", control(second_control, "control-inspection", scoped=task_control))
            jobs.cancel_requested(self.run)
            if second_control == "pause":
                self.assertTrue(jobs.namespace(inspector), "pause must let the existing inspector finish")
        worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(replies[0].get("outcome"), "unknown" if second_control == "cancel" else "succeeded", replies)
        if second_control == "cancel":
            self.assertEqual(self.call(self.token, **retry).get("outcome"), "succeeded")
        if task_control:
            self.assertNotIn("error", control("resume", "resume-task-settled", scoped=True))
        self.assertNotIn("error", control("resume", "resume-settled"))
        state = Engine.read(self.run)
        self.assertIsNone(state["tasks"]["A"]["pending_intent"])
        self.assertFalse(state["tasks"]["A"]["reservations"])
        self.assertEqual(state["tasks"]["A"]["counters"]["implementation"], 1)
        self.assertEqual((self.trees / "A/effect").read_text(), "applied")

    def test_cancelled_adapter_can_be_inspected_readonly_before_resume(self):
        self.cancelled_inspection()

    def test_new_cancel_stops_recovery_inspection_without_losing_original_operation(self):
        self.cancelled_inspection(second_control="cancel")

    def test_pause_preserves_running_recovery_inspection_under_existing_cancel(self):
        self.cancelled_inspection(second_control="pause")

    def test_task_pause_preserves_running_recovery_inspection_under_existing_cancel(self):
        self.cancelled_inspection(second_control="pause", task_control=True)

    def test_legacy_close_adapter_can_write_its_local_tracker_record(self):
        self.adapter_source.write_text("""import pathlib,json,sys
p=json.load(sys.stdin)
pathlib.Path('legacy-tracker-record').write_text('closed')
print(json.dumps({'status':'succeeded','receipt':{**p['target'],**p['evidence'],
 'status':'closed','unpublished':False}}))
""")
        self.configure(kind="close")
        state = Engine.read(self.run)
        task = state["tasks"]["A"]
        request = self.request(kind="close")
        request["target"] = {"authority": state["config"]["tracker"]["authority"],
                             "task_id": "A", "owner": task["claim"]["owner"]}
        request["evidence"] = {**self.proof, "all_jobs_settled": True,
                               "criteria_met": True, "acceptance_ref": "legacy-fixture"}
        result = self.call(channel.issue(self.run, "coordinator"), **request)
        self.assertEqual(result.get("outcome"), "succeeded", result)
        self.assertEqual(result.get("closed"), "A", result)
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["phase"], "closed")
        self.assertEqual((self.trees / "A/legacy-tracker-record").read_text(), "closed")

    def test_private_workspace_inspector_preserves_no_source_access_under_cancel(self):
        self.adapter_source.write_text("""import json,pathlib,sys
p=json.load(sys.stdin)
assert not pathlib.Path(p['target']['source']).exists()
pathlib.Path('scratch').write_text('private inspection scratch')
print(json.dumps({'status':'unknown' if p['mode']=='dispatch' else 'succeeded',
 'receipt':{'ref':'external-fixture','observed_at':'2026-11-08T00:00:00Z','all_jobs_settled':True}}))
""")
        self.configure()
        self.verify_enforcement()
        state = Engine.read(self.run)
        adapter = state["config"]["adapters"]["fixture"]
        adapter["profile"]["workspace_access"] = "none"
        configured = Engine.apply(self.run, {"op":"configure", "action_id":"private-inspector",
            "expected_policy":state["policy_version"], "fields":{"adapters":{"fixture":adapter}}, "evidence":self.proof})
        Engine.apply(self.run, {"op":"delegate", "action_id":"private-grant", "task_id":"A",
            "expected_policy":configured["policy_version"], "expected_task":state["tasks"]["A"]["version"],
            "executor":"driver-A", "actions":["implement"]})
        request = self.request()
        request["target"]["source"] = str(self.trees / "A")
        self.assertEqual(self.call(self.token, **request).get("outcome"), "unknown")
        coordinator = channel.issue(self.run, "coordinator")
        cancelled = self.call(coordinator, op="control", action_id="cancel-private", control="cancel",
                              expected_policy=Engine.read(self.run)["policy_version"])
        self.assertNotIn("error", cancelled)
        result = self.call(self.token, op="execute", action_id=request["action_id"], task_id="A")
        self.assertEqual(result.get("outcome"), "succeeded", result)
        self.assertFalse((self.trees / "A/scratch").exists())

    def test_busy_finish_retains_pending_effect_for_inspection(self):
        from state import StateError
        self.configure()
        request = self.request()
        apply = Engine.apply
        blocked = []
        def busy_finish(run_dir, transition, *args, **kwargs):
            if transition.get("op") == "finish":
                blocked.append(transition)
                raise StateError("state_busy", "injected finish lock contention")
            return apply(run_dir, transition, *args, **kwargs)
        with patch.object(Engine, "apply", side_effect=busy_finish):
            first = self.call(self.token, **request)
        self.assertEqual(first.get("error"), "state_busy", first)
        self.assertEqual(len(blocked), 1, "busy completion must not be relabeled as a rejected receipt")
        self.assertEqual((self.trees / "A/effect").read_text(), "applied")
        self.assertIsNotNone(Engine.read(self.run)["tasks"]["A"]["pending_intent"])
        resumed = self.call(self.token, op="execute", task_id="A", action_id=request["action_id"])
        self.assertEqual(resumed.get("outcome"), "succeeded", resumed)
        self.assertEqual(len(Engine.read(self.run)["communication"]["jobs"]), 2)

    def test_maximum_external_action_id_can_finish_and_replay(self):
        self.adapter_source.write_text(ADAPTER.replace("p['operation_id'] + '-message'", "'completed-message'"))
        self.configure()
        self.verify_enforcement()
        current = Engine.read(self.run)
        Engine.apply(self.run, {"op": "delegate", "action_id": "verified-grant", "task_id": "A",
                               "expected_policy": current["policy_version"], "expected_task": current["tasks"]["A"]["version"],
                               "executor": "driver-A", "actions": ["implement"]})
        request = self.request(action_id="é" * 128)
        first = self.call(self.token, **request)
        self.assertEqual(first.get("outcome"), "succeeded", first)
        self.assertEqual(self.call(self.token, **request), first)
        state = Engine.read(self.run)
        self.assertIsNone(state["tasks"]["A"]["pending_intent"])
        self.assertEqual(state["tasks"]["A"]["counters"]["implementation"], 1)

    def test_adapter_log_overflow_is_bounded_and_not_accepted_as_complete(self):
        self.adapter_source.write_text(ADAPTER.replace("print(json.dumps",
            "sys.stderr.buffer.write(b'x' * (2 * 1024 * 1024))\nprint(json.dumps"))
        self.configure()
        result = self.call(self.token, **self.request())
        self.assertEqual(result.get("outcome"), "unknown", result)
        self.assertEqual((self.trees / "A/effect").read_text(), "applied")
        logs = list(self.run.glob("execution-*/*.stderr"))
        self.assertEqual(len(logs), 1)
        self.assertLessEqual(logs[0].stat().st_size, 1024 * 1024)
        self.assertTrue(result["receipt"]["output"]["stderr"]["truncated"])

    def test_error_after_real_effect_does_not_claim_non_execution(self):
        self.configure()
        launch = isolation.launch

        def fail_after_execution(*args, **kwargs):
            result = launch(*args, **kwargs)
            self.assertEqual(result.returncode, 0)
            raise OSError("injected error after command completion")

        with patch.object(isolation, "launch", side_effect=fail_after_execution):
            result = self.call(self.token, **self.request())
        self.assertEqual((self.trees / "A/effect").read_text(), "applied")
        self.assertEqual(result.get("outcome"), "unknown", result)
        self.assertFalse(result["receipt"].get("no_effects", False))

    def test_truncated_valid_json_prefix_does_not_authorize_completion(self):
        self.adapter_source.write_text(ADAPTER + "\nsys.stdout.write(' ' * (2 * 1024 * 1024))\n")
        self.configure()
        result = self.call(self.token, **self.request())
        self.assertEqual(result.get("outcome"), "unknown", result)
        self.assertTrue(result["receipt"]["output"]["stdout"]["truncated"])
        # The retained prefix is valid JSON; only the completeness check can
        # prevent it from being mistaken for a complete successful result.
        retained = Path(result["receipt"]["ref"]).read_text()
        self.assertEqual(json.loads(retained)["status"], "succeeded")

    def test_missing_profile_or_occupied_workspace_consumes_no_attempt(self):
        self.configure(profile=False)
        first = self.call(self.token, **self.request())
        self.assertEqual(first.get("error"), "isolation", first)
        self.assert_occupied_workspace_consumes_no_attempt()

    def assert_occupied_workspace_consumes_no_attempt(self):
        self.configure()
        with jobs.lease(self.run, str(self.trees / "A"), False):
            sessions = Engine.read(self.run)["communication"]["sessions"]
            launches = set((self.run / "launches").glob("launch-*"))
            for _ in range(3):
                busy = self.call(self.token, **self.request())
                self.assertEqual(busy.get("error"), "unsettled", busy)
                self.assertEqual(busy.get("message"), "another isolated writer or reviewer still owns the workspace", busy)
            self.assertEqual(Engine.read(self.run)["communication"]["sessions"], sessions)
            self.assertEqual(set((self.run / "launches").glob("launch-*")), launches)
        task = Engine.read(self.run)["tasks"]["A"]
        self.assertFalse(task["reservations"])
        self.assertIsNone(task["pending_intent"])
        self.assertEqual(task["counters"].get("implementation", 0), 0)
        self.assertIsNone(Engine.action(self.run, "execute"))

    def test_enforced_occupied_workspace_consumes_no_launch_or_session(self):
        self.verify_enforcement()
        state = Engine.read(self.run)
        Engine.apply(self.run, {"op": "delegate", "action_id": "verified-lease-grant", "task_id": "A",
            "expected_policy": state["policy_version"], "expected_task": state["tasks"]["A"]["version"],
            "executor": "driver-A", "actions": ["implement"]})
        self.assert_occupied_workspace_consumes_no_attempt()

    def test_refused_new_dispatch_retries_allocate_no_sessions_or_launches(self):
        self.verify_enforcement()
        self.configure()
        state = Engine.read(self.run)
        Engine.apply(self.run, {"op": "delegate", "action_id": "verified-grant", "task_id": "A",
            "expected_policy": state["policy_version"], "expected_task": state["tasks"]["A"]["version"],
            "executor": "driver-A", "actions": ["implement"]})
        baseline = Engine.read(self.run)
        launches = set((self.run / "launches").glob("launch-*"))
        # Each fixture state represents a distinct admission refusal. Requests
        # go through the real authenticated gateway, without mocking the gates.
        cases = [
            ("run pause", "paused", lambda s: s["controls"].update(paused=True)),
            ("task pause", "paused", lambda s: s["tasks"]["A"].update(paused=True)),
            ("run cancel", "cancelled", lambda s: s["controls"].update(cancel_requested=True)),
            ("task cancel", "cancelled", lambda s: s["tasks"]["A"].update(cancel_requested=True)),
            ("hold", "held", lambda s: s["controls"]["holds"].update(test={"actions": ["implement"]})),
            ("authority", "authority", lambda s: s["config"].update(authority=["review"])),
            ("delegation", "authority", lambda s: s["tasks"]["A"]["delegation"].update(actions=[])),
            ("dependency", "dependency", lambda s: s["tasks"]["A"].update(recovery_dependencies=["B"])),
            ("deadline", "deadline", lambda s: s["config"].update(launch_cutoff="2000-01-01T00:00:00Z")),
            ("task budget", "budget", lambda s: s["config"].update(limits=[
                {"id": "test", "unit": "implementation", "scope": "task", "max": 0, "enforced": True}])),
            ("run budget", "budget", lambda s: s["config"].update(limits=[
                {"id": "test", "unit": "implementation", "scope": "run", "max": 0, "enforced": True}])),
            ("slots", "capacity", lambda s: (s["config"]["hosts"]["local"].update(slots=1),
                s["tasks"]["B"].update(slot={"host": "local", "reserved_at": self.proof["observed_at"]}))),
        ]
        for label, error, change in cases:
            with self.subTest(label=label):
                state = copy.deepcopy(baseline)
                change(state)
                with locked(self.run) as path:
                    write_atomic(path / "state.json", state)
                request = self.request()
                for action_id in ("execute", "execute", "another-execute"):
                    result = self.call(self.token, **{**request, "action_id": action_id})
                    self.assertEqual(result.get("error"), error, result)
                current = Engine.read(self.run)
                self.assertEqual(current["communication"]["sessions"], baseline["communication"]["sessions"])
                self.assertEqual(set((self.run / "launches").glob("launch-*")), launches)
                self.assertEqual(current["tasks"]["A"]["counters"], baseline["tasks"]["A"]["counters"])
                self.assertFalse(current["tasks"]["A"]["reservations"])
                self.assertIsNone(current["tasks"]["A"]["pending_intent"])
                self.assertIsNone(Engine.action(self.run, "execute"))
        with locked(self.run) as path:
            write_atomic(path / "state.json", baseline)
        request = self.request()
        result = self.call(self.token, **request)
        self.assertEqual(result.get("outcome"), "succeeded", result)
        self.assertEqual(self.call(self.token, **request), result)
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["counters"]["implementation"], 1)

    def test_paused_prepared_dispatch_allocates_nothing_and_resumes_original_attempt(self):
        self.configure()
        request = self.request()
        self.assertNotIn("error", self.call(self.token, **{**request, "op": "prepare"}))
        state = Engine.read(self.run)
        Engine.apply(self.run, {"op": "control", "action_id": "pause-prepared", "control": "pause",
                               "expected_policy": state["policy_version"]})
        sessions = Engine.read(self.run)["communication"]["sessions"]
        launches = set((self.run / "launches").glob("launch-*"))
        for _ in range(3):
            result = self.call(self.token, **request)
            self.assertEqual(result.get("error"), "paused", result)
        state = Engine.read(self.run)
        self.assertEqual(state["communication"]["sessions"], sessions)
        self.assertEqual(set((self.run / "launches").glob("launch-*")), launches)
        self.assertEqual(state["tasks"]["A"]["counters"]["implementation"], 1)
        self.assertIsNone(state["tasks"]["A"]["pending_intent"]["execution"]["dispatched_at"])
        Engine.apply(self.run, {"op": "control", "action_id": "resume-prepared", "control": "resume",
                               "expected_policy": state["policy_version"]})
        result = self.call(self.token, **request)
        self.assertEqual(result.get("outcome"), "succeeded", result)
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["counters"]["implementation"], 1)

    def test_legacy_alias_uses_physical_checkout_lease(self):
        source, physical = self.trees / "A", self.root / "physical-A"
        source.rename(physical)
        source.symlink_to(physical, target_is_directory=True)
        self.configure()
        sessions = Engine.read(self.run)["communication"]["sessions"]
        launches = set((self.run / "launches").glob("launch-*"))
        request = self.request()
        with jobs.lease(self.run, str(physical), False):
            result = self.call(self.token, **request)
            self.assertEqual(result.get("error"), "unsettled", result)
            self.assertEqual(Engine.read(self.run)["communication"]["sessions"], sessions)
            self.assertEqual(set((self.run / "launches").glob("launch-*")), launches)
        result = self.call(self.token, **request)
        self.assertEqual(result.get("outcome"), "succeeded", result)
        self.assertEqual((physical / "effect").read_text(), "applied")
        self.assertEqual(self.call(self.token, **request), result)

    def test_review_adapter_is_readonly_after_implementation_handoff(self):
        self.configure()
        implemented = self.call(self.token, **self.request())
        self.assertEqual(implemented.get("outcome"), "succeeded", implemented)
        self.configure(kind="review")
        reviewed = self.call(self.token, **self.request(action_id="review", kind="review"))
        self.assertEqual(reviewed.get("outcome"), "succeeded", reviewed)
        self.assertEqual((self.trees / "A" / "effect").read_text(), "applied")

    def test_source_access_does_not_expose_private_controller_reports(self):
        metadata = self.trees / "A" / ".git" / "jig" / "review-fix"
        metadata.mkdir(parents=True)
        (metadata / "earlier-report.json").write_text('"private previous finding"')
        for role, actor in (("reviewer", "review-reader"), ("executor", "source-worker")):
            with self.subTest(role=role):
                directory = isolation.prepare(self.run, actor, "A", role=role,
                                              parent_session=channel.parse_credential(self.token))
                result = isolation.launch(directory, ["/usr/bin/python3", "-B", "-c",
                    "from pathlib import Path; assert list(Path('.git/jig').iterdir()) == []; print('private')"],
                    capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), "private")
        self.assertTrue((metadata / "earlier-report.json").exists())

    def test_coordinator_can_start_before_any_task_is_admitted(self):
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            state["tasks"] = {}
            write_atomic(path / "state.json", state)
        directory = isolation.prepare(self.run, "coordinator")
        result = isolation.launch(directory, ["/usr/bin/python3", "-B", "-c",
            "import sys; sys.path.insert(0, '/opt/orchestration'); import communicate; "
            "assert communicate.request({'op':'query'})['tasks'] == {}; print('ready')"],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ready")

    def test_launch_secrets_are_absent_from_prepare_query_detail_and_result(self):
        self.configure()
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            state["config"]["adapters"]["fixture"]["profile"]["environment"] = {"PROVIDER_KEY": "private-fixture-secret"}
            write_atomic(path / "state.json", state)
        request = {**self.request(), "op": "prepare"}
        prepared = self.call(self.token, **request)
        self.assertNotIn("error", prepared)
        view = self.call(self.token, op="query", task_id="A", mode="compact")
        detail = self.call(self.token, **view["detail_request"])
        recorded = self.call(self.token, op="result", task_id="A", action_id=request["action_id"])
        self.assertNotIn("private-fixture-secret", json.dumps([prepared, view, detail, recorded]))
        self.assertIn("sha256", prepared["intent"]["execution"]["adapter_binding"])

    def test_cli_initialization_requires_explicit_enforcement_which_refuses_the_ssh_route(self):
        import supervise
        config = self.root / "config.json"
        config.write_text(json.dumps(self.config))
        for mode in ("enforced", "legacy"):
            run = self.root / ("fresh-" + mode)
            argv = [sys.executable, "-B", str(test_channel.SCRIPTS / "supervise.py"), "init",
                    "--run-dir", str(run), "--config", str(config)]
            if mode == "enforced":
                argv += ["--communication-mode", "enforced"]
            result = subprocess.run(argv, capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout)["communication_mode"], mode)
            self.assertEqual(Engine.read(run)["config"]["communication"]["mode"], mode)
            if mode == "enforced":
                with self.assertRaisesRegex(supervise.RuntimeErrorDetail, "authenticated gateway"):
                    supervise.serve(run, "driver-A", {"op": "query", "task_id": "A"})

    def test_prepared_cli_launch_pins_the_selected_command(self):
        argv = [sys.executable, "-B", str(test_channel.SCRIPTS / "isolation.py")]
        prepared = subprocess.run([*argv, "--run-dir", str(self.run), "--actor", "driver-A", "--task", "A",
                                   "--prepare-only", "--", "/usr/bin/printf", "prepared-ok"],
                                  capture_output=True, text=True, check=True)
        identity = json.loads(prepared.stdout)
        self.assertNotIn("credential", identity)
        started = subprocess.run([*argv, "--launch-dir", identity["launch_dir"]],
                                 capture_output=True, text=True, check=True)
        self.assertEqual(started.stdout, "prepared-ok")


if __name__ == "__main__":
    unittest.main()
