---
name: react-hooks-effects-review
description: Review React hooks, Effects, and refs for stale closures, lifecycle, cleanup, dependency, and render-purity bugs.
---

# React Hooks and Effects Review

Apply this skill when it serves the user's requested task and target. Discovery or a code change does not authorize an additional review, refactor, or broader scan. For review-only requests, report findings without editing; implement changes only when they are part of the user's request.

Treat checklist patterns, counts, and missing comments as investigation signals. Report a defect only after tracing a concrete consequence and checking counterevidence in callers, invariants, tests, and configuration. Missing context is a limitation, not a finding. Assign severity from impact and reachability; keep optional preferences separate and allow no findings.

## Purpose

Use this skill to review scoped React/TypeScript changes for lifecycle, hook, Effect, ref, memoization, and synchronization bugs that type checking does not reliably catch.

The review should answer one question: **does this code respect React's render model, or is it smuggling lifecycle/state synchronization bugs past TypeScript?**

## Use when

Within a requested lifecycle review, inspect relevant changes involving:

- `useEffect`, `useLayoutEffect`, `useInsertionEffect`, `useEffectEvent`, `useMemo`, `useCallback`, `useRef`, `useState`, `useReducer`, `useSyncExternalStore`, `useImperativeHandle`, or custom hooks.
- Event handlers that capture props/state and later run async work.
- Timers, subscriptions, sockets, observers, DOM listeners, browser APIs, external stores, data fetching, media APIs, workers, or third-party imperative widgets.
- Ref usage, imperative handles, forwarded refs, callback refs, focus/measurement, or DOM mutation.
- Derived state, prop-to-state synchronization, reset-on-prop-change logic, memoization, or cached calculations.
- Review requests mentioning stale closures, dependency arrays, cleanup, render loops, Strict Mode, hydration, or hook rules.

## Do not use when

Do not use this as a general React review. If the change is only about styling, static markup, TypeScript types, routing config, server-only code, or business logic with no hook/render lifecycle surface, stay within the user's task; suggest a narrower review only if it is useful.

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

### Select checks by lifecycle concern

- Effects, derivation, render purity, or dependencies: read [Effects and dependencies](references/effects-and-dependencies.md).
- Delayed callbacks, async races, cleanup, or repeated renders: read [closures, cleanup, and loops](references/closures-cleanup-and-loops.md).
- Refs, hook APIs, external stores, or browser widgets: read [refs and integrations](references/refs-and-integrations.md).

Read only the references needed for the scoped code.

## Finding severity

Use this rubric:

- **Critical**: definite crash, infinite render loop, invalid hook call order, state corruption, or user-visible data race likely under normal use.
- **High**: missing cleanup for long-lived external resources, stale closure that can show wrong data or call wrong API, side effect in render, unsafe async request race, or ref misuse that hides render-driving state.
- **Medium**: a traced Effect or dependency path causing materially disruptive repeated work, or state duplication that demonstrably breaks synchronization. Extra renders or broad APIs alone are not defects.
- **Low**: a demonstrated user-visible or operational failure with limited impact. Missing dependency comments, lint configuration gaps, and minor over-memoization without such a consequence belong in optional improvements or questions, not findings.

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
