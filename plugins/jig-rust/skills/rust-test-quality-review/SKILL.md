---
name: rust-test-quality-review
description: Review whether Rust tests prove the changed behavior, including assertions, regression gaps, and determinism.
---

# Rust Test Quality Review

Review whether tests establish the behavior in the user's requested Rust diff, files, or snippet. Without a named target for a review, inspect current staged and unstaged changes and the tests relevant to them. Code changes or a previously loaded skill do not authorize another review.

For a review-only request, report findings and test suggestions without changing files. Add or repair tests when implementation is part of the user's task.

## Evidence standard

Start with the behavioral contracts affected by the diff and locate their tests, including indirect integration coverage. Include test-only changes even when production code and its contract are unchanged. A missing test per function, uncovered branch, test count, directory choice, or assertion syntax alone does not establish a defect.

For each candidate, identify a plausible incorrect implementation or regression that the existing tests would accept, the user-visible consequence, and the coverage or invariant that might already rule it out. Distinguish static inspection from measured coverage. Missing evidence is a limitation. A bug fix without a newly added test is not automatically critical: an existing test may already prevent regression.

## Checks

- **Changes to tests and execution:** Compare the base and final diff for removed tests or assertions, broadened matchers, new `#[ignore]`/`cfg` gates, and changes to CI filters or test discovery. Identify which previously rejected regression would now pass or never execute. Check replacement coverage, approved contract changes, and explicitly provisioned opt-in jobs before reporting; deletion, an ignore attribute, or fewer assertions alone is not a defect. A test-only diff that silently stops checking a required error variant or disables the sole regression test warrants a finding tied to that lost protection.
- **Coverage:** Trace meaningful validation, error mapping, boundary conditions, state changes, and side effects. Prioritize constructable failure cases that can change the promised result. Do not demand every error variant, match arm, feature combination, or public delegator have a dedicated unit test.
- **Assertions:** Check that an oracle is independent of the implementation and sensitive to the relevant failure. `is_ok()` can completely test an acceptance contract or `Result<(), E>`; `is_err()` can be sufficient when rejection, not variant identity, is the promise. Show what incorrect result escapes when stronger assertions are needed.
- **Tautologies:** Comparing the same function call to itself cannot prove its output, but repeated calls can test determinism or state transitions. Inspect inputs, setup, state, and the asserted property before labeling an assertion self-confirming.
- **Precision:** Assert stable behavioral fields. Exact float equality can be correct for exactly representable values or exact contracts; use tolerances for approximate numerical calculations when justified. Debug output, error text, snapshots, or timestamps can be valid contractual outputs. Avoid demanding every field be checked when other tests cover it.
- **Panic tests:** A broad `#[should_panic]` is a signal to inspect whether unrelated setup panics could satisfy it. An expected message is one way to disambiguate, not a requirement if the target failure is already isolated. Do not trigger invalid undefined behavior to test unsafe preconditions.
- **Isolation:** Trace shared mutable state, environment changes, ports, clock assumptions, real services, ordering, and cleanup. Report a plausible interference or nondeterministic failure. Tests under `src/` can legitimately integrate private modules; moving files does not make I/O hermetic.
- **Fixtures and mocks:** Check whether mocks bypass the behavior being asserted, fixtures encode independently known facts, and builders hide assumptions. Three repeated setups or five lines of duplication is not a finding. Extract only when drift or maintenance consequences outweigh local readability.
- **Async and feature behavior:** For changed cancellation, timeout, scheduling, or conditional behavior, inspect the relevant configurations and interleavings. Identify the untested transition and consequence. Do not demand all-features combinations that are mutually exclusive or new concurrency tests for a trivial edit.
- **Semantic traits and unsafe contracts:** For custom `Eq`, `Hash`, `Ord`, `Clone`, or `Drop`, examine the actual semantic law or resource effect. Suggest property tests or Miri only when they address a concrete gap with valid inputs.
- **Regression evidence:** Check whether existing tests fail on the faulty behavior. A before/after run or targeted mutation can strengthen confidence when authorized and isolated; do not revert the user's work in place. Fewer assertions can be an improvement if redundant checks are replaced by a stronger oracle.

## Output and severity

Use a compact changed-behavior/test map when it helps establish coverage. For each finding, provide location, current coverage, a specific surviving regression, consequence, counterevidence considered, and a focused test suggestion. Include an example or skeleton only when it clarifies the independent oracle; state unknown expected values instead of inventing business rules.

Severity follows the risk of the uncovered behavior and likelihood of regression. Missing coverage, helper duplication, test placement, or a bug-fix label never determines severity by itself. Keep optional property-test, naming, and organization suggestions separate. Return no supported findings when appropriate, and state verification limits.
