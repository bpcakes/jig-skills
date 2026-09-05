# Rust Refactoring Smell Catalog

## Contents

1. How to use this catalog
2. Naming and duplication
3. Functions and control flow
4. Data and type design
5. Modules and change coupling
6. Abstraction and delegation
7. Rust-specific amplifiers
8. Candidate scoring

## 1. How to use this catalog

A smell is a prompt to investigate. Report it only when there is concrete evidence and a plausible maintenance cost. For every candidate, record:

- exact path and line range;
- what future change or current confusion it makes harder;
- the Rust-specific context and likely false positives;
- one or more Fowler refactorings that fit;
- confidence and risk;
- a sequence of behavior-preserving steps.

The bundled scanner detects only syntactic proxies. It cannot know domain boundaries, runtime constraints, feature interactions, or whether two similar fragments must evolve independently.

## 2. Naming and duplication

### Mysterious Name

**Signals**

- names such as `data`, `thing`, `handle`, `process`, `do_it`, `tmp`, or unexplained abbreviations;
- names that conceal units, ownership, or state (`timeout` without unit, `id` without entity, `buffer` without role);
- similar names used for different concepts;
- a function whose name omits an important side effect.

**Rust interpretation**

Names should expose domain meaning and ownership intent without restating types. Use module paths to carry context. Common short names such as `i`, `x`, `tx`, `rx`, `cx`, and `fmt` are appropriate in established local conventions.

**Likely moves**

Rename Variable, Rename Field, Change Function Declaration, Extract Function.

**False positives**

Small scopes, algebraic code, standard protocol abbreviations, and conventional trait method names.

### Duplicated Code

**Signals**

- exact or near-exact blocks in multiple functions or modules;
- repeated validation, conversion, error mapping, or state transitions;
- multiple matches that encode the same policy;
- copied test setup that changes together.

**Rust interpretation**

Extract a private function, method, helper type, iterator adapter, conversion trait implementation, macro, or shared test fixture only when the duplicated fragments represent the same concept. A macro is not the default answer; it obscures control flow and diagnostics.

**Likely moves**

Extract Function, Move Function, Parameterize Function, Combine Functions into Transform, Pull Up Method analogue through a trait default method.

**False positives**

Coincidentally similar domain rules, small transparent setup, performance-specialized paths, generated code, and intentionally duplicated FFI adapters.

## 3. Functions and control flow

### Long Function

**Signals**

- the function cannot be summarized as one coherent action;
- distinct parse, validate, transform, persist, and format phases are interleaved;
- many locals remain live simultaneously;
- tests require broad setup because logic cannot be isolated;
- nested control flow hides the dominant path.

**Rust interpretation**

Extract around semantic phases and ownership boundaries. A good extraction often turns an unvalidated input into a validated type, or separates pure transformation from I/O. Do not add clones or shared mutability merely to make extraction compile.

**Likely moves**

Extract Function, Split Phase, Replace Temp with Query, Decompose Conditional, Replace Nested Conditional with Guard Clauses.

**False positives**

Straight-line parsers, protocol codecs, generated visitors, carefully optimized loops, and functions whose local context is clearer than a web of helpers.

### Long Parameter List

**Signals**

- many parameters, especially several with the same primitive type;
- the same parameter group recurs across functions;
- callers repeatedly derive several arguments from one object;
- parameters select modes or partially configure an operation.

**Rust interpretation**

Use a domain struct, configuration type, request object, builder, or whole existing object when the values form a stable concept. Avoid a generic `Context` bag that merely hides dependencies. Distinguish borrowed input from owned configuration.

**Likely moves**

Introduce Parameter Object, Preserve Whole Object, Replace Parameter with Query, Change Function Declaration.

**False positives**

Low-level numerical kernels, FFI entry points, constructors for transparent data records, and hot paths where aggregate construction would be harmful.

### Flag Argument

**Signals**

- `bool` decides which branch or algorithm the function runs;
- call sites contain opaque `true`/`false` literals;
- different boolean combinations create hidden modes.

**Rust interpretation**

Use an enum with meaningful variants or separate explicit methods. A boolean remains appropriate when it represents a fact rather than a mode and the name stays visible, such as a struct field or named local.

**Likely moves**

Remove Flag Argument, Replace Primitive with Object, Change Function Declaration.

**False positives**

Simple predicates, serialization flags with standard meaning, and private helpers with obvious named arguments at every call site.

### Repeated Switches / Complex Conditional

**Signals**

- the same variant or type-code match appears across several modules;
- adding one variant requires edits in many unrelated places;
- match arms contain behavior that belongs to the matched value;
- branch conditions encode a state machine informally.

**Rust interpretation**

An exhaustive `match` is normally good Rust. First centralize behavior in inherent methods on the enum. Use a trait only when implementations are intentionally open or independently owned. Use an enum/state machine when the states are closed and transitions matter.

**Likely moves**

Move Function, Extract Function, Replace Conditional with Polymorphism, Replace Type Code with Subclasses, Decompose Conditional.

**False positives**

One authoritative exhaustive match, serialization/formatting adapters, visitors, and cross-cutting operations where keeping behavior at the use site is clearer.

### Loops

**Signals**

- a loop only filters, maps, folds, searches, partitions, or collects;
- mutable accumulator logic obscures a simple data transformation;
- manual early error propagation repeats boilerplate.

**Rust interpretation**

Iterator pipelines are idiomatic when they clarify the transformation. Use `map`, `filter`, `filter_map`, `find`, `any`, `all`, `fold`, `try_fold`, `try_for_each`, and `collect::<Result<_, _>>()` where appropriate. Keep a loop when control flow, state mutation, labeled exits, or debugging is clearer.

**Likely moves**

Replace Loop with Pipeline, Split Loop, Extract Function, Replace Control Flag with Break.

**False positives**

Complex state machines, mutation-heavy algorithms, tight performance loops that have been measured, and pipelines that become denser than the loop they replace.

### Nested Conditional

**Signals**

- the normal path is buried under error cases;
- several indentation levels are required to understand preconditions;
- conditions repeat or have unclear names.

**Rust interpretation**

Use guard clauses, `let ... else`, `if let`, `matches!`, helper predicates, and early `?` propagation. Do not compress every branch into combinators if the result is harder to read.

**Likely moves**

Replace Nested Conditional with Guard Clauses, Decompose Conditional, Consolidate Conditional Expression, Extract Variable.

### Control Flag

**Signals**

- a mutable boolean exists only to exit or skip loop work;
- a sentinel value simulates a break or return.

**Rust interpretation**

Use `break`, labeled `break`, `continue`, `return`, iterator search methods, or a result-bearing loop. Preserve cleanup and drop order.

**Likely moves**

Replace Control Flag with Break, Substitute Algorithm.

### Separate Query from Modifier

**Signals**

- a method named as a query mutates hidden state;
- callers must invoke a getter to trigger computation or I/O;
- cache filling, logging, and business mutation are indistinguishable.

**Rust interpretation**

Make mutation explicit through `&mut self`, a command method, or a returned updated value. Interior mutability is sometimes required for caches, but its semantics should be documented.

**Likely moves**

Separate Query from Modifier, Return Modified Value, Encapsulate Variable.

## 4. Data and type design

### Primitive Obsession

**Signals**

- strings encode status, role, unit, currency, strategy, or protocol kind;
- integer IDs for different entities are interchangeable;
- repeated validation surrounds raw primitives;
- tuples carry fields whose positions are easy to confuse;
- `Option` or `bool` parameters carry domain meaning.

**Rust interpretation**

Use tuple-struct newtypes, enums, validated constructors, `TryFrom`, standard domain types such as `Duration` or `Path`, and named structs. The type must earn its cost by enforcing meaning, validation, units, formatting, or allowed states.

**Likely moves**

Replace Primitive with Object, Replace Type Code with Subclasses, Introduce Parameter Object, Encapsulate Record.

**False positives**

Transparent wire formats, database rows, high-volume numeric code, and wrappers that would add no invariant or distinction.

### Data Clumps

**Signals**

- the same fields or parameters travel together repeatedly;
- partial combinations are rarely meaningful;
- validation or formatting always applies to the group.

**Rust interpretation**

Introduce a struct or newtype with clear ownership and lifetime parameters. Avoid self-referential aggregates or lifetime complexity unless the concept is real.

**Likely moves**

Introduce Parameter Object, Extract Class, Preserve Whole Object.

### Mutable Data

**Signals**

- wide `mut` or `&mut` scopes;
- multiple components can mutate the same state;
- repeated “update then repair invariant” sequences;
- interior mutability is pervasive;
- cache invalidation is spread across callers.

**Rust interpretation**

Narrow mutation scopes, return transformed values, centralize state transitions, and use types that cannot represent invalid intermediate states. Shared mutability may be correct; focus on ownership and synchronization boundaries.

**Likely moves**

Encapsulate Variable, Split Variable, Return Modified Value, Change Reference to Value, Move Function.

### Global Data

**Signals**

- `static mut`, process-wide registries, implicit singleton state, or ambient configuration;
- tests depend on execution order;
- unrelated functions read or mutate hidden state.

**Rust interpretation**

Prefer explicit state injection. When process-wide state is necessary, use safe initialization and synchronization primitives, isolate access behind a narrow API, and document lifecycle and concurrency guarantees.

**Likely moves**

Encapsulate Variable, Move Function, Change Reference to Value.

### Temporary Field / Invalid State

**Signals**

- many `Option` fields are present only in certain modes;
- comments explain which fields are valid together;
- runtime checks reconstruct a state machine repeatedly;
- a builder and built value share one permissive struct.

**Rust interpretation**

Use enum variants, separate staged types, validated conversion, or distinct request/state structs. Sparse patch objects and DTOs are legitimate counterexamples.

**Likely moves**

Replace Type Code with Subclasses, Extract Class, Introduce Special Case, Split Phase.

### Data Class

**Signals**

- callers repeatedly validate or manipulate fields directly;
- behavior that protects the type's invariants lives elsewhere;
- public fields prevent safe evolution;
- the type is merely an anemic proxy for a domain concept.

**Rust interpretation**

Data-only structs are common and often correct. Add methods or privacy only when they protect invariants or establish a useful API. Do not manufacture getters and setters for transparent records.

**Likely moves**

Encapsulate Record, Move Function, Encapsulate Collection, Remove Setting Method.

### Large Class analogue: Large Struct or Module

**Signals**

- many fields support unrelated concerns;
- an `impl` block changes for unrelated reasons;
- a module mixes parsing, domain logic, I/O, formatting, and orchestration;
- visibility is wide because everything lives together.

**Rust interpretation**

Extract cohesive structs and modules, split external DTOs from internal models, and narrow visibility. Do not split by arbitrary line count.

**Likely moves**

Extract Class, Move Function, Move Field, Split Phase.

### Message Chains

**Signals**

- callers navigate deep internal object graphs (`a.b().c().d()`);
- ownership structure leaks across modules;
- many call sites know the same internal route.

**Rust interpretation**

Method chaining and iterator chains are idiomatic. The smell is dependency on an internal graph, not dots themselves. Add a focused method or query at the owner boundary when it reduces knowledge.

**Likely moves**

Hide Delegate, Extract Function, Move Function.

### Encapsulate Collection

**Signals**

- APIs expose `&Vec<T>` where a slice is sufficient;
- callers mutate a collection without preserving owner invariants;
- a public field fixes the collection implementation permanently.

**Rust interpretation**

Return slices, iterators, or domain operations; accept `IntoIterator` only when the extra generality is useful. Avoid over-general generic signatures that harm readability, compile time, or object safety.

**Likely moves**

Encapsulate Collection, Change Function Declaration, Remove Setting Method.

## 5. Modules and change coupling

### Divergent Change

**Signals**

- one module changes for several unrelated reasons;
- feature work repeatedly edits unrelated regions of the same file/type;
- parsing, persistence, policy, and presentation evolve independently but are coupled.

**Rust interpretation**

Split modules by reason to change and dependency direction. Typical seams are external representation → validation → domain operation → I/O adapter → presentation.

**Likely moves**

Extract Class, Move Function, Split Phase.

### Shotgun Surgery

**Signals**

- one conceptual change requires edits across many modules;
- the same policy is duplicated in constructors, matches, serializers, and validators;
- a new enum variant causes unrelated modifications throughout the crate.

**Rust interpretation**

Centralize the policy in an owning type or module, introduce a domain conversion, or create a stable internal boundary. Do not create a “god context” or broad trait merely to reduce file count.

**Likely moves**

Move Function, Move Field, Combine Functions into Class, Introduce Parameter Object, Change Function Declaration.

### Feature Envy

**Signals**

- a function reads many fields or calls many methods on another type;
- it reconstructs another type's invariant or policy;
- its current module has little connection to its data.

**Rust interpretation**

Move the function into the module/type that owns the data, or expose one purposeful operation. Free functions remain idiomatic when no clear receiver exists.

**Likely moves**

Move Function, Extract Function, Combine Functions into Class.

### Insider Trading

**Signals**

- modules use `pub(crate)` or friend-like access broadly;
- two types know each other's internal representation;
- changes to private fields propagate across module boundaries.

**Rust interpretation**

Narrow visibility (`pub(super)`, private modules), add a domain operation, or move behavior to the owner. Do not hide necessary high-performance collaboration behind allocation-heavy APIs.

**Likely moves**

Move Function, Move Field, Hide Delegate, Encapsulate Record.

## 6. Abstraction and delegation

### Speculative Generality

**Signals**

- a trait has one implementation and no credible extension boundary;
- unused generic parameters, feature flags, adapters, or macros anticipate hypothetical needs;
- dynamic dispatch exists without heterogeneity;
- abstractions lengthen signatures and compile times without reducing change cost.

**Rust interpretation**

Remove abstractions that do not pay rent. Preserve deliberate test seams, plugin interfaces, unsafe contracts, and public extension points. Consider code size and monomorphization as well as runtime dispatch.

**Likely moves**

Inline Class, Collapse Hierarchy, Remove Dead Code, Inline Function, Remove Middle Man.

### Lazy Element

**Signals**

- a wrapper, module, function, or trait adds no name, invariant, policy, or boundary;
- navigation cost exceeds the information it contributes.

**Rust interpretation**

Inline it unless it is protecting semver, visibility, test substitution, type distinction, or unsafe invariants.

**Likely moves**

Inline Function, Inline Class, Remove Middle Man.

### Middle Man

**Signals**

- most methods only forward to another object;
- a wrapper mirrors an entire API without adding policy.

**Rust interpretation**

Forwarding can be valuable for newtypes, capability restriction, semver, and invariants. Remove only the delegation that adds no useful boundary.

**Likely moves**

Remove Middle Man, Inline Function.

### Alternative Classes with Different Interfaces

**Signals**

- multiple types provide the same semantic operation under incompatible names;
- callers write adapters repeatedly.

**Rust interpretation**

Align inherent method names or define a trait only when there is a real shared capability and the orphan/coherence rules permit it. A local extension trait can adapt external types without pretending their entire APIs are equivalent.

**Likely moves**

Change Function Declaration, Extract Superclass analogue through a trait, Move Function.

### Refused Bequest analogue: Over-broad Trait Contract

**Signals**

- implementers panic or return dummy values for required methods;
- a type implements a broad trait only to obtain one capability;
- supertrait bounds force irrelevant behavior.

**Rust interpretation**

Split capability traits, use blanket implementations carefully, favor composition, or remove the inappropriate implementation. This is not a literal inheritance problem.

**Likely moves**

Push Down Method analogue, Collapse Hierarchy, Replace Superclass with Delegate analogue through composition.

### Comments

**Signals**

- comments narrate opaque code rather than explain why;
- a comment compensates for a misleading name;
- safety or invariant comments disagree with code.

**Rust interpretation**

Rename and extract to make “what” visible. Retain comments for rationale, tradeoffs, protocol requirements, `SAFETY:` arguments, panic/error behavior, and public rustdoc contracts.

**Likely moves**

Extract Function, Rename Variable, Introduce Assertion.

## 7. Rust-specific amplifiers

These are not Fowler smell names. They are Rust signals that often reveal one of the smells above.

### Clone bursts

Repeated `clone()` calls can indicate an ownership boundary that does not fit the data flow. They can also be intentional, cheap, and clearer than lifetime-heavy code. Inspect type size, retention, and hot-path impact before recommending change.

### Interior-mutability spread

`Rc<RefCell<_>>`, `Arc<Mutex<_>>`, atomics, and cells can reveal hidden shared state. They can also be the correct representation. Review borrow/lock scope, contention, poisoning, cancellation, and invariants.

### Recoverable work behind `unwrap` or `expect`

Clusters of panics near I/O, parsing, user input, or public library boundaries may indicate scattered error handling. Panics in tests and proven internal invariants are different. Document intentional panic contracts.

### Over-specific borrowed containers

`&Vec<T>` and `&String` often expose more implementation than required. Prefer `&[T]` and `&str` when only slice behavior is needed, while treating public signature changes as semver work.

### Public fields with hidden invariants

A public struct with public fields is fine as a transparent record. It is risky when constructors, validation, or field relationships are supposed to constrain valid values.

### Async lock scope

A lock guard held across `.await` can create contention, deadlock risk, or `Send` constraints. This is a correctness/performance review requiring semantic analysis, not a scanner-only conclusion.

### Unsafe surface growth

Repeated or wide unsafe blocks can signal missing encapsulation. The goal is a small safe abstraction with explicit invariants, not blindly minimizing the number of `unsafe` tokens.

## 8. Candidate scoring

Score each candidate on four independent axes rather than inventing one false precision number.

### Impact

- **High:** recurring correctness/safety risk, invalid states, broad change propagation, or public API friction.
- **Medium:** meaningful comprehension or testability cost in actively changed code.
- **Low:** local idiom or readability improvement with limited leverage.

### Confidence

- **High:** direct evidence, clear shared concept, and low ambiguity.
- **Medium:** strong signal but domain validation is still needed.
- **Low:** metric or syntax proxy with common legitimate counterexamples.

### Scope

- **Local:** one function/type/module.
- **Cross-module:** several internal callers or features.
- **Public:** downstream API, serialization, ABI, or protocol implications.

### Risk

- **Low:** compiler-guided rename/extract with strong tests.
- **Medium:** ownership/API changes, feature combinations, or performance sensitivity.
- **High:** unsafe, FFI, concurrency, async cancellation, persistent data, or public compatibility.

Prioritize high-impact, high-confidence findings that serve current change pressure. Do not prioritize low-confidence metrics merely because they are easy to count.
