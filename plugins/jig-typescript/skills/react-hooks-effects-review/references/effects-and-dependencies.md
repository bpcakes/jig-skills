# Effects, purity, and dependencies

These checks apply only within the requested review. Patterns are investigation signals: confirm consequences and examine safeguards before reporting; assign severity by impact, not syntax.

### 2. Classify every Effect

For each Effect, state what it synchronizes with.

Valid external systems include browser APIs, DOM APIs, timers, subscriptions, sockets, external stores, network requests, analytics, storage, third-party widgets, media APIs, workers, and imperative libraries.

Flag Effects that are only doing React-internal data flow:

- Deriving `fullName`, filtered/sorted lists, booleans, counts, labels, URLs, permissions, or view models from props/state.
- Copying props to state without a real editable local draft boundary.
- Resetting local state from props where a `key`, controlled state, reducer action, or render-time derivation would be clearer.
- Responding to a user action after the fact instead of doing the work inside the event handler that knows what happened.
- Setting synchronous state immediately in an Effect just to transform values for display.

Preferred fixes:

- Compute during render.
- Use `useMemo` only for expensive computation or identity-sensitive derived values.
- Move event-caused logic to the event handler.
- Use a `key` to reset a subtree when identity changes.
- Use `useReducer` when the state transition itself is complex.
- Use framework/server data APIs when the project already has them and the Effect is only ad hoc data loading.

### 3. Check render purity

Render must be deterministic for the same props, state, and context. Flag side effects during render, including:

- `setState`, dispatch, store writes, ref writes, global/module mutation, cache mutation visible outside the render, or prop/state mutation.
- Timers, subscriptions, `addEventListener`, sockets, observers, analytics, logging that changes external state, navigation, DOM reads/writes, focus, scroll, storage writes, network calls.
- Non-deterministic render output from `Date.now()`, `new Date()`, `Math.random()`, generated IDs, or browser-only reads when SSR/hydration is involved.
- Defining component or hook factories inside render when it resets state or changes component identity.

Allow local mutation of freshly created values that do not escape the render, such as pushing into a local array created during the same render.

Allow the narrow ref initialization pattern only when it is deterministic and one-time, for example `if (ref.current === null) ref.current = new StableThing(...)`, and the result does not depend on changing props/state in a way that changes rendered output.

### 4. Audit dependency arrays

For each `useEffect`, `useLayoutEffect`, `useInsertionEffect`, `useMemo`, and `useCallback`:

- Identify every reactive value read inside: props, state, context, local variables, local functions, derived values, and imported values that are not proven stable.
- Verify all reactive values are listed unless there is a valid stable exception.
- Treat missing dependencies as stale-closure bugs, not style nits.
- Treat extra unstable dependencies as churn bugs if they cause unnecessary reconnects, refetches, resubscriptions, recomputation, or render loops.
- Do not accept `// eslint-disable-next-line react-hooks/exhaustive-deps` without a concrete explanation and safer alternative considered.
- Do not accept an empty array just because the author wants “run once.” Empty dependencies are valid only when the body does not read changing reactive values or when the values are intentionally stable by construction.

Stable or special cases:

- State setter functions and reducer dispatch functions are stable.
- Ref object identity is stable, but `ref.current` is mutable and non-reactive; do not put `ref.current` in a dependency array expecting React to track it.
- Module-level constants are stable if they are not mutated.
- `useEffectEvent` callbacks are non-reactive and must be omitted from Effect dependencies, but only when the project's React version supports the hook and the logic is genuinely an Effect event.

If dependencies are unstable objects/functions created in render:

- Prefer moving object/function creation inside the Effect if only the Effect uses it.
- Prefer depending on primitive fields rather than entire objects when semantics match.
- Use `useMemo`/`useCallback` when identity stability is required by a child, memoized dependency, subscription, or external API.
- Lift constants outside the component when they do not depend on props/state.
- Do not memoize blindly just to silence the linter.
