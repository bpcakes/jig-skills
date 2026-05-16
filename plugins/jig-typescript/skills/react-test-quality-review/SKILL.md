---
name: react-test-quality-review
description: Review React test quality for user-visible behavior, accessible queries, interaction coverage, async assertions, mocking boundaries, snapshots, regression tests, and weak assertions in React, Testing Library, Vitest, Jest, Storybook, and Playwright component tests.
---

# React Test Quality Review

Use this skill when reviewing tests for React components, hooks, UI regressions, Storybook interaction tests, Testing Library suites, Vitest/Jest suites, and Playwright component tests.

React tests can pass while proving little. Judge whether the tests would catch the user-visible breakages the product actually cares about, not whether coverage is high or the suite is green.

For detailed anti-patterns, interaction-specific checks, and rewrite examples, read [references/test-quality-rules.md](references/test-quality-rules.md). For a compact sample review, read [references/review-example.md](references/review-example.md).

## Core Standard

A good React test demonstrates observable behavior from the user's point of view:

> If this feature broke in production, would this test fail for the same reason a user would notice the breakage?

If the answer is no, report it. Treat render-only tests, shallow snapshots, implementation-detail assertions, and over-mocked tests as weak until they prove behavior.

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

Flag `data-testid`, CSS selectors, DOM traversal, and class-name assertions when an accessible query should work. If a button, dialog, tab, checkbox, textbox, link, alert, or status cannot be found by role/name, that may expose an accessibility defect, not just a test inconvenience.

## Severity

Use severity based on confidence loss, not style preference.

**Critical** findings mean the test gives false confidence or is disconnected from the behavior it claims to protect. Examples:

- Mocks the component, hook, reducer, or module whose behavior it claims to verify.
- Only asserts render/existence for interaction or state-transition behavior.
- Regression test would pass before the bug fix.
- Async behavior is asserted before the observable result can occur.
- Broad snapshot is the only protection for a complex component.

**Major** findings mean the test exercises some behavior but misses an important user-visible failure path. Examples:

- Uses test IDs, CSS selectors, DOM traversal, or class names where accessible queries should work.
- Asserts internal state, private helper calls, hook internals, or mocked child props instead of user-visible output.
- Tests mouse interaction but misses required keyboard/focus behavior.
- Covers only the happy path and omits error, loading, empty, invalid, disabled, or negative states.
- Waits on a mock call instead of the resulting UI state.

**Minor** findings mean the test is mostly useful but could be clearer or more resilient. Examples:

- Test name describes implementation rather than user outcome.
- Assertion is vague but stronger assertions elsewhere cover the behavior.
- `fireEvent` is used where `userEvent` would better represent user interaction.
- Snapshot is small and intentional but could be replaced by an explicit assertion.

## Common Blunders

Flag these unless the surrounding context justifies them:

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

Lead with findings, ordered by severity. If no issues are found, say so and mention remaining test gaps or residual risk.

Use this structure when useful:

````md
## React test quality review

### Verdict

[Strong / Mixed / Weak / False confidence]

### Highest-risk issue

[One paragraph explaining the biggest confidence gap.]

### Findings

#### Critical: [title]

Evidence:
```ts
[small excerpt]
```

Why this is weak:
[Explain the false confidence or missed failure mode.]

What to test instead:
```ts
[replacement pattern or pseudocode]
```

### Missing behavior coverage

- [User behavior/state missing]

### Query/accessibility review

- [Where accessible queries should replace test IDs/selectors]

### Async/mocking/snapshot review

- [Async waits, mocks, and snapshots that matter]

### Minimum fix plan

1. [Most important test rewrite]
2. [Second]
3. [Third]
````

## Related Skills

Use `react-hooks-effects-review` for hook lifecycle, dependency, cleanup, and stale-closure correctness. Use `react-state-data-flow-review` for state ownership and cache/data-flow risks. Use `react-hooks-component-api-review` for reusable component and hook API contracts.

## Hard Rule

Do not treat a passing test, high coverage number, or clean snapshot as evidence of quality unless the test would fail when user-visible behavior breaks.
