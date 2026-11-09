"""The live acceptance oracle must reject the observed iterable regression."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("workflow_contract", Path(__file__).resolve().parents[1] / "benchmarks/live_workflow.py")
workflow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workflow)


class WorkflowContractTests(unittest.TestCase):
    def test_source_and_required_validation_cover_single_use_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "consumer.py").write_text("from api import summarize\ndef render(values):\n    result = summarize(values)\n    return f\"{result['count']} items: {result['amount_minor']} cents\"\n")
            for source, succeeds in (
                ("def summarize(values):\n    return {'count': len(values), 'amount_minor': sum(values)}\n", False),
                ("def summarize(values):\n    count = total = 0\n    for value in values:\n        count += 1\n        total += value\n    return {'count': count, 'amount_minor': total}\n", True),
            ):
                (root / "api.py").write_text(source)
                for task in ("A", "B"):
                    result = subprocess.run([sys.executable, "-B", "-c", workflow.source_check(task)], cwd=root, capture_output=True)
                    self.assertEqual(result.returncode == 0, succeeds, result.stderr)


if __name__ == "__main__":
    unittest.main()
