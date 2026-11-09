"""Real review-fix controller and isolated processes, with a deterministic provider.

This covers the installed controller's workflow, not model review quality.
"""
import hashlib
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import unittest

import test_channel
from test_channel import ChannelFixture, Engine, channel
from state import locked, read_json, write_atomic

REVIEW = Path(__file__).resolve().parents[2] / "jig-review"
LOOP = Path(os.environ.get("JIG_REVIEW_TEST_SKILL_ROOT", REVIEW / "skills/review-fix-loop"))


class ReviewBoundaryFixture(ChannelFixture):
    setUpClass = classmethod(test_channel.IsolationTests.setUpClass.__func__)

    def setUp(self):
        super().setUp()
        self.node = shutil.which("node")
        if not self.node:
            self.skipTest("Node is needed for the actual review-fix controller")
        self.socket_server()
        self.workspace = self.trees / "A"
        for command in (["init", "-q", "-b", "main"], ["config", "user.name", "Fixture"],
                        ["config", "user.email", "fixture@example.invalid"]):
            subprocess.run(["git", *command], cwd=self.workspace, capture_output=True, check=True)
        (self.workspace / "value.cjs").write_text("module.exports = 0;\n")
        subprocess.run(["git", "add", "."], cwd=self.workspace, capture_output=True, check=True)
        subprocess.run(["git", "commit", "-qm", "initial"], cwd=self.workspace, capture_output=True, check=True)
        (self.workspace / "value.cjs").write_text("module.exports = 1;\n")
        self.verify_enforcement()
        canary = self.root / "host-secret"
        canary.write_text("private")
        provider = self.root / "provider.mjs"
        provider.write_text("""import * as boundaryFS from 'node:fs';
import boundaryAssert from 'node:assert/strict';
boundaryAssert.equal(boundaryFS.existsSync(process.env.HOST_CANARY), false);
boundaryAssert.equal(boundaryFS.existsSync(process.env.HOST_STATE), false);
boundaryAssert.deepEqual(boundaryFS.readdirSync('.git/jig'), []);
""" + (REVIEW / "tests/fixtures/loop-provider.mjs").read_text())
        profile = {"schema": 1, "mounts": [
            {"source": self.node, "target": "/opt/tools/node"},
            {"source": str(provider), "target": "/opt/tools/provider.mjs"}],
            "environment": {"HOST_CANARY": str(canary), "HOST_STATE": str(self.run / "state.json")}}
        self.owner = channel.parse_credential(channel.issue(self.run, "driver-A"))
        policy = {"schema": 2, "run_dir": str(self.run), "task_id": "A",
                  "owner_session": self.owner.id, "task_binding": channel.task_binding(Engine.read(self.run)["tasks"]["A"]),
                  "profiles": {key: profile for key in ("codex", "triage", "repair", "validate")}}
        self.policy = policy
        policy_path = self.root / "policy.json"
        policy_path.write_text(json.dumps(policy))
        policy_path.chmod(0o600)
        boundary = ["/usr/bin/python3", "-B", str(test_channel.SCRIPTS / "review_boundary.py"),
                    "--policy", str(policy_path), "--policy-sha256", hashlib.sha256(policy_path.read_bytes()).hexdigest()]
        command = [self.node, str(provider), "workspace"]
        self.configured = {"cwd": str(self.workspace), "config": {
            "executionBoundary": boundary, "reviewers": [{"id": "codex", "command": command}],
            "triageCommand": command, "repairCommand": command, "timeoutMs": 20000},
            "contract": {"goal": "Export the required value", "acceptanceCriteria": [
                {"id": "value", "description": "The module exports 2"}], "nonGoals": [],
                "compatibilityConstraints": ["Keep CommonJS"], "permittedBehaviorChanges": ["Correct the value"],
                "requiredValidation": [{"id": "unit", "argv": [self.node, "-e",
                    "require('node:assert/strict').equal(require('./value.cjs'),2); "
                    "require('node:assert/strict').equal(require('node:fs').existsSync(process.env.HOST_STATE),false)"]}]}}

    def controller(self, configured, *, commit_mode="none", run=True):
        loop = LOOP / "scripts/review-fix-loop.mjs"
        options = LOOP / "scripts/loop-options.mjs"
        source = f"""import {{createRun, runUntilBoundary, status}} from {json.dumps(loop.as_uri())};
import {{parseArgs}} from {json.dumps(options.as_uri())};
let input=''; for await (const part of process.stdin) input+=part;
const args=JSON.parse(input);
const run=await createRun({{...args, options:parseArgs({json.dumps(['--scope', 'working-tree', '--commit-mode', commit_mode])})}});
const result={"await runUntilBoundary(run.directory)" if run else "run"};
console.log(JSON.stringify({{...status(result), directory:result.directory}}));
"""
        return subprocess.run([self.node, "--input-type=module", "-e", source], input=json.dumps(configured),
                              capture_output=True, text=True, timeout=75)

    def advance_controller(self, directory):
        loop = LOOP / "scripts/review-fix-loop.mjs"
        source = f"""import {{advance, status}} from {json.dumps(loop.as_uri())};
const result=await advance({json.dumps(directory)});
console.log(JSON.stringify(status(result)));"""
        return subprocess.run([self.node, "--input-type=module", "-e", source],
                              capture_output=True, text=True, timeout=20)

class ReviewBoundaryTests(ReviewBoundaryFixture, unittest.TestCase):

    def boundary_request(self):
        return {"role": "review", "assignment": {"id": "preflight-review", "role": "review", "provider": "codex",
                "repository": str(self.workspace), "fingerprint": "fixture"}, "cwd": str(self.workspace),
                "command": ["/usr/bin/python3", "-B", "-c", "print('{}')"], "timeoutMs": 10000}

    def test_busy_source_refuses_review_before_allocating_session_or_launch(self):
        import jobs
        import review_boundary
        request = self.boundary_request()
        sessions = Engine.read(self.run)["communication"]["sessions"]
        launches = set((self.run / "launches").glob("launch-*"))
        with jobs.lease(self.run, str(self.workspace), False):
            for _ in range(2):
                with self.assertRaises(test_channel.StateError) as raised:
                    review_boundary.execute(self.policy, request)
                self.assertEqual(raised.exception.code, "unsettled")
                self.assertEqual(Engine.read(self.run)["communication"]["sessions"], sessions)
                self.assertEqual(set((self.run / "launches").glob("launch-*")), launches)
        self.assertEqual(review_boundary.execute(self.policy, request), 0)

    def test_paused_or_cancelled_controller_child_allocates_nothing(self):
        import review_boundary
        request = self.boundary_request()
        sessions = Engine.read(self.run)["communication"]["sessions"]
        launches = set((self.run / "launches").glob("launch-*"))
        for control in ("pause", "cancel"):
            state = Engine.read(self.run)
            Engine.apply(self.run, {"op": "control", "action_id": control + "-child", "control": control,
                                   "expected_policy": state["policy_version"]})
            for _ in range(2):
                with self.assertRaises(test_channel.StateError) as raised:
                    review_boundary.execute(self.policy, request)
                self.assertEqual(raised.exception.code, "paused")
                self.assertEqual(Engine.read(self.run)["communication"]["sessions"], sessions)
                self.assertEqual(set((self.run / "launches").glob("launch-*")), launches)
            state = Engine.read(self.run)
            Engine.apply(self.run, {"op": "control", "action_id": "resume-" + control, "control": "resume",
                                   "expected_policy": state["policy_version"]})
        self.assertEqual(review_boundary.execute(self.policy, request), 0)

    def test_writer_cannot_replace_private_controller_state_through_git_ancestor(self):
        from test_channel import isolation
        initial = self.controller(self.configured, run=False)
        self.assertEqual(initial.returncode, 0, initial.stderr)
        controller = Path(json.loads(initial.stdout)["directory"])
        before = (controller / "run.json").read_bytes()
        directory = isolation.prepare(self.run, "ancestor-probe", "A", role="executor",
            parent_session=self.owner, profile={"schema": 1, "workspace_access": "write"})
        program = """import errno,pathlib,subprocess
root=pathlib.Path.cwd()
assert list((root/'.git/jig').iterdir())==[]
try:(root/'.git').rename(root/'.git-replaced')
except OSError as error:assert error.errno==errno.EBUSY,error
else:raise AssertionError('writer can replace private controller state')
probe=root/'.git/allowed-metadata-write';probe.write_text('allowed');probe.unlink()
subprocess.run(['git','status','--short'],check=True,capture_output=True)
"""
        result = isolation.launch(directory, ["/usr/bin/python3", "-B", "-c", program],
                                  capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((controller / "run.json").read_bytes(), before)
        resumed = self.advance_controller(str(controller))
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertNotEqual(json.loads(resumed.stdout)["phase"], "SCOPE_CHANGED")

    def test_review_adapter_verifies_its_registered_readonly_channel(self):
        from test_channel import isolation
        script = self.root / "verify-channel.mjs"
        script.write_text("""import assert from 'node:assert/strict';
import {verifiedReadOnlyChannel} from '/opt/tools/panel/scripts/orchestration-channel.mjs';
assert.equal(await verifiedReadOnlyChannel(process.cwd()), true);
console.log('verified-read-only-channel');
""")
        profile = {"schema": 1, "mounts": [
            {"source": self.node, "target": "/opt/tools/node"},
            {"source": str(LOOP.parent / "panel-review"), "target": "/opt/tools/panel"},
            {"source": str(script), "target": "/opt/tools/verify-channel.mjs"}]}
        directory = isolation.prepare(self.run, "verified-reviewer", "A", role="reviewer",
                                      parent_session=self.owner, profile=profile)
        completed = isolation.launch(directory, ["/opt/tools/node", "/opt/tools/verify-channel.mjs"],
                                     capture_output=True, text=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), "verified-read-only-channel")

    def test_controller_reviews_repairs_validates_and_rereviews_through_boundary(self):
        result = self.controller(self.configured)
        self.assertEqual(result.returncode, 0, result.stderr)
        outcome = json.loads(result.stdout)
        errors = [path.read_text() for path in Path(outcome["directory"]).glob("assignments/*/stderr.json")]
        self.assertEqual(outcome["phase"], "CONVERGED", result.stdout + "\n" + "\n".join(errors))
        self.assertEqual((self.workspace / "value.cjs").read_text(), "module.exports = 2;\n")
        state = Engine.read(self.run)
        jobs = list(state["communication"]["jobs"].values())
        self.assertGreaterEqual(sum(job["role"] == "reviewer" for job in jobs), 2)
        self.assertTrue(all(job["local_settled"] for job in jobs))
        self.assertTrue(any(not job["readonly"] for job in jobs))
        self.assertGreaterEqual(len(state["communication"]["artifacts"]), 4)
        requests = list(Path(outcome["directory"]).glob("assignments/*/request.json"))
        self.assertTrue(requests)
        self.assertTrue(all(json.loads(path.read_text()).get("executionBoundary") for path in requests))

    def test_boundary_rejects_native_assignment_before_allocating_controller(self):
        del self.configured["config"]["triageCommand"]
        result = self.controller(self.configured)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("native assignments cannot bypass", result.stderr)
        self.assertFalse((self.workspace / ".git/jig/review-fix/active.json").exists())
        self.assertFalse(Engine.read(self.run).get("communication", {}).get("jobs"))

    def test_replaced_owner_cannot_initialize_controller_or_mint_new_sessions(self):
        channel.issue(self.run, "driver-A")
        before = Engine.read(self.run)["communication"]["sessions"]
        result = self.controller(self.configured)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("revoked or replaced", result.stderr)
        self.assertFalse((self.workspace / ".git/jig/review-fix/active.json").exists())
        self.assertEqual(Engine.read(self.run)["communication"]["sessions"], before)

    def test_controller_waits_for_source_lease_and_honors_pause_and_cancel(self):
        import jobs
        result = self.controller(self.configured, run=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        initial = json.loads(result.stdout)
        directory = initial["directory"]
        saved = (Path(directory) / "run.json").read_bytes()
        source = (self.workspace / "value.cjs").read_bytes()
        with jobs.lease(self.run, str(self.workspace), False):
            blocked = self.advance_controller(directory)
            self.assertEqual(blocked.returncode, 0, blocked.stderr)
            self.assertTrue(json.loads(blocked.stdout)["waiting"])
            self.assertTrue(json.loads(blocked.stdout)["sourceInspectionPending"])
            self.assertEqual((Path(directory) / "run.json").read_bytes(), saved)
        coordinator = channel.issue(self.run, "coordinator")
        paused = self.call(coordinator, op="control", control="pause", action_id="pause-controller", expected_policy=1)
        self.assertNotIn("error", paused)
        result = self.advance_controller(directory)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["waiting"])
        self.assertEqual((Path(directory) / "run.json").read_bytes(), saved)
        cancelled = self.call(coordinator, op="control", control="cancel", action_id="cancel-controller",
                              expected_policy=paused["policy_version"])
        self.assertNotIn("error", cancelled)
        result = self.advance_controller(directory)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["phase"], "BLOCKED")
        self.assertEqual((self.workspace / "value.cjs").read_bytes(), source)
        self.assertFalse(Engine.read(self.run)["communication"].get("jobs"))

    def test_inline_repair_and_commits_do_not_execute_host_git_hooks_or_monitors(self):
        canary = self.root / "git-executed-on-host"
        hook_dir = self.root / "hooks"
        hook_dir.mkdir()
        for name in ("reference-transaction", "pre-commit", "fsmonitor"):
            script = hook_dir / name
            script.write_text(f"#!/bin/sh\nprintf '%s\\n' '{name}' >> '{canary}'\n")
            script.chmod(0o700)
        for name, value in (("core.hooksPath", str(hook_dir)), ("core.fsmonitor", str(hook_dir / "fsmonitor"))):
            subprocess.run(["git", "config", name, value], cwd=self.workspace, check=True)
        for key in ("triageCommand", "repairCommand"):
            self.configured["config"][key] = [*self.configured["config"][key][:-1], "success"]
        result = self.controller(self.configured, commit_mode="per-round")
        self.assertEqual(result.returncode, 0, result.stderr)
        outcome = json.loads(result.stdout)
        self.assertEqual(outcome["phase"], "CONVERGED", result.stdout)
        self.assertTrue(outcome["commits"])
        self.assertFalse(canary.exists(), canary.read_text() if canary.exists() else "")
        committed = subprocess.run(["git", "-c", "core.fsmonitor=false", "show", "HEAD:value.cjs"],
                                   cwd=self.workspace, capture_output=True, text=True, check=True)
        self.assertEqual(committed.stdout, "module.exports = 2;\n")

    def test_policy_rejects_task_rebinding_even_for_coordinator(self):
        from review_boundary import policy_state
        from state import StateError
        policy = {**self.policy, "owner_session": channel.parse_credential(channel.issue(self.run, "coordinator")).id}
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            state["tasks"]["A"]["identity"] = {"native_id": "replacement"}
            write_atomic(path / "state.json", state)
        with self.assertRaisesRegex(StateError, "task binding changed"):
            policy_state(policy)

    def test_executable_conversion_is_rejected_without_running_the_filter(self):
        canary = self.root / "filter-executed"
        script = self.root / "filter.sh"
        script.write_text(f"#!/bin/sh\n/usr/bin/touch '{canary}'\ncat\n")
        script.chmod(0o700)
        (self.workspace / ".gitattributes").write_text("value.cjs filter=probe\n")
        subprocess.run(["git", "config", "filter.probe.clean", str(script)], cwd=self.workspace, check=True)
        result = self.controller(self.configured, run=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unsupported executable Git filter", result.stderr)
        self.assertFalse(canary.exists())

    def test_approved_validation_log_parts_are_readable_without_peer_reports(self):
        from review_boundary import validation_artifacts
        controller = self.workspace / ".git/jig/review-fix/fixture-controller"
        request = controller / "assignments/current-review/request.json"
        request.parent.mkdir(parents=True)
        request.write_text("{}")
        request.chmod(0o600)
        log = controller / "assignments/validation/stdout.log"
        log.parent.mkdir(parents=True)
        contents = "\U0001f642" * 150000
        log.write_text(contents)
        log.chmod(0o600)
        assignment = {"id": "current-review", "role": "review", "fingerprint": "source-fingerprint",
                      "validationEvidence": {"fingerprint": "source-fingerprint", "contentHash": "source-content",
                      "checks": [{"checkId": "unit", "receipt": {"assignmentId": "validation", "log": str(log),
                                                                  "logTruncated": True}}]}}
        enriched = validation_artifacts(self.policy, assignment, request)
        reference = enriched["validationEvidence"]["checks"][0]["receipt"]["logArtifact"]
        self.assertFalse(reference["retained_log_complete"])
        self.assertGreater(len(reference["parts"]), 1)
        token = channel.issue(self.run, "validation-reader", role="reviewer", task_ids=["A"],
                              parent_session=self.owner, review_contract=enriched)
        reconstructed = ""
        for part in reference["parts"]:
            offset = 0
            while True:
                result = self.call(token, op="artifact_read", task_id="A", artifact_id=part["artifact_id"], offset=offset)
                self.assertNotIn("error", result)
                reconstructed += result["content"]
                if result["complete"]:
                    break
                offset = result["next_offset"]
        self.assertEqual(reconstructed, contents)
        peer = channel.issue(self.run, "peer-review", role="reviewer", task_ids=["A"], parent_session=self.owner)
        report = self.call(peer, op="artifact_put", task_id="A", action_id="peer-report", content="private finding")
        denied = self.call(token, op="artifact_read", task_id="A", artifact_id=report["artifact"]["id"])
        self.assertEqual(denied["error"], "artifact")
        from state import StateError
        assignment["validationEvidence"]["checks"][0]["receipt"]["log"] = str(self.root / "host-secret")
        with self.assertRaisesRegex(StateError, "outside its approved assignment"):
            validation_artifacts(self.policy, assignment, request)

    def test_malformed_retained_log_preserves_provenance_and_allows_review_launch(self):
        from review_boundary import validation_artifacts
        controller = self.workspace / ".git/jig/review-fix/fixture-controller"
        for number, raw in enumerate((b"A\xf0", b"A\xffZ")):
            with self.subTest(raw=raw):
                identifier = "current-review-" + str(number)
                request_path = controller / "assignments" / identifier / "request.json"
                request_path.parent.mkdir(parents=True)
                log = controller / "assignments/validation/stdout.log"
                log.parent.mkdir(parents=True, exist_ok=True)
                log.write_bytes(raw)
                log.chmod(0o600)
                assignment = {"id": identifier, "role": "review", "provider": "codex",
                    "repository": str(self.workspace), "fingerprint": "source",
                    "validationEvidence": {"fingerprint": "source", "checks": [{"receipt": {
                        "assignmentId": "validation", "log": str(log),
                        "logTruncated": False, "stdoutDecodingLoss": False}}]}}
                program = """import json,sys
sys.path.insert(0,'/opt/orchestration')
import communicate
a=json.load(sys.stdin)
ref=a['validationEvidence']['checks'][0]['receipt']['logArtifact']
assert not ref['retained_log_complete'] and ref['retained_decoding_loss']
text=''
for part in ref['parts']:
    reply=communicate.request({'op':'artifact_read','task_id':'A','artifact_id':part['artifact_id']})
    assert reply.get('complete') is True,reply
    text+=reply['content']
assert text=='A',text
print(json.dumps({'retrieved':text}))
"""
                request = {"role": "review", "assignment": assignment, "cwd": str(self.workspace),
                           "command": ["/usr/bin/python3", "-B", "-c", program], "timeoutMs": 10000}
                request_path.write_text(json.dumps(request))
                request_path.chmod(0o600)
                enriched = validation_artifacts(self.policy, assignment, request_path)
                reference = enriched["validationEvidence"]["checks"][0]["receipt"]["logArtifact"]
                self.assertFalse(reference["retained_log_complete"])
                self.assertTrue(reference["retained_decoding_loss"])
                self.assertEqual(reference["bytes"], 1)
                self.assertEqual(reference["sha256"], hashlib.sha256(b"A").hexdigest())
                self.assertEqual(reference["retained_source_bytes"], len(raw))
                self.assertEqual(reference["retained_source_sha256"], hashlib.sha256(raw).hexdigest())
                self.assertEqual(log.read_bytes(), raw)
                result = subprocess.run([*self.configured["config"]["executionBoundary"], "--request", str(request_path)],
                                        input=json.dumps(assignment), capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), {"retrieved": "A"})

    def test_log_artifact_completeness_requires_retention_and_decoding_metadata(self):
        from review_boundary import validation_artifacts
        controller = self.workspace / ".git/jig/review-fix/fixture-controller"
        request = controller / "assignments/current-review/request.json"
        request.parent.mkdir(parents=True)
        request.write_text("{}")
        request.chmod(0o600)
        for key, filename, truncation, fidelity in (
                ("log", "stdout.log", "logTruncated", "stdoutDecodingLoss"),
                ("stderrLog", "stderr.json", "stderrTruncated", "stderrDecodingLoss")):
            log = controller / "assignments/validation" / filename
            log.parent.mkdir(parents=True, exist_ok=True)
            log.write_text(json.dumps({"stderr": "retained tail"}) if key == "stderrLog" else "retained output")
            log.chmod(0o600)
            for metadata, complete in (({}, False), ({truncation: True, fidelity: False}, False),
                                       ({truncation: False}, False),
                                       ({truncation: False, fidelity: True}, False),
                                       ({truncation: False, fidelity: False}, True)):
                with self.subTest(stream=key, metadata=metadata):
                    assignment = {"id": "current-review", "role": "review", "fingerprint": "source",
                        "validationEvidence": {"fingerprint": "source", "checks": [{"receipt": {
                            "assignmentId": "validation", key: str(log), **metadata}}]}}
                    enriched = validation_artifacts(self.policy, assignment, request)
                    reference = enriched["validationEvidence"]["checks"][0]["receipt"][key + "Artifact"]
                    self.assertEqual(reference["retained_log_complete"], complete)

    def test_late_report_is_retained_without_publication_after_owner_replacement(self):
        assignment = {"id": "late-review", "role": "review", "provider": "codex", "repository": str(self.workspace)}
        program = "from pathlib import Path; import time\nwhile not Path('release').exists(): time.sleep(.01)\nprint('late report')"
        request = {"role": "review", "assignment": assignment, "cwd": str(self.workspace),
                   "command": ["/usr/bin/python3", "-c", program], "timeoutMs": 10000}
        request_path = self.root / "request.json"
        request_path.write_text(json.dumps(request))
        request_path.chmod(0o600)
        boundary = self.configured["config"]["executionBoundary"]
        process = subprocess.Popen([*boundary, "--request", str(request_path)], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 5
            running = []
            while time.monotonic() < deadline and process.poll() is None:
                running = [job for job in Engine.read(self.run)["communication"].get("jobs", {}).values()
                           if job["status"] == "running"]
                if running:
                    break
                time.sleep(.01)
            if not running:
                stdout, stderr = process.communicate(timeout=5)
                self.fail(f"Boundary did not start a job: {process.returncode}: {stdout}\n{stderr}")
            channel.issue(self.run, "driver-A")
            (self.workspace / "release").touch()
            stdout, stderr = process.communicate(timeout=10)
            self.assertNotEqual(process.returncode, 0, stdout)
            self.assertIn("not durably published", stderr)
            self.assertNotIn("late report", stdout)
            state = Engine.read(self.run)
            self.assertFalse(state["communication"].get("artifacts"))
            job = state["communication"]["jobs"][running[0]["id"]]
            self.assertTrue(job["local_settled"])
            report = read_json(Path(job["directory"]) / "report.json")
            self.assertEqual(base64.b64decode(report["stdout_base64"]), b"late report\n")
        finally:
            if process.poll() is None:
                (self.workspace / "release").touch()
                process.kill()
                process.communicate(timeout=5)

    def test_report_capture_drains_both_streams_with_bounded_retention(self):
        from review_boundary import captured_report
        with captured_report() as (streams, contents, truncated):
            result = subprocess.run(["/usr/bin/python3", "-c",
                "import os; os.write(1,b'x'*1048576); os.write(2,b'y'*131072)"],
                stdout=streams[0], stderr=streams[1], timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertEqual([len(value) for value in contents], [512 * 1024, 32 * 1024])
        self.assertEqual(truncated, [True, True])

    def test_controller_child_retains_source_lease_after_parent_exit(self):
        import jobs
        from state import StateError
        ready, release = self.root / "lease-child-ready", self.root / "release-child"
        child = (f"from pathlib import Path; import time; Path({str(ready)!r}).touch()\n"
                 f"deadline=time.monotonic()+10\n"
                 f"while not Path({str(release)!r}).exists() and time.monotonic()<deadline: time.sleep(.01)\n")
        lease = LOOP / "scripts/controller-lease.mjs"
        git_lease = LOOP.parent / "panel-review/scripts/git-lease.mjs"
        source = f"""import {{spawn}} from 'node:child_process';
import {{withControllerLease}} from {json.dumps(lease.as_uri())};
import {{gitStdio}} from {json.dumps(git_lease.as_uri())};
await withControllerLease({{root:{json.dumps(str(self.workspace))},config:{json.dumps(self.configured['config'])}}}, () => {{
  spawn('/usr/bin/python3',['-c',{json.dumps(child)}],{{stdio:gitStdio(['ignore','ignore','ignore']),detached:true}}).unref();
}});"""
        result = subprocess.run([self.node, "--input-type=module", "-e", source], capture_output=True, text=True, timeout=10)
        try:
            self.assertEqual(result.returncode, 0, result.stderr)
            deadline = time.monotonic() + 3
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(ready.exists())
            with self.assertRaisesRegex(StateError, "still owns the workspace"):
                with jobs.lease(self.run, str(self.workspace), False):
                    pass
        finally:
            release.touch()
        with jobs.lease(self.run, str(self.workspace), False, wait_seconds=3):
            pass

    def test_changed_host_policy_is_rejected_before_a_new_launch(self):
        from review_boundary import read_policy
        from state import StateError
        policy = self.root / "policy.json"
        before = hashlib.sha256(policy.read_bytes()).hexdigest()
        policy.write_text(policy.read_text() + "\n")
        with self.assertRaisesRegex(StateError, "policy changed"):
            read_policy(policy, before)
        self.assertFalse(Engine.read(self.run).get("communication", {}).get("jobs"))


if __name__ == "__main__":
    unittest.main()
