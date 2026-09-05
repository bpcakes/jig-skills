# Rust Dup Unifier

`rust-dup-unifier` scans a Rust repository for abstractions that are structurally or behaviorally similar but have drifted apart. It combines a lightweight offline candidate scanner with an agent workflow that validates semantics before recommending consolidation.

## Installation

This skill is bundled with the `jig-rust` plugin in `jig-skills`. Install the plugin using the [repository instructions](../../../../README.md#install-with-codex), then invoke `$jig-rust:rust-dup-unifier`.

Run the scanner and test commands below from this skill directory.

## Package

- `SKILL.md` — trigger, workflow, evidence standard, and implementation rules.
- `scripts/scan_rust_dup_unifier.py` — dependency-free Rust-aware candidate generator.
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

## Test

```bash
python3 -m unittest discover -s tests -v
```
