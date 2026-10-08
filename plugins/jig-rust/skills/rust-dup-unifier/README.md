# Rust Dup Unifier

`rust-dup-unifier` scans a Rust repository for abstractions that are structurally or behaviorally similar but have drifted apart. It combines a lightweight offline candidate scanner with an agent workflow that validates semantics before recommending consolidation.

## Installation

This skill is bundled with the `jig-rust` plugin in `jig-skills`. Install the plugin using the [repository instructions](../../../../README.md#install-with-codex), then invoke `$jig-rust:rust-dup-unifier`.

Run the scanner and test commands below from this skill directory.

## Package

- `SKILL.md` — trigger, workflow, evidence standard, and implementation rules.
- `scripts/scan_rust_dup_unifier.py` — dependency-free Rust-aware candidate generator.
- `scanner/` — Rust candidate generator using rust-analyzer syntax trees, with its own tests and dependency lockfile.
- `references/rust-semantic-checklist.md` — Rust-specific unification blockers and false positives.
- `references/report-contract.md` — final report shape.
- `references/unification-patterns.md` — Rust consolidation patterns and anti-patterns.
- `tests/` — scanner regression tests and a small Rust fixture.

## Scanner usage

```bash
python3 scripts/scan_rust_dup_unifier.py /path/to/rust/repo
```

JSON output for agent consumption:

```bash
python3 scripts/scan_rust_dup_unifier.py /path/to/rust/repo \
  --format json \
  --output /tmp/rust-dup-unifier.json
```

Useful options:

```text
--scope PATH           Restrict to a repository-relative file or directory; repeatable
--min-score FLOAT      Candidate threshold, default 0.68
--max-candidates N     Cap emitted candidates, default 100
--include-tests        Include tests, examples, and benches
--include-generated    Include generated-looking files
--include-exact        Include mechanically exact duplicate shapes/bodies
--exclude GLOB         Add a repository-relative exclusion glob; repeatable
```

The scanner deliberately favors recall over proof. It is a lightweight lexical extractor, not a Rust compiler: it does not expand macros or resolve types. Its output must be validated using the workflow in `SKILL.md` before a unification recommendation is made.

## Rust scanner

The Rust scanner is an alternative to the Python entrypoint. It parses syntax trees and reports unresolved modules, implementations, and macros as coverage gaps; it does not expand macros or resolve types. Its JSON schema is version 3, while Python emits version 2. Both use declaration IDs in candidate edges, but scores, IDs, and detailed shapes are not interchangeable between implementations.

Build with Rust 1.95 or newer. Dependency setup requires network access and should be performed explicitly before an offline analysis:

```bash
cargo fetch --locked --manifest-path scanner/Cargo.toml
cargo build --frozen --release --manifest-path scanner/Cargo.toml
```

Keep `scanner/Cargo.lock`: it pins a compatible parser release and matching Unicode tables required by the lexer. Unrestricted dependency updates can break that compatibility.

Once built, the executable scans without Cargo, network access, or building the target project:

```bash
scanner/target/release/rust-dup-unifier /path/to/rust/repo \
  --scope src --format json --output /tmp/rust-dup-unifier.json
```

Use `--details` for complete declaration shapes and `--exclude-exact` to omit exact mechanical matches. Both scanners include exact matches by default and cap candidates at 100 per stream (types and callables). Similarity still requires the semantic validation in `SKILL.md`.

## Test

```bash
python3 -m unittest discover -s tests -v
cargo test --frozen --manifest-path scanner/Cargo.toml
cargo fmt --manifest-path scanner/Cargo.toml --check
```
