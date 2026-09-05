from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "scripts" / "scan_rust_dup_unifier.py"
SPEC = importlib.util.spec_from_file_location("scan_rust_dup_unifier", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ScannerTests(unittest.TestCase):
    def test_sanitizer_preserves_offsets_and_masks_nested_content(self) -> None:
        source = '''
        pub fn real() {
            /* outer { /* nested } */ still comment } */
            let raw = r###"struct Fake { value: u8 }"###;
            let ch = '{';
        }
        '''
        sanitized = MODULE.sanitize_rust(source)
        self.assertEqual(len(source), len(sanitized))
        self.assertEqual(source.count("\n"), sanitized.count("\n"))
        self.assertNotIn("Fake", sanitized)
        self.assertNotIn("nested", sanitized)
        self.assertIn("pub fn real", sanitized)

    def test_scan_finds_divergent_structs_traits_and_functions(self) -> None:
        fixture = HERE / "fixture"
        report = MODULE.scan_repository(
            root=fixture,
            scopes=[],
            min_score=0.60,
            max_candidates=50,
            include_tests=False,
            include_generated=False,
            include_exact=False,
            excludes=[],
        )
        pairs = {
            frozenset((candidate["left"]["name"], candidate["right"]["name"]))
            for candidate in report["candidates"]
        }
        self.assertIn(frozenset(("HttpOptions", "RpcOptions")), pairs)
        self.assertIn(frozenset(("ReadStore", "FetchStore")), pairs)
        self.assertIn(frozenset(("HttpError", "RpcError")), pairs)
        self.assertIn(frozenset(("normalize_http", "normalize_rpc")), pairs)
        self.assertNotIn(frozenset(("ExactLeft", "ExactRight")), pairs)
        self.assertGreaterEqual(report["candidate_stats"]["exact_omitted"], 1)
        self.assertEqual(report["coverage"]["rust_file_count"], 1)
        self.assertEqual(report["coverage"]["parse_errors"], [])

    def test_include_exact_emits_exact_shape_pair(self) -> None:
        fixture = HERE / "fixture"
        report = MODULE.scan_repository(
            root=fixture,
            scopes=[],
            min_score=0.60,
            max_candidates=50,
            include_tests=False,
            include_generated=False,
            include_exact=True,
            excludes=[],
        )
        exact_pairs = {
            frozenset((candidate["left"]["name"], candidate["right"]["name"]))
            for candidate in report["candidates"]
            if candidate["exact"]
        }
        self.assertIn(frozenset(("ExactLeft", "ExactRight")), exact_pairs)

    def test_large_group_blocking_keeps_rare_shared_structure(self) -> None:
        group = []
        for index in range(720):
            tokens = ["let", "ID", "=", f"unique_{index}", "(", "ID", ")", ";", "ID"]
            calls = {f"unique_{index}"}
            if index in {0, 719}:
                tokens = ["match", "ID", "{", "TYPE", "::", "SharedRare", "=>", "ID", ".", "normalize", "(", ")", "}"]
                calls = {"normalize"}
            group.append(
                MODULE.Abstraction(
                    kind="function",
                    name=f"function_{index}",
                    file="src/generated_fixture.rs",
                    line=index + 1,
                    visibility="private",
                    attributes=[],
                    signature="fn $name(_: &str)->String",
                    body_tokens=tokens,
                    calls=calls,
                )
            )
        pairs = MODULE.blocked_pair_indices(group)
        self.assertIn((0, 719), pairs)

    def test_scope_escape_is_rejected(self) -> None:
        fixture = HERE / "fixture"
        with self.assertRaises(ValueError):
            MODULE.iter_rust_files(
                root=fixture,
                scopes=["../"],
                include_tests=False,
                include_generated=False,
                excludes=[],
            )


if __name__ == "__main__":
    unittest.main()
