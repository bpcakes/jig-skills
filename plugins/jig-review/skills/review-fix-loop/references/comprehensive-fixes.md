# Comprehensive Fixes

Read only for `fixMode: comprehensive`. Apply the shared research, scope, validation, and stopping rules from the entrypoint and runtime. This reference adds diagnosis and prevention requirements.

## Diagnose the Mechanism

For each group of verified findings, establish the failing scenario, the invariant that should hold, the immediate cause, and any contributing weakness in the contract, representation, ownership, or validation boundary. Identify where the invariant is enforced, bypassed, duplicated, or left to callers.

An omission can be the trigger while a design weakness makes it likely to recur. Check whether a sound boundary was misused or whether every caller must remember the same fragile rule. Do not presume a single root cause, infer bad architecture from severity, or attribute the failure merely to human error.

Inspect relevant callers, sibling paths, and tests for the same mechanism. Bound the search by the invariant and its users; similar-looking code alone is not a causal connection. One proven invariant escape can justify a structural correction without a second observed incident. If evidence is insufficient, retain that uncertainty rather than inventing a structural finding.

Optional, overlapping labels can summarize the evidence:

| Label | Diagnostic question |
|---|---|
| Local omission | Was a sound existing boundary misused in a specific path? |
| Shared implementation defect | Do callers inherit faulty behavior from an otherwise suitable abstraction? |
| Structural deficiency | Does the contract permit invalid states or require repeated caller workarounds? |
| Undetermined | What evidence would distinguish the plausible causes? |

These are prompts, not a complete taxonomy or a severity-to-repair matrix. Keep impact, diagnostic confidence, recurrence exposure, and repair risk separate.

## Select and Implement the Repair

When a structural weakness is plausible, compare a local correction with a change to the responsible abstraction or invariant. Briefly record why the chosen repair addresses the cause, the affected paths, compatibility implications, and how it will be validated. A local defect does not need an architecture proposal or scored alternatives.

Choose the smallest coherent repair that fully addresses the demonstrated cause. Consider correctness, prevention, fit with existing contracts, clarity, and regression or migration risk. Diff size is a cost, not the objective. Reuse a sound abstraction; redesign one only when evidence explains why its contract is insufficient. Prefer enforcing a shared rule at its owning boundary over adding another caller-specific guard.

Implement the supported durable repair and necessary callers now. A recommendation to refactor later is not completion, and a smaller symptom patch is not a reason to defer a demonstrated structural correction. Keep intermediate structural edits reviewable and validate preserved behavior where useful. Do not expand into unrelated cleanup or speculative future requirements.

Temporary mitigation is appropriate only when it has a concrete benefit. Record `verification: verified`, `repair: mitigated`, the benefit, residual cause, validation, and required remaining work. If a later repair weakens that benefit, follow the runtime's [recurrence rules](loop-runtime.md#repair-recurrence). Never silently downgrade the requested mode or treat a mitigation as a durable repair. Follow the runtime's input and stop rules if completing the repair requires a decision or action outside the authorized scope.

## Demonstrate Prevention

Validate the original failure and the repaired invariant across relevant entry points and affected callers. Useful evidence can include a regression test through the real caller, a contract test, a type restriction that prevents invalid states, or a database constraint exercised through application behavior. Preserve supported compatibility.

Choose prevention proportional to the demonstrated mechanism. Enforcing the rule in one implementation may itself provide prevention; additional lint rules, documentation, or test frameworks are not mandatory. Where useful, add a test that would catch another manifestation. State what is now prevented and what remains possible; one passing regression test does not prove an entire bug class impossible.

Classify later requests for additional evidence under the runtime's supporting-obligation rules. Keep an already validated substantive repair fixed unless new evidence contradicts it or invalidates its proof. A material remaining supporting obligation can use bounded closure; optional prevention suggestions do not create new completion requirements. Closure cannot finish an outstanding causal repair or turn a mitigation into a durable fix merely by documenting or testing it.
