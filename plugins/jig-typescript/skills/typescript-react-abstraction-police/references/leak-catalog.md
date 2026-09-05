# TypeScript/React Leak Catalog

Use these rules as investigative lenses. A matching syntax pattern is not enough; validate the boundary, consumer burden, change amplification, ownership, and counterevidence described in `SKILL.md`.

## Type And Data Boundaries

### AP-TSR-101 — Third-Party Type Escape

**Signal:** exported props, options, returns, or domain types mention library-specific types such as `UseQueryResult`, `Control`, `AxiosResponse`, router objects, vendor component props, store types, or generated client types.

**Confirm:** the boundary claims domain or product ownership, while consumers import or understand the third-party library to use it. Replacing the library would change consumers even though product semantics remain the same.

**Not a leak:** the package is explicitly an adapter, compatibility layer, design-system primitive, or typed re-export whose promise includes that library.

**Typical correction:** translate to a small domain contract; keep the library type behind an adapter; or rename/document the boundary as transparent.

### AP-TSR-102 — Transport Or Storage Shape Escape

**Signal:** consumers branch on HTTP status, headers, GraphQL connection internals, database entities, snake_case payloads, persistence IDs, nullable transport fields, or serialization details returned by a domain hook/service.

**Confirm:** multiple consumers normalize or interpret the same raw representation, or a transport/storage change would require UI edits without a product-semantic change.

**Not a leak:** a low-level HTTP, GraphQL, persistence, or SDK package intentionally exposes transport primitives.

**Typical correction:** normalize once into a domain type; make absence and state explicit; own pagination/token translation inside the boundary.

### AP-TSR-103 — Infrastructure Error Escape

**Signal:** UI consumers catch or branch on `AxiosError`, `ApolloError`, query-library errors, database codes, raw status codes, or error-message text.

**Confirm:** the abstraction claims to provide a domain operation but leaves consumers to classify infrastructure failures.

**Not a leak:** diagnostic tooling, low-level clients, or an error boundary intentionally exposes the original cause alongside a stable domain category.

**Typical correction:** map to a stable discriminated domain error and preserve the original cause for logging or debugging.

### AP-TSR-104 — Escape Hatch Becomes The Normal API

**Signal:** public options such as `raw`, `unsafe*`, `internal*`, `force*`, `skip*`, `bypass*`, `suppress*`, or `disableValidation` are routinely needed by ordinary consumers.

**Confirm:** callers use the flags to compensate for policy hidden inside the abstraction, and combinations are undocumented or order-dependent.

**Not a leak:** a rare, clearly isolated administrative or migration capability with strong naming, tests, and constrained call sites.

**Typical correction:** split the use cases, move policy ownership, or expose one explicit lower-level primitive rather than accumulating bypass flags.

## React Component And Hook Boundaries

### AP-TSR-201 — Raw State Setter Or Dispatch Escape

**Signal:** component props or hook returns expose `Dispatch<SetStateAction<T>>`, `setX`, reducer dispatch, action creators, or a mutable store object.

**Confirm:** the abstraction owns behavior or invariants, but consumers can perform invalid transitions or must understand its internal state representation.

**Not a leak:** a genuinely controlled primitive where the consumer owns the value and transitions, such as `value`/`onChange` or `open`/`onOpenChange`.

**Typical correction:** expose semantic events (`onSubmit`, `onDismiss`, `onSelectionChange`) or move the state machine to the actual owner.

### AP-TSR-202 — Consumer-Orchestrated Internal State Machine

**Signal:** consumers coordinate several props/callbacks, call methods in sequence, synchronize duplicate state, or reproduce `loading/error/success/empty` transitions around a supposedly higher-level component or hook.

**Confirm:** two consumers repeat the same ordering or transition logic, or violating the sequence causes incorrect behavior.

**Not a leak:** a headless state-machine API whose documented purpose is to let consumers own rendering and transitions.

**Typical correction:** co-locate the state machine, expose semantic commands/events, or deliberately split headless state from presentation.

### AP-TSR-203 — Prop/Boolean Explosion Mirrors Internal Branches

**Signal:** many booleans, mutually dependent callbacks, mode flags, or optional props encode branches such as `compact`, `showHeader`, `usePortal`, `disableAnimation`, `isEditing`, and `allowRetry`.

**Confirm:** valid combinations are constrained, consumers must know precedence, or adding an internal branch adds another public flag.

**Not a leak:** independent capabilities on a low-level primitive, or a small set of orthogonal accessibility/presentation controls.

**Typical correction:** model true variants with a discriminated union; split components by responsibility; use semantic composition; or delete a prematurely generic component.

### AP-TSR-204 — Imperative Or Temporal Coupling

**Signal:** `useImperativeHandle`, refs with many methods, “call X before Y,” required effect timing, manual `flush/sync/recalculate`, or callbacks that must be invoked in a particular order.

**Confirm:** consumers must know lifecycle details not implied by the component's promise, and wrong ordering creates stale or invalid state.

**Not a leak:** focus, scroll, measure, media control, or other inherently imperative platform capability exposed narrowly.

**Typical correction:** derive behavior declaratively, own sequencing internally, expose one semantic command, or document the component as an imperative controller rather than pretending it is declarative.

### AP-TSR-205 — Context/Provider Implementation Exposure

**Signal:** raw Context objects are exported, consumers call `useContext` directly, provider order is significant, consumers construct reducer values, or feature code knows internal provider nesting.

**Confirm:** the abstraction claims a domain service/state API but consumers depend on Context identity, default values, provider shape, or nesting order.

**Not a leak:** Context itself is the intentional public primitive, especially in a framework or library API.

**Typical correction:** export a domain hook and provider with a stable value contract; validate missing providers; compose internal providers behind one boundary.

### AP-TSR-206 — DOM Or CSS Structure Becomes A Hidden Contract

**Signal:** consumers target internal class names/data attributes, depend on descendant order, pass many `*ClassName`/`*Ref` props, or tests query private markup.

**Confirm:** changing internal markup or styling implementation would force consumers to edit selectors or wiring while visible semantics remain unchanged.

**Not a leak:** `className`, `style`, `ref`, `aria-*`, or documented `data-*` on a DOM-like primitive; explicit stable `slots`/`parts` APIs.

**Typical correction:** expose semantic slots/parts, CSS variables, or one root extension point; move product styling inside; split primitive and product component when necessary.

### AP-TSR-207 — Child Or Slot Shape Dependence

**Signal:** `Children.only`, `cloneElement`, inspection of `child.type`, positional child assumptions, or undocumented props injected into children.

**Confirm:** consumers must provide a particular element shape or component identity not expressed by the public contract, and harmless composition changes break behavior.

**Not a leak:** a documented compound-component or `asChild` contract with runtime/type validation and stable semantics.

**Typical correction:** use explicit render/slot props, a typed compound API, or render the owned element internally.

### AP-TSR-208 — Render Timing Or Identity Leak

**Signal:** consumers must memoize callbacks/objects to prevent correctness failures, know effect ordering, remount via `key`, delay updates, or force identity changes to make a hook/component work.

**Confirm:** the requirement is caused by internal dependency or subscription design, not merely performance optimization.

**Not a leak:** documented identity semantics that are intrinsic to React or an external subscription API.

**Typical correction:** stabilize internal subscriptions, use functional updates/refs appropriately, own memoization, or expose an explicit reset/version semantic.

## Integration Boundaries

### AP-TSR-301 — Query And Cache Contract Escape

**Signal:** domain consumers build query keys, pass `staleTime/gcTime`, call invalidation directly, branch on query-library status, or receive raw query result objects.

**Confirm:** the hook/service claims domain ownership but callers coordinate caching and freshness policy or import the query library.

**Not a leak:** infrastructure-level query factories or an intentionally transparent query toolkit.

**Typical correction:** own keys and cache policy; return a narrow domain result; expose semantic refresh/invalidate operations only when needed.

### AP-TSR-302 — Form Library Contract Escape

**Signal:** product components require `Control`, `register`, field-path strings, resolver types, `UseFormReturn`, or library-specific error objects.

**Confirm:** ordinary product consumers must understand the form library even though the component promises a domain field or form workflow.

**Not a leak:** low-level form primitives or an adapter package explicitly designed for that form library.

**Typical correction:** accept domain `value`, `onChange`, and semantic validation; keep a separate library adapter; or make the dependency explicit in the component name and package.

### AP-TSR-303 — Router Or State-Store Contract Escape

**Signal:** components require router location/history objects, route-param parsing, store slices, selectors, action names, or store instances to perform domain behavior.

**Confirm:** changing routing/state infrastructure would modify unrelated view consumers, or consumers repeat translation and dispatch policy.

**Not a leak:** route components, store infrastructure, or headless bindings whose public purpose includes those objects.

**Typical correction:** pass domain values/events, move parsing/dispatch into a feature boundary, or create a thin explicit integration component around a pure view.

### AP-TSR-304 — Deep Import Or Entrypoint Bypass

**Signal:** consumers import `src`, `internal`, `private`, implementation folders, or non-exported package subpaths to obtain missing behavior/types.

**Confirm:** the deep import is necessary because the official boundary omits a real capability, and internal reorganization breaks consumers.

**Not a leak:** monorepo-internal source imports allowed and governed by a deliberate package convention.

**Typical correction:** add a narrow supported export, move the consumer, or remove the package boundary fiction. Do not blindly expand the barrel.

## Structural Failures

### AP-TSR-401 — Pass-Through Wrapper Pretends To Abstract

**Signal:** a wrapper forwards vendor props and refs unchanged, returns vendor result types, or adds only naming while claiming product ownership.

**Confirm:** consumers still understand the vendor API, and the wrapper cannot replace or constrain the implementation without breaking them.

**Not a leak:** a compatibility alias, instrumentation boundary, or migration shim with explicit lifecycle and purpose.

**Typical correction:** delete the wrapper; or make it own a real invariant, smaller contract, semantics, styling, accessibility, telemetry, or migration boundary.

### AP-TSR-402 — Repeated Consumer Compensation Has No Owner

**Signal:** several consumers normalize the same data, map the same errors, rebuild the same props, synchronize the same state, or contain the same “workaround.”

**Confirm:** the repeated policy is stable enough to name and belongs at a shared boundary; the duplication is not merely coincidental syntax.

**Not a leak:** two superficially similar flows with different business rules or likely independent evolution.

**Typical correction:** move only the stable policy to its natural owner. Avoid a generic helper that preserves all consumer-specific branches.

### AP-TSR-403 — Mixed Abstraction Levels Or Owners

**Signal:** one API mixes domain intent with HTTP/cache/form/DOM controls, or combines state ownership, rendering, persistence, and navigation in one configuration object.

**Confirm:** consumers must reason across layers, flag combinations have precedence, or changes in one owner ripple through unrelated callers.

**Not a leak:** an application composition root where cross-layer wiring is the explicit responsibility.

**Typical correction:** split by ownership and lifecycle; keep integration at the composition root; pass semantic inputs between layers.

### AP-TSR-404 — Test Contract Depends On Internals

**Signal:** tests query private classes/markup, mock internal hooks/modules, assert implementation calls, or reconstruct internal provider values.

**Confirm:** harmless refactoring breaks tests while user-visible or exported behavior remains identical, and the tests constrain the abstraction's implementation.

**Not a leak:** focused unit tests for the internal module itself, or explicit structural/accessibility contracts.

**Typical correction:** test public behavior and accessible semantics; keep narrow internal unit tests colocated; expose a test seam only when it is also a legitimate architectural seam.
