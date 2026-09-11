---
name: react-test-quality-review
description: Review React tests for behavioral coverage, assertion strength, async interactions, mocking, and regression confidence.
---

# React Test Quality Review

Apply this skill when it serves the user's requested task and target. Discovery or a code change does not authorize an additional review, refactor, or broader scan. For review-only requests, report findings without editing; implement changes only when they are part of the user's request.

Treat checklist patterns, counts, and missing comments as investigation signals. Report a defect only after tracing a concrete consequence and checking counterevidence in callers, invariants, tests, and configuration. Missing context is a limitation, not a finding. Assign severity from impact and reachability; keep optional preferences separate and allow no findings.

Use this skill when reviewing tests for React components, hooks, UI regressions, Storybook interaction tests, Testing Library suites, Vitest/Jest suites, and Playwright component tests.

React tests can pass while proving little. Judge whether the tests would catch the user-visible breakages the product actually cares about, not whether coverage is high or the suite is green.

For detailed anti-patterns, interaction-specific checks, and rewrite examples, read [references/test-quality-rules.md](references/test-quality-rules.md). For a compact sample review, read [references/review-example.md](references/review-example.md).

## Core Standard

A good React test demonstrates observable behavior from the user's point of view:

> If this feature broke in production, would this test fail for the same reason a user would notice the breakage?

If the answer is no, inspect other coverage and the test's claimed contract before reporting a concrete surviving regression. Render-only tests can be intentional smoke checks; assertion syntax alone does not establish weak suite coverage.

## Review Workflow

1. Identify the user behavior or regression the test claims to protect.
2. Compare the claim against the actual assertions.
3. Check whether the test interacts through rendered UI rather than bypassing it.
4. Check whether queries reflect accessible, user-visible output.
5. Check async behavior by the final observable result, not incidental promises or mock calls.
6. Check whether mocks preserve a realistic boundary or replace the behavior being tested.
7. Check coverage for important states: success, error, loading, empty, disabled, invalid, permission-limited, and unavailable.
8. Check keyboard and focus behavior for interactive components.
9. For regressions, verify there is a test that would have failed before the fix.
10. Return precise findings with severity, evidence, risk, and a concrete replacement pattern.

## Query Standard

Prefer Testing Library queries in this order:

1. `getByRole` / `findByRole` / `queryByRole`, usually with an accessible `name`.
2. `getByLabelText` / `findByLabelText` for labeled form controls.
3. `getByPlaceholderText` only when placeholder text is the actual user-facing locator.
4. `getByText` for non-interactive visible text.
5. `getByDisplayValue` for current form values.
6. `getByAltText` for images and image-like controls.
7. `getByTitle` only when title is meaningful to users.
8. `getByTestId` only as a last resort.

Investigate test IDs, CSS selectors, DOM traversal, and class-name assertions when they can pass despite a relevant user-visible or accessibility regression. Accessible queries are a useful preference, not a defect threshold. A test ID may intentionally locate a non-semantic container, and separate tests may already verify roles and names.

## Severity

Use severity based on the consequence of a specific regression the tests would miss. Assertion syntax, query choice, or missing coverage alone does not determine severity. The examples below are investigation signals, not automatic ratings.

Potentially high-impact coverage gaps, when they leave a critical contract unprotected:

- Mocks the component, hook, reducer, or module whose behavior it claims to verify.
- Only asserts render/existence for interaction or state-transition behavior.
- Regression test would pass before the bug fix.
- Async behavior is asserted before the observable result can occur.
- Broad snapshot is the only protection for a complex component.

Other signals to investigate for a concrete surviving regression:

- Uses selectors that still match after a required accessible role, name, or behavior breaks, without other tests protecting that contract.
- Asserts internal state, private helper calls, hook internals, or mocked child props instead of user-visible output.
- Tests mouse interaction but misses required keyboard/focus behavior.
- Covers only the happy path and omits error, loading, empty, invalid, disabled, or negative states.
- Waits on a mock call instead of the resulting UI state.

Optional improvements, kept separate when no meaningful regression is demonstrated:

- Test name describes implementation rather than user outcome.
- Assertion is vague but stronger assertions elsewhere cover the behavior.
- `fireEvent` is used where `userEvent` would better represent user interaction.
- Snapshot is small and intentional but could be replaced by an explicit assertion.

## Common Blunders

Investigate these patterns and report only when the tested contract remains materially unproven:

- Render-only smoke tests presented as behavior coverage.
- Assertions like `toBeTruthy`, `toBeDefined`, `toHaveBeenCalled`, or `toMatchSnapshot` without user-visible result assertions.
- `waitFor(() => expect(mock).toHaveBeenCalled())` when the UI result is what matters.
- Side effects inside `waitFor` callbacks.
- Over-mocking routers, stores, query clients, form libraries, child components, or hooks until the integration path disappears.
- Snapshot-only coverage for forms, dialogs, menus, tabs, async flows, or destructive actions.
- Missing negative, loading, error, empty, disabled, permission, and invalid-input states.
- Missing keyboard, focus, and dismissal coverage for dialogs, menus, tabs, comboboxes, popovers, accordions, and custom controls.

## Static Scan Patterns

When reviewing a repository, scan for patterns that deserve scrutiny:

```txt
getByTestId|findByTestId|queryByTestId
data-testid
toMatchSnapshot|toMatchInlineSnapshot
container\.firstChild|container\.querySelector|\.closest\(|\.parentElement|\.children\[
fireEvent\.(click|change|input|keyDown|submit)
waitFor\(.*toHaveBeenCalled
jest\.mock\(|vi\.mock\(
shallow\(|react-test-renderer|react-shallow-renderer
toBeTruthy\(|toBeFalsy\(|toBeDefined\(|not\.toBeNull\(
render\(<.*\);\s*expect\(
```

These are not automatic failures. For each match, ask whether the pattern is justified by the user-visible behavior under test.

## Output Format

Before reporting, read [the report contract](references/report-format.md), the authoritative template for this skill. It supports no findings, impact-based severity, and optional improvements separate from defects. Omit sections that add no useful evidence.

## Related Skills

Use `react-hooks-effects-review` for hook lifecycle, dependency, cleanup, and stale-closure correctness. Use `react-state-data-flow-review` for state ownership and cache/data-flow risks. Use `react-hooks-component-api-review` for reusable component and hook API contracts.

## Hard Rule

Do not treat a passing test, high coverage number, or clean snapshot as evidence of quality unless the test would fail when user-visible behavior breaks.
