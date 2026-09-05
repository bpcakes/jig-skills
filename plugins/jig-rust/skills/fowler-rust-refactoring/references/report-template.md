# Refactoring Opportunity Report Template

Use this structure unless the user requests another format. Keep findings evidence-based and concise enough to act on.

## Scope and constraints

- **Scope reviewed:** paths, crates, workspace members, or diff range
- **Rust contract:** edition, MSRV/toolchain, `no_std`, target platforms
- **Compatibility constraints:** public API, semver, serialization, ABI/FFI, persistent data, protocol behavior
- **Special constraints:** unsafe, async, concurrency, macros, performance, feature combinations
- **Explicit exclusions:** generated/vendor code, tests, examples, or unrelated modules

## Baseline

| Check | Command or evidence | Result | Notes |
|---|---|---|---|
| Format | `cargo fmt --check` or project equivalent | pass/fail/not run | |
| Compile | `cargo check ...` or CI command | pass/fail/not run | |
| Tests | `cargo test ...` or project suite | pass/fail/not run | |
| Clippy | `cargo clippy ...` or project policy | pass/fail/not run | |
| Scanner | bundled scanner command | findings count/not run | Heuristic only |

State why a check was not run. Do not imply behavior preservation when the baseline is already failing.

## Priority findings

### R-01 — <concise title>

- **Location:** `path/to/file.rs:line-line`
- **Impact:** high / medium / low
- **Confidence:** high / medium / low
- **Scope:** local / cross-module / public
- **Risk:** low / medium / high
- **Smell:** Fowler smell name; label Rust-only signals explicitly
- **Evidence:** concrete code structure, duplicated sites, callers, or change-history evidence
- **Why it matters:** specific change cost, correctness risk, invariant leak, or comprehension burden
- **Rust diagnosis:** why this is or is not idiomatic in this context; include legitimate counterexamples
- **Fowler move:** exact refactoring name(s)
- **Target shape:** precise Rust mechanism—enum, newtype, function, module, trait, slice API, typed error, phase type, etc.

**Small-step approach**

1. Add or identify the characterization check that fixes the current behavior.
2. Apply one mechanical or structural step.
3. Compile and run the narrow check.
4. Migrate one caller/branch/module at a time.
5. Run the broader suite.
6. Remove the transitional path only after all callers move.

**Verification**

- exact commands or tests after each step;
- public compatibility check if relevant;
- benchmark/Miri/concurrency/feature-matrix checks if relevant.

**Failure modes / rollback**

- behavior or compatibility that may accidentally change;
- simplest safe stopping point or revert boundary.

## Recommended sequence

Order findings by dependency and risk, not by file position.

1. prerequisite characterization tests or baseline repair;
2. low-risk renames/extractions that expose the design;
3. type/API migrations behind compatibility adapters;
4. module moves and responsibility changes;
5. removal of deprecated or duplicated paths;
6. optional local idiom cleanup.

Explain which findings should be combined and which must remain separate.

## Deferred candidates and non-findings

Record tempting candidates that should **not** be changed now, for example:

- exhaustive enum match is the correct closed-set design;
- data-only struct is a legitimate DTO;
- clone is cheap and clarifies ownership;
- trait is a deliberate test/plugin/unsafe boundary;
- loop is clearer than an iterator pipeline;
- public field or wrapper is required for compatibility;
- metric threshold was crossed without evidence of change friction.

This section prevents the report from becoming a style-enforcement exercise.

## Definition of done for an implemented refactor

- observable behavior and compatibility constraints remain satisfied;
- formatting, compile checks, Clippy policy, tests, and doctests pass;
- specialized unsafe/async/performance/feature checks pass where applicable;
- no accidental new clones, allocations, dynamic dispatch, lock widening, or MSRV increase;
- transitional adapters and deprecated code are tracked or removed according to policy;
- the resulting names and boundaries make the next expected change easier.
