# jig-skills

Specialized code review and refactoring skills for Rust, Swift, and TypeScript.

Each skill targets a specific engineering concern — error handling, type safety, test quality, architecture — rather than running a broad, generic pass. *Jig* in the machinist sense: a guide that holds work at the exact angle for a precise cut.

Distributed as a Codex plugin marketplace across five plugins. Skills can also be installed directly into Claude Code.

## Requirements

- Codex ≥ 0.128.0 — for plugin marketplace install
- [Claude Code](https://claude.ai/code) — for direct skill install and the `$cc:review` step in `comprehensive-review`
- [Claude Code plugin for Codex](https://github.com/sendbird/cc-plugin-codex) — required only for `jig-review:comprehensive-review`

## Install With Codex

Add this repository as a Codex plugin marketplace:

```sh
codex plugin marketplace add bpcakes/jig-skills
```

Or use the Git URL directly:

```sh
codex plugin marketplace add git@github.com:bpcakes/jig-skills.git
```

All five plugins are marked `INSTALLED_BY_DEFAULT`. Codex may install them during the next startup — see [Troubleshooting](#troubleshooting) if the skill autocomplete index doesn't reflect them immediately.

If your Codex version registers the marketplace but does not enable the plugins, enable these IDs in the plugin UI or config:

```
jig-rust@jig-skills
jig-swift@jig-skills
jig-typescript@jig-skills
jig-review@jig-skills
jig-exec-plans@jig-skills
```

In the Codex composer, typing `$jig-rust:` opens the Rust skill submenu. The full qualified name format is `$plugin:skill` — for example, `$jig-rust:rust-simplify`.

## Plugins

### Jig Rust

Path: `plugins/jig-rust`

- `rust-simplify` — refines recently modified Rust code for clarity and idiomatic structure while preserving exact behavior.
- `rust-source-reorg` — reorganizes Rust files without behavior changes: item ordering, `use` grouping and merging, attribute ordering, and the rules in `plugins/jig-rust/skills/rust-source-reorg/references/rust-source-reorg-rules.md`.
- `rust-architecture-review` — reviews module boundaries, crate/workspace structure, public APIs, trait hierarchy, data flow, and structural error architecture.
- `rust-security-boundary-review` — reviews Rust security boundaries around secrets, auth/authz, untrusted input reaching sensitive sinks, CORS, cookies, tokens, rate limiting, and public error leakage.
- `sqlx-query-safety-review` — reviews Rust database access code for SQLx compile-time checking, bind-parameter safety, dynamic SQL risk, nullability, fetch semantics, row counts, N+1 queries, and DB/API DTO boundaries.
- `sql-transaction-consistency-review` — reviews SQL-backed Rust state changes for transaction boundaries, isolation assumptions, SELECT-before-INSERT races, side effects around commits, retries, and connection lifetime safety.
- `rust-error-handling-review` — audits changed error paths for swallowed errors, missing context, panic paths, error type design, resilience, async task failures, and `#[must_use]` gaps.
- `rust-test-quality-review` — checks whether tests prove changed behavior: assertion quality, edge cases, regression coverage, and property-test opportunities.

Plugin-qualified names: `jig-rust:rust-simplify`, `jig-rust:rust-source-reorg`, `jig-rust:rust-architecture-review`, `jig-rust:rust-security-boundary-review`, `jig-rust:sqlx-query-safety-review`, `jig-rust:sql-transaction-consistency-review`, `jig-rust:rust-error-handling-review`, `jig-rust:rust-test-quality-review`

### Jig Swift

Path: `plugins/jig-swift`

- `swift-simplify` — refines recently modified Swift 6 iOS code for clarity, SwiftUI/UIKit correctness, and concurrency safety while preserving exact behavior.

Plugin-qualified name: `jig-swift:swift-simplify`

### Jig TypeScript

Path: `plugins/jig-typescript`

- `typescript-simplify` — refines recently modified TypeScript or React code for clarity and project-standard style while preserving behavior.
- `typescript-type-system-review` — reviews type safety, generics, utility types, and public API shapes. Pass code directly in the prompt to review a snippet instead of a diff.
- `react-hooks-effects-review` — reviews React hooks, Effects, refs, custom hooks, render purity, dependency correctness, stale closures, cleanup, and state synchronization.
- `react-state-data-flow-review` — reviews React state ownership, derived state, reducers, context, server/client data boundaries, async state modeling, external stores, optimistic updates, and cache synchronization.
- `react-render-performance-review` — reviews React render performance, large lists, context invalidation, memoization boundaries, key stability, client bundle costs, and repeated derivations.
- `react-test-quality-review` — reviews React tests for user-visible behavior, accessible queries, interaction coverage, async assertions, mocking boundaries, snapshots, and regression confidence.
- `react-hooks-component-api-review` — reviews React component and hook APIs for prop modeling, controlled/uncontrolled contracts, children typing, callback types, polymorphic components, invalid states, and reusable UI boundaries.

Plugin-qualified names: `jig-typescript:typescript-simplify`, `jig-typescript:typescript-type-system-review`, `jig-typescript:react-hooks-effects-review`, `jig-typescript:react-state-data-flow-review`, `jig-typescript:react-render-performance-review`, `jig-typescript:react-test-quality-review`, `jig-typescript:react-hooks-component-api-review`

### Jig Review

Path: `plugins/jig-review`

- `comprehensive-review` — runs a Claude Code review with `$cc:review`, independently performs a native Codex review over the same scope, then deduplicates and merges findings into one report. Requires the [Claude Code plugin for Codex](https://github.com/sendbird/cc-plugin-codex).

Plugin-qualified name: `jig-review:comprehensive-review`

### Jig ExecPlans

Path: `plugins/jig-exec-plans`

- `write-exec-plan` — writes a self-contained ExecPlan following PLANS.md-style requirements: living-document sections, observable acceptance, validation, idempotence, and durable-state lifecycle coverage.
- `improve-exec-plan` — improves an existing ExecPlan without changing its intent. Requires a named plan file or a recent ExecPlan in chat; verifies all claims against repository evidence.

Plugin-qualified names: `jig-exec-plans:write-exec-plan`, `jig-exec-plans:improve-exec-plan`

## Scope

Most Rust, Swift, and TypeScript skills operate against one of three scopes:

| Scope | Description |
|---|---|
| `current working changes` | Default. Unstaged and staged changes. |
| `feature branch` | Current branch vs. merge base of the default branch. |
| `base ref` | A named ref, tag, or commit vs. `HEAD`. |

Named files or directories further narrow the scope.

Per-skill exceptions:
- `swift-simplify` — focuses on uncommitted Swift code plus directly related tests or support files.
- `typescript-type-system-review` — reviews pasted code when supplied in the prompt.
- `improve-exec-plan` — requires a concrete target: a file path or a recent ExecPlan from chat.
- `write-exec-plan` — reads `.agent/PLANS.md` when available and produces a fully self-contained plan.

## Direct Skill Copy

Every skill except `comprehensive-review` can be installed directly into Codex or Claude without the plugin marketplace. (`comprehensive-review` depends on Codex's native review behavior and the `$cc:review` command from the Claude Code plugin for Codex.)

Install every compatible skill into Codex:

```sh
scripts/install.sh codex
```

Install every Claude-compatible skill into Claude:

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

## Troubleshooting

**Skill autocomplete doesn't reflect newly installed plugins**

When Codex prints `Installed Jig Rust plugin` (or similar) at startup, the plugin is available to the model immediately — but the interactive autocomplete index may lag. Quit and restart Codex once to rebuild it.

**Marketplace registered but plugins not enabled**

Some Codex versions register a marketplace without enabling its default plugins. Enable them manually in the plugin UI, or add the plugin IDs listed in [Install With Codex](#install-with-codex) to your config.
