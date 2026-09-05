# Fowler Ruby/Rails Refactoring Skill

A reusable agent skill for finding and validating refactoring opportunities in Ruby and Ruby on Rails repositories, then producing a safe Fowler-style sequence of behavior-preserving transformations.

## Contents

- `SKILL.md` — the agent workflow and output contract.
- `references/fowler-principles.md` — distilled principles and primary sources.
- `references/ruby-rails-playbook.md` — modern Ruby/Rails mappings and examples.
- `references/smell-to-refactoring-map.md` — detection indicators, counterchecks, and likely moves.
- `scripts/scan_refactoring_opportunities.rb` — dependency-free heuristic scanner.
- `test/scanner_smoke_test.rb` — scanner smoke test.
- `examples/example-assessment.md` — example report.

## Using the Skill

This skill is bundled with the `jig-ruby` plugin in `jig-skills`. Install the plugin using the [repository instructions](../../../../README.md#install-with-codex), then invoke `$jig-ruby:fowler-ruby-rails-refactoring`.

Keep the directory intact so `SKILL.md` can load its relative `references/`, `scripts/`, and `examples/` files. Run the scanner and test commands below from this skill directory.

A typical invocation is:

```text
Review app/models and app/controllers for refactoring opportunities. Use the Fowler Ruby/Rails refactoring skill. Do not edit code; return a ranked plan with behavioral boundaries and verification steps.
```

The skill defaults to read-only assessment. It switches to implementation only when explicitly asked.

## Scanner

Run against a repository:

```bash
ruby scripts/scan_refactoring_opportunities.rb /path/to/repository --format markdown
```

JSON output:

```bash
ruby scripts/scan_refactoring_opportunities.rb /path/to/repository --format json
```

Useful options:

```text
--include-tests
--include-views
--include-migrations
--method-lines N
--class-lines N
--max-parameters N
--max-nesting N
--max-findings N
--exclude DIR
```

The scanner intentionally reports candidates rather than fixes. It cannot prove a smell, infer all dynamic Ruby callers, or determine behavior and change pressure without repository inspection.

## Smoke Test

```bash
ruby test/scanner_smoke_test.rb
```

## Operating Boundary

The skill separates refactoring from bug fixes, optimization, database migration, framework upgrades, security hardening, and public redesign. Those activities can be planned alongside preparatory refactoring but should not be mislabeled or mixed into one unsafe patch.
