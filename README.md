# jig-skills

Portable Codex skills for code review, refinement, and execution planning.

This repository is packaged as a Codex plugin marketplace. The marketplace contains
four plugins, grouped by workflow area:

- `jig-rust`
- `jig-swift`
- `jig-typescript`
- `jig-exec-plans`

Each plugin exposes one or more skills through its own `skills/` directory. The
same skill sources can still be copied directly into Codex or Claude with
`scripts/install.sh`.

## Install With Codex

Add this repository as a Codex plugin marketplace:

```sh
codex plugin marketplace add featherenvy/jig-skills
```

You can also use the Git URL directly:

```sh
codex plugin marketplace add git@github.com:featherenvy/jig-skills.git
```

The marketplace file marks all four plugins as `INSTALLED_BY_DEFAULT` so a Codex
client that honors that policy can make the full skill set available from one
marketplace command.

If your Codex version registers the marketplace but does not automatically enable
the plugins, enable these plugin IDs in the plugin UI or config:

- `jig-rust@jig-skills`
- `jig-swift@jig-skills`
- `jig-typescript@jig-skills`
- `jig-exec-plans@jig-skills`

## Plugins

### Jig Rust

Path: `plugins/jig-rust`

- `rust-simplify`: refines recently modified Rust code for clarity and idiomatic structure while preserving exact behavior.
- `rust-source-reorg`: reorganizes Rust files without behavior changes. Covers item ordering, `use` grouping and merging, attribute ordering, and the rules in `plugins/jig-rust/skills/rust-source-reorg/references/rust-source-reorg-rules.md`.
- `rust-architecture-review`: reviews module boundaries, crate/workspace structure, public APIs, trait hierarchy, data flow, and structural error architecture.
- `rust-error-handling-review`: audits changed error paths for swallowed errors, missing context, panic paths, error type design, resilience, async task failures, and `#[must_use]` gaps.
- `rust-test-quality-review`: checks whether tests prove changed behavior. Covers changed units, assertion quality, edge cases, regression coverage, and property-test opportunities.

### Jig Swift

Path: `plugins/jig-swift`

- `swift-simplify`: refines recently modified Swift 6 iOS code for clarity, SwiftUI/UIKit correctness, and concurrency safety while preserving exact behavior.

### Jig TypeScript

Path: `plugins/jig-typescript`

- `typescript-simplify`: refines recently modified TypeScript or React code for clarity and project-standard style while preserving behavior.
- `typescript-type-system-review`: reviews TypeScript type safety, type clarity, generics, utility types, and public API shapes. If code is pasted directly, it reviews only that code; otherwise it uses the scoped-change workflow.

### Jig ExecPlans

Path: `plugins/jig-exec-plans`

- `write-exec-plan`: writes a self-contained ExecPlan that follows PLANS.md-style requirements. Covers living-document sections, observable acceptance, validation, idempotence, and durable-state lifecycle coverage.
- `improve-exec-plan`: improves an existing ExecPlan without changing its intent. Requires either a named plan file or a recent ExecPlan in chat, verifies claims against repository evidence, and rewrites file targets in place.

## Scope

Most Rust, Swift, and TypeScript skills can work against one of these scopes:

- `current working changes`: the default. Inspect unstaged and staged changes.
- `feature branch`: compare the current branch with the merge base of the default branch.
- `base ref`: compare a named ref, tag, or commit with `HEAD`.

Named files or directories further narrow the scope.

Some skills have extra target rules:

- `swift-simplify` focuses on uncommitted Swift code plus directly related tests or support files.
- `typescript-type-system-review` reviews pasted TypeScript when code is supplied in the prompt.
- `improve-exec-plan` requires a concrete ExecPlan target: a file path or a recent ExecPlan from chat.
- `write-exec-plan` reads repository planning guidance such as `.agent/PLANS.md` when available and produces a fully self-contained plan.

## Direct Skill Copy

The plugin marketplace is the preferred distribution path. For environments that
only support direct skills, use the installer script.

Install every skill into Codex:

```sh
scripts/install.sh codex
```

Install every skill into Claude:

```sh
scripts/install.sh claude
```

Install one skill and replace any existing copy:

```sh
scripts/install.sh codex --force rust-simplify
scripts/install.sh claude --force rust-simplify
```

Default destinations:

- Codex: `${CODEX_HOME:-$HOME/.codex}/skills`
- Claude: `${CLAUDE_HOME:-$HOME/.claude}/skills`
