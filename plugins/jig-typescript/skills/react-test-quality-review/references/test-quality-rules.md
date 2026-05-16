# React Test Quality Rules

Use these rules when reviewing React component tests, hook tests, Testing Library tests, Vitest/Jest suites, Storybook interaction tests, Playwright component tests, and regression tests.

React tests can pass while proving almost nothing. Your job is not to praise coverage or confirm that a suite is green. Your job is to determine whether the tests would catch the user-visible breakages the product actually cares about.

## Core standard

A good React test demonstrates observable behavior from the user's point of view. It should answer:

> If this feature broke in production, would this test fail for the same reason a user would notice the breakage?

If the answer is no, call it out.

Treat render-only tests, shallow snapshots, implementation-detail assertions, and over-mocked tests as weak by default until they prove behavior.

## What to review

Review all tests that exercise React UI or React-derived behavior, including:

- React Testing Library component tests.
- Hook tests using `renderHook` or wrapper components.
- Jest and Vitest suites around React components.
- Storybook `play` interaction tests and test-runner checks.
- Playwright component tests.
- Regression tests for UI bugs.
- Snapshot tests that claim to protect UI behavior.

## Review workflow

1. Identify the user behavior under test.
2. Compare the behavior claim against the actual assertions.
3. Check whether the test interacts through the rendered UI or bypasses it.
4. Check whether queries reflect accessible, user-visible output.
5. Check async behavior by the final observable result, not by incidental promises or mock calls.
6. Check whether mocks preserve a realistic boundary or replace the behavior being tested.
7. Check whether important states are covered: success, error, loading, empty, disabled, invalid, permission-limited, and unavailable states.
8. Check whether keyboard and focus behavior is tested for interactive components.
9. For regressions, verify there is a test that would have failed before the fix.
10. Return precise findings with severity, evidence, risk, and a concrete replacement pattern.

## Query priority standard

Encode Testing Library's user-centered query priority directly in the review.

Prefer queries in this order:

1. `getByRole` / `findByRole` / `queryByRole`, usually with an accessible `name`.
2. `getByLabelText` / `findByLabelText` for form controls where label association is the user-facing handle.
3. `getByPlaceholderText` only when placeholder text is the actual user-facing locator and there is no better label.
4. `getByText` for non-interactive visible text.
5. `getByDisplayValue` for current form values.
6. `getByAltText` for images and image-like controls.
7. `getByTitle` only when title is meaningful to users.
8. `getByTestId` only as a last resort.

Flag `data-testid` use when an accessible query should work. A test ID is acceptable only when the target has no stable semantic or user-visible representation, such as a canvas region, virtualized measurement sentinel, skeleton primitive, instrumentation-only element, or unavoidable duplicate content where accessible names cannot distinguish the target. Even then, the test should assert behavior or visible state, not just existence.

### Examples

Weak:

```ts
expect(screen.getByTestId('submit-button')).toBeInTheDocument();
```

Stronger:

```ts
expect(screen.getByRole('button', { name: /submit order/i })).toBeEnabled();
```

Weak:

```ts
const button = container.querySelector('.primary');
button?.click();
expect(onSubmit).toHaveBeenCalled();
```

Stronger:

```ts
const user = userEvent.setup();
await user.click(screen.getByRole('button', { name: /submit order/i }));
expect(await screen.findByRole('status')).toHaveTextContent(/order submitted/i);
```

## Findings rubric

Use severity based on confidence loss, not style preference.

### Critical

Use when the test gives false confidence or is disconnected from the behavior it claims to protect.

Typical critical findings:

- The test mocks the component, hook, reducer, or module whose behavior it claims to verify.
- The test only asserts render/existence for a feature whose value is interaction or state transition.
- A regression test would pass before the bug fix.
- Async behavior is asserted before the observable result can occur.
- The only protection for a complex component is a broad snapshot.

### Major

Use when the test exercises some behavior but misses an important user-visible failure path.

Typical major findings:

- Uses `data-testid`, CSS selectors, DOM traversal, or class names where accessible queries should work.
- Asserts internal state, props, hook return shape, private helper calls, or implementation details instead of user-visible output.
- Tests mouse interaction but not keyboard/focus behavior for a component that must be keyboard accessible.
- Covers happy path only and omits error, loading, empty, invalid, disabled, or negative states.
- Waits on a mock call instead of the resulting UI state.

### Minor

Use when the test is mostly valuable but could be clearer, more resilient, or more user-centered.

Typical minor findings:

- Test name describes implementation rather than user outcome.
- Assertion is vague but accompanied by stronger assertions elsewhere.
- `fireEvent` is used where `userEvent` would better represent the interaction.
- Snapshot is small and targeted but could be replaced by an explicit assertion.

## Anti-pattern checks

### 1. Render happened, behavior unproven

Flag tests whose only assertion is one of:

```ts
render(<Component />);
expect(screen.getByText(/.../i)).toBeInTheDocument();
expect(screen.getByTestId('...')).toBeTruthy();
expect(container.firstChild).toMatchSnapshot();
```

These are smoke tests. They may be useful as minimal crash checks, but they do not prove behavior.

Demand the missing behavior:

- What can the user do?
- What changes after interaction?
- What feedback appears?
- What is submitted, saved, opened, selected, focused, disabled, hidden, or announced?
- What happens when the operation fails?

### 2. Implementation details instead of user-visible output

Flag assertions against:

- Component instance state.
- Hook internals not exposed through intended API.
- Private helper function calls.
- Class names used as behavior proof.
- DOM structure such as `firstChild`, `parentElement`, `children[0]`, `.closest()`, or brittle selectors.
- Props passed into mocked children when the integration matters.
- Store action names instead of resulting UI behavior, unless the unit under test is the action creator itself.

Replace with assertions against accessible output, enabled/disabled state, focus, selected state, expanded/collapsed state, form values, validation messages, navigation effects, or network boundary calls.

### 3. Overuse of `data-testid`

Flag test IDs when the same element can be found by:

- Role and accessible name: `button`, `link`, `textbox`, `checkbox`, `radio`, `combobox`, `tab`, `dialog`, `menuitem`, `alert`, `status`, `heading`.
- Label text.
- Visible text.
- Display value.
- Alt text.

Test IDs often hide accessibility defects. If a button cannot be found by role and name, that may be a product problem, not a test inconvenience.

### 4. Missing interaction coverage

For interactive components, require tests for the primary user paths.

#### Forms

Check that tests cover:

- Typing into fields through `userEvent.type` or equivalent browser interaction.
- Submitting through the visible submit control and, when relevant, Enter key behavior.
- Validation messages.
- Disabled submit state.
- Required field behavior.
- Server error display.
- Loading state during submission.
- Final user-visible success state.

#### Dialogs and modals

Check that tests cover:

- Opening by user action.
- Accessible dialog name.
- Focus moves into the dialog.
- Escape closes when expected.
- Close button works.
- Cancel versus confirm behavior.
- Background interaction is blocked when expected.
- Focus returns to the triggering element when expected.

#### Menus and popovers

Check that tests cover:

- Trigger opens the menu or popover.
- Items are visible and selectable.
- Escape or outside click closes when expected.
- Keyboard navigation works when the component claims menu/listbox behavior.
- Disabled items cannot be selected.

#### Tabs

Check that tests cover:

- The selected tab is exposed as selected.
- Selecting a tab changes the visible panel.
- Arrow-key navigation works if the component follows tablist semantics.
- Hidden panels are not accidentally asserted as visible content.

#### Comboboxes, listboxes, autocomplete

Check that tests cover:

- Typing filters results.
- Keyboard selection works.
- Mouse selection works.
- Empty results state appears.
- Loading and error states appear for async options.
- Selected value is reflected in the field or visible summary.

### 5. Async tests wait for the wrong thing

Flag patterns like:

```ts
await waitFor(() => expect(fetchMock).toHaveBeenCalled());
expect(screen.getByText(/done/i)).toBeInTheDocument();
```

The mock call may happen before the UI finishes updating. Prefer waiting for the observable result:

```ts
expect(await screen.findByRole('status')).toHaveTextContent(/done/i);
```

Rules:

- Use `findBy*` when an element should appear asynchronously.
- Use `waitForElementToBeRemoved` when loading indicators or dialogs should disappear.
- Await `userEvent` interactions that return promises.
- Do not put side effects inside `waitFor` callbacks.
- Do not use arbitrary sleeps unless no observable signal exists; if no observable signal exists, challenge the component design or test seam.
- Avoid asserting immediately after an async trigger unless the expectation is intentionally synchronous.

### 6. Mocking too deep

Mocks are boundaries, not a substitute for behavior.

Acceptable mocks usually include:

- Network calls at the API boundary.
- Browser APIs unavailable in the test environment.
- Time, random IDs, feature flags, and external services.
- Expensive or unstable dependencies outside the component's responsibility.

Flag mocks that replace:

- The component under review.
- The hook whose behavior the test claims to verify.
- Child components when the parent-child interaction is the behavior.
- Form libraries, routers, stores, or query clients so heavily that the real integration path is gone.
- Validation logic when the test claims to verify validation.

A useful test can mock transport while keeping rendering, state changes, validation, accessibility state, and user feedback real.

### 7. Snapshot tests freeze noise instead of behavior

Flag snapshots when they are:

- Large DOM trees.
- The only test for an interactive component.
- Updated mechanically without an explicit behavior assertion.
- Sensitive to class names, generated IDs, style churn, or layout wrappers.
- Used to claim coverage for forms, dialogs, menus, tabs, or async flows.

Snapshots are acceptable only when they are narrow, intentional, and paired with behavior assertions. Prefer explicit assertions such as:

```ts
expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
expect(screen.getByRole('alert')).toHaveTextContent(/email is required/i);
expect(screen.getByRole('tab', { name: /billing/i })).toHaveAttribute('aria-selected', 'true');
```

### 8. Missing negative, error, loading, disabled, and empty states

For each component, identify the states users can observe and require meaningful coverage.

Common missing states:

- Request loading.
- Request failure.
- Empty data.
- Permission denied.
- Disabled controls.
- Invalid input.
- Boundary values.
- Dismissed or collapsed UI.
- Already-selected or duplicate action.
- Unavailable feature flag or degraded browser support.

A suite that only tests the happy path is not complete for review purposes.

### 9. Keyboard interaction missing

Flag missing keyboard coverage for:

- Dialogs.
- Menus.
- Tabs.
- Comboboxes.
- Dropdowns.
- Popovers.
- Accordions.
- Custom buttons, links, checkboxes, switches, sliders, and listboxes.

At minimum, check focus, activation, navigation, and dismissal behavior that users would expect from the component's role.

Useful assertions include:

```ts
expect(screen.getByRole('button', { name: /close/i })).toHaveFocus();
await user.keyboard('{Escape}');
expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
```

### 10. Regression fixes without failing-before-passing tests

For regression tests, require proof that the test would fail before the fix.

A good regression test:

- Names the bug symptom, not just the implementation.
- Recreates the user-visible failure.
- Fails against the old behavior.
- Passes because the bug is fixed, not because a mock was changed.
- Asserts the final observable result.

Weak regression test:

```ts
it('fixes bug', () => {
  render(<Widget fixed />);
  expect(screen.getByTestId('widget')).toBeInTheDocument();
});
```

Stronger regression test:

```ts
it('keeps the selected shipping method after editing the address', async () => {
  const user = userEvent.setup();
  render(<Checkout />);

  await user.click(screen.getByRole('radio', { name: /express shipping/i }));
  await user.click(screen.getByRole('button', { name: /edit address/i }));
  await user.type(screen.getByRole('textbox', { name: /street/i }), ' 2');
  await user.click(screen.getByRole('button', { name: /save address/i }));

  expect(screen.getByRole('radio', { name: /express shipping/i })).toBeChecked();
});
```

## Hook test review

Hook tests are valid when the hook is a reusable unit with behavior independent of a specific component. They are weak when they merely expose internal state transitions that the product never relies on directly.

Check:

- Can this hook be tested more meaningfully through a component that uses it?
- Are state changes wrapped in the correct interaction or `act` boundary?
- Does the test assert the hook's public contract rather than implementation timing?
- Are async hook updates awaited through observable result changes?
- Are providers, query clients, routers, stores, and feature flags realistic enough to preserve behavior?

Flag hook tests that:

- Assert every intermediate state but never verify the UI behavior the hook enables.
- Mock the hook's own dependencies so deeply that no meaningful logic remains.
- Treat returned function identity as important when users cannot observe it and no consumer contract requires it.

## Storybook interaction test review

A Storybook story without a `play` function is usually a render smoke test. Do not treat it as behavior coverage.

For `play` tests, check:

- The story sets up a meaningful initial state.
- The play function interacts through `canvas` queries.
- It uses accessible queries where possible.
- It asserts the result after each meaningful interaction.
- It covers component states that are hard to reach manually.
- It does not rely solely on action logger calls when user-visible output should change.

## Playwright component test review

For Playwright component tests, apply the same user-visible standard.

Check:

- Uses user-facing locators such as `getByRole`, `getByLabel`, `getByText`, or explicit stable contracts where appropriate.
- Avoids brittle CSS/XPath selectors for user-visible controls.
- Mounts the component in a realistic provider/router/theme environment.
- Uses Playwright's auto-waiting assertions on the final observable result.
- Does not replace the browser-observable behavior with Node-side mocks that cannot affect the mounted component.

## Assertion quality

Flag weak assertions:

```ts
expect(element).toBeTruthy();
expect(wrapper.exists()).toBe(true);
expect(mock).toHaveBeenCalled();
expect(container).toMatchSnapshot();
```

Prefer assertions that express user-visible outcomes:

```ts
expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();
expect(screen.getByRole('alert')).toHaveTextContent(/password is required/i);
expect(screen.getByRole('dialog', { name: /delete project/i })).toBeVisible();
expect(screen.getByRole('checkbox', { name: /email updates/i })).toBeChecked();
expect(screen.getByRole('tab', { name: /security/i })).toHaveAttribute('aria-selected', 'true');
expect(screen.getByRole('textbox', { name: /email/i })).toHaveValue('a@example.com');
```

When using `jest-dom`, prefer semantic matchers like `toBeInTheDocument`, `toBeVisible`, `toBeDisabled`, `toBeEnabled`, `toHaveFocus`, `toHaveAccessibleName`, `toHaveTextContent`, `toHaveValue`, `toBeChecked`, and `toHaveAttribute` when the attribute itself is the contract.

## Recommended static checks

When reviewing a repository, scan for these patterns. They are not automatic failures, but they deserve scrutiny.

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

For each match, ask whether the pattern is justified by the user-visible behavior under test.

## Review output format

Use this structure when reporting findings.

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

#### Major: [title]
...

### Missing behavior coverage

- [User behavior/state missing]
- [User behavior/state missing]

### Query/accessibility review

- [Where accessible queries should replace test IDs/selectors]
- [Where inability to query by role/name suggests an accessibility defect]

### Async/mocking/snapshot review

- [Async waits that do or do not wait for observable results]
- [Mocks that preserve or destroy behavior]
- [Snapshots that are useful or noisy]

### Minimum fix plan

1. [Most important test rewrite]
2. [Second]
3. [Third]
````

## Rewrite patterns

### Render-only to behavior test

Before:

```ts
it('renders checkout form', () => {
  render(<CheckoutForm />);
  expect(screen.getByTestId('checkout-form')).toBeInTheDocument();
});
```

After:

```ts
it('submits a valid checkout form and shows confirmation', async () => {
  const user = userEvent.setup();
  render(<CheckoutForm />);

  await user.type(screen.getByRole('textbox', { name: /email/i }), 'a@example.com');
  await user.type(screen.getByRole('textbox', { name: /address/i }), '10 Main St');
  await user.click(screen.getByRole('button', { name: /place order/i }));

  expect(await screen.findByRole('status')).toHaveTextContent(/order placed/i);
});
```

### Test ID to accessible query

Before:

```ts
await user.click(screen.getByTestId('delete-modal-confirm'));
```

After:

```ts
await user.click(screen.getByRole('button', { name: /delete project/i }));
```

### Mock-call wait to UI-result wait

Before:

```ts
await user.click(screen.getByRole('button', { name: /save/i }));
await waitFor(() => expect(api.save).toHaveBeenCalled());
```

After:

```ts
await user.click(screen.getByRole('button', { name: /save/i }));
expect(await screen.findByRole('status')).toHaveTextContent(/saved/i);
```

### Snapshot to explicit state assertions

Before:

```ts
expect(container.firstChild).toMatchSnapshot();
```

After:

```ts
expect(screen.getByRole('heading', { name: /billing/i })).toBeVisible();
expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
expect(screen.getByRole('alert')).toHaveTextContent(/card number is required/i);
```

## Hard rule

Do not treat a passing test, a high coverage number, or a clean snapshot as evidence of quality unless the test would fail when the user-visible behavior breaks.
