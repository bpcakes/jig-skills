# jig-skills

Jig Skills are standalone agent skills for Codex and Claude. Jig integration is optional.

This repository keeps portable skills under `skills/`. Each skill uses a `SKILL.md`
entrypoint with YAML frontmatter and Markdown instructions, which keeps the source
usable in both Codex and Claude skill directories.

## Skills

Rust:

- `rust-architecture-review`: reviews module, crate, workspace, public API, trait hierarchy, data-flow, and structural error architecture concerns in modified Rust code.
- `rust-test-quality-review`: reviews whether tests prove changed Rust behavior, including a changed-units map, assertion quality, edge cases, regression coverage, and property-test opportunities.
- `rust-error-handling-review`: audits changed Rust error paths for swallowed errors, missing context, panic paths, error type design, resilience, async task failures, and `#[must_use]` gaps.
- `rust-simplify`: refines recently modified Rust code for clarity and idiomatic structure while preserving exact behavior.
- `rust-source-reorg`: reorganizes Rust files without behavior changes using canonical item ordering, precise `use` grouping/merging, attribute ordering, and the detailed rules in `skills/rust-source-reorg/references/rust-source-reorg-rules.md`.

Swift:

- `swift-simplify`: refines recently modified Swift 6 iOS code for clarity, consistency, SwiftUI/UIKit correctness, and concurrency safety while preserving exact behavior.

TypeScript:

- `typescript-simplify`: refines recently modified TypeScript or React code for clarity and project-standard style while preserving behavior.
- `typescript-type-system-review`: reviews TypeScript type-system quality. If TypeScript code is pasted directly, it reviews only that code; otherwise it uses the normal scoped-change workflow.

Generic:

- `write-exec-plan`: writes a self-contained ExecPlan that follows PLANS.md-style requirements, including living-document sections, observable acceptance, validation, idempotence, and durable-state lifecycle coverage.
- `improve-exec-plan`: improves an existing ExecPlan without changing its intent. It requires either a named plan file or a recent ExecPlan in chat, verifies plan claims against repository evidence, and rewrites file targets in place.

## Scope

Most Rust, Swift, and TypeScript skills accept a review or edit scope:

- `current working changes`: default. Inspect unstaged and staged changes.
- `feature branch`: compare the current branch to the merge base with the default branch.
- `base ref`: compare a named base ref, tag, or commit to `HEAD`.

If the user names files or directories, treat those as an additional scope constraint.

Some skills add target-specific behavior:

- `swift-simplify` focuses on uncommitted Swift code and directly related tests or support files.
- `typescript-type-system-review` reviews pasted TypeScript code when code is supplied directly in the prompt.
- `improve-exec-plan` requires a concrete ExecPlan target: either a file path or a recent ExecPlan from the chat.
- `write-exec-plan` should read repository planning guidance such as `.agent/PLANS.md` when available and produce a fully self-contained plan.

## Install

Install all skills into Codex:

```sh
scripts/install.sh codex
```

Install all skills into Claude:

```sh
scripts/install.sh claude
```

Install one skill, replacing an existing copy:

```sh
scripts/install.sh codex --force rust-simplify
scripts/install.sh claude --force rust-simplify
```

Default destinations:

- Codex: `${CODEX_HOME:-$HOME/.codex}/skills`
- Claude: `${CLAUDE_HOME:-$HOME/.claude}/skills`
