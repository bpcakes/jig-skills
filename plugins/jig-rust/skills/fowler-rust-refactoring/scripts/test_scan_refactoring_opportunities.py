#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("scan_refactoring_opportunities.py")
SPEC = importlib.util.spec_from_file_location("scanner", SCRIPT)
assert SPEC and SPEC.loader
scanner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = scanner
SPEC.loader.exec_module(scanner)


class ScannerUnitTests(unittest.TestCase):
    def test_mask_non_code_preserves_shape_and_ignores_nested_comments_and_raw_strings(self) -> None:
        source = '''fn demo() {
    let a = r###"{ not code }"###;
    /* outer { /* inner } */ still comment */
    let lifetime: &'static str = "}";
}
'''
        masked = scanner.mask_non_code(source)
        self.assertEqual(len(masked), len(source))
        self.assertEqual(masked.count("\n"), source.count("\n"))
        self.assertEqual(masked.count("{"), 1)
        self.assertEqual(masked.count("}"), 1)
        self.assertIn("'static", masked)

    def test_split_top_level_handles_nested_types(self) -> None:
        parts = scanner.split_top_level(
            "a: Vec<Result<u8, E>>, b: (u8, u8), c: impl Fn(u8, u8) -> bool"
        )
        self.assertEqual(len(parts), 3)

    def test_cli_reports_expected_candidates(self) -> None:
        code = '''
static mut GLOBAL: usize = 0;

pub struct Request {
    pub status: String,
    pub user_id: u64,
    pub a: Option<String>,
    pub b: Option<String>,
    pub c: Option<String>,
    pub d: Option<String>,
    pub e: Option<String>,
}

fn process(name: &String, enabled: bool, a: u8, b: u8, c: u8, d: u8) -> Result<(), ()> {
    let _x = name.clone();
    let _y = name.clone();
    let _z = name.clone();
    let _w = name.clone();
    Some(1).unwrap();
    Some(2).unwrap();
    Some(3).expect("present");
    if enabled {
        if a > 0 {
            if b > 0 {
                if c > 0 {
                    if d > 0 {
                        println!("nested");
                    }
                }
            }
        }
    }
    Ok(())
}

fn repeated_one() {
    let total = calculate_total();
    validate_total(total);
    persist_total(total);
    publish_total(total);
    audit_total(total);
    notify_total(total);
    finish_total(total);
}

fn repeated_two() {
    let total = calculate_total();
    validate_total(total);
    persist_total(total);
    publish_total(total);
    audit_total(total);
    notify_total(total);
    finish_total(total);
}
'''
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lib.rs"
            path.write_text(code, encoding="utf-8")
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    str(path),
                    "--format",
                    "json",
                    "--deep-nesting",
                    "4",
                ],
                check=True,
                stdout=subprocess.PIPE,
                text=True,
            )
        payload = json.loads(completed.stdout)
        smells = {finding["smell"] for finding in payload["findings"]}
        self.assertIn("Global Data / Mutable Data", smells)
        self.assertIn("Long Parameter List / Data Clumps", smells)
        self.assertIn("Flag Argument / Primitive Obsession", smells)
        self.assertIn("Over-specific API", smells)
        self.assertIn("Error Code / Primitive Obsession", smells)
        self.assertIn("Scattered Error Handling (Rust signal)", smells)
        self.assertIn("Mutable Data / Data Flow Friction (Rust signal)", smells)
        self.assertIn("Temporary Field / Invalid State candidate", smells)
        self.assertIn("Primitive Obsession candidate", smells)
        self.assertIn("Unencapsulated Record candidate", smells)
        self.assertIn("Duplicated Code", smells)

    def test_trait_declaration_is_not_parsed_as_function_body(self) -> None:
        source_text = "trait Example { fn required(&self, a: bool); }\n"
        source = scanner.SourceFile(
            path=Path("lib.rs"),
            display_path="lib.rs",
            text=source_text,
            code=scanner.mask_non_code(source_text),
            line_offsets=scanner.line_offsets(source_text),
        )
        self.assertEqual(scanner.parse_functions(source), [])


if __name__ == "__main__":
    unittest.main()
