from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
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
            frozenset((report["declarations"][candidate["left"]]["name"], report["declarations"][candidate["right"]]["name"]))
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
            frozenset((report["declarations"][candidate["left"]]["name"], report["declarations"][candidate["right"]]["name"]))
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
        _, stats, _ = MODULE.generate_candidates(group, 0.68, 100, True)
        self.assertEqual(stats["blocked_groups"], 1)
        self.assertGreater(stats["pairs_not_selected"], 0)
        self.assertEqual(stats["potential_pairs"], stats["pairs_not_selected"] + stats["pairs_considered"] + stats["pairs_prefiltered"])

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


class RegressionTests(unittest.TestCase):
    def items(self, source):
        return MODULE.build_abstractions(MODULE.parse_raw_items(source, "src/lib.rs"))

    def scan(self, files, **settings):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, source in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(source)
            return MODULE.scan_repository(root, **({
                "scopes": [], "min_score": 0.68, "max_candidates": 100,
                "include_tests": False, "include_generated": False,
                "include_exact": True, "excludes": [],
            } | settings))

    def test_field_contracts_prevent_exact_match(self):
        items = self.items('''
#[derive(Clone)]
struct Remote {
    #[serde(rename = "wire")]
    pub value: u64,
    enabled: bool,
}
#[derive(Clone)]
struct Local { value: u64, enabled: bool }
''')
        candidate = MODULE.compare_pair(*items)
        self.assertFalse(candidate.exact)
        self.assertIn("Member visibility/attributes", " ".join(candidate.divergences))
        self.assertEqual(items[0].metadata["member_contracts"]["value"]["visibility"], "pub")
        self.assertIn('"wire"', str(items[0].metadata))

    def test_trait_supertraits_prevent_exact_match(self):
        items = self.items("""
trait Store: Send + Sync + 'static { fn get(&self); fn put(&self); }
trait LocalStore { fn get(&self); fn put(&self); }
""")
        traits = [item for item in items if item.kind == "trait"]
        candidate = MODULE.compare_pair(*traits)
        self.assertFalse(candidate.exact)
        self.assertIn("Trait bounds/header", " ".join(candidate.divergences))

    def test_function_method_comparison(self):
        items = self.items("""
fn normalize(value: &str) -> String { value.trim().to_lowercase().replace("-", "_") }
struct Client;
impl Client { fn normalize(value: &str) -> String { value.trim().to_lowercase().replace("-", "_") } }
""")
        candidates, stats, _ = MODULE.generate_candidates(items, 0.68, 100, True)
        self.assertEqual(stats["pairs_considered"], 1)
        self.assertEqual(len(candidates), 1)
        self.assertEqual({candidates[0].left.kind, candidates[0].right.kind}, {"function", "method"})

    def test_cross_file_methods_attach_within_crate(self):
        report = self.scan({
            "Cargo.toml": '[package]\nname="sample"\nversion="0.1.0"\n',
            "src/lib.rs": "struct A { x: u8, y: u8 }\nstruct B { x: u8, y: u8 }",
            "src/impls.rs": "impl A { fn run(&self) {} }\nimpl B { fn run(&self) {} }",
            "other/Cargo.toml": '[package]\nname="other"\nversion="0.1.0"\n',
            "other/src/lib.rs": "struct A { x: u8, y: u8 }",
        }, details=True)
        structs = {item["file"] + item["name"]: item for item in report["declarations"].values() if item["kind"] == "struct"}
        self.assertEqual(set(structs["src/lib.rsA"]["methods"]), {"run"})
        self.assertEqual(structs["other/src/lib.rsA"]["methods"], {})

    def test_generic_fn_bounds_are_not_tuple_fields(self):
        items = self.items("""
struct Handler<F> where F: Fn(Request) -> Response { callback: F, retries: u8 }
struct Other<F: Fn(Request) -> Response>(F, std::time::Duration);
""")
        self.assertEqual(items[0].members, {"callback": "F", "retries": "u8"})
        self.assertEqual(items[1].members, {"0": "F", "1": "std::time::Duration"})

    def test_enum_shift_discriminants_and_variant_attributes(self):
        items = self.items('''
enum Flags { A = 1 << 0, B = 1 << 1, C = 1 >> 2 }
enum Wire { #[serde(rename = "a,b") ] A, B(u8, String), C { x: u8, y: Vec<u8> } }
''')
        self.assertEqual(set(items[0].members), {"A", "B", "C"})
        self.assertEqual(items[0].members["B"], "discriminant=1<<1")
        self.assertEqual(set(items[1].members), {"A", "B", "C"})
        self.assertIn('"a,b"', str(items[1].metadata))

    def test_nested_generic_fields_preserve_complete_types(self):
        cases = [
            ("Result<(Vec<u8>, usize), String>", "Result<(Vec<u8>,usize),String>"),
            ("Result<[Vec<u8>; 2], String>", "Result<[Vec<u8>;2],String>"),
            ("Result<[u8; (8 >> 1)], String>", "Result<[u8;(8>>1)],String>"),
            ("Result<Array<{ 8 >> 1 }>, String>", "Result<Array<{8>>1}>,String>"),
        ]
        for field_type, expected in cases:
            with self.subTest(field_type=field_type):
                item, = self.items(f"struct Shape {{ value: {field_type}, active: bool }}")
                self.assertEqual(item.members, {"value": expected, "active": "bool"})
                self.assertEqual(set(item.metadata["member_contracts"]), {"value", "active"})

    def test_enum_generic_discriminants_preserve_variants(self):
        for expression, expected in [
            ("value::<u8, u16>()", "value::<u8,u16>()"),
            ("value :: <Result<Vec<u8>, String>, u16>()", "value::<Result<Vec<u8>,String>,u16>()"),
            ("value::<Result<(Vec<u8>, usize), String>, u16>() << 1",
             "value::<Result<(Vec<u8>,usize),String>,u16>()<<1"),
            ("value::<Array<{ 8 >> 1 }>, u16>() >> 1", "value::<Array<{8>>1}>,u16>()>>1"),
        ]:
            with self.subTest(expression=expression):
                item, = self.items(f"enum Flags {{ A = {expression}, B = 1 << 1, C = 1 >> 2 }}")
                self.assertEqual(set(item.members), {"A", "B", "C"})
                self.assertEqual(set(item.metadata["member_contracts"]), {"A", "B", "C"})
                self.assertEqual(item.members["A"], "discriminant=" + expected)
                self.assertEqual(item.members["B"], "discriminant=1<<1")
                self.assertEqual(item.members["C"], "discriminant=1>>2")

    def test_nested_generic_callable_parameters_preserve_complete_types(self):
        item, = self.items("fn consume(value: Result<(Vec<u8>, usize), String>, active: bool) {}")
        self.assertEqual(item.signature, "fn $name(_:Result<(Vec<u8>,usize),String>,_:bool)")

    def test_nested_generic_enum_payloads_preserve_complete_types(self):
        item, = self.items("""
enum Message {
    Tuple(Result<(Vec<u8>, usize), String>, bool),
    Record { value: Result<(Vec<u8>, usize), String>, active: bool },
    Empty,
}
""")
        self.assertEqual(item.members, {
            "Tuple": "tuple(Result<(Vec<u8>,usize),String>,bool)",
            "Record": "struct{active:bool,value:Result<(Vec<u8>,usize),String>}",
            "Empty": "unit",
        })

    def test_attributes_across_comments_and_multiline(self):
        items = self.items("""
#[derive(
    Clone,
    Debug,
)]
/// A doc comment.
// Another comment.
#[cfg(feature = "one")]
struct A { x: u8, y: u8 }
""")
        self.assertEqual(len(items[0].attributes), 2)
        self.assertTrue(any("Clone" in attr and "Debug" in attr for attr in items[0].attributes))
        self.assertTrue(any('"one"' in attr for attr in items[0].attributes))

    def test_lifetimes_are_not_char_literals(self):
        source = "struct Borrowed<'a, 'b> { a: &'a str, b: &'b str }"
        self.assertEqual(MODULE.sanitize_rust(source), source)
        self.assertNotIn("'x'", MODULE.sanitize_rust("let x = 'x';"))
        self.assertEqual(self.items(source)[0].members, {"a": "&'L str", "b": "&'L str"})

    def test_signature_impl_is_not_an_item(self):
        items = MODULE.parse_raw_items("""
fn make() ->
    impl Iterator<Item = u8>
{ (0..10).map(|x| x + 1) }
struct Real { x: u8, y: u8 }
""", "src/lib.rs")
        self.assertEqual([item.kind for item in items], ["fn", "struct"])

    def test_macro_token_trees_are_not_items(self):
        source = """
macro_rules! make {
    ($name:ident) => {
        struct $name { x: u8, y: u8 }
        impl $name { fn id(&self) -> u8 { self.x } }
    }
}
make! { struct Fake { a: u8, b: u8 } }
struct Real { x: u8, y: u8 }
"""
        self.assertEqual([item.name for item in self.items(source)], ["Real"])

    def test_test_modules_and_functions_are_excluded(self):
        files = {"src/lib.rs": """
struct Real { x: u8, y: u8 }
#[cfg(test)]
mod tests {
    struct TestOnly { x: u8, y: u8 }
    mod nested { struct Nested { x: u8, y: u8 } }
}
#[test]
fn direct_test() { assert_eq!(1 + 1, 2); }
#[cfg(any(test, feature = "prod"))]
struct Production { x: u8, y: u8 }
#[cfg(all(test, feature = "prod"))]
struct TestFeature { x: u8, y: u8 }
mod production { fn real() { println!("hello"); } }
"""}
        report = self.scan(files)
        names = {item["name"] for item in report["declarations"].values()}
        self.assertEqual(names, {"Real", "Production"})
        self.assertEqual(report["inventory"]["by_kind"]["function"], 1)
        self.assertEqual(len(report["coverage"]["skipped_items"]), 3)
        self.assertEqual(report["coverage"]["skipped_item_count"], 6)
        included = self.scan(files, include_tests=True)
        self.assertGreater(included["inventory"]["abstraction_count"], report["inventory"]["abstraction_count"])

    def test_generated_detection_and_directory_filtering(self):
        shape = "struct A { x: u8, y: u8 }"
        report = self.scan({
            "src/keybindings.rs": shape,
            "src/doc.rs": '/// Values generated by the server.\n' + shape,
            "src/comment.rs": '// This value is generated by the server.\n' + shape,
            "src/build/mod.rs": shape, "src/out/mod.rs": shape, "src/bench/mod.rs": shape,
            "src/marked.rs": '// Generated by bindgen.\n' + shape,
            "src/bindings.rs": shape, "target/out.rs": shape, "tests/test.rs": shape,
        })
        self.assertEqual(report["coverage"]["rust_file_count"], 6)
        skipped = report["coverage"]["skipped_paths"]
        self.assertEqual(skipped["generated"], ["src/bindings.rs", "src/marked.rs"])
        self.assertIn("target", skipped["excluded_directory"])
        self.assertIn("tests", skipped["test_or_example_directory"])

    def test_leading_generated_banners_and_doc_comments(self):
        shape = "struct A { x: u8, y: u8 }"
        for banner in [
            "// This file is @generated by prost-build.\n",
            "/* automatically generated by rust-bindgen */\n",
            "/*\n * This file was automatically generated.\n */\n",
            "/* license /* nested comment */ */\n// @generated by tool\n",
        ]:
            with self.subTest(banner=banner):
                files = {"src/api.rs": banner + shape, "src/manual.rs": shape}
                report = self.scan(files)
                self.assertEqual(report["coverage"]["rust_file_count"], 1)
                self.assertEqual(report["coverage"]["skipped_paths"]["generated"], ["src/api.rs"])
                included = self.scan(files, include_generated=True)
                self.assertEqual(included["coverage"]["rust_file_count"], 2)
        for banner in [
            "/// generated by the server\n", "//! @generated by the server\n",
            "/** generated by the server */\n", "/*! @generated by the server */\n",
            'const HELP: &str = "generated by tool";\n',
            "struct Manual;\n// @generated by tool\n",
        ]:
            with self.subTest(banner=banner):
                report = self.scan({"src/api.rs": banner + shape})
                self.assertEqual(report["coverage"]["rust_file_count"], 1)

    def test_macro_calls_remain_in_callable_similarity(self):
        items = self.items('fn first() { println!("hello"); }\nfn second() { panic!("hello"); }')
        self.assertIn("println!", items[0].calls)
        self.assertIn("panic!", items[1].calls)
        self.assertNotEqual(items[0].body_tokens, items[1].body_tokens)

    def test_same_line_declarations_have_distinct_ids(self):
        items = self.items("mod a { struct X { x: u8, y: u8 } } mod b { struct X { x: u8, y: u8 } }")
        self.assertEqual(len(items), 2)
        self.assertNotEqual(items[0].stable_id, items[1].stable_id)

    def test_attribute_literals_are_preserved(self):
        items = self.items('''
struct A { #[serde(rename = "a, b]")] x: u8, y: u8 }
struct B { #[serde(rename = "a,b]")] x: u8, y: u8 }
''')
        self.assertEqual(items[0].members, {"x": "u8", "y": "u8"})
        self.assertFalse(MODULE.compare_pair(*items).exact)

    def test_newtypes_are_negative_control(self):
        items = self.items("struct UserId(u64);\nstruct OrderId(u64);")
        self.assertIsNone(MODULE.compare_pair(*items))
        candidates, _, _ = MODULE.generate_candidates(items, 0.68, 100, True)
        self.assertEqual(candidates, [])

    def test_tuple_positions_are_not_names(self):
        items = self.items("struct Point(f64, f64);\nstruct Size(f64, f64);")
        candidate = MODULE.compare_pair(*items)
        self.assertEqual(candidate.signals["member_name_overlap"], 0)

    def test_stream_budgets_clusters_ids_and_markdown(self):
        report = self.scan({"src/lib.rs": """
struct A { x: u8, y: u8 }
struct B { x: u8, y: u8 }
struct C { x: u8, y: u8 }
fn first(v: &str) -> String { v.trim().to_lowercase().replace("-", "_") }
fn second(v: &str) -> String { v.trim().to_lowercase().replace("-", "_") }
fn third(v: &str) -> String { v.trim().to_lowercase().replace("-", "_") }
"""}, max_candidates=1)
        self.assertEqual(report["candidate_stats"]["truncated"], 4)
        self.assertEqual({item["stream"] for item in report["candidates"]}, {"types", "callables"})
        self.assertEqual(len(report["clusters"]), 2)
        self.assertTrue(all(len(group["members"]) == 3 for group in report["clusters"]))
        self.assertTrue(all(group["omitted_pairs"] == 2 for group in report["clusters"]))
        self.assertTrue(all(candidate["id"] for candidate in report["candidates"]))
        markdown = MODULE.render_markdown(report)
        self.assertIn("Output truncation: 4", markdown)
        self.assertIn("src/lib.rs:", markdown)
        self.assertIn("sampled groups: 0", markdown)
        self.assertNotIn("members", next(iter(report["declarations"].values())))

    def test_cli_defaults_scope_hint_and_attribute_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "tests").mkdir()
            source = "struct A { x: u8, y: u8 }\nstruct B { x: u8, y: u8 }"
            (root / "tests/test.rs").write_text(source)
            # A pathological regex would time out even before parsing an item.
            (root / "lib.rs").write_text("#[a] " * 32 + "use std::fmt;\n" + source)
            def cli(*args):
                return subprocess.run([sys.executable, str(SCRIPT), directory, *args], capture_output=True, text=True, timeout=3)
            result = cli("--format", "json")
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertTrue(report["candidates"][0]["exact"])
            self.assertEqual(json.loads(cli("--exclude-exact", "--format", "json").stdout)["candidates"], [])
            excluded = cli("--scope", "tests")
            self.assertEqual(excluded.returncode, 2)
            self.assertIn("--include-tests", excluded.stderr)
            self.assertEqual(cli("--scope", "tests", "--include-tests").returncode, 0)
            self.assertEqual(cli("--min-score", "2").returncode, 2)
            self.assertEqual(cli("--max-candidates", "0").returncode, 2)


if __name__ == "__main__":
    unittest.main()
