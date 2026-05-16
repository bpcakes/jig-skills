---
name: react-hooks-component-api-review
description: Review React component and hook APIs for prop modeling, controlled/uncontrolled contracts, children typing, callback types, polymorphic components, invalid states, and reusable UI boundaries.
---

# React Component and Hook API Review

Use this skill when reviewing public React + TypeScript component or hook contracts: shared components, design-system components, exported UI modules, form controls, compound components, layout primitives, and reusable hooks.

Do not use this as a general TypeScript review. Focus on the API a consumer imports and calls: prop shapes, hook parameters/returns, child contracts, callback contracts, refs, polymorphism, naming, and whether invalid UI states are representable.

## Review objective

A good React component API should make the valid use obvious, make the invalid use impossible or hard, and expose domain concepts rather than implementation wiring.

When reviewing, ask:

1. What states or modes can this component actually support?
2. Does the prop type encode those states, or can consumers pass impossible combinations?
3. Who owns state: parent, component, DOM, or a hook caller?
4. Are callbacks typed to the event/domain payload the consumer actually receives?
5. Is `children` really arbitrary renderable content, or does the component need a narrower contract?
6. Are generics and polymorphism helping inference, or leaking implementation complexity into call sites?
7. Do prop names describe product behavior, or vague implementation bags?

## Scope discovery

Before judging the API, identify the public surface.

- Start from exported files: `index.ts`, `index.tsx`, package entrypoints, barrel exports, and published component folders.
- Inspect component declarations, `Props` types/interfaces, hook signatures, `forwardRef`, compound component namespaces, story files, docs examples, and existing call sites.
- Use call sites to infer intended behavior, but judge the exported contract, not only the current implementation.
- If a component is internal and has one caller, be lighter. If it is exported/shared/design-system code, be strict.

Useful searches:

```bash
rg -n "type .*Props|interface .*Props|React\.FC|PropsWithChildren|ReactNode|children\?|Function|any|\.\.\.args: any|as\?:|value\?|defaultValue\?|checked\?|defaultChecked\?|on[A-Z]" --glob '*.{ts,tsx}'
rg -n "export .* from|export \{|forwardRef|memo\(|ComponentProps|HTMLProps|HTMLAttributes|PropsWithChildren" --glob '*.{ts,tsx}'
```

## Output format

Return findings in priority order. Prefer concrete rewrites over abstract advice.

Use this structure:

````markdown
# React Component and Hook API Review

## Scope reviewed
- Exported components/hooks checked: ...
- Files inspected: ...

## Blockers / high-risk API issues
1. [Component] issue
   - Why this public contract is unsafe
   - Invalid call site currently allowed
   - Suggested prop/hook signature

## Medium-risk API issues
...

## Low-risk cleanup
...

## Contract rewrite examples
```ts
// before / after
```

## Non-issues
- Things that looked risky but are acceptable because ...
````

If the user asked for code changes, patch the API, update call sites/stories/tests, and run the relevant typecheck/tests. If the user asked only for review, do not patch unless explicitly requested.

## Severity rubric

**Blocker/high:** exported API permits invalid states for shared/design-system components; controlled/uncontrolled contract is ambiguous; callback types use `any`, `Function`, or broad rest args; a public generic/polymorphic API is unsound; accessibility-critical props can be omitted.

**Medium:** broad `ReactNode` hides a stricter child contract; naming obscures behavior; optional-prop soup makes call sites guess; implementation details leak into reusable API; native prop inheritance is too broad or collides with domain props.

**Low:** minor naming consistency, doc comments, small prop grouping improvements, or cleanup that does not change the consumer contract materially.

## Detailed checklist

For nontrivial exported component or hook APIs, read `references/component-api-rules.md` and use it as the detailed checklist for prop modeling, boolean modes, controlled/uncontrolled contracts, children, callbacks, generics, polymorphic `as`, native prop inheritance, naming, compound components, reusable hooks, component-type heuristics, and acceptable tradeoffs.

Every finding should answer four questions:

1. What invalid or unclear consumer behavior does the current API allow?
2. Why does that matter for a reusable React component or hook?
3. What exact type/model/naming change would fix it?
4. What call sites, stories, or tests would need updating?

