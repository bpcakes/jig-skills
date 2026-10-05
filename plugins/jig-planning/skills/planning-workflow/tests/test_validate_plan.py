"""CLI regressions for dependency integrity and literal-code handling."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


SKILL = Path(__file__).resolve().parents[1]
VALIDATOR = SKILL / "scripts" / "validate_plan.py"


def task(task_id, depends="none", outcome="Deliver the configured result"):
    return f"""### {task_id} — Deliver result
- Outcome: {outcome}
- Changes: src/config.py
- Depends on: {depends}
- Verify: Run the configuration tests.
- Recovery: Revert the configuration change.
- Done when: Default and configured cases pass.
"""


def plan(tasks=None, extra=""):
    return """# Configuration plan
## Objective
Expose the configured result.
## Scope
Only the configuration path.
## Evidence
The configuration module owns the default.
## Design
Use the existing configuration module.
## Tasks
""" + (tasks if tasks is not None else task("T-01")) + """## Verification
Run the configuration tests.
## Rollout
Use the existing deployment and revert on failure.
## Risks
No data migration is involved.
""" + extra


class ValidatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="planning validator ")
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name)

    def validate(self, content, profile="standard", strict=False):
        path = self.project / "plan.md"
        path.write_text(content)
        args = [sys.executable, "-B", str(VALIDATOR), str(path),
                "--profile", profile, "--json"]
        if strict:
            args.append("--strict")
        result = subprocess.run(args, cwd=self.project, capture_output=True, text=True)
        self.assertEqual(result.stderr, "")
        return result.returncode, json.loads(result.stdout)

    def assert_error(self, content, code):
        status, report = self.validate(content)
        self.assertEqual(status, 1, report)
        self.assertFalse(report["valid"])
        self.assertIn(code, {f["code"] for f in report["findings"]})

    def test_valid_profiles_and_explicit_absence(self):
        for profile in ("light", "standard", "critical"):
            for absence in ("none", "NONE", "n/a", "n a", "not applicable",
                            "no dependencies", "`none`"):
                with self.subTest(profile=profile, absence=absence):
                    status, report = self.validate(plan(task("T-01", absence)), profile, True)
                    self.assertEqual(status, 0, report)
                    self.assertEqual(report["dependencies"], {"T-01": []})

    def test_normalized_ids_and_duplicate_edges(self):
        content = plan(task("T-01") + task("TASK_2", "T-01")
                       + task("TASK 3", "`task_1`, T1, TASK 2"))
        status, report = self.validate(content, strict=True)
        self.assertEqual(status, 0, report)
        self.assertEqual(report["dependencies"]["T-03"], ["T-01", "T-02"])

    def test_malformed_dependency_values_are_not_dropped(self):
        for value in ("T-O2", "T-01x", "T-01, T-O2", "T-O2, T-01",
                      "T-01,", ",T-01", "none, T-01", "none!", "`T-01",
                      "T-01 T-02", "after T-01", "T-01; T-02"):
            with self.subTest(value=value):
                self.assert_error(plan(task("T-01") + task("T-02", value)),
                                  "invalid-dependency")

    def test_unknown_self_and_cyclic_dependencies_still_fail(self):
        self.assert_error(plan(task("T-01", "T-99")), "unknown-dependency")
        self.assert_error(plan(task("T-01", "T-01")), "self-dependency")
        self.assert_error(plan(task("T-01", "T-02") + task("T-02", "T-01")),
                          "dependency-cycle")

    def test_required_structure_still_fails(self):
        self.assert_error(plan().replace("## Scope", "## Details"), "missing-section")
        self.assert_error(plan().replace("- Outcome:", "- Notes:"), "missing-task-field")

    def test_literal_inline_syntax_and_autolinks_pass_strict(self):
        for value in ("Return Vec<String> and Promise<void>", "Return Map<K, V>",
                      "Use <https://example.com/spec> and <dev@example.com>",
                      "Show `<token>` and `TODO` as literal examples",
                      "Show ``a `nested` <token>``"):
            with self.subTest(value=value):
                status, report = self.validate(plan(task("T-01", outcome=value)), strict=True)
                self.assertEqual(status, 0, report)
                self.assertEqual(report["findings"], [])

    def test_fenced_examples_do_not_create_findings_or_tasks(self):
        for fence in ("```", "~~~", "````"):
            with self.subTest(fence=fence):
                extra = f"\n{fence}text\n### T-99 — Example\n- Outcome: TODO\nVec<String>\n<token>\n{fence}\n"
                status, report = self.validate(plan(extra=extra), strict=True)
                self.assertEqual(status, 0, report)
                self.assertEqual(report["dependencies"], {"T-01": []})

    def test_only_matching_fence_closes_example_and_scanning_resumes(self):
        extra = "\n````text\n```\nTODO in literal code\n~~~\n````\nTODO resolve owner\n"
        status, report = self.validate(plan(extra=extra), strict=True)
        self.assertEqual(status, 2, report)
        self.assertEqual(len(report["findings"]), 1)
        self.assertEqual(report["findings"][0]["line"], len(plan(extra=extra).splitlines()))

    def test_real_placeholders_warn_and_fail_strict(self):
        for value in ("TBD", "TODO", "FIXME", "TK", "??", "<owner>",
                      "<observable result this task delivers>"):
            with self.subTest(value=value):
                content = plan(task("T-01", outcome=value))
                status, report = self.validate(content)
                self.assertEqual(status, 0, report)
                self.assertGreater(report["summary"]["warnings"], 0)
                status, report = self.validate(content, strict=True)
                self.assertEqual(status, 2, report)
                self.assertTrue(report["valid"])

    def test_documented_command_from_another_project(self):
        installed = self.project / "installed skill"
        shutil.copytree(SKILL, installed)
        path = self.project / "path/to/plan.md"
        path.parent.mkdir(parents=True)
        path.write_text(plan())
        text = (installed / "SKILL.md").read_text()
        command = re.search(r"```bash\n(python3 .*?)\n```", text).group(1)
        result = subprocess.run(["bash", "-c", command], cwd=self.project,
                                env={**os.environ, "skill_dir": str(installed)},
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("VALID:", result.stdout)


if __name__ == "__main__":
    unittest.main()
