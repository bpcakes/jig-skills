# Rust Abstraction Police

A reusable agent skill for finding leaky abstractions in Rust codebases.

The skill distinguishes real boundary failures from ordinary concrete Rust APIs. It requires proof of the intended boundary, the implementation detail that escapes, the caller or compatibility consequence, and the absence of an explicit contract that makes the exposure deliberate.

## Contents

- `SKILL.md` — entrypoint, review workflow, severity model, false-positive controls, and output contract.
- `references/leak-taxonomy.md` — Rust-specific leak categories and proof questions.
- `references/remediation-playbook.md` — repair patterns with Rust trade-offs.
- `references/report-template.md` — finding and coverage formats.
- `scripts/collect_candidates.py` — dependency-free, source-only heuristic candidate collector.
- `tests/` — smoke tests for the candidate collector.
- `evals/cases.md` — positive and negative reasoning cases for evaluating the skill.

## Installation

This skill is bundled with the `jig-rust` plugin in `jig-skills`. Install the plugin using the [repository instructions](../../../../README.md#install-with-codex), then invoke `$jig-rust:rust-abstraction-police`.

The collector commands below run from this skill directory. Preserve its directory structure so `SKILL.md` can load the references and helper script.

## Typical prompts

```text
Abstraction-police this Rust workspace. Focus on the domain/application boundary.
```

```text
Review this Rust PR for new leaky abstractions. Report only evidence-backed findings.
```

```text
Check whether our public API leaks Tokio, SQLx, Serde schema, lock guards, lifetimes, or raw handles.
```

## Candidate collector

The helper requires Python 3.11 or newer for the standard-library `tomllib` module. It performs no compilation and installs nothing:

```bash
python3 scripts/collect_candidates.py /path/to/rust/repo --format markdown
```

JSON output is available for automation:

```bash
python3 scripts/collect_candidates.py /path/to/rust/repo --format json > candidates.json
```

Useful options:

```text
--allow-crate CRATE          Ignore an intentionally public dependency path.
--exclude-dir NAME           Skip an additional directory name.
--no-consumer-signals        Omit inner/raw/downcast call-site signals.
--max-candidates N           Cap deterministic output.
```

The collector reports syntactic leads, not findings. The skill must still resolve effective Rust visibility, architectural intent, consumer impact, and counterevidence.

## Design constraints

- No automatic demand for traits, dynamic dispatch, or indirection.
- No finding based only on a public concrete type.
- Public and internal layer boundaries are both supported.
- Rust-specific commitments such as auto traits, lifetimes, macro expansion, trait coherence, layout, feature shape, guards, and unsafe obligations are included.
- Repairs must name their allocation, dispatch, ownership, lifetime, performance, semver, and migration trade-offs.
