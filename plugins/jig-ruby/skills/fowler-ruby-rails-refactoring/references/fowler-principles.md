# Fowler Refactoring Principles

This reference distills Martin Fowler's published definition, workflow guidance, catalog, and related writing into operating rules for Ruby and Rails assessment. It summarizes the ideas; it does not reproduce the book.

## 1. Refactoring Has a Precise Boundary

Refactoring is a disciplined restructuring of existing code that preserves externally observable behavior. The term should not be used as a synonym for any rewrite or cleanup.

Consequences for an assessment:

- A new feature is not a refactoring.
- A bug fix is not a refactoring because intended behavior changes.
- A query optimization is not automatically a refactoring because its success criterion is measured performance.
- A database migration, framework upgrade, or public API redesign is not a refactoring.
- These activities may be enabled by preparatory refactoring, but they need separate plans and verification.

In Ruby and Rails, “observable behavior” is wider than return values. It can include exceptions, mutation, callback ordering, SQL result ordering, transaction/lock boundaries, job enqueue timing, emitted events, rendered JSON shape, redirects, mail, files, and external calls.

## 2. The Mechanism Is a Sequence of Small Transformations

Fowler's central safety mechanism is not confidence in a grand design. It is a chain of small, behavior-preserving changes that keep the program working.

A practical step should be:

- narrow enough to understand in isolation;
- easy to reverse;
- followed by a focused test or load/syntax check;
- free of unrelated formatting or behavior changes;
- a useful intermediate state even before the full restructuring is complete.

Examples of appropriately small steps:

- rename one misleading method and update callers;
- extract one expression into a named query method;
- move one pure calculation to a value object;
- introduce a forwarding method before moving implementation;
- wrap an unstructured hash without changing all callers at once;
- isolate one external call behind a gateway before changing domain logic.

## 3. Tests Provide the Safety Net

The smaller the transformations, the easier failures are to localize, but mistakes remain possible. Refactoring therefore depends on fast, relevant tests.

Use this hierarchy:

1. Run existing focused tests to establish a green baseline.
2. Add characterization tests for behavior that is currently implicit or poorly protected.
3. Refactor in small steps, testing after each.
4. Run broader integration/system/contract coverage at the end.

Characterization tests should capture existing behavior, including awkward behavior, without silently redefining what the product ought to do. A later bug fix can deliberately change the expectation under a different hat.

For Rails, select the test level that protects the boundary being moved:

- pure unit tests for calculations and value objects;
- model tests for validations, callbacks, scopes, and persistence behavior;
- request tests for controller and API contracts;
- job tests for enqueue timing and arguments;
- query-count or strict-loading checks for N+1 work;
- integration/system tests for workflows crossing multiple layers.

## 4. Keep the Two Hats Separate

Fowler, drawing on Kent Beck's metaphor, distinguishes:

- **refactoring mode**, where behavior is preserved and tests remain green; and
- **adding-function mode**, where behavior and tests are intentionally changed.

The programmer may switch hats frequently, but should know which one is being worn.

For repository work, make the separation visible:

- separate plan sections;
- separate patch slices or commits;
- no schema or API change hidden inside a structural cleanup;
- no opportunistic bug fix folded into a rename without a regression test;
- no performance claim without measurement.

## 5. Refactor as Part of Normal Work

Fowler describes several workflows rather than a single “refactoring project”:

- **Preparatory refactoring:** reshape existing code so the next feature or fix becomes easier.
- **Comprehension refactoring:** improve names and structure while learning unfamiliar code.
- **Litter-pickup/opportunistic refactoring:** make a small local improvement while touching nearby code.
- **TDD refactoring:** improve design after making a behavior pass.
- **Planned or long-term refactoring:** use incremental steps when a larger structural problem cannot be solved locally.

The skill should identify which workflow fits the evidence. It should not recommend a broad cleanup campaign when a small preparatory move is enough.

## 6. A Code Smell Is an Investigation Trigger

A smell is a surface indication of a deeper design problem. It is not proof.

Validation questions:

- Does the structure actually make likely changes harder?
- Is knowledge duplicated or merely syntax repeated?
- Does the code have multiple reasons to change?
- Are callers relying on the apparent awkwardness?
- Is the code generated, framework glue, or a stable adapter?
- Is the metric distorted by a DSL, table declaration, or data literal?
- Would the proposed abstraction be clearer than the duplication?

The skill should discard metric-only findings when it cannot explain the expected payoff.

## 7. Refactor Toward Intention and Cohesion

Fowler's discussion of function length emphasizes the gap between intention and implementation. Extraction is valuable when a reader has to interpret a block to discover what it means, even if the block is short and used once.

Use extraction to:

- name domain decisions;
- separate abstraction levels;
- reveal seams for later moves;
- isolate side effects from calculation;
- make duplicated knowledge visible;
- reduce the amount of state a reader must hold at once.

Do not extract mechanically. A proliferation of forwarding methods, generic helpers, and tiny classes with no stable concept can create a Middle Man or Lazy Element smell.

## 8. Refactor for Future Change, Not Abstract Purity

The economic value of refactoring is lower future change cost. Prioritize code that is likely to change or is already creating delivery friction.

Useful evidence:

- frequent edits in version history;
- defects clustered around the same rule;
- a current feature that requires invasive changes;
- duplicated policy across controllers, jobs, and models;
- broad call-site changes for a small concept;
- tests that require excessive setup because responsibilities are entangled.

Stable code that is ugly but rarely touched may not justify risk. The correct outcome can be “leave it alone.”

## 9. Optimization Uses a Different Success Criterion

Refactoring primarily seeks clarity and ease of change. Optimization seeks measured performance improvement.

Some transformations can serve either purpose, but the governing evidence differs:

- Refactoring: structure is clearer and behavior is preserved.
- Optimization: profiler/query/allocation measurements improve while required behavior remains correct.

Rails examples requiring explicit optimization treatment:

- changing eager-loading strategy;
- replacing object loading with `pluck`;
- bulk updates;
- cache introduction;
- query rewrites that alter joins or result cardinality;
- changing enumerable pipelines for allocation reduction.

## 10. External Boundaries Deserve Early Isolation

In Fowler's external-service refactoring example, transport access, response mapping, and domain decisions are separated into different objects. This is especially useful in Rails code where controller/model/job code may directly call remote APIs.

A safe sequence is usually:

1. characterize current success and failure behavior;
2. extract the remote call behind a connection/gateway boundary;
3. encapsulate the remote data shape;
4. separate domain decisions from transport details;
5. only then change workflow or error policy under a separate hat.

## 11. Frequent Integration Supports Refactoring

Large, long-running refactor branches create merge conflict and discourage continuous improvement. Prefer small integrated slices whose intermediate states work.

For a plan, identify seams that can be merged independently:

- add a new API and delegate the old one;
- migrate callers gradually;
- preserve old and new representations temporarily;
- remove compatibility code after callers are moved.

This is often safer than a repository-wide “flag day” rename or extraction.

## Primary Sources Consulted

- Martin Fowler, “Refactoring”: https://martinfowler.com/refactoring/
- Martin Fowler, *Refactoring: Improving the Design of Existing Code*, 2nd ed. overview: https://martinfowler.com/books/refactoring.html
- Martin Fowler, “Catalog of Refactorings”: https://refactoring.com/catalog/
- Martin Fowler, “Workflows of Refactoring”: https://martinfowler.com/articles/workflowsOfRefactoring/
- Martin Fowler, “An example of preparatory refactoring”: https://martinfowler.com/articles/preparatory-refactoring-example.html
- Martin Fowler, “Opportunistic Refactoring”: https://martinfowler.com/bliki/OpportunisticRefactoring.html
- Martin Fowler, “Code Smell”: https://martinfowler.com/bliki/CodeSmell.html
- Martin Fowler, “Function Length”: https://martinfowler.com/bliki/FunctionLength.html
- Martin Fowler, “Is Optimization Refactoring”: https://martinfowler.com/bliki/IsOptimizationRefactoring.html
- Martin Fowler, “Refactoring code that accesses external services”: https://martinfowler.com/articles/refactoring-external-service.html
- Martin Fowler, “Refactoring Ruby Edition”: https://martinfowler.com/books/refactoringRubyEd.html
