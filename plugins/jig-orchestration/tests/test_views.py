"""Compact responses preserve blockers and retain immutable full evidence."""
import json
import unittest

from test_channel import ChannelFixture, channel, Engine


class ViewTests(ChannelFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.socket_server()
        self.token = channel.issue(self.run, "driver-A")

    def test_hidden_findings_and_holds_remain_visible_as_blockers(self):
        findings = [{"id": str(index), "status": "fixed", "text": "details " * 100} for index in range(100)]
        findings[-1].update(status="open", text="must not lose this finding")
        task = Engine.read(self.run)["tasks"]["A"]
        Engine.apply(self.run, {"op": "observe", "task_id": "A", "action_id": "findings",
                               "expected_policy": 1, "expected_task": task["version"],
                               "fields": {"findings": findings}, "evidence": self.proof})
        for index in range(14):
            state = Engine.read(self.run)
            Engine.apply(self.run, {"op": "control", "control": "hold", "action_id": "hold-" + str(index),
                                   "hold_id": str(index), "reason": "still blocked " * 100,
                                   "expected_policy": state["policy_version"]})
        view = self.call(self.token, op="query", task_id="A")
        self.assertFalse(view["complete"])
        self.assertEqual(view["blocking_summary"]["unresolved_findings"], 1)
        self.assertEqual(view["blocking_summary"]["run_holds"], 14)
        self.assertLess(len(json.dumps(view)), 30000)
        full = self.call(self.token, **view["detail_request"], path=["task", "findings", 99])
        self.assertEqual(json.loads(full["content"])["text"], "must not lose this finding")

    def test_snapshot_survives_task_changes_but_not_session_replacement(self):
        first = self.call(self.token, op="query", task_id="A", mode="compact")
        self.assertEqual(first, self.call(self.token, op="query", task_id="A", mode="compact"))
        self.call(self.token, op="observe", task_id="A", action_id="change", expected_policy=1,
                  expected_task=first["task"]["version"], fields={"next_action": "new action"}, evidence=self.proof)
        old = self.call(self.token, **first["detail_request"], path=["task", "next_action"])
        self.assertIsNone(json.loads(old["content"]))
        new = self.call(self.token, op="query", task_id="A", mode="compact")
        self.assertNotEqual(first["snapshot"], new["snapshot"])
        reviewer = channel.issue(self.run, "reviewer", role="reviewer", task_ids=["A"])
        self.assertEqual(self.call(reviewer, **first["detail_request"])["error"], "forbidden")
        replacement = channel.issue(self.run, "driver-A")
        self.assertEqual(self.call(self.token, **first["detail_request"])["error"], "session_revoked")
        self.assertEqual(self.call(replacement, **first["detail_request"])["error"], "snapshot")

    def test_paginated_snapshot_reconstructs_full_view(self):
        compact = self.call(self.token, op="query", task_id="A", mode="compact")
        full = self.call(self.token, op="query", task_id="A", mode="full")
        chunks, offset = [], 0
        while True:
            result = self.call(self.token, **compact["detail_request"], offset=offset, limit=113)
            chunks.append(result["content"])
            offset = result["next_offset"]
            if result["complete"]:
                break
        for field in ("protocol", "view_schema", "mode", "complete"):
            full.pop(field)
        self.assertEqual(json.loads("".join(chunks)), full)

    def test_small_view_remains_complete_without_creating_a_snapshot(self):
        small = self.call(self.token, op="query", task_id="A")
        self.assertEqual(small["mode"], "full")
        self.assertTrue(small["complete"])
        self.assertFalse((self.run / "view-snapshots").exists())

    def test_large_coordinator_overview_retains_blockers_and_fenced_details(self):
        import copy
        import views
        from state import locked, read_json, write_atomic
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            for index in range(100):
                key = f"extra-{index:03}"
                state["tasks"][key] = {**copy.deepcopy(state["tasks"]["A"]), "id": key,
                                       "next_action": "detail " * 200}
                state["config"]["scope"]["task_ids"].append(key)
            last = state["tasks"]["extra-099"]
            last.update(blocker="late blocker", holds={"gate": "pending"}, findings=[{"status": "open"}])
            write_atomic(path / "state.json", state)
        token = channel.issue(self.run, "coordinator")
        view = self.call(token, op="query")
        self.assertFalse(view["complete"])
        self.assertLessEqual(len(views.canonical(view).encode()), views.MAX_VIEW_BYTES + 20)
        self.assertEqual(view["blocking_summary"]["blocked_tasks"], 1)
        self.assertEqual(view["blocking_summary"]["held_tasks"], 1)
        self.assertEqual(view["blocking_summary"]["unresolved_findings"], 1)
        detail = self.call(token, **view["detail_request"], path=["tasks", "extra-099"])
        self.assertEqual(json.loads(detail["content"])["blocker"], "late blocker")
        self.assertEqual(self.call(self.token, **view["detail_request"])["error"], "wrong_task")
        replacement = channel.issue(self.run, "coordinator")
        self.assertEqual(self.call(replacement, **view["detail_request"])["error"], "snapshot")

    def test_late_unknown_candidate_survives_preview_and_escaped_keys_are_bounded(self):
        import views
        import gateway
        full = gateway.query(self.run, channel.parse_credential(self.token), "A", "full")
        full["integration"] = {"enabled": True, "candidates": {
            str(index): {"status": "clean"} for index in range(100)}}
        full["integration"]["candidates"]["99"] = {"status": "unknown"}
        full["task"]["findings"] = [{"id": str(index), "text": "\u0001" * 1000} for index in range(100)]
        full["task"]["holds"] = {"x" * 50000: {"reason": "retained"}}
        compact = views.compact(self.run, channel.parse_credential(self.token), "A", full)
        self.assertLessEqual(len(views.canonical(compact).encode()), views.MAX_VIEW_BYTES)
        self.assertEqual(compact["blocking_summary"]["unknown_integration_candidates"], 1)
        self.assertEqual(compact["blocking_summary"]["task_holds"], 1)
        self.assertFalse(compact["complete"])
        detail = self.call(self.token, **compact["detail_request"], path=["integration", "candidates", "99"])
        self.assertEqual(json.loads(detail["content"])["status"], "unknown")

    def test_filtered_findings_keep_original_indices_and_use_the_pinned_snapshot(self):
        from state import locked, read_json, write_atomic
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            state["tasks"]["A"]["findings"] = [
                {"id": "old", "status": "resolved"}, {"id": "required", "status": "open"},
                {"id": "unclassified", "status": None}]
            write_atomic(path / "state.json", state)
        view = self.call(self.token, op="query", task_id="A", mode="compact")
        with locked(self.run) as path:
            state = read_json(path / "state.json")
            state["tasks"]["A"]["findings"] = []
            write_atomic(path / "state.json", state)
        result = self.call(self.token, **view["detail_request"], path=["task", "findings"], select="unresolved_findings")
        items = json.loads(result["content"])
        self.assertEqual([item["index"] for item in items], [1, 2])
        self.assertEqual([item["finding"]["id"] for item in items], ["required", "unclassified"])


if __name__ == "__main__":
    unittest.main()
