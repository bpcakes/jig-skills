---
name: fowler-rust-refactoring
description: Review Rust crates, workspaces, or diffs for behavior-preserving refactoring opportunities, diagnose Fowler-style code smells in Rust context, and produce a prioritized small-step refactoring plan. Use for Rust maintainability reviews, code-smell searches, refactoring audits, or preparing a safe structural change. Do not use as a generic feature, bug, security, or performance review unless refactoring is the primary task.
---

# Fowler Rust Refactoring

Review Rust code for structural improvements without confusing style preferences with design evidence. Default to analysis and a refactoring plan; do not edit code unless the user explicitly asks for implementation.

## Core rules

1. Preserve observable behavior. Treat public API, errors, panic contracts, ordering, allocation, blocking, serialization, ABI/FFI, feature behavior, and unsafe invariants as behavior when relevant.
2. Move in tiny steps. Every planned step should compile and have a named verification check.
3. Keep the two hats separate. Do not mix refactoring with feature or bug behavior changes in the same step.
4. Treat smells as hypotheses. A metric or scanner signal is not a finding until code context shows a real maintenance cost.
5. Adapt Fowler to Rust rather than translating object-oriented mechanics literally.
6. Respect the repository's edition, MSRV, features, `no_std` status, targets, CI policy, and semver obligations.
7. Prioritize refactoring that makes an expected change safer or easier. Put speculative cleanup last.

Read [references/principles.md](references/principles.md) before evaluating candidates.

## Workflow

### 1. Establish scope and constraints

Inspect the user-requested paths or diff. Then inspect, when present:

- `Cargo.toml` files and workspace membership;
- `rust-toolchain.toml` or `rust-toolchain`;
- `clippy.toml`, `rustfmt.toml`, `.cargo/config.toml`, and feature definitions;
- `AGENTS.md`, contributor guidance, CI workflows, and project test commands;
- public crate boundaries, serialization models, FFI, unsafe code, async/concurrency, macros, build scripts, and generated code.

State the effective scope and exclusions. Do not review `target/`, vendored dependencies, or generated files unless explicitly requested.

Determine whether the task is:

- a whole-repository audit;
- a scoped module/type review;
- a changed-code review against a Git reference;
- preparatory refactoring for a named feature or bug fix.

For a public library, assume signature, visibility, error, trait, field, and serialization changes may be breaking until proven otherwise.

### 2. Establish a trustworthy baseline

Use documented project or CI commands first. Do not invent a stricter policy and report its failures as project defects.

Typical read-only baseline commands are:

```bash
cargo fmt --all -- --check
cargo check --workspace --all-targets
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets
```

Adjust for the repository's feature matrix, target, `--locked`, `--no-default-features`, MSRV, or `no_std` setup. Do not blindly use `--all-features` when features may be mutually exclusive. Do not add `-D warnings` unless the project already treats warnings as errors.

Record failures that predate the review. If the baseline is red, do not claim later behavior preservation. If no Rust toolchain or tests are available, continue with static analysis and state the reduced confidence.

### 3. Run the heuristic scanner

Resolve this skill's directory from the loaded `SKILL.md` path, then run:

```bash
python3 <skill-directory>/scripts/scan_refactoring_opportunities.py . --format json
```

For changed code:

```bash
python3 <skill-directory>/scripts/scan_refactoring_opportunities.py . \
  --git-diff <base-ref> --format json
```

Use `--exclude-tests` only when the user excludes test refactoring. Tune thresholds for unusual generated, parser, numeric, or low-level code rather than treating defaults as universal.

The scanner is read-only and heuristic. Verify every candidate manually. Never copy its wording into the final report without checking the code, callers, ownership, and domain.

### 4. Search in four layers

Read [references/smell-catalog.md](references/smell-catalog.md) while reviewing.

#### A. Local mechanical signals

Use compiler diagnostics, existing Clippy output, the scanner, and targeted search to find:

- mysterious names and duplicated blocks;
- long functions, parameter clumps, flag arguments, and nested control flow;
- primitive domain concepts, invalid-state structs, broad mutation, and ambient state;
- over-specific APIs such as `&Vec<T>` or `&String`;
- error information discarded into `()`, panics, or repeated mapping boilerplate;
- large or repeated matches, while remembering that exhaustive enum matching is idiomatic;
- wrappers, traits, generics, macros, or delegation that may not earn their complexity.

#### B. Semantic design review

Trace callers and data ownership. Ask:

1. What concept does this code implement?
2. What expected change is difficult because of the current shape?
3. Where does the invariant or policy actually belong?
4. Is the set of variants closed or open?
5. Does the proposed boundary clarify ownership, or merely move borrow-checker friction?
6. Will the target add clones, allocation, boxing, dynamic dispatch, locks, lifetime complexity, or dependencies?
7. Is the code a legitimate DTO, parser, codec, generated path, hot loop, test seam, or compatibility wrapper?

#### C. Change topology

When Git history is available, inspect frequently changed files and co-change patterns. Use history to strengthen or reject Divergent Change and Shotgun Surgery candidates. A large file with one stable responsibility is weaker evidence than a file repeatedly edited for unrelated reasons.

Useful commands include:

```bash
git log --oneline -- path/to/file.rs
git log --name-only --format= -- '*.rs'
git blame -L <start>,<end> path/to/file.rs
rg -n '<symbol-or-policy>' .
```

Do not infer developer intent or quality from authorship. Use history only to understand change pressure and coupling.

#### D. Rust risk surfaces

Give extra scrutiny to:

- unsafe boundaries and `SAFETY:` invariants;
- FFI representation, symbol, ownership-transfer, and unwind contracts;
- async cancellation, `Send`, pinning, task lifetime, and locks across `.await`;
- macros and generated expansion;
- serialization and persistent formats;
- feature combinations, target-specific code, and `no_std`;
- performance-sensitive allocation, cloning, dispatch, layout, and pass count.

### 5. Validate each candidate

Do not report a candidate unless it has:

- exact path and line evidence;
- a concrete maintenance, correctness, testability, or change-propagation cost;
- a Rust-specific diagnosis including legitimate counterexamples;
- a plausible target shape;
- a Fowler refactoring name that describes the move;
- a behavior-preserving migration path.

Reject or defer candidates based only on line count, parameter count, number of match arms, number of fields, number of clones, or one-implementation traits when no deeper problem is present.

Use independent labels:

- **Impact:** high, medium, or low;
- **Confidence:** high, medium, or low;
- **Scope:** local, cross-module, or public;
- **Risk:** low, medium, or high.

Do not collapse these into a pseudo-precise score.

### 6. Select the Rust form of the Fowler move

Read [references/refactoring-catalog.md](references/refactoring-catalog.md) before writing the approach.

Apply these decision rules:

- Prefer enum methods and exhaustive matching for a closed set; use traits for a genuinely open capability.
- Treat data-only structs as smells only when behavior or invariants are wrongly scattered.
- Use newtypes/enums when they enforce meaning, validation, units, identity, or allowed states.
- Use slices and borrowed views when concrete container identity is irrelevant.
- Split parse, validate, domain, and side-effect phases when phase types can encode invariants.
- Use typed `Result<T, E>` for recoverable failures; do not map Fowler's exception language to panics.
- Narrow mutation and shared state, but do not pursue “zero mutation.”
- Keep loops when clearer than a dense iterator pipeline.
- Keep wrappers and one-implementation traits when they protect semver, visibility, testing, plugin extension, or unsafe contracts.
- Do not add a dependency solely to make a small refactor look fashionable.

### 7. Outline tiny steps

For each accepted finding, provide a sequence in which every step has one purpose and a verification check. Prefer:

1. characterization test or existing behavior check;
2. compiler-guided rename or extraction;
3. introduction of the target type/function/module behind existing behavior;
4. migration of one caller, branch, or module at a time;
5. broad verification;
6. removal of transitional adapters only after migration is complete.

For public API work, use expand → migrate → contract. For large internal changes, use an abstraction seam or parallel path only when needed, and include removal of that transitional structure in the plan.

Do not propose a rewrite when a sequence of small transformations can reach the target.

### 8. Produce the report

Use [references/report-template.md](references/report-template.md).

The report must contain:

- scope, constraints, and exclusions;
- baseline commands and results;
- prioritized findings with exact evidence;
- Rust-specific false-positive analysis;
- Fowler move and precise Rust target shape;
- independently verifiable steps;
- compatibility, unsafe, async, feature, and performance risks where relevant;
- deferred candidates and explicit non-findings;
- recommended execution order.

Keep the number of primary findings small enough to act on. Merge symptoms that share one root cause. Do not pad the report with low-value lint cleanup.

## Default non-findings

Do not report these without stronger evidence:

- a long but straight-line parser or codec;
- an exhaustive `match` over a closed enum;
- a transparent DTO or serialization struct with no hidden invariant;
- a cheap clone that makes ownership clear;
- a loop clearer than its iterator equivalent;
- a private one-implementation trait used as a deliberate test, plugin, or unsafe boundary;
- a public wrapper maintained for semver compatibility;
- an `unwrap` in a test or behind a proven invariant;
- a large file that changes for one cohesive reason.

## Implementation mode

When the user explicitly asks to perform the refactor, keep the same protocol:

- make one behavior-preserving step at a time;
- run the narrow check after each step;
- avoid opportunistic unrelated edits;
- show any behavior or compatibility change separately;
- stop at the last green state if a step cannot be proven safe;
- finish with the full project-defined verification suite and a concise change summary.
