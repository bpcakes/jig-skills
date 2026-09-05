# Contributing

[Back to the README](README.md)

Keep each skill focused on a concrete task, with clear inputs, default behavior, evidence requirements, and expected output. Describe whether it reports findings, writes a plan, or changes code.

## Repository Layout

- `.agents/plugins/marketplace.json` registers plugins and their installation policies.
- `plugins/<plugin>/.codex-plugin/plugin.json` declares plugin metadata and version.
- `plugins/<plugin>/skills/<skill>/SKILL.md` is the skill entrypoint. Supporting references, scanners, examples, and tests stay with the skill.
- `scripts/install.sh` copies complete skill directories into Codex or Claude Code; it excludes `comprehensive-review` from Claude installs.
- `docs/` contains user guidance that is too detailed for the root README.

## Changing Skills and Documentation

When adding or renaming a skill, update its frontmatter, supporting references, plugin metadata where relevant, and the linked README catalog. Register new plugins in the marketplace. Bump the affected plugin version when releasing changes to its bundled contents.

Use paths relative to the skill directory for bundled resources. For scanner examples, distinguish the scanner's location from the target project being scanned. Keep a skill's directory intact when testing direct installation.

For documentation changes, verify local links and heading anchors, check commands against the actual CLI or script, and keep installation and update instructions consistent with the installer. Do not describe a candidate scanner's output as validated findings.

## Relevant Checks

Run commands from the repository root. Select the checks for the helper you changed; documentation-only edits need link, command, and diff checks rather than the entire runtime suite.

| Changed helper | Command |
|---|---|
| Comprehensive-review adapters | `node --test plugins/jig-review/tests/*.test.mjs` |
| Privacy-audit scripts | `bash plugins/jig-privacy-audit/scripts/test_fixtures.sh` |
| Rust abstraction-police collector | `python3 -m unittest discover -s plugins/jig-rust/skills/rust-abstraction-police/tests -v` |
| Rust duplication scanner | `python3 -m unittest discover -s plugins/jig-rust/skills/rust-dup-unifier/tests -v` |
| Fowler Rust scanner | `python3 plugins/jig-rust/skills/fowler-rust-refactoring/scripts/test_scan_refactoring_opportunities.py` |
| Fowler Ruby/Rails scanner | `ruby plugins/jig-ruby/skills/fowler-ruby-rails-refactoring/test/scanner_smoke_test.rb` |
| TypeScript/React abstraction scanner | `node --test plugins/jig-typescript/skills/typescript-react-abstraction-police/tests/scan.test.mjs` |
| TypeScript/React duplication scanner | `node plugins/jig-typescript/skills/typescript-react-dup-unifier/scripts/test-typescript-react-dup-unifier.mjs` |

Use the [feature-specific runtimes](README.md#requirements). The Ruby smoke test needs Minitest; the TypeScript AST scanner tests need an existing TypeScript installation. The [review CI workflow](.github/workflows/jig-review-tests.yml) runs the review suite on Node 22 and 24. That workflow does not cover every plugin's helpers.

The ordinary review suite skips authenticated CLI checks. To verify real Claude and Cursor evidence access, explicitly opt in:

```sh
JIG_REVIEW_LIVE=claude,cursor node --test plugins/jig-review/tests/review-evidence-live.test.mjs
```

These checks require authenticated CLIs and consume provider usage. Select only the providers you intend to test. See the [runtime reference](plugins/jig-review/skills/comprehensive-review/references/parallel-review-runtime.md) for what they verify.

Before submitting a change, run:

```sh
git diff --check
```

Describe the resulting behavior and the validation performed in the pull request. For an issue report, include the skill name, installation method, agent and runtime versions, scope, and a reproducible example with secrets removed.
