# Smell-to-Refactoring Map for Ruby and Rails

Use this catalog as an investigation guide. Thresholds are prompts, not rules. Confirm each candidate by reading its call sites, tests, runtime boundaries, and change history.

## Core Smells

| Smell / pressure | Search indicators in Ruby/Rails | Questions that validate or reject it | Likely Fowler moves | Common Ruby/Rails destination |
|---|---|---|---|---|
| Duplicated Code / duplicated knowledge | Similar predicates, validation messages, query fragments, state transitions, payload mapping, or callback bodies across files. | Is the same business rule represented, or is the text coincidentally similar? Will the copies change together? | Extract Function, Move Function, Parameterize Function, Pull Up Method, Combine Functions into Class. | Named predicate/calculation, reusable scope, value object, policy, gateway mapper. |
| Long Function | Many branches, mixed abstraction levels, multiple phases, many locals, comments labeling sections. | Is the function hard to name/summarize? Does extraction reveal domain language? Is it linear framework glue or a generated DSL? | Extract Function, Replace Temp with Query, Introduce Parameter Object, Split Phase, Decompose Conditional. | Small private methods; cohesive command only if state/steps justify it. |
| Large Class | Many unrelated method clusters, callbacks, associations, scopes, constants, and external dependencies; frequent edits for unrelated features. | Does it have multiple reasons to change? Are methods cohesive around one aggregate? Is size mainly declarations? | Extract Class, Move Function, Combine Functions into Class, Split Phase; use inheritance refactorings only when a real subtype relationship already exists. | Domain value/calculator/policy/query/gateway; not automatically `app/services`. |
| Long Parameter List | More than several independent parameters; repeated keyword groups; option hashes with repeated keys. | Do values form a concept? Does the callee need the whole source object? Are keywords already clear enough? | Introduce Parameter Object, Preserve Whole Object, Change Function Declaration. | Keywords, `Data`/plain value object, form/input object. |
| Data Clumps | The same fields travel together through controllers, jobs, models, serializers, and tests. | Do the values have shared validation/operations/lifetime? | Introduce Parameter Object, Extract Class, Preserve Whole Object. | Date range, address, money, pagination/filter request. |
| Primitive Obsession | Currency as integer/string pairs, status strings, unstructured IDs, date ranges as two values, repeated parsing/formatting. | Does a stable domain concept exist? Would a wrapper own rules or just add ceremony? | Replace Primitive with Object, Encapsulate Record. | Immutable value object, custom Active Model/Active Record type when justified. |
| Feature Envy | A method reads many fields from another object or navigates its associations more than its own state. | Would moving it improve ownership, or couple a persistence model to presentation? | Move Function, Extract Function, Hide Delegate. | Method on value/domain owner, presenter for display-only logic. |
| Divergent Change | One class changes for pricing, notifications, reporting, imports, and authorization. | Are these actually separate responsibilities or one cohesive lifecycle? | Extract Class, Move Function, Split Phase. | Namespaced collaborators with explicit interfaces. |
| Shotgun Surgery | One business change touches many callbacks, controllers, jobs, and serializers. | Is one rule scattered? Are the edits unavoidable boundary adaptations? | Move Function/Field, Combine Functions into Class, Inline Class, Encapsulate Variable. | Single policy/value/workflow source with boundary adapters. |
| Mutable Data / Global Data | Class variables, mutable constants, process globals, thread locals, singleton registries, class-level memoization of reloadable objects. | Is mutation intentional and synchronized? Is state request-, thread-, process-, or cluster-scoped? | Encapsulate Variable, Change Reference to Value, Split Variable. | Configuration object, injected dependency, immutable value, request-local state. |
| Repeated Switches | The same `case`/status/type branching appears in several places. | Is the variation stable and behavior-rich? Would a strategy clarify or overcomplicate? | Replace Conditional with Polymorphism, Introduce Special Case, Extract Function. | Duck-typed strategy/callable; enum predicate methods for simple state. |
| Loops doing several things | One `each` calculates totals, mutates records, and builds output. | Can phases be separated without unacceptable measured cost? Are side effects ordered? | Split Loop, Replace Loop with Pipeline, Extract Function. | Enumerable pipeline for pure transforms; explicit loops for side effects. |
| Message Chains | `order.customer.account.region.tax_policy` repeated. | Is navigation leaking, or is it a one-off query/display path? Would delegation create a Middle Man? | Hide Delegate, Extract Function, Move Function. | Domain query method or intention-revealing delegation. |
| Middle Man | Object/module mostly delegates to another object; presenter mirrors every model method; service forwards to model. | Does the boundary add policy, authorization, instrumentation, or substitution? | Remove Middle Man, Inline Function/Class. | Direct collaboration or a smaller intentional facade. |
| Lazy Element / Speculative Generality | One-use service/module with no state, unused extension points, abstract base classes with one implementation. | Is a second use imminent and evidenced? Does the abstraction name a real concept? | Inline Function/Class, Collapse Hierarchy, Remove Dead Code. | Plain method or direct object collaboration. |
| Temporary Field | Instance variables valid only during one workflow; methods require hidden call order. | Is the object being used as a procedural scratchpad? | Extract Class, Introduce Special Case, Split Phase. | Local immutable intermediate or command object with explicit lifecycle. |
| Comments explaining mechanics | Comments label code sections or explain what a predicate does. | Is the comment documenting why/constraint, or compensating for unclear code? | Extract Function, Rename Variable/Function, Introduce Assertion. | Named methods and domain terms; retain rationale comments. |
| Query/Modifier mixture | Method returns a value while saving, enqueueing, logging, or mutating arguments. | Do callers rely on the side effect? Can data be calculated once and applied explicitly? | Separate Query from Modifier, Extract Function, Split Phase. | `calculate` plus `apply!`; explicit command for workflow. |
| Flag Argument | Boolean/mode argument selects distinct branches. | Is the flag a true property or a hidden second method? Are there more modes coming? | Remove Flag Argument, Replace Conditional with Polymorphism, Parameterize Function. | Named entry points or strategy object. |
| Alternative Classes with Different Interfaces | Multiple gateways/calculators do equivalent work with inconsistent method names/results. | Is a shared protocol stable? Are differences meaningful? | Change Function Declaration, Move Function, Extract Superclass only if shared implementation matters. | Duck-typed protocol (`call`, `fetch`, `apply`) and adapter normalization. |
| Insider Trading / Inappropriate Intimacy | Classes access each other's internals, private data via `send`, or depend on callback/association implementation details. | Is the collaboration missing an explicit protocol? | Move Function/Field, Hide Delegate, Extract Class. | Public domain operation, gateway, or value boundary. |
| Dead Code | Unreferenced methods/constants, permanently disabled branches, compatibility shims after migration. | Could Rails reflection, callbacks, routes, serialization, or external gem consumers call it? | Remove Dead Code, Inline Function/Class. | Delete only after dynamic-use search and tests. |

## Rails-Specific Opportunities and Hazards

| Candidate | Evidence | What it may mean | Likely approach | False-positive / behavior warning |
|---|---|---|---|---|
| Callback-heavy model | Several lifecycle callbacks, conditional callbacks, callback methods calling each other. | Hidden workflow, order dependence, mixed invariants and external effects. | Extract named methods, separate pure decision from effect, introduce explicit workflow, migrate callers gradually. | Callbacks can be appropriate for local invariants; removal can miss alternate persistence paths. |
| External effect in save callback | Mail, job, webhook, file, event, or remote call from `after_save`/`after_update`. | Transaction semantics are implicit or inconsistent. | Characterize commit/rollback behavior; isolate gateway/job; use commit-aware orchestration where intended. | Moving to `after_commit` changes failure and timing semantics. |
| `default_scope` | Implicit filtering/order/joins on every query. | Hidden global query behavior and surprising creation/merge semantics. | Introduce explicit named scope; migrate callers; remove default last. | Multi-tenancy or soft-delete invariants may depend on it; security boundary may be involved. |
| Query inside loop | `.find`, `.where`, `.exists?`, `.count`, association loading inside `each`/render loop. | N+1 or repeated query work. | Confirm with runtime evidence; extract query; preload/batch or aggregate as appropriate. | Changing eager-loading/join strategy is optimization and can change cardinality/order. |
| `Model.all.each` on large table | Loads all records at once. | Memory pressure and batch-processing opportunity. | Measure/understand ordering; use `find_each`/batches when semantics allow. | Batch iteration changes order and can race with concurrent updates. |
| Complex controller action | Multiple model writes, business branching, remote calls, render decisions. | Mixed HTTP, domain, and workflow phases. | Characterize request contract; extract local methods; split phases; move cohesive domain operation. | A one-use workflow object may only relocate complexity. |
| Complex view/helper/serializer | Branching and formatting mixed with queries or authorization. | Hidden presentation policy or data access. | Extract presentation function/object; preload in query/controller; preserve contract. | HTML safety, serializer nulls, and authorization can silently change. |
| Concern with many host assumptions | Uses undeclared columns/methods, adds callbacks/associations/scopes, inclusion order matters. | Hidden inheritance-like coupling. | Make dependencies explicit; extract collaborator; inline if single-use. | Shared framework integration may legitimately be a concern. |
| Option/params hash crosses layers | Repeated `params[:x]`, string/symbol conversion, defaults in several places. | Implicit record and duplicated normalization. | Encapsulate record/input; split normalization/validation/persistence. | Strong Parameters and external API shape must remain stable. |
| Complex relation assembly duplicated | Repeated `joins.where.merge.order` fragments. | Duplicated query vocabulary. | Extract composable scopes or query object returning relation. | Scope conditional semantics and `default_scope` merging can differ from class methods. |
| Bulk write / callback bypass | `update_all`, `delete_all`, `update_columns`, validation/callback skip. | Intentional performance/invariant bypass or hidden risk. | Document invariants; encapsulate behind named operation; test affected data. | Replacing with per-record writes is a behavior and performance change. |
| Serialized JSON/hash column logic spread around | Repeated key access/defaults/type conversion. | Primitive obsession / implicit schema. | Encapsulate record/value; add access API; migrate callers. | Stored historical shapes and dirty tracking may vary. |
| State predicates repeated around enum/string | Repeated `status ==` branches across layers. | Repeated switches or policy scattered by state. | Extract predicates; consolidate transitions; strategy only for rich variation. | Rails enum scopes/predicates may already provide adequate vocabulary. |
| Namespace/file mismatch | Extracted class cannot autoload, manual `require` under `app`. | Structural extraction ignored Zeitwerk conventions. | Align constant and path; run loader check. | Gems and `lib` have different loading rules. |
| Time API inconsistency | `Time.now`/`Date.today` mixed with Rails time-zone APIs. | Hidden temporal semantics, possible bug. | First characterize intended zone; then change separately if behavior differs. | This may be a bug fix, not a refactoring. |

## Heuristic Thresholds

The bundled scanner uses conservative defaults to find review starting points:

- method body over roughly 16 significant lines;
- very long method over roughly 30 significant lines;
- nesting deeper than roughly 3–4 control levels;
- more than 4 parameters or an explicit boolean default;
- class/module over roughly 250 significant lines or more than roughly 20 methods;
- multiple callbacks in one file;
- explicit query calls inside an enumerable loop;
- explicit Rails APIs with hidden/global/bypass semantics.

Do not cite a threshold as the reason to refactor. Use the threshold to locate code, then explain the actual design pressure.

## Evidence Quality

Use this confidence rubric:

### High confidence

- repeated business rule is visibly duplicated;
- tests and callers confirm the same behavior;
- runtime traces confirm repeated queries or side effects;
- version history shows recurring coordinated edits;
- the proposed first steps are local and behavior-preserving.

### Medium confidence

- static structure strongly suggests mixed responsibilities or hidden coupling;
- some callers/tests are known, but runtime or history evidence is limited;
- a plausible safe sequence exists with characterization work.

### Low confidence

- finding is metric-only;
- dynamic Ruby hides callers;
- target behavior or ownership is unclear;
- suggested destination depends on unverified framework/version assumptions.

Low-confidence findings belong in a watch list or require explicit evidence-gathering steps; they should not dominate the plan.

## Prioritization Test

A candidate deserves attention when the answer is clear to at least one of these:

- What imminent feature or fix becomes simpler?
- What repeated defect mechanism is removed?
- What broad edit becomes local?
- What hidden side effect becomes explicit?
- What behavior becomes testable at a narrower level?
- What duplicated policy gains one owner?

When none applies, the opportunity cost of refactoring may exceed the benefit.
