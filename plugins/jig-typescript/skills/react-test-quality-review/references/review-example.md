# Example review using `react-test-quality-review`

## Input test

```ts
it('renders delete modal', () => {
  const onDelete = vi.fn();
  const { container } = render(<DeleteProjectModal open onDelete={onDelete} />);

  expect(screen.getByTestId('delete-modal')).toBeInTheDocument();
  expect(screen.getByText('Delete project')).toBeInTheDocument();
  expect(container.firstChild).toMatchSnapshot();
});
```

## Review

Assume repository inspection establishes that this is the only deletion-flow test, confirming deletion must invoke `onDelete`, and no integration test covers that operation. Without those facts, report a coverage limitation and investigate rather than assuming a defect from this excerpt.

### Verdict

Weak / false confidence.

### Highest-risk issue

The suite does not protect the required confirmation operation: replacing its click handler with a no-op leaves all three assertions unchanged, while users can no longer delete a project. Other modal behaviors below require checking their actual contracts and coverage before making additional findings.

### Findings

#### Medium: Deletion can stop working without a failing test

Evidence:

```ts
expect(screen.getByTestId('delete-modal')).toBeInTheDocument();
expect(container.firstChild).toMatchSnapshot();
```

Why this is weak:

Removing the confirmation handler changes neither initial DOM nor snapshot. Given the inspected absence of other confirmation coverage, that bounded operation failure survives the suite. The severity follows this consequence, not the presence of a snapshot or test ID.

What to test instead:

```ts
it('confirms deletion and shows completion state', async () => {
  const user = userEvent.setup();
  const onDelete = vi.fn().mockResolvedValue(undefined);
  render(<DeleteProjectModal open onDelete={onDelete} />);

  expect(screen.getByRole('dialog', { name: /delete project/i })).toBeVisible();

  await user.click(screen.getByRole('button', { name: /delete project/i }));

  expect(onDelete).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole('status')).toHaveTextContent(/project deleted/i);
});
```

### Optional query improvement and counterexample

`getByRole('dialog', { name: /delete project/i })` can make this assertion express an accessibility contract. The test ID alone is not a finding. If a separate test already verifies the required dialog role/name, and interaction tests protect confirmation and cancellation, retaining this smoke test warrants no defect report. Investigate an actual missing accessible name before making an accessibility finding.

### Additional behavior to investigate, not assumed missing coverage

- Cancel does not call `onDelete`.
- Escape closes the dialog when expected.
- Focus moves into the dialog and returns to the trigger.
- Delete button is disabled while deletion is pending.
- Failed deletion shows an error message.
