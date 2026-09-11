# Refs, custom hooks, and browser integrations

These checks apply only within the requested review. Patterns are investigation signals: confirm consequences and examine safeguards before reporting; assign severity by impact, not syntax.

### 8. Review refs

Refs are for mutable values that do not drive rendering. Flag:

- Reading or writing `ref.current` during render except deterministic one-time initialization.
- Storing visible UI state, derived render data, validation state, loading state, selected items, or props snapshots in refs instead of state/reducer.
- Using refs to bypass dependency arrays without explaining why the logic is intentionally non-reactive.
- Depending on `ref.current` in dependency arrays as if React will re-render when it changes.
- Mutating objects held in refs that are also rendered from state/props.
- Passing refs across custom hook/component boundaries in a way that leaks internals or makes ownership unclear.
- Imperative handles that expose too much internal state or methods that conflict with controlled props.

Accept refs for DOM nodes, timer/request IDs, imperative library instances, latest callback cells, measurement targets, and cancellation tokens when they are used in handlers/effects and do not hide render-driving state.

### 9. Review custom hooks

Custom hooks should make lifecycle logic safer, not more obscure.

Check that custom hooks:

- Are named `useX` and only called from React components or other hooks.
- Call hooks unconditionally at the top level, never in conditions, loops, callbacks, async functions, class methods, or after early returns.
- Expose a declarative API: inputs describe what to synchronize with; outputs return state and stable actions where appropriate.
- Hide setup/cleanup details instead of forcing every caller to remember lifecycle rules.
- Do not leak mutable refs, raw subscription handles, or internal setters unless the abstraction explicitly requires imperative control.
- Own their cleanup and race handling internally.
- Preserve dependency correctness inside the hook; callers should not need to know about hidden dependencies.
- Use `useSyncExternalStore` when reading and subscribing to an external mutable store that affects rendered output.
- Avoid returning unstable object/function identities unless that is intentional or memoized for consumers that depend on identity.

For custom hook rule violations, do not propose “just move the hook call into a condition.” Restructure the hook/component so hooks are always called in the same order and conditional behavior happens inside the hook body or returned JSX.

### 10. Review browser/API integration

For code that touches browser or external APIs:

- Ensure browser-only APIs are not read during SSR render unless guarded by client-only boundaries or lazy client behavior.
- Use `useLayoutEffect` only for layout measurement or visual mutation that must happen before paint; otherwise prefer `useEffect`.
- Use callback refs or layout effects for DOM measurement when timing matters.
- Ensure event listener options and handler identity make cleanup actually remove the listener.
- Ensure external subscriptions do not call `setState` after unmount or after their input key has changed.
- Ensure data fetching protects against out-of-order responses and dependency changes.
- Ensure third-party widgets are updated incrementally when props change and destroyed on cleanup.
