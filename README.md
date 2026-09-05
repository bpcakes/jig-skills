# jig-skills

Specialized code review, refactoring, planning, and privacy-audit skills for Rust, Swift, TypeScript, and encrypted-product review.

Each skill targets a specific engineering concern — error handling, type safety, test quality, architecture — rather than running a broad, generic pass. *Jig* in the machinist sense: a guide that holds work at the exact angle for a precise cut.

Distributed as a Codex plugin marketplace across six plugins. Skills can also be installed directly into Claude Code.

## Requirements

- Codex ≥ 0.128.0 — for plugin marketplace install
- Python ≥ 3.10 — for `jig-privacy-audit` helper scripts
- Node.js ≥ 22 — for the `comprehensive-review` helper scripts; CI covers the active Node 22 and 24 LTS lines
- Linux, macOS, or Windows through WSL — native Windows is not supported by the external-review adapters because Node cannot guarantee descendant process-group termination there
- [Claude Code](https://claude.ai/code) — installed and authenticated when the default Claude pass is selected in `comprehensive-review`
- [Cursor Agent](https://cursor.com/) — required for `jig-exec-plans:cursor-implement-exec-plan`, and installed and authenticated when the opt-in Cursor/Grok pass is selected in `comprehensive-review`

## Install With Codex

Add this repository as a Codex plugin marketplace:

```sh
codex plugin marketplace add bpcakes/jig-skills
```

Or use the Git URL directly:

```sh
codex plugin marketplace add git@github.com:bpcakes/jig-skills.git
```

All six plugins are marked `INSTALLED_BY_DEFAULT`. Codex may install them during the next startup — see [Troubleshooting](#troubleshooting) if the skill autocomplete index doesn't reflect them immediately.

If your Codex version registers the marketplace but does not enable the plugins, enable these IDs in the plugin UI or config:

```
jig-rust@jig-skills
jig-swift@jig-skills
jig-typescript@jig-skills
jig-review@jig-skills
jig-exec-plans@jig-skills
jig-privacy-audit@jig-skills
```

In the Codex composer, typing `$jig-rust:` opens the Rust skill submenu. The full qualified name format is `$plugin:skill` — for example, `$jig-rust:rust-simplify`.

## Plugins

### Jig Rust

Path: `plugins/jig-rust`

- `rust-simplify` — refines recently modified Rust code for clarity and idiomatic structure while preserving exact behavior.
- `fowler-rust-refactoring` — assesses Rust code smells using Fowler's refactoring principles and produces prioritized, behavior-preserving plans. Includes a heuristic scanner.
- `rust-source-reorg` — reorganizes Rust files without behavior changes: item ordering, `use` grouping and merging, attribute ordering, and the rules in `plugins/jig-rust/skills/rust-source-reorg/references/rust-source-reorg-rules.md`.
- `rust-architecture-review` — reviews module boundaries, crate/workspace structure, public APIs, trait hierarchy, data flow, and structural error architecture.
- `rust-abstraction-police` — finds leaky Rust abstractions with evidence of the intended boundary, exposed implementation detail, and concrete caller or compatibility consequences. Includes a source-only candidate collector.
- `rust-dup-unifier` — finds similar but divergent Rust abstractions and validates whether to unify them, extract a shared core, or keep them separate. Includes an offline candidate scanner.
- `rust-async-concurrency-review` — reviews async and concurrency correctness around Tokio tasks, cancellation, `select!`, channels, locks, blocking work, backpressure, timeouts, shutdown, and tracing.
- `rust-security-boundary-review` — reviews Rust security boundaries around secrets, auth/authz, untrusted input reaching sensitive sinks, CORS, cookies, tokens, rate limiting, and public error leakage.
- `sqlx-query-safety-review` — reviews Rust database access code for SQLx compile-time checking, bind-parameter safety, dynamic SQL risk, nullability, fetch semantics, row counts, N+1 queries, and DB/API DTO boundaries.
- `sql-transaction-consistency-review` — reviews SQL-backed Rust state changes for transaction boundaries, isolation assumptions, SELECT-before-INSERT races, side effects around commits, retries, and connection lifetime safety.
- `rust-error-handling-review` — audits changed error paths for swallowed errors, missing context, panic paths, error type design, resilience, async task failures, and `#[must_use]` gaps.
- `rust-test-quality-review` — checks whether tests prove changed behavior: assertion quality, edge cases, regression coverage, and property-test opportunities.

Plugin-qualified names: `jig-rust:rust-simplify`, `jig-rust:fowler-rust-refactoring`, `jig-rust:rust-source-reorg`, `jig-rust:rust-architecture-review`, `jig-rust:rust-abstraction-police`, `jig-rust:rust-dup-unifier`, `jig-rust:rust-async-concurrency-review`, `jig-rust:rust-security-boundary-review`, `jig-rust:sqlx-query-safety-review`, `jig-rust:sql-transaction-consistency-review`, `jig-rust:rust-error-handling-review`, `jig-rust:rust-test-quality-review`

### Jig Swift

Path: `plugins/jig-swift`

- `swift-simplify` — refines recently modified Swift 6 iOS code for clarity, SwiftUI/UIKit correctness, and concurrency safety while preserving exact behavior.

Plugin-qualified name: `jig-swift:swift-simplify`

### Jig TypeScript

Path: `plugins/jig-typescript`

- `typescript-simplify` — refines recently modified TypeScript or React code for clarity and project-standard style while preserving behavior.
- `typescript-type-system-review` — reviews type safety, generics, utility types, and public API shapes. Pass code directly in the prompt to review a snippet instead of a diff.
- `typescript-react-abstraction-police` — validates leaky TypeScript and React abstractions using consumer evidence and concrete consequences. Includes a source-only candidate scanner.
- `typescript-react-dup-unifier` — finds similar TypeScript and React abstractions and assesses whether to unify them, extract shared behavior, standardize a contract, or retain intentional duplicates. Includes a TypeScript AST scanner.
- `react-hooks-effects-review` — reviews React hooks, Effects, refs, custom hooks, render purity, dependency correctness, stale closures, cleanup, and state synchronization.
- `react-state-data-flow-review` — reviews React state ownership, derived state, reducers, context, server/client data boundaries, async state modeling, external stores, optimistic updates, and cache synchronization.
- `react-render-performance-review` — reviews React render performance, large lists, context invalidation, memoization boundaries, key stability, client bundle costs, and repeated derivations.
- `react-test-quality-review` — reviews React tests for user-visible behavior, accessible queries, interaction coverage, async assertions, mocking boundaries, snapshots, and regression confidence.
- `react-hooks-component-api-review` — reviews React component and hook APIs for prop modeling, controlled/uncontrolled contracts, children typing, callback types, polymorphic components, invalid states, and reusable UI boundaries.

Plugin-qualified names: `jig-typescript:typescript-simplify`, `jig-typescript:typescript-type-system-review`, `jig-typescript:typescript-react-abstraction-police`, `jig-typescript:typescript-react-dup-unifier`, `jig-typescript:react-hooks-effects-review`, `jig-typescript:react-state-data-flow-review`, `jig-typescript:react-render-performance-review`, `jig-typescript:react-test-quality-review`, `jig-typescript:react-hooks-component-api-review`

### Jig Review

Path: `plugins/jig-review`

- `comprehensive-review` — runs selected Claude Code, native Codex, and Cursor/Grok review subagents in parallel over the same Git changes, then deduplicates and merges their frozen findings. Claude plus Codex is the default; Cursor is opt-in. Bundled read-only adapters avoid separate forwarding skills.

Reviewer examples:

```text
$comprehensive-review
$comprehensive-review --reviewers claude,codex,cursor --cursor-effort xhigh
$comprehensive-review --claude-file-access host
$comprehensive-review --reviewers codex --codex-model gpt-5.6-sol --codex-effort high
```

Claude reviews default to `--claude-file-access restricted`, which confines Claude's read-only file tools to the reviewed working directory. Select `host` only when the review intentionally needs read access elsewhere on the machine; the review notes disclose that expanded boundary.

Plugin-qualified name: `jig-review:comprehensive-review`

### Jig ExecPlans

Path: `plugins/jig-exec-plans`

- `write-exec-plan` — writes a self-contained ExecPlan following PLANS.md-style requirements: living-document sections, observable acceptance, validation, idempotence, and durable-state lifecycle coverage.
- `improve-exec-plan` — improves an existing ExecPlan without changing its intent. Requires a named plan file or a recent ExecPlan in chat; verifies all claims against repository evidence.
- `cursor-implement-exec-plan` — runs Cursor Agent with Composer 2.5 to implement a checked-in ExecPlan and keep the plan's living sections current.

Plugin-qualified names: `jig-exec-plans:write-exec-plan`, `jig-exec-plans:improve-exec-plan`, `jig-exec-plans:cursor-implement-exec-plan`

### Jig Privacy Audit

Path: `plugins/jig-privacy-audit`

- `audit-intake-and-evidence-map` — scopes privacy, zero-knowledge, and E2EE audits and produces an evidence map.
- `privacy-claims-field-classifier` — builds a field-level privacy matrix from schemas, APIs, code, and traces.
- `threat-model-and-dataflow-builder` — produces evidence-focused security and privacy threat models.
- `network-payload-zero-knowledge-test` — scans HAR/network captures for controlled sentinels in requests, responses, telemetry, and third-party traffic.
- `client-encryption-boundary-audit` — traces whether protected plaintext is encrypted before serialization, upload, local persistence, logs, or telemetry.
- `crypto-architecture-review` — reviews key hierarchy, primitives, nonce strategy, recovery, sharing, and server influence.
- `crypto-implementation-static-review` — statically scans cryptographic API use, randomness, KDFs, envelope fields, and plaintext sinks.
- `server-decryptability-and-plaintext-path-audit` — inspects backend decryptability, plaintext stores, queues, logs, support tools, and admin paths.
- `metadata-leakage-inventory` — inventories visible metadata and maps privacy risks and claim conflicts.
- `telemetry-crash-logs-support-leakage-audit` — checks logs, traces, crash reporters, analytics, and support tooling for sensitive leakage.
- `vulnerability-disclosure-and-retest-manager` — normalizes findings, tracks remediation status, and produces retest summaries.

`audit-common` is a support skill used by the privacy-audit skills for shared severity, confidence, evidence, and redaction rules.

Plugin-qualified names use the `jig-privacy-audit:` prefix, for example `jig-privacy-audit:network-payload-zero-knowledge-test`.

When changing the privacy-audit helper scripts, run `plugins/jig-privacy-audit/scripts/test_fixtures.sh`.

When changing the comprehensive-review adapters, run `node --test plugins/jig-review/tests/*.test.mjs`.

## Scope

Most Rust, Swift, and TypeScript skills operate against one of three scopes:

| Scope | Description |
|---|---|
| `current working changes` | Default. Unstaged and staged changes. |
| `feature branch` | Current branch vs. merge base of the default branch. |
| `base ref` | A named ref, tag, or commit vs. `HEAD`. |

Named files or directories further narrow the scope.

Privacy-audit skills use claim-and-evidence scope instead: product claims, repositories, docs, test accounts, captures, storage/log artifacts, and explicit authorization boundaries.

Per-skill exceptions:
- `swift-simplify` — focuses on uncommitted Swift code plus directly related tests or support files.
- `typescript-type-system-review` — reviews pasted code when supplied in the prompt.
- `improve-exec-plan` — requires a concrete target: a file path or a recent ExecPlan from chat.
- `write-exec-plan` — reads `.agent/PLANS.md` when available and produces a fully self-contained plan.
- `cursor-implement-exec-plan` — requires a checked-in ExecPlan file path; if the plan only exists in chat, write it to a file first.

## Direct Skill Copy

Every skill can be installed directly into Codex without the plugin marketplace. `comprehensive-review` cannot be installed directly into Claude because it depends on Codex subagents; its bundled adapters invoke the selected local Claude Code and Cursor Agent CLIs for independent external passes.

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
