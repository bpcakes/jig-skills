# Refactoring assessment

> Fictional example showing the skill's expected output. Locations and commands are illustrative.

## Context and baseline

- Scope: `app/models/order.rb`, `app/controllers/orders_controller.rb`, and direct tests/callers.
- Ruby / Rails: Ruby 3.3.x; Rails 7.2.x; `config.load_defaults 7.2`.
- Tests run and result: focused model and request specs pass (42 examples, 0 failures).
- Existing analysis tools: RuboCop and RuboCop Rails are configured; no Reek/Flay/Flog configuration.
- Important behavioral boundaries: order creation is transactional; confirmation mail is currently enqueued from an `after_save`; API clients depend on error keys and HTTP status; `Order.visible` must remain chainable as an `ActiveRecord::Relation`.

## Ranked opportunities

| Priority | Location | Evidence | Smell / pressure | Fowler moves | Ruby/Rails destination | Confidence |
|---|---|---|---|---|---|---|
| P1 | `app/models/order.rb:41` (`Order#complete!`) | Method changes three records, calculates pricing, and invokes a gateway; tests cover only the happy path. | Long Function, Split Phase, Query/Modifier mixture | Extract Function, Separate Query from Modifier, Split Phase, Move Function | Keep transaction in `Order#complete!`; extract pure `Order::CompletionPrice`; isolate gateway call behind `FulfillmentGateway`. | high |
| P1 | `app/models/order.rb:12` (`after_save :enqueue_confirmation`) | External job enqueue is hidden in persistence; rollback/duplicate behavior is not tested. | Hidden side effect / callback workflow | Extract Function, Move Function, Separate Query from Modifier | First isolate enqueue method; characterize commit behavior; later expose explicit completion workflow while callback delegates. | high |
| P2 | `app/controllers/orders_controller.rb:28` (`#create`) | Parameter normalization and cross-field defaults repeat in API and admin controllers. | Data Clump, Duplicated Knowledge | Encapsulate Record, Introduce Parameter Object, Split Phase | `OrderInput` plain/Active Model object, preserving Strong Parameters and error shape. | medium |
| P3 | `app/models/order.rb:7` | `default_scope` hides archival filtering, but admin and reporting paths already use `unscoped`. | Hidden global query behavior | Extract Function, Change Function Declaration | Introduce explicit `active` scope and migrate callers; remove default last. | medium |

## Detailed approach

### P1 — Separate completion calculation, persistence, and fulfillment access

**Why this matters:** The current method makes a pricing-rule change touch transaction orchestration and remote fulfillment code. Failures are difficult to localize, and the pure pricing rule cannot be tested without database and gateway setup.

**Behavior to preserve:**

- the same records are locked and updated in one transaction;
- the same exceptions escape;
- no fulfillment call occurs when persistence rolls back;
- completion remains idempotent for an already-complete order;
- totals use the current integer rounding behavior.

**Sequence:**

1. Add characterization examples for rollback, already-complete orders, rounding, and gateway failure.
2. Extract `completion_total` as a private method inside `Order`; keep all calls and mutation in place.
3. Move only the pure calculation into `Order::CompletionPrice`, with the existing method delegating to it.
4. Extract the remote call into `FulfillmentGateway#complete(order:)`; keep invocation at the same point.
5. Extract a private `persist_completion!` method inside the existing transaction.
6. Re-read the resulting method. Introduce a command object only if stateful orchestration is still clearer as a named concept; do not create it merely to shorten `order.rb`.

**Verification after each step:** Run focused model specs. After the gateway extraction, run contract tests against the fake adapter. At the end, run request specs and compare SQL transaction/lock behavior in logs.

**Risks / stop conditions:** If the remote call currently occurs inside the database transaction, moving it is a behavior and reliability redesign, not a refactoring. Keep it in place and list relocation as adjacent work.

### P1 — Make confirmation enqueue timing explicit

**Why this matters:** A callback hides when and how often mail is enqueued. The code appears to intend “after successful completion,” but the current hook is `after_save`, not commit-aware.

**Behavior to preserve:** Current enqueue count, callback conditions, transaction timing, and exception behavior until a product/reliability decision explicitly changes them.

**Sequence:**

1. Add tests for save inside a rolled-back transaction and repeated saves.
2. Extract the callback block/body to `enqueue_confirmation` without changing the hook.
3. Move mailer construction behind `OrderConfirmation.enqueue(order)` while retaining the callback.
4. Add an explicit completion entry point that invokes the same collaborator, and let the callback delegate during migration.
5. Decide separately whether commit-aware timing is desired. Changing `after_save` to `after_commit` is adjacent behavior work.

**Verification after each step:** Assert job count, job arguments, rollback behavior, and duplicate behavior.

## Adjacent work that is not refactoring

- Changing confirmation enqueue from `after_save` to `after_commit` changes timing and failure semantics.
- Replacing the fulfillment call with an outbox changes architecture and delivery guarantees.
- Rewriting the pricing query to use `pluck` is an optimization and may change type casting/materialization.
- Removing archival records or changing schema is a migration.

## Verification plan

- Focused tests: `bundle exec rspec spec/models/order_spec.rb spec/requests/orders_spec.rb`.
- Wider suite: order, billing, fulfillment, job, and admin/reporting specs; full suite before merge.
- Runtime/query/contract checks: transaction and lock SQL; job enqueue count/timing; API snapshot/contract; loader check for new constants; configured RuboCop targets.
