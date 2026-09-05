# React And TypeScript Duplication Taxonomy

Use this reference after the scanner identifies a candidate. The purpose is to distinguish repeated implementation from repeated meaning.

## Candidate Archetypes

### Renamed clone

The control flow and behavior are effectively identical; identifiers, labels, endpoints, or types differ.

Likely action: parameterize a small stable value, or extract a shared core and retain named wrappers when domain language matters.

### Forked abstraction

One implementation was copied and has accumulated a few branches, effects, or props.

Likely action: identify whether the divergence is a stable variant or evidence of different ownership. Do not simply combine both branches.

### Shared shell, divergent core

The layout, loading/error shell, or state plumbing is repeated while the meaningful behavior differs.

Likely action: extract the shell, headless primitive, or pure state transition. Keep feature behavior outside it.

### Shadow design-system primitive

Multiple features independently implement the same interaction pattern, styling contract, or accessibility behavior.

Likely action: create or extend a design-system primitive only when the interaction semantics and ownership are genuinely shared.

### Parallel data hook

Hooks share query state, request orchestration, pagination, or mutation flow but differ in endpoint and domain mapping.

Likely action: share a typed request/query core only after cache, cancellation, retry, invalidation, auth, and error semantics are proven compatible.

### Parallel form workflow

Forms repeat field registration, validation, submit state, and error presentation.

Likely action: share field or submit primitives; avoid a generic form engine unless the domain workflow is truly the same.

### Parallel state transition

Reducers, stores, or state machines use similar actions and transitions.

Likely action: extract pure transitions or a parameterized machine only when invariants and forbidden states align.

### Shape-only type duplication

Interfaces or schemas repeat fields but represent different concepts.

Likely action: keep separate unless the shared type carries the same semantic contract. Structural similarity alone is not a reason to alias domain types.

## Component Review

Compare all of the following:

- User-visible purpose and semantic HTML.
- Accessibility role, label, keyboard behavior, focus order, focus restoration, and live-region behavior.
- Controlled versus uncontrolled state.
- State ownership and reset behavior.
- Event ordering, propagation, default prevention, and callback guarantees.
- Loading, empty, error, disabled, optimistic, and partial states.
- Child composition model: slots, render props, children, portals, and overlays.
- Responsive behavior, theming, density, directionality, and localization.
- Ref forwarding and imperative handles.
- Memoization assumptions and identity-sensitive props.
- Suspense, error boundaries, transitions, and hydration behavior.
- Server component compatibility and `use client` requirements.

Do not unify components merely because their JSX trees look alike. A card, dialog, picker, and list row can share markup while having incompatible interaction contracts.

## Hook Review

Compare:

- Hook call order and whether every call remains unconditional after extraction.
- Effect dependency arrays, cleanup, and remount behavior.
- Cancellation and stale-response protection.
- Cache key construction, cache scope, staleness, deduplication, and garbage collection.
- Retry policy, backoff, timeout, and offline behavior.
- Invalidation and refetch triggers.
- Optimistic updates, rollback, and conflict resolution.
- Authentication, tenant, locale, and feature-flag context.
- Error normalization and whether errors are returned, thrown, logged, or captured.
- Suspense and transition behavior.
- Return identity and whether callers depend on stable callbacks or objects.
- Subscription lifetime and external-store semantics.

A generic hook that accepts arbitrary callbacks for request, parse, cache, error, and side effects is usually not a unification. It is displaced complexity.

## Form Review

Compare:

- Source of defaults and reset semantics.
- Synchronous, asynchronous, server-side, and cross-field validation.
- Dirty, touched, visited, and submission state.
- Field arrays and dynamic field lifecycles.
- Serialization, coercion, trimming, and localization.
- Autosave, drafts, optimistic submission, and duplicate-submit prevention.
- Error placement, focus-on-error, and accessible descriptions.
- Permission or workflow gates.
- Post-submit navigation, cache invalidation, and side effects.

Extract shared fields or submission primitives before creating a configuration-driven universal form.

## Data Access Review

Compare:

- Transport and endpoint ownership.
- Request and response types.
- Authentication and tenant scoping.
- Pagination, sorting, filtering, and cursor semantics.
- Cache keys and invalidation.
- Normalization and entity identity.
- Partial failure and retry behavior.
- Rate limiting and batching.
- Error mapping and observability.
- Server-only versus browser-safe dependencies.

The safe seam is often a pure request builder, response mapper, or typed query factory—not one all-purpose data hook.

## Reducer, Store, And State-Machine Review

Compare:

- State invariants and invalid states.
- Action names versus actual transition meaning.
- Initial state and hydration.
- Persistence, rehydration, and version migration.
- Concurrency and reentrancy.
- Reset, cancellation, and teardown.
- Side-effect ownership.
- Selectors and memoization.
- Cross-tab or external-store behavior.

Do not merge machines that use similar action names but protect different invariants.

## Type And Schema Review

Compare:

- Domain meaning, not only field names.
- Required versus optional semantics.
- Null, missing, empty, and default behavior.
- Read versus write models.
- Input versus validated versus persisted representations.
- Serialization and versioning.
- Branded identifiers and tenant boundaries.
- Security- or compliance-sensitive fields.
- Refinements, transforms, and error messages.
- Whether consumers require covariance, contravariance, or exactness.

Prefer separate named domain types over a generic shared type when independent evolution is likely. Share lower-level value objects only when their semantic contract is identical.

## Utility And Service Review

Compare:

- Side effects and environmental dependencies.
- Error behavior and fallback policy.
- Time, randomness, locale, and timezone assumptions.
- Mutation versus immutability.
- Ordering and stability guarantees.
- Input normalization and output precision.
- Logging, metrics, and tracing.
- Security and authorization boundaries.

A utility should be extracted only when its contract can be stated without referring to either feature.

## React-Specific Hard Smells In A Proposed Unification

- Conditional calls to hooks or hooks hidden behind runtime strategy objects.
- Three or more independent booleans controlling behavior.
- A broad `options` object with unrelated optional callbacks.
- A component that accepts both domain models and switches internally.
- A shared hook that knows feature route names, analytics events, and cache keys.
- A design-system primitive that imports feature code.
- An abstraction requiring callers to understand its internal state machine.
- A discriminated union whose branches share almost no implementation.
- Server-safe consumers forced across a client boundary.
- Accessibility behavior expressed as an optional afterthought.

## Evidence That Separation Is Intentional

Record intentional duplication when one or more of these is true:

- Different domain owners need independent release cadence.
- The code is mirrored across platform, runtime, or security boundaries.
- Public APIs must remain independently versioned.
- The duplicated code is small and stable while a shared dependency would be costly.
- The abstractions are expected to diverge.
- The same shape represents different legal, financial, identity, or authorization semantics.
- A shared owner would be broader than the actual common domain.
