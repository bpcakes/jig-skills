"""Explicit profile provisioning does not expose an ambient home."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import test_channel
from test_channel import ChannelFixture, isolation, StateError


class ProfileTests(ChannelFixture, unittest.TestCase):
    setUpClass = classmethod(test_channel.IsolationTests.setUpClass.__func__)

    def test_only_selected_profile_file_enters_session_home(self):
        self.socket_server()
        selected = self.root / "selected-credential"
        selected.write_text("fixture credential")
        other = self.root / "unrelated-credential"
        other.write_text("must remain outside")
        profile = {"schema": 1, "argv": ["/usr/bin/python3", "-c",
                   "import os,pathlib; p=pathlib.Path(os.environ['HOME']); assert (p/'config/key').read_text() == 'fixture credential'; print('selected-only')"],
                   "files": [{"source": str(selected), "target": "config/key"}]}
        launch = isolation.prepare(self.run, "driver-A", "A", profile=profile)
        result = isolation.launch(launch, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "selected-only")
        spec = json.loads((launch / "launch.json").read_text())
        self.assertEqual((Path(spec["home"]) / "config/key").stat().st_mode & 0o777, 0o600)
        self.assertFalse((Path(spec["home"]) / "unrelated-credential").exists())

    def test_profile_cannot_write_outside_its_home(self):
        with self.assertRaisesRegex(StateError, "inside the private home"):
            isolation.prepare(self.run, "driver-A", "A", profile={"schema": 1,
                              "files": [{"content": "escape", "target": "../escape"}]})

    def test_malformed_profile_does_not_create_launch_or_replace_credential(self):
        from profiles import validate
        from state import Engine
        import channel
        credential = channel.issue(self.run, "driver-A")
        before = Engine.read(self.run)["communication"]["active"]
        malformed = [
            {"workspace_access": []}, {"environment": {1: "value"}},
            {"mounts": [None]}, {"mounts": [{"source": "/usr", "target": "/opt/tools/../escape"}]},
            {"files": [{"content": "text", "target": None}]},
            {"files": [{"content": "a", "target": "x"}, {"content": "b", "target": "x/y"}]},
            {"egress_hosts": "api.openai.com"}, {"egress_hosts": [None]},
        ]
        for fields in malformed:
            with self.subTest(fields=fields), self.assertRaises(StateError):
                isolation.prepare(self.run, "driver-A", "A", profile={"schema": 1, **fields})
        self.assertEqual(Engine.read(self.run)["communication"]["active"], before)
        self.assertFalse((self.run / "launches").exists())
        self.assertEqual(channel.caller(self.run, channel.parse_credential(credential), "query", "A"), "driver-A")

    def test_binding_change_during_preparation_cannot_issue_a_mismatched_credential(self):
        import channel
        from state import Engine, locked, read_json, write_atomic
        original = channel.issue
        def rebind(*args, **kwargs):
            with locked(self.run) as path:
                state = read_json(path / "state.json")
                state["tasks"]["A"]["identity"] = {"native_id": "replacement-during-prepare"}
                write_atomic(path / "state.json", state)
            return original(*args, **kwargs)
        with patch.object(channel, "issue", side_effect=rebind):
            with self.assertRaisesRegex(StateError, "binding changed during launch preparation"):
                isolation.prepare(self.run, "driver-A", "A")
        self.assertFalse(Engine.read(self.run).get("communication", {}).get("sessions"))


if __name__ == "__main__":
    unittest.main()
