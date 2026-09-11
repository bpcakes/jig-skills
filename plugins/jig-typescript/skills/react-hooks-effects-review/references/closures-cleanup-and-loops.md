# Closures, cleanup, and loops

These checks apply only within the requested review. Patterns are investigation signals: confirm consequences and examine safeguards before reporting; assign severity by impact, not syntax.

### 5. Hunt stale closures

Look for callbacks that run later than the render that created them:

- `setTimeout`, `setInterval`, `requestAnimationFrame`, `requestIdleCallback`.
- Promise chains, `async` handlers, fetch callbacks, retries, debounced/throttled functions.
- DOM/event emitter listeners, sockets, observers, workers, external store subscriptions.
- Third-party APIs that store callbacks.
- Memoized callbacks passed to children or hooks.

Investigate delayed callbacks reading changing values. Report when the contract requires fresh values and the captured snapshot produces wrong behavior; intentional event-time snapshots are counterevidence.

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
