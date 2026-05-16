# React Render Performance Rules

Use these rules when reviewing React components, hooks, providers, lists, client components, or memoization changes for render-path performance. The goal is not to add `useMemo`, `useCallback`, or `React.memo` everywhere. The goal is to identify real render costs, identity churn that crosses meaningful boundaries, subtree invalidation, remounts, repeated derivations, and avoidable client JavaScript.

## Core stance

React render performance is a measurement and structure problem first, a memoization problem second.

Prefer these before manual memoization:

1. Keep render logic pure and idempotent.
2. Move state down or colocate it with the interaction that needs it.
3. Push provider boundaries down and split context by update frequency or concern.
4. Avoid broad client component boundaries that pull heavy code into the browser.
5. Use stable, data-derived keys that preserve identity.
6. Virtualize large lists that create DOM, render, layout, or scroll cost.
7. Compute shared derived data once at the right owner or selector layer.
8. Measure before and after changes.

React Compiler changes the default recommendation when it is enabled for the project or the repo is actively adopting it. In that case, assume many local values and functions can be automatically memoized. Manual `useMemo`, `useCallback`, and `React.memo` are escape hatches for measured cases, interoperability boundaries, context values, hook dependencies, cross-component caches, or code the compiler cannot safely optimize.

Never use memoization to make impure render logic acceptable. A memo callback must be pure. If a calculation mutates props, writes to external state, subscribes, logs analytics, performs I/O, reads non-idempotent values like `Date.now()` or `Math.random()` during render, or triggers React state updates, the fix is purity and placement, not memoization.

Always separate:

- **Measured cost**: profiler timing, production timing, bundle report, flamegraph, reproduction.
- **Likely cost**: large list, broad context invalidation, heavy import in a client bundle, repeated sorting/filtering.
- **Noise**: cheap inline values, harmless functions, `useMemo` around literals, memoized components whose props always change.

## Fast discovery commands

Run searches like these when reviewing a codebase:

```bash
rg -n "useMemo|useCallback|memo\(|createContext|useContext|Provider|value=\{\{|key=|\.map\(|\.filter\(|\.sort\(|'use client'|\"use client\"" .
rg -n "Math\.random\(|Date\.now\(|new Date\(|crypto\.randomUUID\(|JSON\.parse\(|JSON\.stringify\(" .
rg -n "from ['\"](lodash|moment|date-fns|dayjs|chart|recharts|d3|prism|shiki|markdown|monaco|framer-motion|@mui/icons-material)" .
rg -n "new Intl\.|Intl\.|RegExp\(|structuredClone\(|Object\.fromEntries\(|Array\.from\(" .
```

Also inspect:

- `package.json`, `next.config.*`, `vite.config.*`, `babel.config.*`, and compiler config for React Compiler usage.
- Next.js App Router client boundaries marked by `'use client'`.
- Bundle analyzer output when reviewing client imports.
- Existing profiling traces or regressions attached to the issue or PR.

## Review workflow

1. **Identify the slow path.** Name the exact interaction, route, component, list, provider, or prop change under review.
2. **Establish evidence.** Prefer React DevTools Profiler, `<Profiler>`, production builds, user-like devices, CPU throttling, bundle analyzer output, or `console.time` around a suspected pure calculation. Do not rely only on development Strict Mode behavior.
3. **Find the update source.** Determine whether the render starts from local state, parent state, context propagation, effects that derive state, route changes, external store updates, key changes, or client bundle execution.
4. **Classify the bottleneck.** Use the categories below: expensive render work, list size, context/provider invalidation, identity churn, remounting keys, redundant derivation, unnecessary client JavaScript, or useless memoization.
5. **Choose the smallest structural fix.** Prefer moving state, splitting components, splitting context, pushing providers down, virtualizing, moving static work server-side, or calculating once at the right owner before adding memoization.
6. **Validate before and after.** State what changed in render count, commit duration, interaction latency, list responsiveness, bundle size, or remount behavior. If no measurement is available, say so and mark the recommendation as inferred.

## Checks and fixes

### 1. Expensive calculations during render

Flag render-path work such as:

- Filtering, sorting, grouping, aggregating, or mapping large arrays.
- Repeated date formatting, number formatting, markdown parsing, syntax highlighting, schema validation, chart data shaping, deep cloning, deep equality, `JSON.parse`, or `JSON.stringify`.
- Calling `sort()` on props, state, or data from a cache without copying first.
- Repeating the same derived calculation in siblings or nested components.
- Effects that derive render data into state and trigger a second render.

Prefer this fix order:

1. Remove redundant state and effects. Calculate render data directly when it is cheap.
2. Move shared derivation to the common owner, selector, query layer, server component, loader, or external cache.
3. Normalize data so the render path is lookup-based instead of repeatedly scanning.
4. For truly heavy pure calculations that only need to update when specific inputs change, use `useMemo` as a measured optimization.
5. For calculations shared across multiple component instances, use an external memoized selector or cache keyed by stable inputs rather than per-component `useMemo`.

Bad:

```tsx
function ProductList({ products, query, sortBy }) {
  const visible = products
    .filter(product => product.name.includes(query))
    .sort((a, b) => compareProducts(a, b, sortBy));

  return visible.map(product => <ProductRow key={product.id} product={product} />);
}
```

Better when the calculation is heavy or repeated:

```tsx
function ProductList({ products, query, sortBy }) {
  const visible = useMemo(() => {
    return products
      .filter(product => product.name.includes(query))
      .toSorted((a, b) => compareProducts(a, b, sortBy));
  }, [products, query, sortBy]);

  return visible.map(product => <ProductRow key={product.id} product={product} />);
}
```

But do not recommend the `useMemo` version unless the list is large enough, the calculation is actually expensive, `products` has stable identity, and the optimization is visible on update paths. If the same filtering/sorting is repeated across components, compute it once higher up instead.

### 2. Large lists without virtualization or stable keys

Flag:

- Long lists rendered fully when only a viewport slice is visible.
- Rows with expensive children, images, charts, editors, or layout-heavy DOM.
- `key={index}` in dynamic lists that can insert, delete, filter, sort, or reorder.
- `key={Math.random()}`, `key={Date.now()}`, `key={crypto.randomUUID()}`, or keys generated during render.
- Keys tied to mutable labels, display text, array position, filter state, or sort order.

Fix:

- Use stable IDs from the data model.
- Add IDs at data creation time, not during render.
- Use virtualization/windowing for genuinely large or expensive lists.
- Keep row props minimal and stable where rows are memoized.
- Preserve stable `itemKey` or equivalent when using virtualization.

Bad:

```tsx
{items.map((item, index) => (
  <Row key={index} item={item} />
))}
```

Better:

```tsx
{items.map(item => (
  <Row key={item.id} item={item} />
))}
```

Do not overstate virtualization. Small lists do not need it. Use it when DOM count, row render cost, layout, memory, or scrolling performance is the bottleneck.

### 3. Context values recreated every render

Flag provider values that create new objects or functions on every parent render:

```tsx
<AuthContext value={{ currentUser, login }}>
  {children}
</AuthContext>
```

This invalidates consumers because the context value identity changes. `React.memo` on the consumer does not block re-rendering caused by changed context.

Use the provider syntax that matches the project's React version: React 19 supports `<SomeContext value={...}>`, while older versions use `<SomeContext.Provider value={...}>`.

Fix order:

1. Confirm whether the provider changes frequently and how many consumers it invalidates.
2. Split unrelated context values, especially by update frequency.
3. Push providers closer to the subtree that needs them.
4. Pass primitives or stable dispatch functions where possible.
5. Memoize the provider value only when the provider boundary and context shape are otherwise appropriate.

Acceptable targeted fix:

```tsx
function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  const login = useCallback((credentials: Credentials) => {
    return authenticate(credentials).then(setCurrentUser);
  }, []);

  const value = useMemo(() => ({ currentUser, login }), [currentUser, login]);

  return <AuthContext value={value}>{children}</AuthContext>;
}
```

Do not stop at this fix if a high-frequency value, such as cursor position, search text, hover state, or animation state, lives in a provider above a large app subtree. Split or move that provider.

### 4. Provider boundaries that invalidate huge subtrees

Flag:

- App-wide providers containing state that changes on every keystroke, hover, resize, scroll, animation frame, or polling tick.
- Provider stacks wrapped around the whole app when only one route or panel needs the data.
- Mixed contexts where slow-changing identity, fast-changing UI state, permissions, preferences, and actions all share one value object.
- Providers placed high in a Next.js App Router tree that force large regions into client rendering.

Fix:

- Move state to the smallest owner that needs it.
- Split providers by change frequency and consumer set.
- Move providers deeper.
- Keep static layout outside volatile providers.
- Use external stores or selector-based subscriptions when many consumers need small slices of fast-changing state.
- In Next.js, keep server-renderable shells as Server Components and put client providers as deep as practical.

### 5. Inline object/function props passed to memoized children

Inline values are not inherently bad. They matter when identity is consumed by a boundary that checks identity.

Flag inline objects, arrays, and callbacks only when they cross one of these boundaries:

- A `React.memo` child.
- A hook dependency array.
- A context provider value.
- A selector, cache key, or external store subscription.
- A virtualization row prop where identity triggers row re-rendering.
- A heavy third-party component that performs shallow prop checks.

Bad when `ExpensiveChart` is memoized or shallow-compares props:

```tsx
<ExpensiveChart
  data={data}
  options={{ theme, stacked: true }}
  onPointClick={() => selectPoint(activeSeriesId)}
/>
```

Better structural option:

```tsx
<ExpensiveChart
  data={data}
  theme={theme}
  stacked
  activeSeriesId={activeSeriesId}
  onPointClick={selectPoint}
/>
```

Targeted memoization option when the child API cannot change and profiling shows it matters:

```tsx
const chartOptions = useMemo(() => ({ theme, stacked: true }), [theme]);
const handlePointClick = useCallback(() => {
  selectPoint(activeSeriesId);
}, [selectPoint, activeSeriesId]);

<ExpensiveChart data={data} options={chartOptions} onPointClick={handlePointClick} />;
```

Do not recommend this for cheap children, un-memoized children, or components that must re-render anyway because state or context changed.

### 6. `memo`, `useMemo`, and `useCallback` used without a measurable reason

Audit existing memoization. Remove or discourage it when it adds complexity without preventing real work.

#### `React.memo`

Valid when all are true:

- The child re-renders often with the same props.
- The child render is expensive enough to matter.
- Props are stable or can be made stable without contorting the code.
- Context changes are not invalidating the child anyway.

Weak or harmful when:

- Props always include new objects/functions.
- The component reads frequently changing context.
- The render is cheap.
- A custom comparator is slower or less correct than rendering.
- The comparator ignores function props and risks stale closures.

#### `useMemo`

Valid when at least one is true:

- A pure calculation is measured or clearly large enough to be costly on updates.
- The memoized value is passed to a memoized child and would otherwise break a useful skip.
- The value is a dependency of another hook and stabilizing it avoids unnecessary work.
- The value is a context provider value after the context boundary has been shaped correctly.

Weak or harmful when:

- It wraps cheap literals, trivial object creation, or simple arithmetic.
- Dependencies change every render.
- The component is slow for reasons unrelated to that calculation.
- It hides mutation, side effects, or non-idempotent reads.
- It is used as a semantic guarantee. `useMemo` is a cache, not state.

#### `useCallback`

Valid when at least one is true:

- The function is passed to a memoized child and function identity is the reason it cannot skip.
- The function is used as a dependency of another hook and stabilizing it prevents real repeated work.
- The function is part of a context value that would otherwise invalidate consumers.

Weak or harmful when:

- No consumer checks function identity.
- Dependencies change every render.
- The callback makes dependency management harder than moving logic into an event, effect, reducer, or child.
- It is used under the false belief that it avoids creating a function. React still receives a function; `useCallback` lets React return a cached one when dependencies are unchanged.

### 7. `useMemo` hiding impure logic

Flag this immediately:

```tsx
const result = useMemo(() => {
  analytics.track('calculated');
  cache.set(input.id, input);
  return expensiveCalculate(input);
}, [input]);
```

Fix:

```tsx
const result = useMemo(() => expensiveCalculate(input), [input]);

useEffect(() => {
  analytics.track('calculated');
}, [input.id]);
```

Or move the side effect into the event that caused the change. Do not mutate props, state, external caches, refs used by render, or global objects during render.

### 8. Key misuse causing remounts and state loss

Flag:

```tsx
<Form key={selectedUser.name} user={selectedUser} />
<Row key={Math.random()} row={row} />
<TabPanel key={activeTab + Date.now()} />
```

Explain the cost precisely:

- React treats a changed key as a different component identity.
- Local state resets.
- Inputs can lose focus or typed text.
- Effects clean up and re-run.
- DOM is recreated instead of updated.

Use intentional key changes only when resetting state is the desired behavior:

```tsx
<ProfileForm key={selectedUser.id} userId={selectedUser.id} />
```

### 9. Bundle-heavy imports inside client components

For Next.js, React Server Components, or any split client/server app, inspect imports inside files marked `'use client'` and anything they import.

Flag:

- A high-level layout, page shell, or provider marked `'use client'` when only a small widget needs interactivity.
- Markdown parsing, syntax highlighting, chart data transformation, search indexing, schema generation, or heavy date manipulation in client components when it could run on the server.
- Large icon packages, component libraries, animation libraries, editors, maps, charts, or syntax highlighters imported into initial client bundles.
- Broad barrel imports that defeat tree-shaking or pull unused modules.

Fix:

- Push `'use client'` down to the smallest interactive component.
- Keep static shells, data shaping, markdown/syntax transforms, and expensive formatting in Server Components or loaders when possible.
- Dynamically import interaction-only heavy widgets.
- Use bundle analyzer output to target actual large modules.
- Use package import optimization only after confirming import-chain cost.

### 10. Repeated derived filtering/sorting across components

Flag duplicate derivations like:

```tsx
const activeUsers = users.filter(user => user.active).sort(byName);
```

appearing in multiple siblings, rows, panels, hooks, or selectors.

Fix:

- Compute once in the common owner and pass the result down.
- Create a memoized selector keyed by stable source data and parameters.
- Move derivation to the data/query layer when it is part of fetching or normalization.
- Store normalized indexes or maps for repeated lookups.
- Avoid memoizing the same calculation separately in many components unless each instance has genuinely different inputs.

## Decision gates

Use these gates before recommending manual memoization.

### Add `useMemo` only if

- The calculation is pure.
- The calculation is measured or obviously large enough to matter.
- The expensive path is an update path, not just initial mount.
- Dependencies are stable and do not change every render.
- Structural fixes would not remove the work more cleanly.
- React Compiler is unavailable, insufficient for this case, or the memo serves a boundary the compiler cannot cover.
- The readability cost is justified.

### Add `React.memo` only if

- The child re-renders frequently with identical props.
- Rendering the child is expensive enough to matter.
- Props can remain shallowly stable.
- Context updates are not the real invalidation source.
- A custom comparator is not needed, or is demonstrably cheaper and correct.

### Add `useCallback` only if

- Function identity is consumed by a memoized child, hook dependency, context value, selector, or cache.
- Dependencies can remain stable.
- An updater function, reducer, event relocation, or child-local logic would not be simpler.

### Add virtualization only if

- List size, row complexity, DOM count, layout, memory, or scroll performance is a real bottleneck.
- Stable item keys can be preserved.
- The UX can handle windowed rendering, focus behavior, accessibility, and dynamic heights.

### Split or move context only if

- Provider value changes invalidate many consumers.
- Consumers need different slices or different update frequencies.
- A provider sits much higher than the subtree that needs it.
- A client provider forces otherwise static/server-renderable UI into the client bundle.

### Move work out of the client bundle only if

- The import is in a client boundary or imported by one.
- The work does not require browser APIs or immediate interaction.
- Bundle analyzer output, import-chain inspection, or obvious library weight supports the change.

## Severity rubric

Use this rubric when reporting issues.

- **High**: Measured user-visible lag; broad context invalidation of a large subtree; unstable keys causing remounts or state loss; heavy library pulled into the initial client bundle; unvirtualized large list with expensive rows.
- **Medium**: Likely expensive repeated derivation; inline provider value in a frequently rendered provider; memoized child defeated by avoidable object/function props; unnecessary effect-derived state causing extra renders.
- **Low**: Memoization noise; cheap inline objects with no identity-sensitive consumer; minor render calculations without evidence; premature `useCallback` or `useMemo` added for style.

## Required review output

When applying this skill, structure the answer like this:

```text
Performance verdict
- Top issue 1
- Top issue 2
- Top issue 3

Evidence
- What was measured, inspected, or inferred.
- Whether React Compiler is enabled or unknown.
- Which render path, provider, list, key, import, or calculation is involved.

Findings
1. [Severity] Issue name
   Evidence: ...
   Why it matters: ...
   Fix: ...
   Validation: ...

Do not change
- Existing memoization or inline values that are harmless.
- Cheap calculations where optimization would add complexity.
- Code where React Compiler already makes manual memoization unnecessary, unless an escape hatch is justified.

Suggested patch
- Include focused code changes or pseudocode.
- Avoid broad rewrites unless the structure is the bottleneck.
```

Be explicit when a recommendation is inferred rather than measured. Do not claim a performance win without a validation method.

## Common anti-patterns to call out

- "This component is slow; add `useMemo` everywhere."
- `useMemo(() => ({ ... }), [])` with missing dependencies.
- `useCallback` used only to satisfy a belief that functions should never be inline.
- `React.memo` around a component whose props or context always change.
- Custom memo comparators that ignore functions or deep-compare large data every render.
- Provider values combining unrelated fast-changing and slow-changing state.
- Recreating context values while assuming `memo` protects consumers.
- Random, index, or render-generated keys in dynamic lists.
- Effects that mirror props/state into derived state for rendering.
- Client component boundaries placed above mostly static UI.
- Heavy client imports used only for static transformation.
- Sorting mutable arrays from props, state, query caches, or external stores during render.

## Review tone

Be skeptical of both extremes:

- Do not dismiss performance issues because React is usually fast.
- Do not accept memoization as a substitute for measurement, purity, and correct boundaries.

A strong review says exactly which work is happening, why React cannot skip it, what structural change removes it, and how to confirm the improvement.
