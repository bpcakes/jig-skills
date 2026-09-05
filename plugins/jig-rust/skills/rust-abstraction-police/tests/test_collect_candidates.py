from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "collect_candidates.py"
FIXTURES = Path(__file__).resolve().parent / "fixtures"


class CandidateCollectorTests(unittest.TestCase):
    def scan(self, fixture: str) -> dict:
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                str(FIXTURES / fixture),
                "--format",
                "json",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(result.stdout)

    def test_detects_high_signal_leaky_fixture(self) -> None:
        payload = self.scan("leaky")
        rules = {item["rule"] for item in payload["candidates"]}
        expected = {
            "APC001",  # public fields
            "APC002",  # concrete type alias
            "APC003",  # dependency paths
            "APC005",  # into_inner
            "APC006",  # serde layout
            "APC007",  # repr
            "APC008",  # cfg-shaped API
            "APC009",  # unsafe public function
            "APC010",  # generic spread
            "APC011",  # doc(hidden) pub
            "APC012",  # exported macro
            "APC013",  # raw resource
            "APC014",  # foreign error
            "APC016",  # consumer reach-through/downcast
            "APC017",  # Deref
        }
        self.assertTrue(expected.issubset(rules), expected - rules)

    def test_clean_fixture_avoids_strong_leak_signals(self) -> None:
        payload = self.scan("clean")
        rules = {item["rule"] for item in payload["candidates"]}
        self.assertFalse(
            {"APC001", "APC003", "APC005", "APC006", "APC007", "APC009", "APC013", "APC014", "APC017"}
            & rules
        )


if __name__ == "__main__":
    unittest.main()
