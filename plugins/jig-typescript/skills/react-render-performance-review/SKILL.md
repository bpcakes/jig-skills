---
name: react-render-performance-review
description: Review React render performance, slow components, large lists, provider-heavy trees, context usage, expensive render calculations, memoization changes, object/function prop identity churn, keys, client bundle-heavy imports, repeated filtering/sorting, and avoid cargo-cult useMemo/useCallback/React.memo changes.
---

# React Render Performance Review

Use this skill when reviewing React components, hooks, providers, lists, client components, or memoization changes for render-path performance.

The goal is not to add `useMemo`, `useCallback`, or `React.memo` everywhere. The goal is to identify real render costs, identity churn that crosses meaningful boundaries, subtree invalidation, remounts, repeated derivations, and avoidable client JavaScript.

For detailed checks, examples, decision gates, and rewrite patterns, read [references/render-performance-rules.md](references/render-performance-rules.md).

## Core Stance

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

Never use memoization to make impure render logic acceptable. A memo callback must be pure.

## Review Workflow

1. Identify the slow path: exact interaction, route, component, list, provider, or prop change under review.
2. Establish evidence: React DevTools Profiler, `<Profiler>`, production builds, user-like devices, CPU throttling, bundle analyzer output, or focused timing around a suspected pure calculation. Do not rely only on development Strict Mode behavior.
3. Find the update source: local state, parent state, context propagation, effect-derived state, route changes, external store updates, key changes, or client bundle execution.
4. Classify the bottleneck: expensive render work, list size, context/provider invalidation, identity churn, remounting keys, redundant derivation, unnecessary client JavaScript, or useless memoization.
5. Choose the smallest structural fix: move state, split components, split context, push providers down, virtualize, move static work server-side, or calculate once at the right owner before adding memoization.
6. Validate before and after: render count, commit duration, interaction latency, list responsiveness, bundle size, or remount behavior. If no measurement is available, say so and mark the recommendation as inferred.

## Fast Discovery Commands

Run targeted searches like these when reviewing a codebase:

```bash
rg -n "useMemo|useCallback|memo\(|createContext|useContext|Provider|value=\{\{|key=|\.map\(|\.filter\(|\.sort\(|'use client'|\"use client\"" .
rg -n "Math\.random\(|Date\.now\(|new Date\(|crypto\.randomUUID\(|JSON\.parse\(|JSON\.stringify\(" .
rg -n "from ['\"](lodash|moment|date-fns|dayjs|chart|recharts|d3|prism|shiki|markdown|monaco|framer-motion|@mui/icons-material)" .
rg -n "new Intl\.|Intl\.|RegExp\(|structuredClone\(|Object\.fromEntries\(|Array\.from\(" .
```

Also inspect `package.json`, framework config, compiler config, Next.js App Router client boundaries, bundle analyzer output, and any profiling traces or regressions attached to the issue or PR.

## What To Flag

Flag issues when they affect a real or likely render path:

- Expensive calculations during render: filtering, sorting, grouping, parsing, formatting, validation, chart shaping, deep cloning, deep equality, or repeated derivation.
- Large lists rendered fully when only a viewport slice is visible, especially with expensive rows or unstable keys.
- Context provider values recreated every render, or provider boundaries that invalidate large subtrees.
- Fast-changing state stored in app-wide providers.
- Inline object/function props only when they cross identity-sensitive boundaries such as `React.memo`, hook dependencies, context values, selectors, virtualization rows, or heavy shallow-comparing third-party components.
- `memo`, `useMemo`, and `useCallback` used without a measurable reason.
- `useMemo` hiding impure logic.
- Random, index, mutable-label, or render-generated keys that cause remounts or state loss.
- Heavy imports inside client components, broad `'use client'` boundaries, or static transforms forced into the browser.
- Repeated derived filtering/sorting across siblings, rows, hooks, or selectors.

Do not flag cheap inline values, small lists, minor render calculations, or harmless functions just because they are not memoized.

## Decision Gates

Add `useMemo` only if the calculation is pure, measured or obviously costly, on an update path, has stable dependencies, and a structural fix would not remove the work more cleanly.

Add `React.memo` only if the child re-renders frequently with identical props, rendering is expensive enough to matter, props can stay shallowly stable, and context updates are not the real invalidation source.

Add `useCallback` only if function identity is consumed by a memoized child, hook dependency, context value, selector, or cache, and simpler state or event placement would not solve the issue.

Add virtualization only if list size, row complexity, DOM count, layout, memory, or scroll performance is a real bottleneck and the UX can handle windowed rendering, focus behavior, accessibility, and dynamic heights.

Split or move context only if provider value changes invalidate many consumers, consumers need different slices or update frequencies, or the provider sits much higher than the subtree that needs it.

Move work out of the client bundle only if the import is in or below a client boundary, the work does not require browser APIs or immediate interaction, and import-chain or bundle evidence supports the change.

## Severity

- **High**: Measured user-visible lag; broad context invalidation of a large subtree; unstable keys causing remounts or state loss; heavy library pulled into the initial client bundle; unvirtualized large list with expensive rows.
- **Medium**: Likely expensive repeated derivation; inline provider value in a frequently rendered provider; memoized child defeated by avoidable object/function props; unnecessary effect-derived state causing extra renders.
- **Low**: Memoization noise; cheap inline objects with no identity-sensitive consumer; minor render calculations without evidence; premature `useCallback` or `useMemo` added for style.

## Output Format

Use this structure:

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

## Related Skills

Use `react-hooks-effects-review` for render purity, stale closures, effect-derived state, and dependency correctness. Use `react-state-data-flow-review` for state ownership and cache/data-flow placement. Use `react-test-quality-review` when performance-sensitive behavior needs regression coverage.
