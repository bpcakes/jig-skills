# jig-skills

Focused skills for code review, refactoring, implementation planning, and privacy audits in Codex and Claude Code. Each skill supplies an agent with a workflow, evidence standards, and an output format; some include optional scanners.

Use them to investigate a specific concern in Rust, Ruby and Rails, Swift, or TypeScript/React, or to review changes with multiple models. The catalog identifies which skills report findings, produce plans, or change files.

[Quick start](#quick-start) · [Choose a skill](#choose-a-skill) · [Catalog](#plugins) · [Installation](#installation) · [Requirements](#requirements) · [Examples](#scope-and-examples) · [Troubleshooting and updates](#troubleshooting-and-updates) · [Contributing](CONTRIBUTING.md)

## Quick Start

For Codex, install the Rust plugin from this marketplace:

```sh
codex plugin marketplace add bpcakes/jig-skills
codex plugin add jig-rust@jig-skills
```

Open a Rust project with staged or unstaged changes in a new Codex session:

```sh
cd /path/to/your/rust-project
codex
```

Enter this in the Codex composer, not your shell:

```text
$jig-rust:rust-error-handling-review Review my current working changes. Report findings with file locations; do not edit code.
```

Expect findings about error handling, with source locations and explanations, or an explicit statement that no issues were found. If the scope has no changes, choose a branch comparison or named files using the [scope examples](#scope-and-examples).

This example uses your Codex session without a second reviewer CLI. The commands were checked with Codex CLI 0.153.4; if your version lacks the plugin commands, use [direct skill copy](#direct-skill-copy). For Claude Code, start with that direct-copy installation instead.

## Choose a Skill

| What you want | Start with | Default result |
|---|---|---|
| Simplify code now | Language-specific `simplify` skills in [Rust](#jig-rust), [Swift](#jig-swift), or [TypeScript](#jig-typescript) | Code changes |
| Get a behavior-preserving refactoring plan | Fowler refactoring in [Rust](#jig-rust) or [Ruby/Rails](#jig-ruby) | Prioritized plan |
| Assess Rust module boundaries and ownership | [rust-architecture-review](plugins/jig-rust/skills/rust-architecture-review/SKILL.md) | Findings |
| Find consumers coupled to hidden implementation details | Abstraction police in [Rust](#jig-rust) or [TypeScript/React](#jig-typescript) | Findings |
| Decide whether similar implementations should be merged | Dup unifier in [Rust](#jig-rust) or [TypeScript/React](#jig-typescript) | Consolidation recommendations |
| Check a specific correctness or testing concern | Focused reviews in [Rust](#jig-rust) or [TypeScript/React](#jig-typescript) | Findings |
| Get independent reviews of the same diff | [comprehensive-review](plugins/jig-review/skills/comprehensive-review/SKILL.md) | Combined findings and coverage notes |
| Write, improve, or execute an implementation plan | [ExecPlans](#jig-execplans) | Plan, plan edits, or implementation |
| Assess privacy or encryption claims | [audit-intake-and-evidence-map](plugins/jig-privacy-audit/skills/audit-intake-and-evidence-map/SKILL.md), then the relevant [privacy skills](#jig-privacy-audit) | Audit scope and evidence map |

## Plugins

The seven plugins contain 38 task skills and one shared support skill. Click a skill name for its full workflow and supporting resources. “Findings” and “recommendations” mean analysis by default; “code changes” means the skill implements edits. Plan and audit outputs may be written to files when requested.

For marketplace installs, invoke `$plugin:skill` followed by your request in Codex. For example: `$jig-rust:rust-simplify Simplify my current working changes.` Direct-copy installs use the [host-specific names](#direct-skill-copy) below.

[Rust](#jig-rust) · [Ruby/Rails](#jig-ruby) · [Swift](#jig-swift) · [TypeScript/React](#jig-typescript) · [Multi-model review](#jig-review) · [ExecPlans](#jig-execplans) · [Privacy audit](#jig-privacy-audit)

### Jig Rust

Plugin: `jig-rust` · [Browse files](plugins/jig-rust)

| Skill | Use it for | Default result |
|---|---|---|
| [rust-simplify](plugins/jig-rust/skills/rust-simplify/SKILL.md) | Refines recently modified Rust code for clarity and idiomatic structure while preserving exact behavior. | Code changes |
| [fowler-rust-refactoring](plugins/jig-rust/skills/fowler-rust-refactoring/SKILL.md) | Assesses Rust code smells using Fowler's refactoring principles and produces prioritized, behavior-preserving plans. Includes a heuristic scanner. | Refactoring plan |
| [rust-source-reorg](plugins/jig-rust/skills/rust-source-reorg/SKILL.md) | Reorders Rust items, imports, and attributes without changing behavior. | Code changes |
| [rust-architecture-review](plugins/jig-rust/skills/rust-architecture-review/SKILL.md) | Reviews module boundaries, crate/workspace structure, public APIs, trait hierarchy, data flow, and structural error architecture. | Findings |
| [rust-abstraction-police](plugins/jig-rust/skills/rust-abstraction-police/SKILL.md) | Finds leaky Rust abstractions with evidence of the intended boundary, exposed implementation detail, and concrete caller or compatibility consequences. Includes a source-only candidate collector. | Findings |
| [rust-dup-unifier](plugins/jig-rust/skills/rust-dup-unifier/SKILL.md) | Finds similar but divergent Rust abstractions and validates whether to unify them, extract a shared core, or keep them separate. Includes an offline candidate scanner. | Recommendations |
| [rust-async-concurrency-review](plugins/jig-rust/skills/rust-async-concurrency-review/SKILL.md) | Reviews async and concurrency correctness around Tokio tasks, cancellation, `select!`, channels, locks, blocking work, backpressure, timeouts, shutdown, and tracing. | Findings |
| [rust-security-boundary-review](plugins/jig-rust/skills/rust-security-boundary-review/SKILL.md) | Reviews Rust security boundaries around secrets, auth/authz, untrusted input reaching sensitive sinks, CORS, cookies, tokens, rate limiting, and public error leakage. | Findings |
| [sqlx-query-safety-review](plugins/jig-rust/skills/sqlx-query-safety-review/SKILL.md) | Reviews Rust database access code for SQLx compile-time checking, bind-parameter safety, dynamic SQL risk, nullability, fetch semantics, row counts, N+1 queries, and DB/API DTO boundaries. | Findings |
| [sql-transaction-consistency-review](plugins/jig-rust/skills/sql-transaction-consistency-review/SKILL.md) | Reviews SQL-backed Rust state changes for transaction boundaries, isolation assumptions, SELECT-before-INSERT races, side effects around commits, retries, and connection lifetime safety. | Findings |
| [rust-error-handling-review](plugins/jig-rust/skills/rust-error-handling-review/SKILL.md) | Audits changed error paths for swallowed errors, missing context, panic paths, error type design, resilience, async task failures, and `#[must_use]` gaps. | Findings |
| [rust-test-quality-review](plugins/jig-rust/skills/rust-test-quality-review/SKILL.md) | Checks whether tests prove changed behavior: assertion quality, edge cases, regression coverage, and property-test opportunities. | Findings |

### Jig Ruby

Plugin: `jig-ruby` · [Browse files](plugins/jig-ruby)

| Skill | Use it for | Default result |
|---|---|---|
| [fowler-ruby-rails-refactoring](plugins/jig-ruby/skills/fowler-ruby-rails-refactoring/SKILL.md) | Assesses Ruby and Rails refactoring opportunities using Fowler's principles and produces prioritized, behavior-preserving plans. Includes an offline heuristic scanner and smoke tests. | Refactoring plan |

### Jig Swift

Plugin: `jig-swift` · [Browse files](plugins/jig-swift)

| Skill | Use it for | Default result |
|---|---|---|
| [swift-simplify](plugins/jig-swift/skills/swift-simplify/SKILL.md) | Refines recently modified Swift 6 iOS code for clarity, SwiftUI/UIKit correctness, and concurrency safety while preserving exact behavior. | Code changes |

### Jig TypeScript

Plugin: `jig-typescript` · [Browse files](plugins/jig-typescript)

| Skill | Use it for | Default result |
|---|---|---|
| [typescript-simplify](plugins/jig-typescript/skills/typescript-simplify/SKILL.md) | Refines recently modified TypeScript or React code for clarity and project-standard style while preserving behavior. | Code changes |
| [typescript-type-system-review](plugins/jig-typescript/skills/typescript-type-system-review/SKILL.md) | Reviews type safety, generics, utility types, and public API shapes. Pass code directly in the prompt to review a snippet instead of a diff. | Findings |
| [typescript-react-abstraction-police](plugins/jig-typescript/skills/typescript-react-abstraction-police/SKILL.md) | Validates leaky TypeScript and React abstractions using consumer evidence and concrete consequences. Includes a source-only candidate scanner. | Findings |
| [typescript-react-dup-unifier](plugins/jig-typescript/skills/typescript-react-dup-unifier/SKILL.md) | Finds similar TypeScript and React abstractions and assesses whether to unify them, extract shared behavior, standardize a contract, or retain intentional duplicates. Includes a TypeScript AST scanner. | Recommendations |
| [react-hooks-effects-review](plugins/jig-typescript/skills/react-hooks-effects-review/SKILL.md) | Reviews React hooks, Effects, refs, custom hooks, render purity, dependency correctness, stale closures, cleanup, and state synchronization. | Findings |
| [react-state-data-flow-review](plugins/jig-typescript/skills/react-state-data-flow-review/SKILL.md) | Reviews React state ownership, derived state, reducers, context, server/client data boundaries, async state modeling, external stores, optimistic updates, and cache synchronization. | Findings |
| [react-render-performance-review](plugins/jig-typescript/skills/react-render-performance-review/SKILL.md) | Reviews React render performance, large lists, context invalidation, memoization boundaries, key stability, client bundle costs, and repeated derivations. | Findings |
| [react-test-quality-review](plugins/jig-typescript/skills/react-test-quality-review/SKILL.md) | Reviews React tests for user-visible behavior, accessible queries, interaction coverage, async assertions, mocking boundaries, snapshots, and regression confidence. | Findings |
| [react-hooks-component-api-review](plugins/jig-typescript/skills/react-hooks-component-api-review/SKILL.md) | Reviews React component and hook APIs for prop modeling, controlled/uncontrolled contracts, children typing, callback types, polymorphic components, invalid states, and reusable UI boundaries. | Findings |

### Jig Review

Plugin: `jig-review` · [Browse files](plugins/jig-review)

| Skill | Use it for | Default result |
|---|---|---|
| [comprehensive-review](plugins/jig-review/skills/comprehensive-review/SKILL.md) | Runs independent reviews over the same Git changes and merges their findings. Claude plus Codex is the default; Cursor is opt-in. | Combined findings |

Runs in Codex and requires its subagent facility. External reviewers require authenticated CLIs and consume provider usage. Reviews report coverage limitations; Cursor workspace trust does not isolate project hooks. See [review setup, examples, and limitations](docs/comprehensive-review.md).

### Jig ExecPlans

Plugin: `jig-exec-plans` · [Browse files](plugins/jig-exec-plans)

| Skill | Use it for | Default result |
|---|---|---|
| [write-exec-plan](plugins/jig-exec-plans/skills/write-exec-plan/SKILL.md) | Writes a self-contained implementation plan with milestones, acceptance criteria, and validation steps. | Implementation plan |
| [improve-exec-plan](plugins/jig-exec-plans/skills/improve-exec-plan/SKILL.md) | Revises an existing plan against repository evidence. Edits a named file in place; returns a revised plan when the target is in chat. | Plan edits |
| [cursor-implement-exec-plan](plugins/jig-exec-plans/skills/cursor-implement-exec-plan/SKILL.md) | Runs Cursor Agent with Composer 2.5 to implement a checked-in plan and update its progress. | Code and plan changes |

### Jig Privacy Audit

Plugin: `jig-privacy-audit` · [Browse files](plugins/jig-privacy-audit)

| Skill | Use it for | Default result |
|---|---|---|
| [audit-intake-and-evidence-map](plugins/jig-privacy-audit/skills/audit-intake-and-evidence-map/SKILL.md) | Scopes privacy, zero-knowledge, and E2EE audits and produces an evidence map. | Audit report |
| [privacy-claims-field-classifier](plugins/jig-privacy-audit/skills/privacy-claims-field-classifier/SKILL.md) | Builds a field-level privacy matrix from schemas, APIs, code, and traces. | Audit report |
| [threat-model-and-dataflow-builder](plugins/jig-privacy-audit/skills/threat-model-and-dataflow-builder/SKILL.md) | Produces evidence-focused security and privacy threat models. | Audit report |
| [network-payload-zero-knowledge-test](plugins/jig-privacy-audit/skills/network-payload-zero-knowledge-test/SKILL.md) | Scans HAR/network captures for controlled sentinels in requests, responses, telemetry, and third-party traffic. | Audit report |
| [client-encryption-boundary-audit](plugins/jig-privacy-audit/skills/client-encryption-boundary-audit/SKILL.md) | Traces whether protected plaintext is encrypted before serialization, upload, local persistence, logs, or telemetry. | Audit report |
| [crypto-architecture-review](plugins/jig-privacy-audit/skills/crypto-architecture-review/SKILL.md) | Reviews key hierarchy, primitives, nonce strategy, recovery, sharing, and server influence. | Audit report |
| [crypto-implementation-static-review](plugins/jig-privacy-audit/skills/crypto-implementation-static-review/SKILL.md) | Statically scans cryptographic API use, randomness, KDFs, envelope fields, and plaintext sinks. | Audit report |
| [server-decryptability-and-plaintext-path-audit](plugins/jig-privacy-audit/skills/server-decryptability-and-plaintext-path-audit/SKILL.md) | Inspects backend decryptability, plaintext stores, queues, logs, support tools, and admin paths. | Audit report |
| [metadata-leakage-inventory](plugins/jig-privacy-audit/skills/metadata-leakage-inventory/SKILL.md) | Inventories visible metadata and maps privacy risks and claim conflicts. | Audit report |
| [telemetry-crash-logs-support-leakage-audit](plugins/jig-privacy-audit/skills/telemetry-crash-logs-support-leakage-audit/SKILL.md) | Checks logs, traces, crash reporters, analytics, and support tooling for sensitive leakage. | Audit report |
| [vulnerability-disclosure-and-retest-manager](plugins/jig-privacy-audit/skills/vulnerability-disclosure-and-retest-manager/SKILL.md) | Normalizes findings, tracks remediation status, and produces retest summaries. | Audit report |

[audit-common](plugins/jig-privacy-audit/skills/audit-common/SKILL.md) is the shared support skill for severity, confidence, evidence, and redaction rules. Start with intake to establish authorized scope and available evidence before choosing a specialized audit.

## Installation

### Install With Codex

Use the [quick start](#quick-start) to register the marketplace and install a plugin. To inspect available plugins or add another one:

```sh
codex plugin list --marketplace jig-skills --available --json
codex plugin add jig-ruby@jig-skills
```

Replace `jig-ruby` with any plugin ID in the catalog. Six plugins are marked `INSTALLED_BY_DEFAULT` and may be installed during startup; `jig-ruby` is available for explicit installation. You can also select the plugin in the Codex plugin UI and install or enable it there.

An SSH Git URL is an alternative marketplace source if your GitHub SSH access is configured:

```sh
codex plugin marketplace add git@github.com:bpcakes/jig-skills.git
```

### Direct Skill Copy

For direct installation into Codex or Claude Code, clone this repository and run the installer from its root:

```sh
git clone https://github.com/bpcakes/jig-skills.git
cd jig-skills
```

Choose one host. These examples install a single review skill:

```sh
scripts/install.sh codex rust-error-handling-review
```

```sh
scripts/install.sh claude rust-error-handling-review
```

Omit the skill name to install every compatible skill, or pass multiple names to select several. The installer copies each complete skill directory and skips existing destinations unless `--force` is provided.

| Host | Default destination | Invocation in the agent's composer |
|---|---|---|
| Codex | `${CODEX_HOME:-$HOME/.codex}/skills` | `$rust-error-handling-review Review my current working changes; do not edit code.` |
| Claude Code | `${CLAUDE_HOME:-$HOME/.claude}/skills` | `/rust-error-handling-review Review my current working changes; do not edit code.` |

Start a new agent session in the project you want to review after copying. Direct copies use the skill name without the plugin prefix. Claude's `/skill-name` syntax is documented in its [skills guide](https://code.claude.com/docs/en/skills).

`comprehensive-review` is Codex-only because it orchestrates Codex subagents. The installer excludes it when installing all skills for Claude and rejects an explicit request to install it there. Calling Claude as an external reviewer from Codex is supported.

### Requirements

Start with an authenticated Codex or Claude Code installation. Marketplace installation requires Codex's `plugin` commands; direct copying requires Git and a POSIX shell. The extra runtimes below are needed only for the corresponding helpers or external reviewers, not for every skill.

| Feature | Additional requirements |
|---|---|
| Rust abstraction-police collector | Python ≥ 3.11 |
| Rust Fowler and duplication scanners | Python ≥ 3.10 |
| Privacy-audit helper scripts | Python ≥ 3.10 |
| Ruby/Rails scanner | Ruby; Minitest for its smoke tests |
| TypeScript/React scanners | Node.js; use Node 22 or newer. The duplication scanner also needs an existing `typescript` package in the target repository or a global installation. |
| Comprehensive review | Node.js ≥ 22 and Codex subagents. Linux, macOS, or Windows through WSL; native Windows is unsupported by the external adapters. |
| Claude pass in comprehensive review | Installed, authenticated [Claude Code](https://claude.ai/code) CLI |
| Cursor pass in comprehensive review | Installed, authenticated [Cursor Agent](https://cursor.com/) CLI |
| Cursor ExecPlan implementation | Python ≥ 3.10 and an authenticated Cursor Agent CLI |

Scanners generate investigation leads; the agent validates them against source and consumers. Project builds and tests require that project's own toolchain and dependencies. See individual skill documentation for scanner commands and constraints.

## Scope and Examples

Run skills from the project you want assessed. Name the scope in your request: current working changes, a feature branch, a base reference, or specific files and directories. For most focused diff reviews, current working changes means staged and unstaged changes; consult the selected skill for exclusions and other supported inputs.

Enter these examples in Codex with the relevant plugins installed. Replace sample paths and branch names with yours.

Review a React branch for Effect and cleanup problems:

```text
$jig-typescript:react-hooks-effects-review Review this feature branch against main. Report findings; do not edit code.
```

Get a Ruby/Rails refactoring plan for named directories:

```text
$jig-ruby:fowler-ruby-rails-refactoring Assess app/models and app/controllers. Return a prioritized, behavior-preserving plan; do not edit code.
```

Apply Rust simplifications within a directory:

```text
$jig-rust:rust-simplify Simplify my current working changes in crates/api, preserving behavior. Apply the edits and run relevant checks.
```

Request independent reviews of working changes:

```text
$jig-review:comprehensive-review --reviewers claude,codex
```

The last example returns merged findings plus reviewer and coverage notes. See [comprehensive-review usage](docs/comprehensive-review.md) for branch scope, reviewer selection, and failure handling.

Some skills use different inputs:

- Fowler refactoring, abstraction police, and duplication unification can assess requested repositories or paths, including unchanged code. The TypeScript duplication skill defaults to the current directory.
- `swift-simplify` focuses on uncommitted Swift code and directly related support files. `typescript-type-system-review` can review pasted code.
- `write-exec-plan` creates an implementation plan and reads `.agent/PLANS.md` when available. `improve-exec-plan` needs a named plan file or a recent plan in chat. `cursor-implement-exec-plan` implements a checked-in plan; save and commit a chat-only plan first.
- Privacy audits start from product claims and explicitly authorized evidence: repositories, documentation, test accounts, network captures, and storage or logging artifacts.

## Troubleshooting and Updates

### Plugin or skill is missing

Check that the marketplace is registered and the plugin is available, then install the intended plugin explicitly:

```sh
codex plugin marketplace list
codex plugin list --marketplace jig-skills --available --json
codex plugin add jig-rust@jig-skills
```

If an installed plugin is disabled, select it in the Codex plugin UI and enable it. Start a new Codex session after installation or enabling. If autocomplete still looks stale, quit and restart Codex, then try the full `$jig-rust:rust-error-handling-review` name. A direct-copy installation uses `$rust-error-handling-review` instead.

If `codex plugin` is unavailable, use [direct skill copy](#direct-skill-copy) or upgrade Codex through your existing installation method.

### Update marketplace plugins

Refresh the Git marketplace snapshot:

```sh
codex plugin marketplace upgrade jig-skills
```

To replace an installed plugin's cached copy with the refreshed marketplace version, reinstall that plugin:

```sh
codex plugin remove jig-rust@jig-skills
codex plugin add jig-rust@jig-skills
```

Repeat for other plugins you use, then start a new session. Removal deletes the plugin's local cache; preserve any edits you made inside that cache first. For a marketplace registered from a local checkout, update that checkout with Git instead of using the Git-marketplace snapshot command.

### Update direct copies

From your `jig-skills` clone, fetch the latest repository contents and replace the selected installed copy:

```sh
git pull --ff-only
scripts/install.sh codex --force rust-error-handling-review
```

Use `claude` instead of `codex` for Claude Code. Omit the skill name to replace all compatible copies. `--force` replaces the entire destination skill directory, including local edits; preserve any customizations first. Restart the agent after updating.

### An old or duplicate skill still appears

Marketplace installation does not remove earlier direct copies, and direct-copy updates do not remove renamed skills. Check the [direct-copy destinations](#direct-skill-copy) and any personal `~/.agents/skills` directory for old copies. The former `dup-unifier` skill is now `rust-dup-unifier` in `jig-rust`. Keep any local edits before removing an obsolete copy, and use the qualified plugin name when choosing a marketplace skill.

### A scanner or external reviewer fails

Check the [feature-specific requirements](#requirements). A missing TypeScript dependency prevents the AST duplication scanner from running; it never installs packages itself. Missing reviewer authentication, a dirty checkout for branch review, and limited evidence coverage are explained in the [review troubleshooting guide](docs/comprehensive-review.md#troubleshooting).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for repository layout, documentation expectations, and the checks relevant to each helper. To report a problem, [open an issue](https://github.com/bpcakes/jig-skills/issues) with the skill name, installation method, agent/runtime versions, scope, and observed versus expected behavior. Redact secrets from logs and examples.
