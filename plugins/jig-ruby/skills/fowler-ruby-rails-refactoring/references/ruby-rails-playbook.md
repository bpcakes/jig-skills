# Fowler-to-Ruby/Rails Refactoring Playbook

Use this reference to translate Fowler's language-neutral catalog into idiomatic Ruby and Rails shapes. The destination is conditional on the repository's Ruby version, Rails version, conventions, and behavioral constraints.

## Version and Convention Gate

Before recommending a destination:

1. Read `.ruby-version` or `.tool-versions`.
2. Read the locked Rails version from `Gemfile.lock`.
3. Read `config.load_defaults` in `config/application.rb`.
4. Read `.rubocop.yml` and existing code in adjacent namespaces.
5. Check whether the code is a gem/library with a compatibility matrix rather than an application with one runtime.

Do not recommend `Data.define`, numbered block parameters, endless methods, pattern matching, newer Active Record APIs, or Rails transaction/job behavior merely because they are modern. They must be supported by the target.

## Core Catalog Mappings

| Fowler refactoring | Ruby/Rails adaptation | Use when | Main preservation risks |
|---|---|---|---|
| Extract Function | Extract a private method, module function, lambda, or named collaborator method. Name the intention, not the mechanics. | A block mixes abstraction levels, hides a decision, or needs a seam. | Local variable capture, mutation order, non-local `return`, block control flow, exception location. |
| Inline Function | Remove a method whose body is clearer than its name or that only forwards without adding a stable protocol. | An extraction became a Lazy Element or Middle Man. | Visibility, overrides, instrumentation, tests stubbing the method. |
| Extract Variable | Name a complex predicate, calculation, or query fragment. | A reader must decode an expression before understanding the branch. | Evaluation count, time-dependent values, lazy relations, methods with side effects. |
| Inline Variable | Remove a name that obscures a direct expression or is assigned once without adding meaning. | The variable adds indirection but no intention. | Evaluation count and mutation between assignment/use. |
| Change Function Declaration | Rename, add keyword arguments, introduce a compatibility wrapper, or split a public method. | The API communicates the wrong concept or permits invalid calls. | Public callers, reflection, `send`, callbacks by symbol, routes, serializers, tests/stubs. |
| Encapsulate Variable | Replace global/class-variable access with an accessor, configuration object, or injected dependency. | Mutable state is read/written broadly. | Initialization order, thread safety, reloader behavior, process-local versus shared state. |
| Rename Variable | Use domain language and Rails conventions (`order`, not `obj`; `account_id`, not `aid`). | Meaning is unclear or stale. | Dynamic local binding is low risk; instance variables may be read by views or serializers. |
| Introduce Parameter Object | Start with keyword arguments; introduce a named value object when values travel together or have invariants. | Long parameter list or data clump. | Defaults, positional callers, serialization, equality, mutability. |
| Combine Functions into Class | Create a cohesive value/domain object or command with explicit state. | Functions share data and form a concept. | Over-classification, state lifetime, side effects hidden in constructors. |
| Combine Functions into Transform | Produce a derived hash/data object without mutating the source. | Several calculations derive values from the same input. | Key shape, laziness, duplicate calculation, mutable nested values. |
| Split Phase | Separate parsing/normalization from decisions; separate loading from calculation; separate validation from persistence. | One method performs distinct phases with different data. | Transaction boundary, ordering, error mapping, partial side effects. |
| Move Function | Move behavior toward the data or boundary it primarily uses. | Feature Envy or misplaced transport/domain logic. | Public API, callback context, private access, circular dependencies. |
| Move Field | Relocate state to the object that owns its invariant. | State changes with another object more than its current owner. | Persistence/schema changes are not pure refactoring; use delegation first. |
| Extract Class | Create a cohesive collaborator after a seam is visible. | A class has unrelated reasons to change or a stable sub-concept. | Excessive service objects, transaction leakage, autoload naming, test setup. |
| Inline Class | Fold a class/module with no distinct responsibility back into its owner. | Lazy Element or needless indirection. | External construction, serialization, subclassing, autoloaded constants. |
| Hide Delegate | Add intention-revealing delegation when callers know too much of an object graph. | Message chains expose navigation rather than domain language. | A blanket `delegate` can create a Middle Man or ambiguous `allow_nil` behavior. |
| Remove Middle Man | Let callers use the real collaborator when forwarding adds no stable abstraction. | A class mostly delegates. | Boundary ownership, authorization, instrumentation, future substitution. |
| Encapsulate Record | Wrap hashes/JSON payloads in a value object or gateway response type. | Repeated implicit key schemas or string/symbol key confusion. | Missing keys, defaults, serialization, mutable nested data. |
| Replace Primitive with Object | Introduce `Money`, `EmailAddress`, `DateRange`, `Percentage`, etc. | Validation/formatting/operations repeat around a primitive. | Equality, persistence casting, JSON shape, time zone/currency rules. |
| Replace Temp with Query | Move a derived value into a method when repeated or meaningful. | A temporary is reassigned or obscures intent. | Recalculation, database queries, time, randomness, side effects. |
| Substitute Algorithm | Replace an implementation with a clearer Ruby/Rails-native equivalent. | Behavior is well specified and the new algorithm is simpler. | Ordering, duplicates, `nil`/`false`, exceptions, numerical precision, SQL semantics. |
| Split Loop | Separate loops/pipelines that calculate unrelated results. | One pass does multiple jobs and obscures intention. | Performance; measure only if the loop is actually hot. |
| Replace Loop with Pipeline | Use `map`, `filter_map`, `select`, `reject`, `sum`, `tally`, `each_with_object`, or relation chaining. | A loop is a sequence of transformations with no complex control flow. | Side-effect order, `break`/`next`, false/nil handling, enumerator laziness, database loading. |
| Decompose Conditional | Extract predicates and branch actions with domain names. | A conditional encodes policy in low-level expressions. | Evaluation order and side effects in predicates. |
| Consolidate Conditional Expression | Combine branches that lead to the same result and name the combined predicate. | Repeated outcomes obscure one rule. | Short-circuit order and side effects. |
| Replace Nested Conditional with Guard Clauses | Use early returns for exceptional/precondition cases, leaving the main path linear. | Nesting hides the normal flow. | Rails controller render/redirect flow; ensure execution really stops. |
| Replace Conditional with Polymorphism | Introduce small objects or callables sharing a protocol. | Variation is stable, repeated, and likely to grow. | Overengineering one switch; constructor wiring; default/unknown cases. |
| Introduce Special Case | Use a null/special object for recurring absence behavior. | Repeated `nil` checks express one coherent absence policy. | Truthiness, serialization, Rails associations returning `nil`, identity checks. |
| Separate Query from Modifier | Split calculation/read from mutation or external effects. | A method both answers and changes state. | Callers relying on side effects; duplicate database queries. |
| Remove Flag Argument | Create named entry points or strategies rather than `perform(force: true)`. | A boolean selects substantially different behavior. | Public compatibility; shared setup; more than two modes may need a strategy. |
| Parameterize Function | Merge nearly identical methods by passing a meaningful value or strategy. | Differences are data, not separate concepts. | Replacing clear names with cryptic mode parameters. |
| Preserve Whole Object | Pass a cohesive object instead of extracting several of its values. | Caller decomposes data only to pass it onward. | Coupling to a large Active Record model; lazy-loaded associations. |
| Replace Function with Command | Use an object with `call` when a function needs staged state, undo, rich configuration, or several private steps. | A workflow is cohesive but too stateful for a simple function. | Generic “service object” proliferation; hidden transactions/side effects. |
| Replace Command with Function | Collapse a one-method object with no meaningful state into a function/method. | The command object adds ceremony only. | Existing dependency injection or protocol use. |
| Remove Dead Code | Delete unreachable/unused methods, branches, constants, and compatibility layers after proving no dynamic callers. | Code no longer serves behavior. | `send`, reflection, Rails callbacks, routes, serializers, jobs, external gem API. |

## Ruby-Specific Guidance

### Extract Function: Blocks and Non-Local Flow

Ruby blocks can contain `next`, `break`, `redo`, `throw`, and non-local `return`. Extracting such a block into a method can change control flow.

Before:

```ruby
def eligible_total(lines)
  lines.sum do |line|
    next 0 unless line.billable?
    line.quantity * line.unit_price
  end
end
```

Safe extraction:

```ruby
def eligible_total(lines)
  lines.sum { |line| billable_amount(line) }
end

private

def billable_amount(line)
  return 0 unless line.billable?

  line.quantity * line.unit_price
end
```

The extracted method replaces block-local `next` with method-local `return`, preserving the enclosing sum behavior.

### Parameter Objects: Keywords First, Concept Second

A long positional signature can often be made clearer with keywords before introducing a class.

```ruby
# Transitional API

def quote(customer, subtotal, currency, at)
  quote_for(customer:, subtotal:, currency:, at:)
end

def quote_for(customer:, subtotal:, currency:, at:)
  # existing behavior
end
```

Introduce a value object only when the values are one concept or carry invariants:

```ruby
QuoteRequest = Data.define(:customer, :subtotal, :currency, :at)
```

Use a plain class instead when construction must normalize, validate, hide representation, or support older Ruby versions. Do not use `Data` merely to reduce typing. `Data` is shallowly immutable: mutable members remain mutable unless copied/frozen deliberately.

### Replace Primitive with Object

Before:

```ruby
def discounted_total(amount_cents, discount_percent)
  amount_cents - (amount_cents * discount_percent / 100)
end
```

Potential destination:

```ruby
Percentage = Data.define(:value) do
  def initialize(value:)
    numeric = Integer(value)
    raise ArgumentError, "percentage out of range" unless (0..100).cover?(numeric)

    super(value: numeric)
  end

  def apply_to(amount)
    amount * value / 100
  end
end
```

This is useful only if percentage rules recur. Adding the invariant is a behavior change unless existing callers already satisfy it and tests establish that invalid values were not supported. A strictly behavior-preserving first step can wrap without validation, then introduce policy separately.

### Replace Loop with Pipeline

Before:

```ruby
active_emails = []
users.each do |user|
  next unless user.active?
  active_emails << user.email
end
```

After:

```ruby
active_emails = users.filter_map { |user| user.email if user.active? }
```

Verification points:

- target Ruby supports `filter_map`;
- `false` is not a meaningful mapped value, because `filter_map` drops both `nil` and `false`;
- `users` is an in-memory enumerable, or materialization is intended;
- the block has no order-sensitive side effects.

Do not mechanically replace `map { ... }.compact` with `filter_map`; `compact` retains `false`, while `filter_map` does not.

### Replace Conditional with Polymorphism

Prefer a small protocol over a class hierarchy tied to database inheritance.

```ruby
class PercentageDiscount
  def initialize(percent)
    @percent = percent
  end

  def apply(total)
    total - (total * @percent / 100)
  end
end

class NoDiscount
  def apply(total) = total
end
```

A hash of callables can be clearer for small, closed variation:

```ruby
CALCULATORS = {
  standard: ->(total) { total },
  vip: ->(total) { total * 0.9 }
}.freeze
```

Do not use polymorphism when one readable conditional is unlikely to grow.

### Encapsulate Dynamic Ruby Before Moving It

Search is incomplete around:

- `send`/`public_send` with computed names;
- `method_missing`/`respond_to_missing?`;
- callbacks registered by strings/symbols;
- `constantize` and inflection;
- monkey patches and refinements;
- DSL macros that define methods;
- serialization hooks and Rails attributes.

Before renaming or deleting, inspect runtime registration, tests, routes, schema, and external API usage. A compatibility forwarding method is often the safest intermediate step.

## Rails Context Mappings

### Controllers

Candidate signals:

- actions contain domain calculations, several persistence operations, or remote calls;
- the same parameter normalization or policy repeats across actions;
- branching mixes authentication/HTTP concerns with business decisions;
- actions are hard to test without broad setup.

Likely sequence:

1. Characterize request/response contract.
2. Extract parameter normalization or a predicate into private methods.
3. Separate query from mutation.
4. Move a cohesive domain operation to the model or a plain workflow object.
5. Keep rendering/redirecting in the controller unless a project convention deliberately centralizes it.

Avoid moving controller code into a `SomethingService.call(params)` object that simply mirrors the action and still knows about `params`, `render`, or `redirect_to`.

### Active Record Models

A large model is not automatically wrong; persistence and cohesive domain behavior belong together in Active Record. Extract when responsibilities are genuinely unrelated.

Good extraction candidates:

- value calculations independent of persistence;
- parsing/normalization of an external payload;
- policy variation repeated across methods;
- a complex query vocabulary;
- a workflow coordinating several aggregates/external systems;
- presentation formatting used by several renderers.

Potential destinations:

- namespaced plain Ruby object near the domain;
- `ActiveModel` object when forms/validation/naming integration is needed;
- query object returning a relation;
- gateway/adapter for external systems;
- policy/strategy object for stable variation.

Bad default: move every method from a “fat model” into unrelated `app/services/*` classes. That changes file size without improving ownership.

### Scopes and Query Objects

Use a scope for a small, reusable, composable relation fragment:

```ruby
scope :overdue, -> { where(due_at: ...Time.current) }
```

Use a class method when ordinary control flow or `nil` return semantics are intentional. Rails scopes always produce a relation-like result, which can differ from a conditional class method.

Use a query object when:

- many optional filters need names and tests;
- joins/CTEs/subqueries form a coherent query language;
- the query spans models but should still return a relation;
- controllers/jobs duplicate query assembly.

Preserve:

- relation laziness;
- caller chaining;
- result ordering;
- selected columns and model materialization;
- join cardinality and duplicate rows;
- database adapter behavior.

### N+1 and Eager Loading

A static message chain is not proof of N+1. Confirm with logs, notifications, query-count tests, Bullet if already configured, or `strict_loading`.

Choice matters:

- `preload` loads associations in separate queries;
- `eager_load` uses a left outer join;
- `includes` chooses behavior based on the relation and conditions;
- `strict_loading` can expose unexpected lazy loads.

Because these choices can alter SQL, row duplication, filtering, ordering, or memory, classify the primary objective as optimization when query count is the reason for change. Structural extraction around the query can still be refactoring.

### Callbacks

Callbacks are appropriate for lifecycle-local invariants and framework integration. They become a refactoring target when they hide an application workflow, depend on order across many callbacks, or perform external effects without an explicit boundary.

Safe sequence for a callback-heavy workflow:

1. Write tests for save/rollback/commit behavior and callback order that matters.
2. Extract the callback body to a named private method without changing registration.
3. Separate pure decision logic from mutation/external effects.
4. Move external access behind a gateway or job.
5. Introduce an explicit workflow entry point while the callback delegates to it.
6. Migrate intentional callers to the workflow.
7. Remove the callback only when all creation/update paths deliberately use the new entry point.

Do not casually replace `after_save` with `after_commit`; failure and transaction behavior differ. Do not move external work outside the transaction without verifying the commit point.

### Transactions and Locks

A transaction boundary is often part of behavior even when callers do not see it directly. During extraction:

- keep all protected writes inside the same transaction;
- keep pessimistic locks around the same reads/writes;
- do not introduce network calls into a database transaction;
- do not move job enqueue timing unless Rails/job adapter semantics are verified;
- retain exception propagation and rollback behavior.

A useful first refactoring is often Extract Function *inside* the existing transaction, not moving the transaction into a new class immediately.

### Bulk Persistence APIs

These APIs may bypass callbacks, validations, dirty tracking, or object instantiation:

- `update_all`, `delete_all`;
- `insert_all`, `upsert_all`;
- `update_columns`, `update_column`;
- `save(validate: false)`;
- callback skipping.

Treat their use as explicit behavior. The refactoring plan should document which invariants are intentionally bypassed. Replacing them with per-record operations can change correctness, performance, locking, and callback effects.

### Forms and Input Objects

When controllers repeatedly manipulate a parameter hash or one form updates several models, an input/form object may make the phases explicit.

Use `ActiveModel::API`, attributes, or validations only when integration with Rails forms/errors/naming is useful. Otherwise a plain object is simpler.

Sequence:

1. Preserve permitted parameter shape and error messages.
2. Encapsulate normalized input.
3. Move cross-field validation.
4. Separate validation from persistence.
5. Keep transaction and partial-failure behavior explicit.

### Concerns and Modules

Use a concern when it represents a coherent role shared by multiple hosts and its dependencies are explicit. A concern is not a generic escape hatch for making a model file shorter.

Smells in concerns:

- callbacks, validations, associations, scopes, and unrelated methods bundled together;
- implicit required host methods/columns;
- inclusion order affects behavior;
- a concern is used by only one class and has no independent concept;
- many concerns jointly define one workflow.

Likely Fowler moves: Extract Class, Move Function, or Inline Class. A Ruby-specific composition tactic is to replace a mixin with explicit delegation; treat that as an adaptation, not as a named catalog entry.

### Views, Helpers, Presenters, and Serializers

Extract when presentation decisions obscure the contract or repeat. Keep queries out of presentation objects.

Preserve:

- escaping and HTML safety;
- partial locals and collection rendering behavior;
- JSON key names, null handling, ordering where consumers rely on it;
- authorization scope;
- eager-loading expectations.

A presenter that simply delegates every model method is a Middle Man. A helper that loads records is hidden data access.

### External Services

Separate three concerns when entangled:

1. transport/authentication/retries;
2. mapping the remote representation;
3. domain decisions and persistence.

Do not change retry policy, timeout behavior, exception mapping, idempotency, or transaction placement under the refactoring label.

### Autoloading and Namespaces

Rails uses Zeitwerk conventions. For extracted constants:

- align file path and constant name;
- use existing namespaces;
- avoid manual `require` for application files under autoload paths;
- run the project's loader check when available, commonly `bin/rails zeitwerk:check`;
- consider reload safety for objects cached in initializers or class state.

## Modern Rails/Ruby Sources

Research checked against the current official Rails 8.1 guides and Ruby 4.0 documentation on 2026-08-06. The skill remains project-version adaptive and does not assume those versions are the target repository versions.

- Ruby 4.0 `Data` documentation: https://docs.ruby-lang.org/en/4.0/Data.html
- Ruby 4.0 `Enumerable` documentation: https://docs.ruby-lang.org/en/4.0/Enumerable.html
- Rails Guides index/current version: https://guides.rubyonrails.org/
- Active Model Basics: https://guides.rubyonrails.org/active_model_basics.html
- Active Record Query Interface: https://guides.rubyonrails.org/active_record_querying.html
- Active Record Callbacks: https://guides.rubyonrails.org/active_record_callbacks.html
- Active Record Basics: https://guides.rubyonrails.org/active_record_basics.html
- Testing Rails Applications: https://guides.rubyonrails.org/testing.html
- Autoloading and Reloading Constants: https://guides.rubyonrails.org/autoloading_and_reloading_constants.html
- Active Job Basics: https://guides.rubyonrails.org/active_job_basics.html
- RuboCop Rails cops: https://docs.rubocop.org/rubocop-rails/latest/cops.html
