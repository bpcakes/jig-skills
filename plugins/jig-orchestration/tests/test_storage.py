"""Bounded retained protocol data and responsive control under contention."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
import unittest.mock

import test_channel
from test_channel import ChannelFixture, Engine, StateError, channel, communicate
from state import canonical, locked, read_json, write_atomic
import storage


class ContractStorageTests(ChannelFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            state["config"]["communication"] = {"mode": "enforced", "storage": {
                "max_bytes": 4 * 1024 * 1024, "reserved_bytes": 128 * 1024,
                "max_files": 128, "reserved_files": 24, "max_state_bytes": 64 * 1024}}
            write_atomic(path / "state.json", state)
            storage.initialize(path, state["config"])
        self.token = channel.issue(self.run, "driver-A")
        self.owner = channel.parse_credential(self.token)
        self.socket_server()

    def issue(self, contract):
        return channel.issue(self.run, "review-A", role="reviewer", task_ids=["A"],
                             parent_session=self.owner, review_contract=contract)

    def test_large_contracts_remain_retrievable_without_growing_hot_state(self):
        approved = self.call(self.token, op="artifact_put", task_id="A", action_id="approved", content="approved")
        private = self.call(self.token, op="artifact_put", task_id="A", action_id="private", content="private")
        approved_id, private_id = approved["artifact"]["id"], private["artifact"]["id"]
        for index in range(8):
            contract = {"id": str(index), "provider": "codex", "source": "x" * 48000,
                        "artifact_ids": [approved_id]}
            token = self.issue(contract)
            self.assertEqual(self.call(token, op="query", task_id="A")["review"], contract)
            self.assertEqual(self.call(token, op="artifact_read", task_id="A", artifact_id=approved_id)["content"], "approved")
            self.assertIn("error", self.call(token, op="artifact_read", task_id="A", artifact_id=private_id))
            channel.revoke(self.run, "review-A")
            self.assertEqual(self.call(token, op="query", task_id="A")["error"], "session_revoked")
        state = Engine.read(self.run)
        self.assertLess(len(canonical(state).encode()), 64 * 1024)
        records = [row for row in state["communication"]["sessions"].values() if row["role"] == "reviewer"]
        for record in records:
            self.assertNotIn("source", record["review_contract"])
            self.assertEqual(channel.contract(self.run, record)["source"], "x" * 48000)
        blobs = list((self.run / "review-contracts").glob("*.json"))
        self.assertEqual(len(blobs), 8)
        ledger = read_json(self.run / storage.LEDGER)
        for blob in blobs:
            self.assertGreaterEqual(ledger["files"][str(blob.relative_to(self.run))], 2 * blob.stat().st_size)
        self.issue(contract)
        self.assertEqual(len(list((self.run / "review-contracts").glob("*.json"))), 8)

    def test_missing_or_corrupt_contract_fails_closed_without_replacement(self):
        contract = {"id": "immutable", "source": "retained"}
        token = self.issue(contract)
        record = Engine.read(self.run)["communication"]["sessions"][channel.parse_credential(token).id]
        blob = self.run / "review-contracts" / (record["review_contract_sha256"] + ".json")
        blob.write_text('{}\n')
        self.assertEqual(self.call(token, op="query", task_id="A")["error"], "session")
        with self.assertRaisesRegex(StateError, "contract changed"):
            self.issue(contract)
        self.assertEqual(blob.read_text(), '{}\n')
        blob.unlink()
        self.assertIn("error", self.call(token, op="query", task_id="A"))

    def test_retained_inline_contracts_still_resolve(self):
        contract = {"id": "old", "source": "inline"}
        token = self.issue(contract)
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            record = state["communication"]["sessions"][channel.parse_credential(token).id]
            del record["review_contract_sha256"]
            record["review_contract"] = contract
            write_atomic(path / "state.json", state)
        self.assertEqual(self.call(token, op="query", task_id="A")["review"], contract)

    def test_contract_capacity_refusal_preserves_active_session_and_evidence(self):
        token = self.issue({"id": "original", "source": "kept"})
        before = Engine.read(self.run)
        blobs = set((self.run / "review-contracts").iterdir())
        with self.assertRaisesRegex(StateError, "protocol capacity"):
            self.issue({"id": "too-large", "source": "x" * (2 * 1024 * 1024)})
        self.assertEqual(Engine.read(self.run), before)
        self.assertEqual(set((self.run / "review-contracts").iterdir()), blobs)
        self.assertEqual(self.call(token, op="query", task_id="A")["review"]["source"], "kept")


class StorageTests(ChannelFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.driver = channel.issue(self.run, "driver-A")
        self.coordinator = channel.issue(self.run, "coordinator")
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            state["config"]["communication"] = {"mode": "legacy", "storage": {
                "max_bytes": 512 * 1024, "reserved_bytes": 128 * 1024,
                "max_files": 128, "reserved_files": 24, "max_state_bytes": 128 * 1024}}
            write_atomic(path / "state.json", state)
            storage.initialize(path, state["config"])
        self.server = self.socket_server()

    def put(self, identifier, content):
        return self.call(self.driver, op="artifact_put", task_id="A", action_id=identifier, content=content)

    def fill(self):
        accepted = []
        for index in range(20):
            content = str(index) + "x" * 24000
            reply = self.put("fill-" + str(index), content)
            if "error" in reply:
                self.assertEqual(reply["error"], "storage_capacity", reply)
                return accepted
            accepted.append((index, content, reply))
        self.fail("retained data did not reach its configured bound")

    def test_capacity_preserves_reads_replay_answers_and_control_across_restart(self):
        question = self.call(self.driver, op="message", task_id="A", action_id="question",
                             recipient="coordinator", kind="question", body="Which interface?")
        self.assertTrue(question["accepted"], question)
        accepted = self.fill()
        self.assertTrue(accepted)
        self.stop_server(self.server)
        self.server = self.socket_server()
        index, content, original = accepted[0]
        before = storage.status(self.run)
        self.assertEqual(self.put("fill-" + str(index), content), original)
        self.assertEqual(storage.status(self.run), before)
        artifact = self.call(self.driver, op="artifact_read", task_id="A", artifact_id=original["artifact"]["id"], limit=65536)
        self.assertEqual(artifact["content"], content)
        answered = self.call(self.coordinator, op="message", task_id="A", action_id="answer",
                             recipient="driver-A", kind="reply", reply_to="question", body="Use v2")
        self.assertTrue(answered.get("accepted"), answered)
        paused = self.call(self.coordinator, op="control", control="pause", action_id="pause-at-capacity", expected_policy=1)
        self.assertNotIn("error", paused)
        self.assertTrue(Engine.read(self.run)["controls"]["paused"])
        self.assertLessEqual(storage.status(self.run)["reserved_bytes"], before["limits"]["max_bytes"])

    def test_state_growth_is_rejected_without_mutating_task(self):
        before = Engine.read(self.run)
        response = self.call(self.driver, op="observe", task_id="A", action_id="large-state", expected_policy=1,
                             expected_task=before["tasks"]["A"]["version"], fields={"next_action": "x" * 200000}, evidence=self.proof)
        self.assertEqual(response.get("error"), "storage_capacity", response)
        self.assertEqual(Engine.read(self.run), before)
        self.assertIsNone(Engine.action(self.run, "large-state"))

    def fill_receipts(self):
        state = Engine.read(self.run)
        cursor = state["communication"]["epoch"] + ":" + str(state["communication"]["sequence"])
        receipts = []
        for index in range(150):
            request = {"op": "ack", "task_id": "A", "action_id": "ack-" + str(index), "cursor": cursor}
            reply = self.call(self.driver, **request)
            if "error" in reply:
                self.assertEqual(reply["error"], "storage_capacity", reply)
                break
            receipts.append((request, reply))
        else:
            self.fail("acknowledgement receipts escaped their storage budget")
        self.assertTrue(receipts)
        return receipts

    def test_receipts_cannot_spend_pause_and_cancel_capacity(self):
        self.fill()
        receipts = self.fill_receipts()
        # Restart cannot reset accounting, and replay must consume no capacity.
        self.stop_server(self.server)
        self.server = self.socket_server()
        before = storage.status(self.run)
        self.assertEqual(self.call(self.driver, **receipts[0][0]), receipts[0][1])
        self.assertEqual(storage.status(self.run), before)
        old_coordinator = self.coordinator
        self.coordinator = channel.issue(self.run, "coordinator")
        self.assertEqual(self.call(old_coordinator, op="query").get("error"), "session_revoked")
        for control in ("pause", "cancel"):
            policy = Engine.read(self.run)["policy_version"]
            request = {"op": "control", "control": control, "action_id": "protected-" + control,
                       "expected_policy": policy}
            result = self.call(self.coordinator, **request)
            self.assertNotIn("error", result)
            self.assertEqual(self.call(self.coordinator, **request), result)
        controls = Engine.read(self.run)["controls"]
        self.assertTrue(controls["paused"])
        self.assertTrue(controls["cancel_requested"])
        self.assertLessEqual(storage.status(self.run)["reserved_bytes"], before["limits"]["max_bytes"])

    def test_pause_journal_recovers_after_process_exit_at_capacity(self):
        self.fill()
        self.fill_receipts()
        self.stop_server(self.server)
        script = '''
import os, sys
sys.path.insert(0, sys.argv[1])
import channel, state
write = state.write_atomic
def interrupt(path, value, **options):
    if path.name == 'state.json': os._exit(17)
    return write(path, value, **options)
state.write_atomic = interrupt
channel.apply(sys.argv[2], channel.parse_credential(sys.argv[3]),
              {'op':'control', 'control':'pause', 'action_id':'interrupted-pause', 'expected_policy':1})
'''
        result = subprocess.run([sys.executable, "-B", "-c", script, str(test_channel.SCRIPTS), str(self.run),
                                 self.coordinator], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 17, result.stderr)
        self.assertTrue((self.run / "transaction.json").exists())
        reserved = storage.status(self.run)
        self.server = self.socket_server()
        self.assertTrue(Engine.read(self.run)["controls"]["paused"])
        self.assertFalse((self.run / "transaction.json").exists())
        replay = self.call(self.coordinator, op="control", control="pause", action_id="interrupted-pause", expected_policy=1)
        self.assertNotIn("error", replay)
        self.assertEqual(storage.status(self.run), reserved)

    def test_cancel_at_capacity_stops_and_settles_real_enforced_job(self):
        from test_channel import isolation
        test_channel.IsolationTests.setUpClass()
        self.verify_enforcement()
        directory = isolation.prepare(self.run, "driver-A", "A")
        self.driver = (directory / "credential").read_text().strip()
        results, failures = [], []
        program = "from pathlib import Path; import time; Path('started').touch(); time.sleep(30)"
        def run():
            try:
                results.append(isolation.launch(directory, ["/usr/bin/python3", "-c", program],
                                                capture_output=True, text=True, timeout=10))
            except Exception as error:
                failures.append(error)
        thread = threading.Thread(target=run)
        thread.start()
        try:
            deadline = time.monotonic() + 5
            while not (self.trees / "A/started").exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue((self.trees / "A/started").exists(), failures)
            self.fill()
            self.fill_receipts()
            result = self.call(self.coordinator, op="control", control="cancel", action_id="cancel-full-live-job",
                               expected_policy=Engine.read(self.run)["policy_version"])
            self.assertNotIn("error", result)
            thread.join(4)
            self.assertFalse(thread.is_alive(), "cancel did not stop the isolated process")
            self.assertFalse(failures, failures)
            self.assertNotEqual(results[0].returncode, 0)
            job = Engine.read(self.run)["communication"]["jobs"][directory.name]
            self.assertTrue(job["local_settled"], job)
            self.assertFalse(self.server.finished.is_set(), self.server.maintenance_failure)
        finally:
            if thread.is_alive():
                # The launch timeout kills this owned namespace even if the
                # control assertion fails; never leave fixture processes live.
                thread.join(12)

    def test_concurrent_snapshots_share_reservation_and_respect_capacity(self):
        from views import save_snapshot
        snapshot = {"large": "x" * 40000}
        identifier = hashlib.sha256(canonical(snapshot).encode()).hexdigest()
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: save_snapshot(self.run, identifier, snapshot), range(8)))
        ledger = read_json(self.run / storage.LEDGER)
        self.assertEqual(sum(key.startswith("view-snapshots/") for key in ledger["files"]), 1)
        self.assertEqual(read_json(self.run / "view-snapshots" / identifier), snapshot)
        self.fill()
        with self.assertRaisesRegex(StateError, "capacity"):
            save_snapshot(self.run, "another", {"large": "y" * 200000})
        self.assertFalse((self.run / "view-snapshots/another").exists())

    def snapshot(self, index, size=2000):
        import views
        body = {"session_id": "fixture", "task_id": "A", "view": {"index": index, "detail": "x" * size}}
        identifier = hashlib.sha256(canonical(body).encode()).hexdigest()
        views.save_snapshot(self.run, identifier, body)
        return identifier

    def snapshots(self):
        import views
        reserved = {name.split("/", 1)[1] for name in read_json(self.run / storage.LEDGER)["files"]
                    if name.startswith("view-snapshots/")}
        stored = set(views.retained(self.run / "view-snapshots"))
        self.assertEqual(reserved, stored)  # Storage is returned with each expired snapshot.
        self.assertEqual(len(list((self.run / "view-snapshots").glob(".write-lock-*"))), len(stored))
        return stored

    def test_snapshot_cache_keeps_the_most_recent_and_returns_the_rest(self):
        import views
        issued = []
        with unittest.mock.patch.object(views, "SNAPSHOT_LIMIT", 3):
            for index in range(6):
                issued.append(self.snapshot(index))
                # Issue times a clock tick apart, whatever this filesystem's resolution.
                stamp = time.time_ns() - (60 - index) * 10 ** 9
                os.utime(self.run / "view-snapshots" / issued[-1], ns=(stamp, stamp))
            self.assertEqual(self.snapshots(), set(issued[3:]))
            before = storage.status(self.run)
            self.assertEqual(self.snapshot(3), issued[3])  # Issued again: recent again, and no new storage.
            self.assertEqual(storage.status(self.run), before)
            issued.append(self.snapshot(6))
            self.assertEqual(self.snapshots(), {issued[3], issued[5], issued[6]})
        with self.assertRaisesRegex(StateError, "only the view snapshot cache"):
            storage.retain(self.run, "actions", [])

    def test_snapshot_makes_room_from_older_snapshots_when_storage_is_short(self):
        older = [self.snapshot(index, 20000) for index in range(2)]
        for index, identifier in enumerate(older):
            stamp = time.time_ns() - (60 - index) * 10 ** 9
            os.utime(self.run / "view-snapshots" / identifier, ns=(stamp, stamp))
        self.fill()
        newest = self.snapshot(2, 30000)  # Larger than what the artifacts left free.
        stored = self.snapshots()
        self.assertIn(newest, stored)
        self.assertNotIn(older[0], stored)
        status = storage.status(self.run)
        self.assertLessEqual(status["reserved_bytes"], status["limits"]["max_bytes"] - status["limits"]["reserved_bytes"])

    def test_repeated_process_crashes_leave_one_reserved_temporary_then_recover(self):
        content = "recover this immutable artifact" * 100
        digest = hashlib.sha256(content.encode()).hexdigest()
        script = '''
import os, sys
sys.path.insert(0, sys.argv[1])
import protocol, state
replace = state.os.replace
def interrupt(source, target):
    if str(target).endswith(sys.argv[4]): os._exit(17)
    return replace(source, target)
state.os.replace = interrupt
protocol.write_blob(sys.argv[2], sys.argv[3])
'''
        for _ in range(3):
            result = subprocess.run([sys.executable, "-B", "-c", script, str(test_channel.SCRIPTS), str(self.run), content, digest],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 17, result.stderr)
        self.assertEqual(len(list((self.run / "artifacts").glob(".write-pending-*"))), 1)
        ledger = read_json(self.run / storage.LEDGER)
        self.assertEqual(sum(key.startswith("artifacts/") for key in ledger["files"]), 1)
        stored = self.put("recovered", content)
        self.assertIn("artifact", stored)
        self.assertFalse(list((self.run / "artifacts").glob(".write-pending-*")))
        self.assertEqual((self.run / "artifacts" / digest).read_text(), content)

    def test_state_lock_pressure_returns_honest_bounded_error_then_same_control_succeeds(self):
        request = {"op": "control", "control": "pause", "action_id": "pressure-pause", "expected_policy": 1}
        # Warm the immutable identity cache, then block authoritative state.
        self.assertNotIn("error", self.call(self.coordinator, op="query"))
        def unknown(index):
            return communicate._request_once({"op": "query", "task_id": "A"}, credential=str(index) + ".invalid",
                                            socket_path=str(self.run / "endpoint/gateway.sock"), deadline=time.monotonic() + 2)
        with locked(self.run), ThreadPoolExecutor(max_workers=8) as pool:
            noise = [pool.submit(unknown, number) for number in range(8)]
            started = time.monotonic()
            reply = communicate._request_once(request, credential=self.coordinator,
                                              socket_path=str(self.run / "endpoint/gateway.sock"), deadline=time.monotonic() + 2)
            elapsed = time.monotonic() - started
            self.assertEqual(reply.get("error"), "state_busy", reply)
            self.assertLess(elapsed, 1.5)
            self.assertFalse(self.server.finished.is_set())
            for future in noise:
                self.assertIn(future.result().get("error"), {"busy", "state_busy", "unauthenticated"})
        self.assertIsNone(Engine.action(self.run, request["action_id"]))
        applied = self.call(self.coordinator, **request)
        self.assertNotIn("error", applied)
        self.assertEqual(self.call(self.coordinator, **request), applied)
        self.assertTrue(Engine.read(self.run)["controls"]["paused"])


if __name__ == "__main__":
    unittest.main()
