"""Launcher boundary tests; these do not claim live Cursor completion behavior."""
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from contextlib import redirect_stdout
from unittest.mock import patch

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("launcher", Path(__file__).with_name("run_cursor_execplan.py"))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="jig-plan-test-")
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name).resolve() / "repo with spaces"
        self.workspace.mkdir()
        self.plan = self.workspace / "plan.md"
        self.plan.write_text("# Two milestones\n\n- [ ] Labels\n- [ ] Search\n")

    def run_launcher(self, options=(), code=0, models="composer-2.5 - Composer\n", worktree_lists=("", "")):
        calls = []

        def run(command, **kwargs):
            calls.append((command, kwargs))
            return subprocess.CompletedProcess(command, 0 if "--list-models" in command else code,
                                               stdout=models, stderr="")

        with patch.object(sys, "argv", ["launcher", "plan.md", "--workspace", str(self.workspace), *options]), \
             patch.object(launcher.shutil, "which", return_value="/fixture/cursor-agent"), \
             patch.object(launcher.subprocess, "run", side_effect=run), \
             patch.object(launcher.subprocess, "check_output", side_effect=worktree_lists), \
             redirect_stdout(io.StringIO()) as stdout:
            status = launcher.main()
        self.stdout = stdout.getvalue()
        return status, calls

    def test_default_provider_and_workspace_preserved(self):
        status, calls = self.run_launcher()
        self.assertEqual(status, 0)
        self.assertEqual(calls[0][0], ["cursor-agent", "--list-models"])
        command, kwargs = calls[1]
        self.assertEqual(command[:7], ["cursor-agent", "--print", "--trust", "--workspace",
                                     str(self.workspace), "--model", "composer-2.5"])
        self.assertNotIn("--force", command)
        self.assertEqual(kwargs["cwd"], self.workspace)
        # Structural prompt guard only; independent forward tests exercise behavior.
        self.assertIn("Complete the whole ExecPlan", command[-1])

    def test_milestone_constraints_and_explicit_force_reach_child(self):
        status, calls = self.run_launcher(["--milestone", "Labels", "--force", "--extra-instruction", "Preserve Search."])
        command = calls[-1][0]
        self.assertEqual(status, 0)
        self.assertIn("--force", command)
        self.assertIn("milestone named 'Labels'", command[-1])
        self.assertIn("Preserve Search.", command[-1])
        self.assertNotIn("Complete the whole ExecPlan", command[-1])

    def test_blank_milestone_is_rejected(self):
        for milestone in ["", "  \t"]:
            with self.subTest(milestone=repr(milestone)), \
                 patch.object(sys, "argv", ["launcher", "plan.md", "--milestone", milestone]):
                with self.assertRaisesRegex(SystemExit, "2"):
                    launcher.parse_args()

    def test_failure_is_not_reported_as_success(self):
        self.assertEqual(self.run_launcher(code=7)[0], 7)

    def test_unavailable_model_fails_without_implementation(self):
        with self.assertRaisesRegex(SystemExit, "not available"):
            self.run_launcher(models="other - Other\n")

    def test_worktree_is_passed_explicitly(self):
        actual = Path(self.temp.name).resolve() / "isolated"
        actual.mkdir()
        before = f"worktree {self.workspace}\n"
        after = before + f"\nworktree {actual}\n"
        status, calls = self.run_launcher(["--worktree", "isolated"], worktree_lists=(before, after))
        command = calls[-1][0]
        self.assertEqual(status, 0)
        self.assertEqual(command[command.index("--worktree") + 1], "isolated")
        self.assertIn("actual worktree root", command[-1])
        self.assertEqual(json.loads(self.stdout), {"cursorWorktree": str(actual)})

    def test_successful_worktree_run_fails_if_checkout_cannot_be_verified(self):
        status, _ = self.run_launcher(["--worktree", "isolated"])
        self.assertEqual(status, 1)

    def test_worktree_name_cannot_escape_documented_root(self):
        for name in ["", "  ", ".", "..", "nested/name", "nested\\name"]:
            with self.subTest(name=repr(name)), \
                 patch.object(sys, "argv", ["launcher", "plan.md", "--worktree", name]):
                with self.assertRaisesRegex(SystemExit, "2"):
                    launcher.parse_args()

    def test_follow_up_uses_actual_worktree_as_workspace(self):
        worktree = Path(self.temp.name).resolve() / "cursor worktree"
        worktree.mkdir()
        (worktree / "plan.md").write_text("# Continue here\n")
        calls = []

        def run(command, **kwargs):
            calls.append((command, kwargs))
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with patch.object(sys, "argv", ["launcher", "plan.md", "--workspace", str(worktree), "--skip-model-check"]), \
             patch.object(launcher.shutil, "which", return_value="/fixture/cursor-agent"), \
             patch.object(launcher.subprocess, "run", side_effect=run):
            self.assertEqual(launcher.main(), 0)

        command, kwargs = calls[0]
        self.assertEqual(command[command.index("--workspace") + 1], str(worktree))
        self.assertNotIn("--worktree", command)
        self.assertEqual(kwargs["cwd"], worktree)
        self.assertIn("ExecPlan path: plan.md", command[-1])

    def test_outside_plan_is_rejected(self):
        outside = Path(self.temp.name) / "outside.md"
        outside.write_text("outside")
        with self.assertRaisesRegex(SystemExit, "must be inside"):
            launcher.resolve_paths(str(outside), str(self.workspace))


if __name__ == "__main__":
    unittest.main()
