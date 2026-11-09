"""Prevent live acceptance from crediting absent, partial or another session's logs."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("workflow_evidence", Path(__file__).parents[1] / "benchmarks/workflow_evidence.py")
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class WorkflowEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.content = "workflow-validation-A\nžluťoučký\n"
        self.part = {"artifact_id": "approved", "sha256": hashlib.sha256(self.content.encode()).hexdigest(),
                     "bytes": len(self.content.encode())}
        self.contract = {"id": "00006-review", "provider": "claude", "validationEvidence": {"checks": [
            {"checkId": "unit", "receipt": {"logArtifact": {"parts": [self.part], "retained_log_complete": True}}}]}}
        self.sessions = {"reviewer-session": {"role": "reviewer", "task_ids": ["A"], "review_contract": self.contract}}

    def row(self, offset=0, content=None, session="reviewer-session"):
        return {"session_id": session, "provider": "claude", "request": {
            "op": "artifact_read", "task_id": "A", "artifact_id": "approved"}, "response": {
            "artifact_id": "approved", "sha256": self.part["sha256"], "offset": offset,
            "content": self.content if content is None else content}}

    def summarize(self, rows):
        return evidence.summarize(self.sessions, rows, tasks=("A",), providers=("claude",))

    def test_initial_review_without_receipts_does_not_claim_evidence_access(self):
        self.contract["validationEvidence"]["checks"][0]["receipt"] = None
        result = self.summarize([])
        self.assertTrue(result["all_supplied_logs_retrieved"])
        self.assertTrue(result["all_selected_reviewers_present"])
        self.assertFalse(result["all_selected_providers_exercised"])
        self.assertEqual(result["by_task"]["A"]["claude"]["status"], "not_exercised")

    def test_live_access_requires_both_providers_on_the_selected_runtime(self):
        runtime = {"selected-runtime": "sha256"}
        probe = {"outcome": "succeeded", "phase": "CONVERGED", "runtime_sha256": runtime,
                 "validation_log_reads": {"claude": 1, "codex": 1}}
        self.assertTrue(evidence.live_access_complete(probe, runtime))
        for provider in ("claude", "codex"):
            for reads in ({}, {provider: 1}, {"claude": 0, "codex": 0},
                          {**probe["validation_log_reads"], provider: True}):
                with self.subTest(reads=reads):
                    self.assertFalse(evidence.live_access_complete({**probe, "validation_log_reads": reads}, runtime))
        for field, value in (("outcome", "unknown"), ("phase", "REVIEW_INCOMPLETE"),
                             ("runtime_sha256", {"selected-runtime": "old-sha256"})):
            incomplete = {**probe, field: value}
            self.assertFalse(evidence.live_access_complete(incomplete, runtime))
        self.assertFalse(evidence.live_access_complete({}, runtime))
        self.assertFalse(evidence.live_access_complete(probe, {}))

    def test_missing_reviewer_metadata_is_not_a_clean_evidence_result(self):
        result = evidence.summarize({}, [], tasks=("A",), providers=("claude",))
        self.assertFalse(result["all_selected_reviewers_present"])
        self.assertFalse(result["all_selected_providers_exercised"])

    def test_supplied_but_unread_evidence_fails(self):
        result = self.summarize([])
        self.assertTrue(result["all_selected_providers_exercised"])
        self.assertFalse(result["all_supplied_logs_retrieved"])
        self.assertEqual(result["by_task"]["A"]["claude"]["status"], "failed")

    def test_wrong_session_hash_artifact_or_partial_marker_cannot_satisfy_retrieval(self):
        wrong_hash = self.row(); wrong_hash["response"]["sha256"] = "wrong"
        wrong_artifact = self.row(); wrong_artifact["request"]["artifact_id"] = "unapproved"
        for row in (self.row(session="other-session"), wrong_hash, wrong_artifact,
                    self.row(content="workflow-validation-A\n")):
            with self.subTest(row=row):
                self.assertFalse(self.summarize([row])["all_supplied_logs_retrieved"])

    def test_complete_unicode_pages_allow_retries_and_overlap(self):
        rows = [self.row(content=self.content[:22]), self.row(20, self.content[20:]),
                self.row(content=self.content[:22])]
        self.assertTrue(self.summarize(rows)["all_supplied_logs_retrieved"])
        self.assertFalse(self.summarize([self.row(content=self.content[:10]),
                                       self.row(20, self.content[20:])])["all_supplied_logs_retrieved"])


class ControllerRetentionTests(unittest.TestCase):
    def fixture(self, root):
        run, workspace = root / "run", root / "workspace"
        execution = run / "execution-test"
        execution.mkdir(parents=True)
        directory = workspace / ".git/jig/review-fix/controller-id"
        assignment = directory / "assignments/00001-review"
        assignment.mkdir(parents=True)
        logs = {execution / "controller-run-test.stdout": b'{"phase":"CONVERGED"}\n',
                execution / "controller-run-test.stderr": b'original failure\n\xff\x00',
                assignment / "request.json": b'{"role":"review"}\n',
                assignment / "stdout.log": b'reviewer evidence\n',
                assignment / "stderr.json": b'{"stderr":""}\n'}
        for path, raw in logs.items():
            path.write_bytes(raw)
        # The allowlist must not copy controller state, credentials or policies.
        for path in (run / "state.json", execution / "controller-policy.json",
                     directory / "run.json", assignment / "credential", assignment / "state.json"):
            path.write_text("PRIVATE-CANARY")
        receipt = {"ref": str(execution / "controller-run-test.stdout"),
                   "stderr_ref": str(execution / "controller-run-test.stderr"),
                   "output": {"stderr": {"path": str(execution / "controller-run-test.stderr"),
                       "bytes_seen": 2000, "retained_bytes": len(logs[execution / "controller-run-test.stderr"]),
                       "truncated": True, "complete": False}}}
        return run, workspace, directory, logs, receipt

    def test_successful_and_unknown_receipts_survive_fixture_deletion(self):
        for outcome in ("succeeded", "unknown"):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as retained:
                with tempfile.TemporaryDirectory() as temporary:
                    run, workspace, directory, logs, receipt = self.fixture(Path(temporary))
                    if outcome == "succeeded":
                        receipt["controller"] = {"directory": str(directory), "phase": "CONVERGED"}
                    else:
                        receipt["controller_directory"] = str(directory)
                    result = {"outcome": outcome, "receipt": receipt}
                    original = json.dumps(result, sort_keys=True)
                    destination = Path(retained) / "diagnostics"
                    evidence.retain_controller(result, run=run, workspace=workspace, destination=destination)
                    self.assertEqual(json.dumps(result, sort_keys=True), original)
                self.assertFalse(run.exists())
                manifest = json.loads((destination / "manifest.json").read_text())
                self.assertEqual(manifest["outcome"], outcome)
                self.assertEqual(manifest["output"], receipt["output"])
                copied = {Path(row["source"]): row for row in manifest["files"] if row["status"] == "copied"}
                self.assertEqual(set(copied), set(logs))
                for source, raw in logs.items():
                    row = copied[source]
                    self.assertEqual((destination / row["retained"]).read_bytes(), raw)
                    self.assertEqual(row["bytes"], len(raw))
                    self.assertEqual(row["sha256"], hashlib.sha256(raw).hexdigest())
                missing = [row for row in manifest["files"] if row["status"] == "missing"]
                self.assertEqual([row["source"] for row in missing],
                                 [str(directory / "assignments/00001-review/result.json")])
                self.assertIsNone(missing[0]["retained"])
                for path in destination.rglob("*"):
                    if path.is_file():
                        self.assertNotIn(b"PRIVATE-CANARY", path.read_bytes())

    def test_absent_references_and_files_remain_explicit(self):
        with tempfile.TemporaryDirectory() as retained, tempfile.TemporaryDirectory() as temporary:
            run, workspace, _, logs, receipt = self.fixture(Path(temporary))
            Path(receipt["stderr_ref"]).unlink()
            receipt["timed_out"] = True
            destination = Path(retained) / "diagnostics"
            manifest = evidence.retain_controller({"outcome": "unknown", "receipt": receipt},
                run=run, workspace=workspace, destination=destination)
            self.assertEqual(manifest["controller_directory"]["status"], "missing-reference")
            self.assertEqual((destination / "host.stdout").read_bytes(), logs[Path(receipt["ref"])])
            self.assertEqual(manifest["files"][1]["status"], "missing")
            self.assertEqual(manifest["files"][1]["source"], receipt["stderr_ref"])
            self.assertIsNone(manifest["files"][1]["retained"])
            self.assertEqual(manifest["output"], receipt["output"])

    def test_actual_timeout_receipt_retains_known_assignments_after_cleanup(self):
        import test_channel  # Select the configured installed runtime.
        import review_controller
        with tempfile.TemporaryDirectory() as retained:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                run, workspace, directory, logs, _ = self.fixture(root)
                entry = root / "controller.py"
                entry.write_text("import sys,time\nprint('timeout diagnostic',file=sys.stderr,flush=True)\ntime.sleep(30)\n")
                manifest_path = run / "execution-test/controller-manifest.json"
                review_controller.write_atomic(manifest_path, {"node": sys.executable, "entry": str(entry),
                    "id": directory.name, "directory": str(directory), "binding": {"runtime_sha256": "test-runtime"}})
                with (root / "lock").open("wb") as lock:
                    observed = review_controller.invoke(run, manifest_path, lock.fileno(), 1)
                self.assertEqual(observed["status"], "unknown")
                receipt = observed["receipt"]
                self.assertTrue(receipt["timed_out"])
                self.assertEqual(receipt["controller_directory"], str(directory))
                self.assertEqual(receipt["controller_id"], directory.name)
                self.assertEqual(receipt["runtime_sha256"], "test-runtime")
                destination = Path(retained) / "diagnostics"
                manifest = evidence.retain_controller({"outcome": observed["status"], "receipt": receipt},
                    run=run, workspace=workspace, destination=destination)
                expected = {path: raw for path, raw in logs.items() if directory in path.parents}
                expected.update({Path(receipt[key]): Path(receipt[key]).read_bytes() for key in ("ref", "stderr_ref")})
            self.assertFalse(run.exists())
            manifest = json.loads((destination / "manifest.json").read_text())
            self.assertEqual(manifest["outcome"], "unknown")
            self.assertEqual(manifest["source_receipt"], "receipt")
            self.assertEqual(manifest["output"], receipt["output"])
            copied = {Path(row["source"]): row for row in manifest["files"] if row["status"] == "copied"}
            self.assertEqual(set(copied), set(expected))
            for source, raw in expected.items():
                row = copied[source]
                self.assertEqual((destination / row["retained"]).read_bytes(), raw)
                self.assertEqual(row["bytes"], len(raw))
                self.assertEqual(row["sha256"], hashlib.sha256(raw).hexdigest())

    def test_missing_controller_directory_is_explicit(self):
        with tempfile.TemporaryDirectory() as retained, tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = evidence.retain_controller({"outcome": "unknown", "receipt": {
                "controller_directory": str(root / "workspace/.git/jig/review-fix/absent")}},
                run=root / "run", workspace=root / "workspace", destination=Path(retained) / "diagnostics")
            self.assertEqual(manifest["controller_directory"]["status"], "missing")
            self.assertEqual([row["status"] for row in manifest["files"]], ["missing-reference"] * 2)
            self.assertEqual([row["target"] for row in manifest["files"]], ["host.stdout", "host.stderr"])

    def test_unapproved_paths_and_symlinks_are_not_copied(self):
        with tempfile.TemporaryDirectory() as retained, tempfile.TemporaryDirectory() as temporary:
            run, workspace, directory, _, receipt = self.fixture(Path(temporary))
            private = run / "state.json"
            Path(receipt["ref"]).unlink()
            Path(receipt["ref"]).symlink_to(private)
            receipt["stderr_ref"] = str(private)
            receipt.pop("output")
            assignment = directory / "assignments/00001-review"
            (assignment / "request.json").unlink()
            (assignment / "request.json").symlink_to(private)
            (directory / "assignments/00002-review").symlink_to(run, target_is_directory=True)
            receipt["controller_directory"] = str(directory)
            destination = Path(retained) / "diagnostics"
            manifest = evidence.retain_controller({"outcome": "unknown", "receipt": receipt},
                run=run, workspace=workspace, destination=destination)
            refused = {row["target"] for row in manifest["files"] if row["status"] == "refused"}
            self.assertIn("host.stdout", refused)
            self.assertIn("host.stderr", refused)
            self.assertIn("assignments/00001-review/request.json", refused)
            self.assertEqual(sum(target.startswith("assignments/00002-review/") for target in refused), 4)
            for path in destination.rglob("*"):
                if path.is_file():
                    self.assertNotIn(b"PRIVATE-CANARY", path.read_bytes())


if __name__ == "__main__":
    unittest.main()
