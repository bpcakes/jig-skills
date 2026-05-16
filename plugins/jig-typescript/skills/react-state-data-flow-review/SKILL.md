---
name: react-state-data-flow-review
description: Review React state ownership and data flow in TypeScript/React changes, including derived state, duplicated state, reducers, context, server/client data boundaries, async state modeling, prop drilling, external stores, optimistic updates, and cache synchronization.
---

# React State Data Flow Review

Use this skill to review React + TypeScript changes where state shape, ownership, or data movement can create drift, stale UI, redundant renders, unclear ownership, or invalid async states.

Do not use this as a general React review. Focus on how data enters the UI, where it is owned, how it is derived, how it changes, and how consumers observe those changes. Use `react-hooks-effects-review` for lifecycle/dependency/cleanup bugs and `react-hooks-component-api-review` for exported component or hook API contracts.

## Review objective

A good React state model should have one clear owner for each piece of mutable data, derive everything else as close to render as possible, and make impossible UI/data states hard to represent.

When reviewing, ask:

1. Which state is source-of-truth, and which values are derived from it?
2. Can duplicated state drift from props, URL params, cache data, server data, form state, or external stores?
3. Are async states modeled explicitly, or as loose `loading`/`error`/`data` flags?
4. Are updates expressed as domain transitions, or as scattered setter calls?
5. Does context or global state contain data that should stay local?
6. Does server/client data flow match the framework's data loading and caching model?
7. Are optimistic updates, cache invalidation, and rollback paths coherent?

## Scope discovery

Prefer the user's named files or diff. If no scope is named, inspect the current git diff first.

Record:

- Components and hooks that own state, reducers, contexts, stores, cache calls, or form data.
- Data sources: props, URL/search params, route loaders, server components/actions, query/cache libraries, external stores, local storage, sockets, and browser APIs.
- State consumers: child props, context consumers, memoized selectors, effects, event handlers, and rendered output.
- Framework/runtime assumptions: SSR, React Server Components, route loaders/actions, Suspense, query libraries, strict mode, and external store libraries.

Useful searches:

```bash
git diff --name-only
rg -n "use(State|Reducer|Context|Memo|SyncExternalStore)|createContext|Provider|selector|store|query|mutation|loader|action|useSearchParams|useParams|useForm|defaultValue|value=|set[A-Z]" . --glob '*.{ts,tsx}'
```

Do not scan the whole repository unless needed to understand an ownership boundary. Do not modify files unless the user asked for fixes.

## Core checks

### 1. Source of truth

Flag unclear or competing ownership:

- The same value is stored in props and local state without an editable draft boundary.
- URL/search params, route state, cache data, form state, or external store data is copied into local state and then manually synchronized.
- Parent and child both update the same conceptual value.
- A component keeps local state for data that is already controlled by a query/cache/store layer.
- State is reset by effects when a `key`, reducer transition, route boundary, or controlled prop would express ownership more clearly.

Preferred fixes:

- Keep one owner and pass derived values down.
- Use local draft state only for real edit/cancel flows; name it as draft state.
- Use a `key` to reset a subtree when identity changes.
- Move ownership up only when multiple peers must coordinate.
- Keep state local until there is a concrete cross-component coordination need.

### 2. Derived state and memoization

Flag state that can be computed during render:

- Filtered/sorted lists, counts, booleans, labels, selected objects, permissions, display strings, URLs, or view models derived from props/state.
- State updated immediately after render only to transform another value.
- `useMemo` used to hide unclear data flow rather than protect expensive work or stable identity.
- Derived objects stored separately and manually kept in sync.

Preferred fixes:

- Compute cheap derived values during render.
- Use `useMemo` only for expensive calculations or identity-sensitive derived values.
- Derive selected records from `selectedId` plus `items`, not by storing both.
- Normalize state only when updates genuinely become simpler or consistency improves.

### 3. Async state modeling

Flag loose async state:

- Independent `isLoading`, `error`, `data`, `empty`, `success`, or `hasLoaded` flags that can contradict each other.
- State that cannot distinguish initial load, refetch, empty result, error, stale data, optimistic data, and committed data when the UI needs those distinctions.
- Retry, cancellation, or stale response handling that can write old data into current UI.
- Server/cache data copied into local state without clear invalidation.

Prefer explicit state machines or discriminated unions when combinations matter:

```ts
type LoadState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'empty' }
  | { status: 'error'; error: Error };
```

For query libraries, prefer using the library's source-of-truth state and selectors instead of mirroring query result fields into component state.

### 4. Reducers and transitions

Flag scattered updates when several fields must change together:

- Multiple setters in one handler that represent one domain transition.
- Boolean flags that are manually toggled across many handlers.
- State updates that rely on the current closure value instead of functional updates.
- Reducers that accept vague actions such as `{ type: 'set'; payload: Partial<State> }`.
- Reducer state that mixes durable domain data, transient UI state, and derived values.

Preferred fixes:

- Use `useReducer` for multi-field transitions or event-driven state machines.
- Name actions by domain event: `submitted`, `retryClicked`, `itemSelected`, `draftReset`.
- Keep reducer state minimal and derive secondary values from it.
- Use functional updates when the next value depends on previous state.

### 5. Context, stores, and prop drilling

Flag global state misuse:

- Context values that change frequently and force broad rerenders.
- Providers that combine unrelated state, actions, and derived data into one unstable object.
- Global stores for state needed by only one route or component cluster.
- Prop drilling complaints solved by global state when composition or local providers would be simpler.
- External mutable stores read directly during render without `useSyncExternalStore` or the store library's safe React binding.

Preferred fixes:

- Split contexts by update frequency and responsibility.
- Memoize provider values only after state ownership is correct.
- Put providers as low in the tree as practical.
- Use selectors or store-specific hooks to minimize rerenders.
- Keep server/cache state in the cache layer; keep ephemeral UI state local.

### 6. Server/client and cache flow

For frameworks with server data loading, React Server Components, server actions, route loaders, or query libraries, flag:

- Fetching client-side in component state when the framework already provides route/server data.
- Duplicating server data into client state without a draft, optimistic, or offline reason.
- Optimistic updates without rollback, invalidation, or conflict handling.
- Mutations that update UI state but leave cache/server source of truth stale.
- URL/search params treated as local state when they are part of navigation or shareable state.
- Hydration-sensitive state initialized from browser-only APIs during render.

Preferred fixes:

- Use the project's established data loading and cache invalidation primitives.
- Keep shareable filters/sort/page in URL state when product behavior requires it.
- Keep server data immutable in the component unless creating an explicit draft.
- Model optimistic, pending, committed, and failed states when the UI exposes them.

## Finding severity

- **Critical**: definite state corruption, invalid render loop from state flow, stale server/cache data causing destructive user action, or impossible async state likely under normal use.
- **High**: duplicated source of truth with plausible drift, stale response overwrites current UI, broken optimistic rollback/invalidation, global store misuse affecting broad UI correctness, or controlled/local state ownership conflict.
- **Medium**: unnecessary derived state, scattered setters that should be one transition, overbroad context causing avoidable rerenders, unclear URL/cache/form ownership, or async flags that permit contradictory UI states.
- **Low**: naming, small state grouping issues, avoidable memoization, or minor prop drilling/context organization issues without clear bug.

Prefer fewer, concrete findings over architecture advice without a demonstrated failure mode.

## Output format

Return a review in this shape:

```markdown
# React state/data-flow review

Scope: <files/diff reviewed>
Verdict: <pass | needs changes | blocked by missing context>

## Findings

### [High] <file>:<line> - <component/hook/store>: <issue>
Why it matters: <specific drift, invalid state, stale data, or ownership bug>
Evidence: <current source-of-truth path and conflicting/derived state path>
Fix: <minimal ownership/modeling change>

## State map
- Source-of-truth state: <owner and consumers>
- Derived state that should stay derived: <values>
- Async/cache/server boundaries: <libraries/framework pieces involved>

## Checks performed
- Source of truth: <pass/issue>
- Derived state: <pass/issue>
- Async state: <pass/issue>
- Reducers/transitions: <pass/issue>
- Context/stores: <pass/issue>
- Server/cache flow: <pass/issue>
```

If no issues are found, say: `No state/data-flow issues found in the scoped files.` Do not claim the whole app is safe unless the whole app was reviewed.

## Patch guidance when asked to fix

When asked to fix issues:

- Prefer removing duplicated state over adding synchronization.
- Preserve public component/hook APIs unless the API is the source of the ownership bug.
- Keep state as local as possible while satisfying real coordination needs.
- Update call sites, stories, and tests affected by ownership or async-state model changes.
- Run the most relevant typecheck/test command already present in the project, or explain why it was not run.
