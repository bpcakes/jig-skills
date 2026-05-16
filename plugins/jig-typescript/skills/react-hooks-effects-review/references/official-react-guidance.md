# Source basis for `react-hooks-effects-review`

Researched on 2026-05-16 from official OpenAI and React documentation.

## Codex skill structure

- OpenAI Codex Agent Skills: a skill is a directory with a required `SKILL.md`; `SKILL.md` includes `name` and `description`; optional scripts/references/assets can live beside it.
- OpenAI Codex best practices: keep each skill scoped to one job, define clear inputs/outputs, and write the description with concrete trigger phrases.

## React lifecycle and hook guidance

- `useEffect` synchronizes a component with an external system. React runs cleanup before rerunning changed Effects and after unmount.
- If code is not synchronizing with an external system, React's docs advise that an Effect is probably unnecessary.
- Effects should declare all reactive dependencies. Missing dependencies cause stale closures.
- Effects that subscribe/connect/listen/fetch often need cleanup: disconnect, unsubscribe, remove listener, cancel, abort, or ignore stale results.
- Components and hooks must be pure. Side effects should run in event handlers or Effects, not during render.
- Unconditional state updates during render cause additional renders and can create infinite loops.
- Synchronous state updates in Effects often create avoidable extra render passes when the value can be derived during render.
- Refs hold values not needed for rendering. Changing `ref.current` does not trigger a render, so refs should not hold visible UI state.
- Reading/writing refs during render is unsafe except narrow deterministic one-time initialization.
- Hooks must be called in the same order on every render: not conditionally, in loops, in callbacks, in async functions, after early returns, at module level, or in classes.
- `useEffectEvent` can separate non-reactive Effect event logic from reactive synchronization in React versions that support it, but it must not be used to dodge dependencies.
