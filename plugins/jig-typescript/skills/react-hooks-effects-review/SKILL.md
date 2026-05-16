---
name: react-hooks-effects-review
description: Review React hooks, Effects, refs, custom hooks, render purity, dependency correctness, stale closures, cleanup, and state synchronization in scoped TypeScript/React changes.
---

# React Hooks and Effects Review

## Purpose

Use this skill to review scoped React/TypeScript changes for lifecycle, hook, Effect, ref, memoization, and synchronization bugs that type checking does not reliably catch.

The review should answer one question: **does this code respect React's render model, or is it smuggling lifecycle/state synchronization bugs past TypeScript?**

## Use when

Use this skill for changes involving any of the following:

- `useEffect`, `useLayoutEffect`, `useInsertionEffect`, `useEffectEvent`, `useMemo`, `useCallback`, `useRef`, `useState`, `useReducer`, `useSyncExternalStore`, `useImperativeHandle`, or custom hooks.
- Event handlers that capture props/state and later run async work.
- Timers, subscriptions, sockets, observers, DOM listeners, browser APIs, external stores, data fetching, media APIs, workers, or third-party imperative widgets.
- Ref usage, imperative handles, forwarded refs, callback refs, focus/measurement, or DOM mutation.
- Derived state, prop-to-state synchronization, reset-on-prop-change logic, memoization, or cached calculations.
- Review requests mentioning stale closures, dependency arrays, cleanup, render loops, Strict Mode, hydration, or hook rules.

## Do not use when

Do not use this as a general React review. If the change is only about styling, static markup, TypeScript types, routing config, server-only code, or business logic with no hook/render lifecycle surface, use a narrower skill instead.

## Default review stance

React bugs usually hide in timing, identity, and ownership. Be skeptical of code that tries to “sync” React state with itself.

Default hierarchy for fixes:

1. **Remove the Effect** if the value can be computed during render or handled in the initiating event handler.
2. **Make the Effect honest** if it truly synchronizes with an external system: complete dependencies, mirrored cleanup, race protection, stable semantics.
3. **Restructure ownership** if state is duplicated, controlled/uncontrolled boundaries are blurred, or a custom hook leaks implementation details.
4. **Use refs only for non-rendered mutable values** such as DOM nodes, timer IDs, request tokens, or imperative handles. Do not use refs to hide UI state from React.
5. **Memoize only for identity/performance needs**, not to silence dependency warnings or paper over a confused data flow.

## Review workflow

For source-backed React and Codex skill guidance, see `references/official-react-guidance.md` when you need to verify the basis for these review rules. Do not load it for routine reviews unless the task is ambiguous or the user asks for sources.

### 1. Establish scope

Prefer the user-specified files or diff. If no scope is specified, inspect the current git diff first. Do not scan the whole repository unless needed to understand a custom hook or external API boundary.

Record:

- Changed React components and custom hooks.
- React version and whether `useEffectEvent` is available before recommending it.
- Existing lint setup, especially `eslint-plugin-react-hooks` and whether `exhaustive-deps`, `rules-of-hooks`, `refs`, `set-state-in-render`, and `set-state-in-effect` are enabled.
- Whether the project uses SSR, Server Components, framework data loading, React Compiler, Strict Mode, or external stores.

Useful commands when available:

```bash
git diff --name-only
rg "use(Effect|LayoutEffect|InsertionEffect|EffectEvent|Memo|Callback|Ref|State|Reducer|SyncExternalStore|ImperativeHandle)\b|function use[A-Z]" .
```

Run lint/tests only when the repository already has clear scripts and the review scope justifies it. Do not modify files unless the user asked for fixes.

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

### 5. Hunt stale closures

Look for callbacks that run later than the render that created them:

- `setTimeout`, `setInterval`, `requestAnimationFrame`, `requestIdleCallback`.
- Promise chains, `async` handlers, fetch callbacks, retries, debounced/throttled functions.
- DOM/event emitter listeners, sockets, observers, workers, external store subscriptions.
- Third-party APIs that store callbacks.
- Memoized callbacks passed to children or hooks.

Flag stale closure risks when the delayed callback reads props/state/context that can change before it runs.

Preferred fixes:

- Use functional state updates when the next state only depends on previous state: `setCount(c => c + 1)`.
- Include reactive values in dependencies and recreate the subscription/timer when synchronization should change.
- Use `useEffectEvent` for non-reactive Effect event logic in React versions that support it.
- Use a ref as a latest-value cell only when the value is not itself rendered by that ref and the pattern is localized, documented, and kept in sync.
- Use `AbortController`, a request sequence ID, or an `ignore` flag for async races.
- Move event-specific logic into the event handler rather than an Effect.

### 6. Verify cleanup and reversibility

Every Effect that starts, subscribes, schedules, connects, observes, listens, opens, locks, or mutates an external system must return cleanup unless the external API is self-contained and cannot outlive the component.

Check cleanup for:

- `setInterval` / `clearInterval`.
- `setTimeout` / `clearTimeout` when pending work can fire after unmount or dependency change.
- `requestAnimationFrame` / `cancelAnimationFrame`.
- DOM `addEventListener` / `removeEventListener` with the same target, event type, handler identity, and options semantics.
- `ResizeObserver`, `IntersectionObserver`, `MutationObserver`, media query listeners, geolocation watches.
- WebSocket/EventSource connections, RxJS/EventEmitter subscriptions, BroadcastChannel, workers, WebRTC, media streams.
- Fetches and async requests with abort or ignore-on-settle protection.
- Third-party imperative widgets that require destroy/dispose/reset/unmount.
- Body/document mutations such as scroll locking, classes, global attributes, or focus traps.

Cleanup must mirror setup and tolerate Strict Mode's development setup-cleanup-setup cycle. It should be idempotent or safely callable after partial setup failure.

Do not mark `useEffect(async () => ...)` as valid. The Effect callback itself should be synchronous and may define/call an async function inside it.

### 7. Detect render and Effect loops

Flag:

- Unconditional `setState` or dispatch during render.
- State updates in render guarded by conditions that can still oscillate or hide derived state problems.
- Effects that synchronously set state and list that same state as a dependency without a terminating condition.
- Effects that write a value which changes an unstable dependency, causing reconnect/refetch/recompute loops.
- Effects that mirror props into state and then re-trigger on both prop and state changes.
- `useMemo`/`useCallback` dependencies that are recreated every render, defeating the memo.

Preferred fixes:

- Derive in render.
- Use reducer transitions or event handlers.
- Store previous values only when there is a real previous/current semantic and guard it explicitly.
- Split one overloaded Effect into independent Effects by external system and dependency set.
- Move non-reactive reads into `useEffectEvent` where available and appropriate.

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

## Finding severity

Use this rubric:

- **Critical**: definite crash, infinite render loop, invalid hook call order, state corruption, or user-visible data race likely under normal use.
- **High**: missing cleanup for long-lived external resources, stale closure that can show wrong data or call wrong API, side effect in render, unsafe async request race, or ref misuse that hides render-driving state.
- **Medium**: unnecessary Effect causing duplicate renders, unstable dependency causing avoidable reconnect/refetch/resubscribe, overbroad custom hook API, duplicated state with plausible drift.
- **Low**: minor over-memoization, unclear dependency rationale, small maintainability issue, or lint configuration gap with no immediate bug shown.

Prefer fewer, sharper findings over checklist noise. If a pattern is safe, do not flag it just because it looks unusual; explain the invariant if it is worth noting.

## Output format

Return a review in this shape:

```markdown
# React hooks/effects review

Scope: <files/diff reviewed>
Verdict: <pass | needs changes | blocked by missing context>

## Findings

### [High] <file>:<line> — <component/hook>: <issue>
Why it matters: <specific lifecycle/render bug, not vague style>
Evidence: <exact code behavior or dependency/cleanup path>
Fix: <minimal change; prefer removing Effects when possible>

## Lifecycle notes
- Effects that should stay: <external systems and dependencies>
- Effects that should be removed/simplified: <derived state/event logic>
- Cleanup/race assumptions: <what must hold>

## Checks performed
- Render purity: <pass/issue>
- Dependencies: <pass/issue>
- Stale closures: <pass/issue>
- Cleanup: <pass/issue>
- Refs: <pass/issue>
- Custom hooks: <pass/issue>
- Lint support: <configured/missing/not checked>
```

If no issues are found, say: `No hook/effect lifecycle issues found in the scoped files.` Still include scope and checks performed. Do not claim the whole app is safe unless the whole app was reviewed.

## Patch guidance when asked to fix

When the user asks for fixes, make the smallest lifecycle-correct change:

- Prefer deletion of unnecessary Effects over dependency hacks.
- Preserve public component/hook APIs unless the API itself is the bug.
- Add cleanup and race guards where external systems are involved.
- Do not add `eslint-disable` comments unless the user explicitly requires it and the invariant is documented inline.
- After changes, run the most relevant lint/test command already present in the project, or explain why it was not run.

## Hard noes

Do not recommend these as primary fixes:

- “Add `[]` so it only runs once” when reactive values are read.
- “Remove the dependency to stop rerenders” without restructuring the code.
- “Store it in a ref” to avoid React reactivity for UI state.
- “Wrap everything in `useCallback`/`useMemo`” as a blanket solution.
- Side effects during render because “it works.”
- Custom hooks that conditionally call other hooks.
- Async Effect callbacks returned directly to React.
