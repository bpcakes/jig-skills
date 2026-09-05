---
name: fowler-ruby-rails-refactoring
description: Analyze Ruby and Ruby on Rails code for refactoring opportunities and produce a prioritized, behavior-preserving plan grounded in Martin Fowler's refactoring principles. Use for code-smell reviews, refactoring assessments, Rails model/controller/query/callback simplification, legacy-code preparation, or requests to explain how to restructure Ruby/Rails code safely. Default to read-only analysis. Do not treat bug fixes, performance tuning, framework upgrades, schema/data migrations, public API changes, or architecture rewrites as refactoring; identify and separate them explicitly.
---

# Fowler-Grounded Ruby and Rails Refactoring

## Purpose

Find code whose internal design is making likely changes harder, validate whether the apparent smell is real, and outline a sequence of small behavior-preserving transformations suited to the repository's actual Ruby and Rails versions.

The goal is not to maximize the number of abstractions or minimize line count. The goal is to reduce the cost and risk of future change while keeping observable behavior stable.

## Required Discipline

Apply these rules throughout the assessment:

1. **Preserve observable behavior.** Refactoring changes internal structure, not product behavior. Treat HTTP contracts, return values, raised exceptions, database writes, transaction boundaries, locks, callbacks, jobs, emitted events, logs relied on operationally, files, emails, and external calls as potentially observable.
2. **Use tiny, reversible steps.** Each step should leave the code loadable and the relevant tests passing. Prefer a chain of obvious transformations over one clever rewrite.
3. **Keep the two hats separate.** Do not mix refactoring with feature work, bug fixes, optimization, dependency upgrades, migrations, or policy changes. Put non-refactoring work in a separate section and, during implementation, separate commits.
4. **Start from green.** Run the narrowest relevant tests before proposing or applying a change. When coverage is weak, first add characterization tests around current behavior.
5. **Treat smells as clues, not verdicts.** Confirm call sites, change history, runtime behavior, coupling, and team conventions. A long method that is linear and stable may be lower value than a short method that hides cross-system side effects.
6. **Refactor where change pressure exists.** Prioritize code that is currently being changed, repeatedly causes defects, blocks a requested feature, or creates broad blast radius. Do not polish stable code merely because a metric crossed a threshold.
7. **Prefer clarity over novelty.** Use ordinary Ruby messages, small objects, cohesive modules, and Rails-native APIs. Do not replace straightforward code with metaprogramming, generic frameworks, or Java-shaped class hierarchies.

Read `references/fowler-principles.md` for the full rationale and source links.

## Default Mode

Operate read-only unless the user explicitly asks to implement refactorings.

In read-only mode:

- inspect code, tests, configuration, schema, routes, call sites, and relevant history;
- run existing tests and analysis tools when safe;
- report opportunities and a sequenced approach;
- do not edit files.

In implementation mode:

- implement one coherent slice at a time;
- run focused verification after every meaningful step;
- keep behavior changes separate and clearly identified;
- stop and report when the supposed refactoring requires an unresolved product or data decision.

## Workflow

### 1. Resolve Scope and Repository Context

Use the scope named by the user. If the request points to a diff, pull request, directory, class, or feature, stay within that boundary unless evidence requires inspecting direct collaborators.

Establish context before recommending syntax or framework APIs:

- inspect `.ruby-version`, `.tool-versions`, `Gemfile`, and `Gemfile.lock`;
- identify the Rails version and `config.load_defaults` target;
- identify Minitest, RSpec, or another test stack and the repository's documented commands;
- inspect `.rubocop.yml` and any configured RuboCop extensions;
- inspect existing architectural conventions before inventing directories such as `app/services`, `app/queries`, or `app/forms`;
- check `git status` and avoid overwriting unrelated work;
- inspect relevant recent history when it helps establish change pressure or intended behavior.

Never recommend a language feature or Rails API unsupported by the project. For example, use `Data.define` only when the target Ruby supports it and value semantics are appropriate.

### 2. Establish the Behavioral Baseline

Run the narrowest relevant test command first. Examples, chosen only when the project supports them:

```bash
bin/rails test test/models/order_test.rb
bundle exec rspec spec/models/order_spec.rb
bundle exec ruby -Itest test/path/to/test_file.rb
```

If the focused tests are green, record that. If they are red, distinguish pre-existing failures from findings caused by later work.

Identify behavior that must remain stable:

- public Ruby method results and exceptions;
- request status, headers, redirects, rendered payloads, and validation errors;
- persisted records and callback ordering;
- transaction and locking behavior;
- job enqueue timing and arguments;
- external service calls, mail, notifications, file operations, and event publication;
- query ordering, laziness, relation composability, and memory behavior when callers depend on them.

When tests do not cover these behaviors, propose characterization tests before structural changes.

### 3. Search Broadly, Then Validate Narrowly

Run the bundled heuristic scanner as one input, not as an oracle:

```bash
ruby /path/to/this-skill/scripts/scan_refactoring_opportunities.rb . --format markdown
```

The scanner requires only Ruby's standard library. It reports candidates such as long functions, deep conditionals, flag arguments, large classes, callback-heavy models, queries inside loops, `default_scope`, and APIs that bypass validations or callbacks. Its findings must be confirmed by reading the code and call sites.

Also use repository-native tools when already present. Do not install new gems merely for an assessment:

```bash
bundle exec rubocop
bundle exec rubocop --only Metrics,Style,Lint,Rails
bundle exec reek .
bundle exec flay app lib
bundle exec flog app lib
```

Search lenses:

- duplicated knowledge, not just duplicated text;
- unclear intention, misleading names, and mixed abstraction levels;
- long functions, deep nesting, flag arguments, and repeated conditionals;
- data clumps, primitive obsession, option hashes, and implicit hash schemas;
- feature envy, inappropriate intimacy, message chains, and middle men;
- classes or modules with multiple reasons to change;
- scattered edits required for one business rule;
- mutable global or class-level state;
- hidden side effects and query/modifier mixtures;
- Rails callback chains, implicit scopes, N+1 risks, view queries, and transaction leakage;
- code around external services that mixes transport, mapping, and domain decisions.

Read `references/smell-to-refactoring-map.md` before finalizing mappings.

### 4. Validate Every Candidate

For each candidate, answer all of the following:

1. **Evidence:** What exact code, call pattern, runtime trace, test gap, or change history supports the finding?
2. **Smell:** Which design pressure is present? Use Fowler's smell vocabulary where it fits, but do not force a label.
3. **Change pressure:** What likely change is expensive because of this structure?
4. **Counterevidence:** Is the code stable, generated, framework glue, intentionally optimized, or constrained by a public API?
5. **Behavioral risk:** What could silently change during the refactoring?
6. **Named moves:** Which small Fowler refactorings can form a safe sequence?
7. **Idiomatic destination:** What Ruby/Rails shape improves cohesion without creating ceremony?
8. **Verification:** Which focused tests, query assertions, contract checks, or instrumentation prove preservation?

Discard low-value metric-only findings that lack a plausible change benefit.

### 5. Distinguish Refactoring from Adjacent Work

Classify these separately:

- **Bug fix:** intended externally observable behavior changes.
- **Optimization:** performance, memory, allocation, or query count is the primary goal. Measure before and after.
- **Migration:** database schema or stored data changes.
- **Upgrade:** Ruby, Rails, gem, API, or configuration version changes.
- **Redesign:** public boundaries, domain policy, workflow, or architecture changes.
- **Security hardening:** trust boundaries or accepted inputs change.

A task may contain both refactoring and adjacent work. Sequence preparatory refactoring first where it lowers the risk of the later change, but do not pretend they are the same hat.

### 6. Prioritize Without Fake Precision

Assign `P1`, `P2`, or `P3` using judgment:

- **P1:** blocks imminent work, creates high defect/blast-radius risk, hides transactional or external side effects, or has strong runtime evidence such as queries in a loop.
- **P2:** recurring friction with clear payoff and manageable safety work.
- **P3:** local readability improvement, weak change pressure, or a lower-confidence smell.

Raise priority for high change frequency, duplicated business rules, broad fan-out, production incidents, and easy characterization. Lower it for generated code, stable adapters, one-off migrations, and code whose current shape is constrained by a framework or public contract.

Confidence must be `high`, `medium`, or `low`. State what evidence would raise confidence.

### 7. Build a Fowler-Style Sequence

A good plan names the intermediate transformations, not only the desired end state. Typical sequence:

1. Add or identify characterization tests.
2. Rename misleading variables/functions without changing logic.
3. Extract a coherent expression or function.
4. Separate query from modifier or isolate an external boundary.
5. Introduce a parameter/value object if data travels together.
6. Move behavior toward the object that owns the relevant data.
7. Extract a class or strategy only after the seam is visible.
8. Remove delegation, dead code, or duplication exposed by the earlier steps.
9. Run focused tests after every step and the wider suite at the end.

Every step must be independently understandable and reversible. Avoid plans such as “rewrite as service objects” or “make the model skinny”; they are destinations without mechanics or evidence.

## Modern Ruby Adaptation Rules

Use `references/ruby-rails-playbook.md` for detailed mappings and examples. Apply these defaults:

- Prefer intention-revealing private methods over comments that narrate implementation.
- Prefer keyword arguments for call-site clarity; use a parameter object when values form a concept, travel together, or carry invariants.
- Use a small immutable value object for domain values. `Data.define` is suitable when supported and shallow immutable value semantics fit; otherwise use a plain class or an appropriate `Struct`.
- Prefer `Enumerable` pipelines such as `filter_map`, `sum`, and `each_with_object` only when they preserve ordering, laziness, exceptions, false/nil handling, and side effects.
- Use duck-typed strategies or callable objects for genuine variation. Do not build inheritance hierarchies merely to remove one conditional.
- Replace implicit hash shapes with named objects at stable boundaries, especially when keys are repeated across files.
- Encapsulate metaprogramming and monkey patches before changing them. Dynamic dispatch can hide callers from text search.
- Preserve visibility and API shape. Extracted helpers should be private unless a public protocol is intentional.
- Follow the repository's formatter and style configuration rather than imposing a generic style guide.

## Modern Rails Adaptation Rules

- **Controllers:** Keep request/response concerns visible. Move cohesive domain decisions or multi-step workflows out when doing so clarifies behavior; do not chase “skinny controllers” as a metric.
- **Active Record models:** Cohesive domain behavior may belong on the model. Extract persistence-free values, policies, calculations, gateways, or workflows when the model has unrelated reasons to change. Do not use concerns as dumping grounds.
- **Plain/Active Model objects:** Use plain Ruby objects by default; add `ActiveModel` modules when validations, naming, conversion, or form integration are actually needed.
- **Queries:** Prefer composable scopes for small reusable relation fragments. Preserve `ActiveRecord::Relation` semantics. Use a query object when a query has its own vocabulary, many branches, or cross-model composition.
- **N+1 findings:** Confirm with tests, logs, instrumentation, or strict loading. Choosing `includes`, `preload`, or `eager_load` is partly an optimization decision and can alter SQL semantics; verify result cardinality and ordering.
- **Callbacks:** Keep invariant-local lifecycle behavior close to the model. When callbacks hide workflow, ordering, or external side effects, expose orchestration explicitly. External effects tied to persistence generally require commit-aware handling. Preserve callback order and transaction semantics during extraction.
- **Transactions and locks:** Treat their boundaries as behavior. Do not split a transaction, move a query outside a lock, or enqueue work at a different commit point without calling it a behavior change.
- **Bulk APIs:** `update_all`, `delete_all`, `insert_all`, `upsert_all`, `update_columns`, validation bypasses, and callback skipping are semantic boundaries. Do not replace or wrap them casually.
- **Views and serializers:** Extract presentation logic when it obscures the contract or repeats. Do not move database queries into helpers, presenters, or serializers.
- **Autoloading:** Keep constants and file paths aligned with Zeitwerk conventions. Follow existing namespaces and avoid manual `require` calls for application code under `app`.
- **Jobs:** Preserve enqueue timing, queue, retry/discard behavior, idempotency assumptions, and argument serialization.
- **Time:** In Rails code, assess `Time.current`/`Date.current` versus system time deliberately. Changing time-zone semantics is not automatically a behavior-preserving refactoring.

## Output Contract

Use this structure unless the user requests another format:

```markdown
# Refactoring assessment

## Context and baseline
- Scope:
- Ruby / Rails:
- Tests run and result:
- Existing analysis tools:
- Important behavioral boundaries:

## Ranked opportunities
| Priority | Location | Evidence | Smell / pressure | Fowler moves | Ruby/Rails destination | Confidence |
|---|---|---|---|---|---|---|

## Detailed approach
### P1 — <concise finding name>
**Why this matters:** ...
**Behavior to preserve:** ...
**Sequence:**
1. ...
2. ...
**Verification after each step:** ...
**Risks / stop conditions:** ...

## Adjacent work that is not refactoring
- ...

## Verification plan
- Focused tests:
- Wider suite:
- Runtime/query/contract checks:
```

For each ranked finding:

- include a precise file and line or symbol;
- quote only the minimum code needed as evidence;
- name one or more Fowler refactorings;
- describe the intermediate passing states;
- state confidence and false-positive risk;
- avoid presenting a speculative final architecture as certain.

If no worthwhile opportunities are found, say so and explain the evidence. Do not manufacture findings to fill a report.

## Implementation Protocol

When explicitly asked to apply a finding:

1. Re-run the relevant baseline tests.
2. Add characterization coverage if the behavior is not protected.
3. Apply one named transformation.
4. Run the narrowest relevant test or syntax/load check.
5. Inspect the diff for accidental behavior changes.
6. Repeat until the selected slice is complete.
7. Run the broader relevant suite and configured linting.
8. Report exact files changed, tests run, and any behavior-changing work deliberately excluded.

Prefer commits or patch slices that each tell one refactoring story. Never combine a broad rename, framework upgrade, schema change, and behavior change under a single “refactor” label.

## Bundled Files

- `scripts/scan_refactoring_opportunities.rb` — dependency-free heuristic scanner with Markdown and JSON output.
- `references/fowler-principles.md` — principles, boundaries, and primary sources.
- `references/ruby-rails-playbook.md` — Fowler-to-Ruby/Rails adaptation table and examples.
- `references/smell-to-refactoring-map.md` — detection indicators, false-positive checks, and likely moves.
- `examples/example-assessment.md` — model output.
- `test/scanner_smoke_test.rb` — scanner smoke test.
