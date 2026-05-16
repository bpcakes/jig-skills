# Example review using `react-test-quality-review`

## Input test

```ts
it('renders delete modal', () => {
  const onDelete = vi.fn();
  render(<DeleteProjectModal open onDelete={onDelete} />);

  expect(screen.getByTestId('delete-modal')).toBeInTheDocument();
  expect(screen.getByText('Delete project')).toBeInTheDocument();
  expect(container.firstChild).toMatchSnapshot();
});
```

## Review

### Verdict

Weak / false confidence.

### Highest-risk issue

The test proves that a modal can be rendered, but it does not prove that a user can operate it. A delete modal's important behavior is confirmation, cancellation, focus, dismissal, and disabled/error handling. None of that is protected.

### Findings

#### Critical: Render-only test for an interactive destructive flow

Evidence:

```ts
expect(screen.getByTestId('delete-modal')).toBeInTheDocument();
expect(container.firstChild).toMatchSnapshot();
```

Why this is weak:

The test would still pass if the confirm button did nothing, Escape no longer closed the modal, focus was broken, or the delete error was never shown.

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

#### Major: `data-testid` hides the accessibility contract

Use `getByRole('dialog', { name: /delete project/i })`. If that query fails, the modal likely lacks an accessible name.

### Missing behavior coverage

- Cancel does not call `onDelete`.
- Escape closes the dialog when expected.
- Focus moves into the dialog and returns to the trigger.
- Delete button is disabled while deletion is pending.
- Failed deletion shows an error message.
