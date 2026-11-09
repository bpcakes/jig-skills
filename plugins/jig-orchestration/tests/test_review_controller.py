"""Authenticated execution of the real controller, including journal recovery."""
import copy
import json
import os
from pathlib import Path
import signal
import shlex
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from test_review_boundary import ReviewBoundaryFixture, LOOP
from test_channel import Engine, channel, communicate
from state import StateError, read_json


class ReviewControllerTests(ReviewBoundaryFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.token = channel.issue(self.run, "driver-A")
        self.owner = channel.parse_credential(self.token)
        config = copy.deepcopy(self.configured["config"])
        del config["executionBoundary"]
        base = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.workspace, text=True).strip()
        self.adapter = {"kind": "review", "host": "local", "timeout_seconds": 90,
                        "controller": {"task_id": "A", "node": self.node, "skill_root": str(LOOP),
                        "options": ["--base", base, "--commit-mode", "per-round", "--reviewers", "codex", "--max-rounds", "2"],
                        "config": config, "contract": self.configured["contract"], "profiles": self.policy["profiles"]}}
        self.configure()

    def configure(self, *, recover_operation=None):
        state = Engine.read(self.run)
        configured = Engine.apply(self.run, {"op": "configure", "action_id": "configure-" + str(state["version"]),
            "expected_policy": state["policy_version"], "fields": {"adapters": {"review-loop": self.adapter}}, "evidence": self.proof})
        task = Engine.read(self.run)["tasks"]["A"]
        Engine.apply(self.run, {"op": "delegate", "action_id": "delegate-" + str(task["version"]), "task_id": "A",
            "expected_policy": configured["policy_version"], "expected_task": task["version"],
            "executor": "driver-A", "actions": ["review"],
            **({"recover_operation": recover_operation} if recover_operation else {})})

    def request(self, action_id="review-through-channel"):
        state = Engine.read(self.run)
        return {"op": "execute", "action_id": action_id, "task_id": "A", "kind": "review", "adapter": "review-loop",
                "target": {"worktree": str(self.workspace)}, "refs": {}, "evidence": self.proof,
                "expected_policy": state["policy_version"], "expected_task": state["tasks"]["A"]["version"]}

    def execute(self, request):
        return communicate.request(request, socket_path=str(self.run / "endpoint/gateway.sock"),
                                   credential=self.token, timeout=120)

    def assert_completed(self, result):
        self.assertEqual(result.get("outcome"), "succeeded", result)
        controller = result["receipt"]["controller"]
        self.assertEqual(controller["phase"], "CONVERGED")
        self.assertTrue(result["receipt"]["all_jobs_settled"])
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.workspace, text=True).strip()
        self.assertEqual(controller["commitRange"]["tip"], head)
        self.assertEqual((self.workspace / "value.cjs").read_text(), "module.exports = 2;\n")
        state = Engine.read(self.run)
        self.assertIsNone(state["tasks"]["A"]["pending_intent"])
        self.assertFalse(state["tasks"]["A"]["reservations"])
        self.assertTrue(all(job["local_settled"] for job in state["communication"]["jobs"].values()))
        Engine._review_gate(state, state["tasks"]["A"], head)
        self.assertEqual(state["tasks"]["A"]["refs"]["review_head"], head)
        return controller

    def test_session_cannot_assert_review_evidence_or_settle_its_own_review(self):
        token = channel.issue(self.run, "coordinator")
        session = channel.parse_credential(token)
        for fields in ({"findings": []}, {"refs": {"review_head": "invented"}},
                       {"refs": {"controller_id": "invented", "run_id": "invented"}}):
            state = Engine.read(self.run)
            with self.assertRaisesRegex(StateError, "fixed controller"):
                Engine.apply(self.run, {"op": "observe", "action_id": "forged", "task_id": "A",
                    "expected_policy": state["policy_version"], "expected_task": state["tasks"]["A"]["version"],
                    "fields": fields, "evidence": self.proof}, session=session)
        state = Engine.read(self.run)
        with self.assertRaisesRegex(StateError, "fixed controller"):
            Engine.apply(self.run, {"op": "reserve", "action_id": "self-review", "task_id": "A", "kind": "review",
                "expected_policy": state["policy_version"], "expected_task": state["tasks"]["A"]["version"],
                "refs": {}, "evidence": self.proof}, session=session)
        self.assertNotIn("certified_review", Engine.read(self.run)["tasks"]["A"])

    def assert_repair_reflog_link_is_refused(self, *, private_controller):
        provider = self.root / "provider.mjs"
        reflog = ".git/logs/HEAD" if private_controller else ".git/logs/refs/heads/main"
        target = "'../jig/review-fix/active.json'" if private_controller else "process.env.HOST_CANARY"
        needle = '} else if (a.role === "repair") {'
        provider.write_text(provider.read_text().replace(needle, needle +
            "\n  boundaryFS.writeFileSync('.git/repair-head', boundaryFS.readFileSync('.git/refs/heads/main'));"
            f"\n  boundaryFS.unlinkSync({json.dumps(reflog)});\n"
            f"  boundaryFS.symlinkSync({target},{json.dumps(reflog)});\n"))
        result = self.execute(self.request())
        self.assertEqual((self.workspace / "value.cjs").read_text(), "module.exports = 2;\n")
        self.assertTrue((self.workspace / reflog).is_symlink())
        self.assertNotEqual(result.get("outcome"), "succeeded", result)
        diagnostic = Path(result["receipt"]["stderr_ref"]).read_text()
        self.assertIn("Git metadata must not contain symlinks or shared hardlinks", diagnostic)
        self.assertEqual((self.root / "host-secret").read_text(), "private")
        active = json.loads((self.workspace / ".git/jig/review-fix/active.json").read_text())
        self.assertTrue(Path(active["directory"]).is_dir())
        # The controller may checkpoint pre-existing dirty source before repair.
        # No commit may follow the worker's metadata change.
        self.assertEqual(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.workspace),
                         (self.workspace / ".git/repair-head").read_bytes())
        state = Engine.read(self.run)
        with self.assertRaises(StateError):
            Engine._review_gate(state, state["tasks"]["A"])

    def test_repair_reflog_link_cannot_redirect_publication_into_controller_state(self):
        self.assert_repair_reflog_link_is_refused(private_controller=True)

    def test_repair_reflog_link_cannot_redirect_publication_into_host_file(self):
        self.assert_repair_reflog_link_is_refused(private_controller=False)

    def test_authenticated_review_repairs_commits_and_replay_reuses_completion(self):
        selected = self.adapter["controller"]
        selected["profiles"]["validate"] = copy.deepcopy(selected["profiles"]["validate"])
        selected["profiles"]["validate"]["environment"]["PINNED_TEST_VALUE"] = "profile-only"
        check = selected["contract"]["requiredValidation"][0]
        check["requiredEnvironment"] = ["PINNED_TEST_VALUE"]
        check["argv"][-1] += ";require('node:assert/strict').equal(process.env.PINNED_TEST_VALUE,'profile-only');console.log('validated-value');process.stderr.write('x'.repeat(20000)+'😀'+'y'.repeat(16383))"
        provider = self.root / "provider.mjs"
        provider.write_text("import {execFileSync as evidenceCommand} from 'node:child_process';\n" + provider.read_text().replace(
            "const a = JSON.parse(Buffer.concat(chunks));", """const a = JSON.parse(Buffer.concat(chunks));
if (a.role === 'review') for (const check of a.validationEvidence?.checks ?? []) {
  if (!check.receipt) continue;
  assert.equal(check.receipt.log, undefined);
  const log = check.receipt.logArtifact;
  assert.ok(log.retained_log_complete);
  let content = '';
  for (const part of log.parts) {
    const reply = JSON.parse(evidenceCommand('/usr/bin/python3', ['/opt/orchestration/communicate.py'], {
      input: JSON.stringify({op:'artifact_read',task_id:process.env.ORCHESTRATION_TASK,artifact_id:part.artifact_id}), encoding:'utf8'}));
    assert.equal(reply.complete, true);
    content += reply.content;
  }
  assert.equal(content, 'validated-value\\n');
  assert.equal(check.receipt.stderrTruncated, true);
  assert.equal(check.receipt.stderrBytes, 20000 + 4 + 16383);
  assert.equal(check.receipt.stderrRetainedBytes, 16383);
  const err = check.receipt.stderrLogArtifact;
  assert.equal(err.retained_log_complete, false);
  let stderr = '';
  for (const part of err.parts) {
    let offset = 0;
    while (true) {
      const reply = JSON.parse(evidenceCommand('/usr/bin/python3', ['/opt/orchestration/communicate.py'], {
        input: JSON.stringify({op:'artifact_read',task_id:process.env.ORCHESTRATION_TASK,artifact_id:part.artifact_id,offset}), encoding:'utf8'}));
      assert.equal(reply.error, undefined);
      stderr += reply.content;
      if (reply.complete) break;
      offset = reply.next_offset;
    }
  }
  assert.equal(JSON.parse(stderr).stderr, 'y'.repeat(16383));
}
"""))
        self.configure()
        request = self.request()
        result = self.execute(request)
        self.assert_completed(result)
        jobs = Engine.read(self.run)["communication"]["jobs"]
        replay = self.execute(request)
        self.assertEqual(replay, result)
        self.assertEqual(Engine.read(self.run)["communication"]["jobs"], jobs)
        state = Engine.read(self.run)
        task = state["tasks"]["A"]
        head = task["refs"]["review_head"]
        target = {"repository": str(self.repo), "base": "main", "pr": 10, "head": head}
        gates = {**{key: True for key in ("complete", "validation", "checks", "feedback", "findings", "target_current", "clean")},
                 **task["refs"], "checkout_head": head, "pr_head": head, "commit_mode": "per-round"}
        Engine.apply(self.run, {"op": "intent", "action_id": "merge-certified", "task_id": "A", "kind": "merge",
            "expected_policy": state["policy_version"], "expected_task": task["version"],
            "target": target, "gates": gates, "evidence": self.proof},
            session=channel.parse_credential(channel.issue(self.run, "coordinator")))
        for changed in ("head", "binding", "status", "settled", "dirty", "findings"):
            damaged = copy.deepcopy(task)
            proof = damaged["certified_review"]
            if changed == "head": proof["candidate"]["head"] = "another-head"
            if changed == "binding": damaged["branch"] = "another-branch"
            if changed == "status": proof["status"] = "unknown"
            if changed == "settled": proof["all_jobs_settled"] = False
            if changed == "dirty": proof["candidate"]["clean"] = False
            if changed == "findings": proof["findings"] = [{"status": "unknown"}]
            with self.subTest(changed=changed), self.assertRaises(StateError):
                Engine._review_gate(state, damaged, head)

    def closure_request(self, op, action_id):
        state = Engine.read(self.run)
        task = state["tasks"]["A"]
        target = {"authority": state["config"]["tracker"]["authority"], "task_id": "A", "owner": task["claim"]["owner"]}
        proof = {**self.proof, "all_jobs_settled": True, "criteria_met": True,
                 "acceptance_ref": task.get("acceptance_ref") or "fixture-acceptance"}
        request = {"op": op, "action_id": action_id, "task_id": "A", "expected_policy": state["policy_version"],
                   "expected_task": task["version"], "kind": "close", "target": target, "evidence": proof, "refs": {}}
        if op == "close":
            request["receipt"] = {**proof, **target, "status": "closed", "unpublished": False}
        if op in {"prepare", "execute"}:
            request["adapter"] = "close-fixture"
        return request

    def test_direct_closure_requires_certification_findings_and_current_source(self):
        coordinator = channel.issue(self.run, "coordinator")
        def close(action):
            return self.call(coordinator, **self.closure_request("close", action))
        self.assertEqual(close("uncertified").get("error"), "review_evidence")
        self.assert_completed(self.execute(self.request()))
        state = Engine.read(self.run)
        Engine.apply(self.run, {"op": "observe", "action_id": "new-finding", "task_id": "A",
            "expected_policy": state["policy_version"], "expected_task": state["tasks"]["A"]["version"],
            "fields": {"findings": [{"status": "unresolved"}]}, "evidence": self.proof})
        self.assertEqual(close("unresolved").get("error"), "findings")
        state = Engine.read(self.run)
        Engine.apply(self.run, {"op": "observe", "action_id": "resolved-finding", "task_id": "A",
            "expected_policy": state["policy_version"], "expected_task": state["tasks"]["A"]["version"],
            "fields": {"findings": []}, "evidence": self.proof})
        source = self.workspace / "value.cjs"
        source.write_text("module.exports = 3;\n")
        self.assertEqual(close("dirty").get("error"), "review_evidence")
        source.write_text("module.exports = 2;\n")
        request = self.closure_request("close", "certified-direct")
        result = self.call(coordinator, **request)
        self.assertEqual(result.get("closed"), "A", result)
        source.write_text("module.exports = 4;\n")
        self.assertEqual(self.call(coordinator, **request), result, "receipt replay must not become new authorization")

    def closure_source_changes(self, *, workspace_access):
        self.assert_completed(self.execute(self.request()))
        coordinator = channel.issue(self.run, "coordinator")
        session = channel.parse_credential(coordinator)
        head = Engine.read(self.run)["tasks"]["A"]["certified_review"]["candidate"]["head"]
        script = self.root / "close-adapter.py"
        script.write_text("""import json,sys,pathlib
p=json.load(sys.stdin)
try: pathlib.Path('must-not-write-source').write_text('bad')
except OSError: pass
else: raise AssertionError('close source must be read-only')
print(json.dumps({'status':'succeeded','receipt':{**p['target'],**p['evidence'],
                 'status':'closed','unpublished':False}}))
""")
        argv = ["/usr/bin/python3", "-B", "/opt/tools/close.py"]
        if workspace_access == "none":
            script.write_text(script.read_text().replace(
                "try: pathlib.Path('must-not-write-source').write_text('bad')\nexcept OSError: pass\nelse: raise AssertionError('close source must be read-only')",
                "assert not pathlib.Path(" + repr(str(self.workspace)) + ").exists()\npathlib.Path('scratch').write_text('private')"))
        adapter = {"kind": "close", "host": "local", "argv": argv, "inspect_argv": argv, "timeout_seconds": 10,
                   "profile": {"schema": 1, "workspace_access": workspace_access,
                               "mounts": [{"source": str(script), "target": "/opt/tools/close.py"}]}}
        state = Engine.read(self.run)
        Engine.apply(self.run, {"op": "configure", "action_id": "close-adapter", "expected_policy": state["policy_version"],
            "fields": {"adapters": {"review-loop": self.adapter, "close-fixture": adapter}}, "evidence": self.proof})
        source = self.workspace / "value.cjs"
        source.write_text("module.exports = 3;\n")
        for phase in ("dirty", "committed"):
            if phase == "committed":
                subprocess.run(["git", "add", "value.cjs"], cwd=self.workspace, check=True)
                subprocess.run(["git", "commit", "-qm", "later implementation"], cwd=self.workspace, check=True)
            for op in ("close", "intent", "prepare", "execute"):
                result = self.call(coordinator, **self.closure_request(op, phase + "-" + op))
                self.assertEqual(result.get("error"), "review_evidence", (op, phase, result))
                self.assertIsNone(Engine.read(self.run)["tasks"]["A"]["pending_intent"])
        subprocess.run(["git", "reset", "--hard", head], cwd=self.workspace, check=True, capture_output=True)
        prepared = self.closure_request("prepare", "close-issued")
        Engine.apply(self.run, prepared, session=session)
        source.write_text("module.exports = 3;\n")
        retry = {"op": "execute", "task_id": "A", "action_id": "close-issued"}
        self.assertEqual(self.call(coordinator, **retry).get("error"), "review_evidence")
        self.assertIsNone(Engine.read(self.run)["tasks"]["A"]["pending_intent"]["execution"]["dispatched_at"])
        source.write_text("module.exports = 2;\n")
        apply = Engine.apply
        def busy_finish(run_dir, request, *args, **kwargs):
            if request.get("op") == "finish":
                raise StateError("state_busy", "injected lost completion after the external effect")
            return apply(run_dir, request, *args, **kwargs)
        with patch.object(Engine, "apply", side_effect=busy_finish):
            result = self.call(coordinator, **retry)
        self.assertEqual(result.get("error"), "state_busy", result)
        self.assertIsNotNone(Engine.read(self.run)["tasks"]["A"]["pending_intent"]["execution"]["dispatched_at"])
        source.write_text("module.exports = 4;\n")
        # Read-only inspection records the issued effect even after source drift.
        closed = self.call(coordinator, **retry)
        self.assertEqual(closed.get("outcome"), "succeeded", closed)
        self.assertEqual(closed.get("closed"), "A", closed)

    def test_closure_intent_prepare_and_dispatch_recheck_certified_checkout(self):
        self.closure_source_changes(workspace_access="write")

    def test_private_workspace_close_checks_and_retains_actual_source_lease(self):
        self.closure_source_changes(workspace_access="none")

    def test_isolated_control_driver_can_wait_for_review_without_owning_source(self):
        import isolation
        launch = isolation.prepare(self.run, "driver-A", "A", profile={"schema": 1, "workspace_access": "none"})
        request = self.request()
        script = ("import json, sys; from pathlib import Path; sys.path.insert(0, '/opt/orchestration'); import communicate; "
                  + "assert not Path(" + repr(str(self.workspace)) + ").exists(); "
                  + "print(json.dumps(communicate.request(" + repr(request) + ", timeout=120)))")
        completed = isolation.launch(launch, ["/usr/bin/python3", "-c", script], capture_output=True, timeout=150)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assert_completed(json.loads(completed.stdout))

    def test_dirty_none_mode_review_does_not_certify_a_committed_candidate(self):
        options = self.adapter["controller"]["options"]
        options[options.index("--commit-mode") + 1] = "none"
        self.configure()
        result = self.execute(self.request())
        self.assertEqual(result.get("outcome"), "succeeded", result)
        self.assertEqual(result["receipt"]["controller"]["phase"], "CONVERGED")
        self.assertFalse(result["receipt"]["controller"]["candidate"]["clean"])
        state = Engine.read(self.run)
        with self.assertRaisesRegex(StateError, "reviewed commit binding"):
            Engine._review_gate(state, state["tasks"]["A"])

    def test_unverified_host_or_unsafe_profile_consumes_no_review_attempt(self):
        import capabilities
        request = self.request()
        (self.run / capabilities.RECEIPT).unlink()
        result = self.execute(request)
        self.assertEqual(result.get("error"), "host_unverified", result)
        capabilities.verify(self.run, "local")
        profile = self.adapter["controller"]["profiles"]["validate"]
        profile["mounts"] = [*profile["mounts"], {"source": str(self.run), "target": "/opt/tools/private"}]
        self.configure()
        result = self.execute(self.request())
        self.assertEqual(result.get("error"), "profile_exposure", result)
        task = Engine.read(self.run)["tasks"]["A"]
        self.assertFalse(task["reservations"])
        self.assertIsNone(task["pending_intent"])
        self.assertEqual(task["counters"].get("review", 0), 0)
        self.assertIsNone(Engine.action(self.run, request["action_id"]))

    def test_retained_data_prevents_a_fresh_controller_runtime_copy(self):
        import review_controller
        import runtime_storage
        directory = self.run / "capacity-controller"
        directory.mkdir(mode=0o700)
        retained = self.run / "retained-job-output"
        with retained.open("wb") as stream:
            stream.truncate(runtime_storage.DEFAULTS["max_bytes"])
        with self.assertRaises(StateError) as caught:
            review_controller.prepare(self.run, directory, self.adapter, "A", self.owner)
        self.assertEqual(caught.exception.code, "runtime_capacity")
        self.assertFalse((directory / "controller-runtime").exists())
        self.assertFalse((directory / "controller-manifest.json").exists())
        self.assertTrue(retained.exists())
        self.assertIsNone(Engine.read(self.run)["tasks"]["A"]["pending_intent"])

    def test_upstream_validation_recovers_lost_reply_and_release_preserves_reports(self):
        self.upstream_recovery(close_mode="direct")

    def test_upstream_recovery_after_owner_replacement_and_history_change(self):
        self.upstream_recovery(replace_owner=True, close_mode="adapter")

    def upstream_recovery(self, *, replace_owner=False, close_mode=None):
        import review_controller
        original_request = self.request()
        original_result = self.execute(original_request)
        controller = self.assert_completed(original_result)
        other = channel.issue(self.run, "driver-B")
        wrong_task = communicate.request({"op": "review_release", "task_id": "B",
            "operation_id": original_request["action_id"], "action_id": "wrong-task-release"},
            socket_path=str(self.run / "endpoint/gateway.sock"), credential=other, timeout=5)
        self.assertEqual(wrong_task.get("error"), "controller")
        directory = Path(controller["directory"])
        journal = json.loads((directory / "run.json").read_text())
        reports = {file.name: file.read_bytes() for file in (directory / "reports").glob("*.json")}
        validation_count = len(journal["validation"])
        original_record = Engine.action(self.run, original_request["action_id"] + "/complete", runner=True)
        if replace_owner:
            subprocess.run(["git", "commit", "--amend", "-qm", "same source after history change"],
                           cwd=self.workspace, check=True, capture_output=True)
            self.token = channel.issue(self.run, "driver-A")
            self.owner = channel.parse_credential(self.token)
        base = self.adapter["controller"]["options"][1]
        proof = {"from": journal["fingerprint"]["fingerprint"],
                 "upstream": {"pr": 1, "head": base, "landing": base, "target": base},
                 "evidence": "Fixture prerequisite is already contained in the reviewed candidate and target",
                 "assessment": {key: {"applicable": True, "evidence": "Fixture inputs remain applicable; rerun validation"}
                                for key in ("history", "environment", "tools", "generatedOutputs")}}
        selected = {**copy.deepcopy(self.adapter), "kind": "validate"}
        adapters = {"review-loop": self.adapter, "review-landing": selected}
        if close_mode:
            script = self.root / "upstream-close.py"
            script.write_text("""import json,sys,pathlib
p=json.load(sys.stdin)
assert pathlib.Path('value.cjs').read_text() == 'module.exports = 2;\\n'
try: pathlib.Path('value.cjs').write_text('uncertified mutation')
except OSError: pass
else: raise AssertionError('close source must be read-only')
print(json.dumps({'status':'succeeded','receipt':{**p['target'],**p['evidence'],
 'status':'closed','unpublished':False}}))
""")
            argv = ["/usr/bin/python3", "-B", "/opt/tools/close.py"]
            adapters["close-fixture"] = {"kind": "close", "host": "local", "argv": argv,
                "inspect_argv": argv, "timeout_seconds": 10, "profile": {"schema": 1,
                "mounts": [{"source": str(script), "target": "/opt/tools/close.py"}]}}
        state = Engine.read(self.run)
        changed = Engine.apply(self.run, {"op": "configure", "action_id": "add-revalidation",
            "expected_policy": state["policy_version"], "fields": {"adapters": adapters}, "evidence": self.proof})
        task = Engine.read(self.run)["tasks"]["A"]
        Engine.apply(self.run, {"op": "delegate", "action_id": "grant-revalidation", "task_id": "A",
            "expected_policy": changed["policy_version"], "expected_task": task["version"],
            "executor": "driver-A", "actions": ["review", "validate"]})
        request = {**self.request("revalidate-landing"), "kind": "validate", "adapter": "review-landing",
                   "reconcile_upstream": {"operation_id": original_request["action_id"], "receipt": proof}}
        invalid = copy.deepcopy(request)
        invalid["action_id"] = "invalid-landing"
        invalid["reconcile_upstream"]["receipt"]["assessment"]["tools"]["applicable"] = False
        self.assertEqual(self.execute(invalid).get("error"), "controller")
        state = Engine.read(self.run)
        self.assertIsNone(state["tasks"]["A"]["pending_intent"])
        self.assertEqual(state["tasks"]["A"]["counters"].get("validation", 0), 0)
        self.assertEqual(json.loads((directory / "run.json").read_text()), journal)
        original_run = review_controller.run
        lost = []

        def lose_reply(*args, **kwargs):
            result = original_run(*args, **kwargs)
            if args[1] == "upstream-preflight":
                before_dispatch = json.loads((directory / "run.json").read_text())
                self.assertEqual(before_dispatch.get("upstreamLandings", []), [])
                self.assertEqual(len(before_dispatch["validation"]), validation_count)
                self.assertEqual(before_dispatch["fingerprint"], journal["fingerprint"])
            if args[1] == "reconcile-upstream" and not lost:
                self.assertIsNotNone(result[0], result[1])
                lost.append(result)
                raise OSError("fixture lost reply after controller completed")
            return result

        with patch.object(review_controller, "run", side_effect=lose_reply):
            interrupted = self.execute(request)
        self.assertIn("error", interrupted)
        self.assertEqual(len(lost), 1, interrupted)
        after = json.loads((directory / "run.json").read_text())
        self.assertEqual(len(after["validation"]), validation_count + 1)
        release = {"op": "review_release", "task_id": "A", "operation_id": original_request["action_id"],
                   "action_id": "release-completed-controller"}
        self.assertEqual(self.execute(release).get("error"), "unsettled")
        resumed = self.execute({"op": "execute", "task_id": "A", "action_id": request["action_id"]})
        self.assertEqual(resumed.get("outcome"), "succeeded", resumed)
        self.assertEqual(resumed["receipt"]["controller"]["id"], controller["id"])
        self.assertEqual(self.execute(request), resumed)
        self.assertEqual(self.execute(original_request), original_result)
        after = json.loads((directory / "run.json").read_text())
        self.assertEqual(len(after["validation"]), validation_count + 1)
        self.assertEqual(len(after["upstreamLandings"]), 1)
        self.assertEqual(after["reports"], journal["reports"])
        self.assertEqual({file.name: file.read_bytes() for file in (directory / "reports").glob("*.json")}, reports)
        self.assertEqual(Engine.action(self.run, original_request["action_id"] + "/complete", runner=True), original_record)
        state = Engine.read(self.run)
        self.assertEqual(state["tasks"]["A"]["counters"]["review"], 1)
        self.assertEqual(state["tasks"]["A"]["counters"]["validation"], 1)
        certification = state["tasks"]["A"]["certified_review"]
        self.assertEqual(certification["operation_id"], request["action_id"])
        self.assertEqual(certification["controller_operation_id"], original_request["action_id"])
        if close_mode == "direct":
            self.close_after_upstream("close")
        released = self.execute(release)
        self.assertEqual(released.get("phase"), "RELEASED", released)
        self.assertFalse(released["recordsDeleted"])
        self.assertEqual(self.execute(release), released)
        self.assertTrue((directory / "run.json").is_file())
        self.assertEqual({file.name: file.read_bytes() for file in (directory / "reports").glob("*.json")}, reports)
        if close_mode == "adapter":
            self.close_after_upstream("execute")
        channel.issue(self.run, "driver-A")
        self.assertEqual(self.execute(release).get("error"), "session_revoked")

    def close_after_upstream(self, operation):
        coordinator = channel.issue(self.run, "coordinator")
        source = self.workspace / "value.cjs"
        original = source.read_bytes()
        source.write_text("module.exports = 3;\n")
        for op in ("close", "intent", "prepare", "execute"):
            result = self.call(coordinator, **self.closure_request(op, "upstream-drift-" + op))
            self.assertEqual(result.get("error"), "review_evidence", (op, result))
            self.assertIsNone(Engine.read(self.run)["tasks"]["A"]["pending_intent"])
        source.write_bytes(original)
        result = self.call(coordinator, **self.closure_request(operation, "close-after-upstream"))
        self.assertEqual(result.get("closed"), "A", result)
        if operation == "execute":
            self.assertEqual(result.get("outcome"), "succeeded", result)
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["phase"], "closed")

    def test_question_answer_and_resume_use_only_the_authenticated_channel(self):
        config = self.adapter["controller"]["config"]
        config["triageCommand"] = [*config["triageCommand"][:-1], "ambiguous"]
        self.configure()
        request = self.request()
        result = self.execute(request)
        self.assertEqual(result.get("outcome"), "unknown", result)
        controller = result["receipt"]["controller"]
        response = {"op": "review_answer", "task_id": "A", "operation_id": request["action_id"],
                    "action_id": "answer-value", "question_id": controller["question"]["id"], "answer": "Export 2, as required by the pinned contract."}
        accepted = self.execute(response)
        self.assertTrue(accepted.get("accepted"), accepted)
        self.assertEqual(self.execute(response), accepted)
        rejected = self.execute({**response, "answer": "Export 3"})
        self.assertEqual(rejected.get("error"), "duplicate", rejected)
        final = self.assert_completed(self.execute(request))
        self.assertEqual(final["id"], controller["id"])
        saved = read_json(Path(final["directory"]) / "run.json")
        self.assertEqual(len(saved["answers"]), 1)
        jobs = Engine.read(self.run)["communication"]["jobs"]
        self.assertEqual(self.execute(response), accepted)
        self.assertEqual(self.execute({**response, "answer": "Export 3"}).get("error"), "duplicate")
        self.assertEqual(Engine.read(self.run)["communication"]["jobs"], jobs)
        channel.issue(self.run, "driver-A")
        self.assertEqual(self.execute(response).get("error"), "session_revoked")

    def test_controller_crash_resumes_same_journal_without_repeating_review(self):
        request = self.request()
        results = []
        thread = threading.Thread(target=lambda: results.append(self.execute(request)))
        thread.start()
        process_file = None
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and thread.is_alive():
                files = list(self.run.glob("execution-*/controller-process.json"))
                jobs = Engine.read(self.run).get("communication", {}).get("jobs", {})
                if files and jobs and read_json(files[0])["mode"] == "run":
                    process_file = files[0]
                    break
                time.sleep(.02)
            self.assertIsNotNone(process_file, results)
            process = read_json(process_file)
            actual = Path(f"/proc/{process['pid']}/stat").read_text().rsplit(")", 1)[1].split()[19]
            self.assertEqual(actual, process["start_ticks"])
            os.kill(process["pid"], signal.SIGKILL)
            thread.join(10)
            self.assertFalse(thread.is_alive())
            self.assertEqual(results[0].get("outcome"), "unknown", results)
            manifest = read_json(process_file.parent / "controller-manifest.json")
            resumed = self.execute(request)
            controller = self.assert_completed(resumed)
            self.assertEqual(controller["id"], manifest["id"])
            jobs = Engine.read(self.run)["communication"]["jobs"]
            # The controller requires two initial and two final independent
            # reports. Recovery must not add another invocation for either slot.
            self.assertEqual(sum(job["role"] == "reviewer" for job in jobs.values()), 4)
            saved = read_json(Path(controller["directory"]) / "run.json")
            slots = [(attempt["pass"], attempt["slot"]) for attempt in saved["attempts"]]
            self.assertEqual(len(slots), len(set(slots)))
        finally:
            thread.join(120)

    def test_busy_source_preflight_consumes_no_attempt(self):
        import jobs
        before = Engine.read(self.run)["tasks"]["A"]["counters"]
        with jobs.lease(self.run, str(self.workspace), False):
            result = self.execute(self.request())
        self.assertEqual(result.get("error"), "controller", result)
        task = Engine.read(self.run)["tasks"]["A"]
        self.assertEqual(task["counters"], before)
        self.assertIsNone(task["pending_intent"])
        self.assertFalse(Engine.read(self.run)["communication"].get("jobs"))

    def test_fixed_controller_preflight_cannot_run_a_repository_transport(self):
        def git(*args):
            return subprocess.check_output(["git", *args], cwd=self.workspace, text=True).strip()
        oid = git("rev-parse", "HEAD:value.cjs")
        marker = self.root / "host-transport-ran"
        helper = self.root / "transport.cjs"
        helper.write_text("require('node:fs').writeFileSync(" + json.dumps(str(marker)) + ", 'ran');process.exit(1)")
        git("config", "remote.origin.url", "ssh://unused.invalid/repository")
        git("config", "remote.origin.promisor", "true")
        git("config", "extensions.partialClone", "origin")
        git("config", "core.sshCommand", shlex.join([self.node, str(helper)]))
        (self.workspace / ".git/objects" / oid[:2] / oid[2:]).unlink()
        before = Engine.read(self.run)["tasks"]["A"]["counters"]
        result = self.execute(self.request())
        self.assertEqual(result.get("error"), "controller", result)
        self.assertFalse(marker.exists(), result)
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["counters"], before)
        self.assertFalse(Engine.read(self.run)["communication"].get("jobs"))

    def interrupted_initialization(self, stage, *, replace_owner=False):
        fault = self.root / "initialization-fault.mjs"
        marker = self.root / "initialization-fault-fired"
        runs = str(self.workspace / ".git/jig/review-fix") + "/"
        fault.write_text("""import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const [runs, stage, marker] = """ + json.dumps([runs, stage, str(marker)]) + """;
function stop(file, operation) {
  file = String(file);
  if (!file.startsWith(runs) || fs.existsSync(marker)) return;
  const relative = file.slice(runs.length);
  if ((stage === 'directory' && operation === 'mkdir' && /^[a-f0-9-]{36}$/.test(relative)) ||
      (stage === 'journal' && operation === 'rename' && relative.endsWith('/run.json'))) {
    fs.writeFileSync(marker, file);
    process.kill(process.pid, 'SIGKILL');
  }
}
const mkdir = fs.mkdirSync, rename = fs.renameSync;
fs.mkdirSync = function(file, ...args) { const result = mkdir.call(this, file, ...args); stop(file, 'mkdir'); return result; };
fs.renameSync = function(source, destination, ...args) { const result = rename.call(this, source, destination, ...args); stop(destination, 'rename'); return result; };
syncBuiltinESMExports();
""")
        request = self.request()
        with patch.dict(os.environ, {"NODE_OPTIONS": "--import=" + fault.as_uri()}):
            result = self.execute(request)
        self.assertTrue(marker.exists(), result)
        self.assertEqual(result.get("outcome"), "unknown", result)
        self.assertFalse(Engine.read(self.run)["communication"].get("jobs"))
        manifest = read_json(next(self.run.glob("execution-*/controller-manifest.json")))
        directory = Path(manifest["directory"])
        self.assertEqual((directory / "run.json").exists(), stage == "journal")
        attempts = Engine.read(self.run)["tasks"]["A"]["counters"]
        if stage == "directory":
            original = (self.workspace / "value.cjs").read_text()
            (self.workspace / "value.cjs").write_text("module.exports = 44;\n")
            changed = self.execute(request)
            self.assertEqual(changed.get("outcome"), "unknown", changed)
            self.assertFalse(Engine.read(self.run)["communication"].get("jobs"))
            (self.workspace / "value.cjs").write_text(original)
        if replace_owner:
            self.token = channel.issue(self.run, "driver-A")
            self.owner = channel.parse_credential(self.token)
        completed = self.assert_completed(self.execute(request))
        self.assertEqual(completed["id"], manifest["id"])
        self.assertEqual(Engine.read(self.run)["tasks"]["A"]["counters"], attempts)

    def test_initialization_recovers_after_directory_creation_without_resetting_scope(self):
        self.interrupted_initialization("directory")

    def test_initialization_recovers_after_journal_before_active_reference(self):
        self.interrupted_initialization("journal")

    def test_new_owner_recovers_interrupted_initialization(self):
        self.interrupted_initialization("directory", replace_owner=True)

    def test_new_owner_recovers_initial_journal_before_active_reference(self):
        self.interrupted_initialization("journal", replace_owner=True)

    def replace_owner(self, *, identity_change=False, interrupt_adoption=False):
        import isolation
        import review_controller
        self.adapter["controller"]["config"]["triageCommand"][-1] = "ambiguous"
        self.configure()
        request = self.request()
        waiting = self.execute(request)
        self.assertEqual(waiting.get("outcome"), "unknown", waiting)
        controller = waiting["receipt"]["controller"]
        self.assertTrue(controller["question"])
        manifest_path = next(self.run.glob("execution-*/controller-manifest.json"))
        original = read_json(manifest_path)
        original_policy = manifest_path.parent / "controller-policy.json"
        policy_bytes = original_policy.read_bytes()
        launch = isolation.prepare(self.run, "surviving-writer", "A", role="executor", parent_session=self.owner)
        results = []
        writer = threading.Thread(target=lambda: results.append(isolation.launch(launch, ["/usr/bin/python3", "-c",
            "from pathlib import Path; import time; Path('/home/agent/started').touch(); "
            "exec(\"while not Path('/home/agent/finish').exists(): time.sleep(.01)\")"], capture_output=True)))
        writer.start()
        try:
            deadline = time.monotonic() + 5
            while not (launch / "home/started").exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue((launch / "home/started").exists(), results)
            previous_token = self.token
            if identity_change:
                state = Engine.read(self.run)
                task = state["tasks"]["A"]
                Engine.apply(self.run, {"op": "recover_session", "action_id": "replace-controller-session", "task_id": "A",
                    "expected_policy": state["policy_version"], "expected_task": task["version"],
                    "previous_identity": task["identity"], "identity": {"session": "replacement-controller"},
                    "evidence": {**self.proof, "previous_session_stopped": True, "replacement_verified": True,
                                 "host": task["host"], "worktree": task["worktree"]}})
                state = Engine.read(self.run)
                with self.assertRaisesRegex(StateError, "reconcile pending work"):
                    Engine.apply(self.run, {"op": "delegate", "action_id": "cannot-expand-recovered-grant", "task_id": "A",
                        "expected_policy": state["policy_version"], "expected_task": state["tasks"]["A"]["version"],
                        "executor": "driver-A", "actions": ["review", "merge"], "recover_operation": request["action_id"]})
                self.configure(recover_operation=request["action_id"])
            self.token = channel.issue(self.run, "driver-A")
            self.owner = channel.parse_credential(self.token)
            rejected = communicate.request(request, socket_path=str(self.run / "endpoint/gateway.sock"), credential=previous_token)
            self.assertEqual(rejected.get("error"), "session_revoked", rejected)
            busy = self.execute(request)
            self.assertEqual(busy.get("error"), "unsettled", busy)
            self.assertEqual(read_json(manifest_path), original)
        finally:
            (launch / "home/finish").touch()
            writer.join(10)
        self.assertFalse(writer.is_alive())
        self.assertEqual(results[0].returncode, 0, results[0].stderr)
        jobs = Engine.read(self.run)["communication"]["jobs"]
        if interrupt_adoption:
            write = review_controller.write_atomic
            def lose_manifest(path, value):
                if Path(path) == manifest_path:
                    raise OSError("injected interruption after controller adoption")
                return write(path, value)
            with patch.object(review_controller, "write_atomic", side_effect=lose_manifest):
                failed = self.execute(request)
            self.assertEqual(failed.get("error"), "channel_error", failed)
            self.assertEqual(read_json(manifest_path), original)
        resumed = self.execute(request)
        self.assertEqual(resumed.get("outcome"), "unknown", resumed)
        self.assertEqual(resumed["receipt"]["controller"]["id"], controller["id"])
        self.assertEqual(resumed["receipt"]["controller"]["question"], controller["question"])
        self.assertEqual(Engine.read(self.run)["communication"]["jobs"], jobs)
        self.assertEqual(original_policy.read_bytes(), policy_bytes)
        manifest = read_json(manifest_path)
        self.assertEqual(manifest["binding"]["owner_session"], self.owner.id)
        saved = read_json(Path(controller["directory"]) / "run.json")
        self.assertEqual(sum(event["event"] == "orchestration-owner-adopted" for event in saved["events"]), 1)
        accepted = self.execute({"op": "review_answer", "task_id": "A", "operation_id": request["action_id"],
            "action_id": "replacement-answer", "question_id": controller["question"]["id"], "answer": "Export 2."})
        self.assertTrue(accepted.get("accepted"), accepted)
        self.assert_completed(self.execute(request))

    def test_replacement_waits_for_surviving_writer_and_continues_same_controller(self):
        self.replace_owner()

    def test_host_identity_recovery_resumes_interrupted_owner_adoption(self):
        self.replace_owner(identity_change=True, interrupt_adoption=True)

    def test_replacement_before_completion_preserves_result_until_current_owner_adopts(self):
        import review_controller
        original = review_controller.invoke
        replacement = []
        def replace_after_result(*args, **kwargs):
            result = original(*args, **kwargs)
            self.assertEqual(result["status"], "succeeded", result)
            replacement.append(channel.issue(self.run, "driver-A"))
            return result
        request = self.request()
        with patch.object(review_controller, "invoke", side_effect=replace_after_result):
            observed = self.execute(request)
        self.assertEqual(observed.get("outcome"), "unknown", observed)
        self.assertEqual(observed["receipt"]["rejection"]["code"], "session_revoked")
        self.assertIsNotNone(Engine.read(self.run)["tasks"]["A"]["pending_intent"])
        from test_workflow_evidence import evidence
        with tempfile.TemporaryDirectory() as retained:
            destination = Path(retained) / "diagnostics"
            manifest = evidence.retain_controller(observed, run=self.run, workspace=self.workspace, destination=destination)
            diagnostic_receipt = observed["receipt"]["rejected_result"]["receipt"]
            self.assertEqual(manifest["outcome"], "unknown")
            self.assertEqual(manifest["source_receipt"], "receipt.rejected_result.receipt")
            self.assertEqual(manifest["rejection"], observed["receipt"]["rejection"])
            self.assertEqual(manifest["rejected_status"], "succeeded")
            self.assertEqual(manifest["output"], diagnostic_receipt["output"])
            copied = {row["target"]: row for row in manifest["files"] if row["status"] == "copied"}
            self.assertEqual(copied["host.stdout"]["source"], diagnostic_receipt["ref"])
            self.assertEqual(copied["host.stderr"]["source"], diagnostic_receipt["stderr_ref"])
            self.assertTrue(any(name.startswith("assignments/") for name in copied))
            original_bytes = {name: Path(row["source"]).read_bytes() for name, row in copied.items()}
            self.token = replacement[0]
            jobs = Engine.read(self.run)["communication"]["jobs"]
            original_source = (self.workspace / "value.cjs").read_text()
            (self.workspace / "value.cjs").write_text("module.exports = 44;\n")
            self.assertEqual(self.execute(request).get("error"), "controller")
            (self.workspace / "value.cjs").write_text(original_source)
            self.assert_completed(self.execute(request))
            self.assertEqual(Engine.read(self.run)["communication"]["jobs"], jobs)
            self.doCleanups()
            self.assertFalse(self.run.exists())
            self.assertEqual(json.loads((destination / "manifest.json").read_text()), manifest)
            for name, raw in original_bytes.items():
                self.assertEqual((destination / copied[name]["retained"]).read_bytes(), raw)


if __name__ == "__main__":
    unittest.main()
