# Prevent scope creep in planning-workflow

Historical integration guide for an older, user-supplied `planning-workflow`
skill, not an auto-installer or permission to modify another skill. The sibling
`planning-workflow` in Jig Planning already includes scope controls. The section
names and uppercase reference filenames below belong to the older workflow;
inspect the installed version and use only guidance that remains relevant.

Use planning to establish and preserve authorized scope. Use scope-drill to
challenge an existing epic when there is a reason to suspect excess work. Do not
make the standalone drill a mandatory stage of every small change.

## 1. Replace the planning objective

Replace volume- and iteration-based success criteria with:

```text
Produce a sufficiently detailed, dependency-aware plan for the smallest coherent
release that satisfies the user's approved outcomes and evidenced constraints.

Success means the required behavior is covered, major implementation choices are
justified, tasks are executable with the relevant context, and dependencies model
real prerequisites. No minimum line count, bead count, or review count applies.

Do not include optional features or major infrastructure commitments merely
because they would be useful. Present them separately for a user decision.
Necessary implementation details inside the agreed boundary do not each require
user approval. Material changes to breadth, commitments, or risk do.
```

Retain grounding in the actual codebase, concrete acceptance criteria, real
prerequisites, and risk-appropriate validation. Verify technical claims against
the installed/pinned version or actual project constraints. Do not turn grounding
into an unrequested dependency upgrade or a broad research project.

## 2. Insert a scope checkpoint before decomposition

Place this after focused discovery and before the detailed implementation plan:

```text
SCOPE CHECKPOINT

Recover the original request, existing approved decisions, and relevant project
constraints. Propose a compact release boundary:

- Outcome and concrete acceptance conditions.
- Required constraints, with evidence.
- Explicit exclusions.
- Major implementation boundaries: what to reuse, and whether new infrastructure,
  generic frameworks, broad refactors, or extra compatibility are authorized.
- Unconfirmed assumptions that materially affect scope, complexity, or risk.

Ask only unresolved material decisions. Use the host's available structured
user-input tool; otherwise ask in chat and wait. Do not ask the user to restate
an already explicit approved specification. Missing answers are not approval.

Separate what the user requested from what the agent proposes adding. Recommend
the smallest sufficient option and explain the tradeoff. Do not ask for a blanket
"looks good?" approval of a long expanded plan.

Record approved scope in the plan and keep rejected/provisional ideas outside
its implementation obligations. If questions are prohibited or the user is
unavailable, label the boundary provisional and keep the plan draft; do not
convert unresolved additions into executable beads.
```

This is a scope agreement, not a second product-discovery workshop. Omit questions
when the scope is already explicit and the plan stays within it.

## 3. Replace the main and reference review prompts

Replace `SKILL.md`'s plan-review prompt and the corresponding section in
`references/PROMPTS.md` with the same text:

```text
Review this plan against its Approved Scope.

The objective is the simplest coherent implementation that satisfies the
approved outcomes and evidenced constraints, not the most comprehensive project.

Identify:
1. Missing work necessary for an approved acceptance condition or constraint.
2. Work that can be removed, deferred, or implemented more simply.
3. Material scope or complexity changes that require a user decision.

For each proposed addition, identify its requirement or evidence and explain why
a smaller alternative is insufficient. Flag unsupported assumptions as uncertain.

Do not add features, extensibility, infrastructure, speculative scaling,
compatibility promises, or broad refactoring just because they might help later.
Keep optional proposals outside the implementation plan.

Preserve the required correctness, security, data integrity, compatibility,
accessibility, and validation for retained behavior. Match the amount of process
to the actual risk; do not inflate the plan in the name of completeness.

Show focused changes with rationale. Do not optimize for document length, ticket
count, or the number of review rounds. Finding no necessary changes is success.
```

## 4. Constrain integration and multi-model blending

Replace both copies of the integration prompt:

```text
Integrate only in-scope corrections and changes explicitly approved by the user.

For every suggested revision, check the Approved Scope. Keep unapproved scope
or major complexity changes as separate proposals with rationale and tradeoffs;
do not silently merge them into the plan or its acceptance criteria.

Preserve established exclusions. If a new fact makes the agreed approach
infeasible, explain the conflict and alternatives for a user decision.

Return a brief scope-impact summary: necessary refinements made, material changes
still awaiting approval, and work removed or simplified. Do not invent changes
when the review found none.
```

Replace the multi-model blending prompt with:

```text
Compare the candidate plans against the same Approved Scope. Select the simplest
well-supported approach for each requirement. Do not take the union of features,
architecture, or implementation tasks across the candidates.

Retain in-scope improvements only. Identify rejected additions and meaningful
tradeoffs. Keep unapproved scope or complexity changes separate. A shorter or
unchanged plan is acceptable when it better serves the approved outcome.
```

Other-model review is optional. No particular model, provider, or fixed number of
rounds is required by this integration. Do not outsource user scope authority to
a model vote or final model arbiter.

## 5. Replace validation and bead-polishing rules

Use the following validation loop in place of expansion-oriented checks:

```text
A. Scope coverage: each required outcome/constraint has implementation and
   appropriate validation. Each planned obligation serves one of those outcomes
   or is a justified prerequisite of the chosen sufficient implementation.
B. Simplicity: challenge speculative features, generalization, and infrastructure.
   Explain why the chosen approach is sufficient and a smaller one is not.
C. Execution clarity: resolve missing context by clarifying, linking stable local
   context, splitting, or merging as appropriate. Do not reflexively expand scope.
D. Graph accuracy: distinguish hierarchy from blocking relationships. Check real
   prerequisites and cycles. Independent tasks and terminal deliverables are valid.
E. Scope delta: compare the current plan to the approved boundary. Ask only about
   material new obligations, architecture commitments, or risk changes.

Stop when there are no unresolved material correctness, scope, or execution gaps
that prevent the next authorized step. No minimum review-round count applies.
A necessary unresolved user decision pauses that affected branch; it is not an
excuse to keep expanding the rest of the plan.
```

Immediately before creating beads, add:

```text
Compare the final plan with Approved Scope. Surface and resolve material changes;
do not re-approve an unchanged plan. Convert only approved implementation work.

Ensure each bead or coherent task group traces to an approved requirement or a
necessary enabling step. Preserve concrete acceptance criteria and useful local
context. Include dependency edges only where the relationship is real.

Do not turn optional suggestions into executable "future" beads by default.
Use a short Not Now note unless the user explicitly wants backlog creation.
```

Use the constrained plan-review objective for any bead-polishing pass too. Do not
retain the old instruction to keep polishing or never simplify after conversion.

## 6. Resolve the remaining contradictions in the supplied files

| Location | Replacement |
| --- | --- |
| `SKILL.md`: opening planning-time claim | Scale discovery and planning to ambiguity and risk; no fixed planning-time percentage. |
| `SKILL.md`: Outcome and delivery failures | Use approved coverage and executable clarity, not line counts or four mandatory reviews. |
| `SKILL.md`: Process Overview | Focused discovery -> scope checkpoint -> bounded plan -> necessary review -> scope-delta check -> approved beads. |
| `SKILL.md`: plan-quality comparison | Judge outcome coverage, justified choices, and clarity; remove volume as a quality measure. |
| `SKILL.md`: Essential Elements | Sufficient context and justified task granularity, not forced duplication of every source document. |
| `SKILL.md`: Common Mistakes | Warn against unapproved expansion, premature implementation under material uncertainty, and unnecessary planning ceremony. |
| `references/PROMPTS.md`: Repeat Until Steady-State | Stop on resolved material gaps; no mandatory number of rounds or claimed duration. |
| `references/PROMPTS.md`: Initial Plan Creation | Recover approved outcomes, boundaries, and constraints before architecture and detailed decomposition. |
| `references/FAQ.md`: skeleton-first answer | A bounded, shippable slice may be appropriate; comprehensiveness does not require planning the entire future system. |
| `references/FAQ.md`: unanticipated problems | Planning reduces uncertainty but does not guarantee implementation; material discoveries reopen affected decisions. |

Do not leave the old prompts elsewhere as recommended alternatives: that would
make the skill's objective contradictory. Keep unrelated references intact unless
the user has also asked to change them.

## 7. Optional invocation rule

A planner may suggest running `scope-drill-workflow` when it discovers substantial
unsupported branches, speculative infrastructure, repeated scope expansion, or an
existing epic whose intent is unclear. Do not auto-run an interview after every
planning task, and do not chain the drill back into an expanding planning loop.

## Integration smoke checks

A request for one export format must not acquire multi-format support or a plugin
framework without approval. A required security safeguard must survive a push for
simplicity. A small, clear plan may finish without multiple review rounds. A final
plan matching already approved scope must not trigger a redundant interview.
An unresolved optional feature must not become an executable bead during conversion.
