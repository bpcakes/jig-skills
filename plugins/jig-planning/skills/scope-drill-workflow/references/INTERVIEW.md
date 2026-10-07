# Focused scope interview

Use after gathering enough evidence to ask a real decision. Do not run every
question below as a checklist. A single well-framed question may settle a branch.

## Interaction protocol

1. Use an available, permitted structured user-input tool; inspect its schema.
   Examples of host tool names include `AskUserQuestion` and `request_user_input`.
   They are alternatives, not dependencies or guaranteed capabilities.
2. Ask one decision at a time unless the user requests a small batch. Keep
   dependent questions for later. Include a custom-answer or unresolved route.
3. Put the recommendation and its tradeoff in the question, not in a hidden
   default. Label whether it concerns a user-visible feature or implementation.
4. Wait for the answer. Record it with affected requirements/branches. Do not
   infer agreement from silence, "skip," or a failed/unavailable tool.
5. Prune excluded branches. Follow only decisions that still affect this release.

Without a structured tool, use the same question in chat and end the turn.
In audit-only/no-questions mode, show the unresolved decision as a conditional
finding instead; do not present an unanswered question as an approved default.

## Question shape

```text
Decision: <one release boundary or major implementation choice>
Evidence: <approved requirement, code path, or missing support>
Affected work: <IDs or capability branch>
Recommendation: <smaller option and why it can meet the outcome>
Tradeoff: <what is lost, delayed, or riskier>
Choices: <smaller option>; <keep current scope>; <custom / unresolved>.
```

Do not overwhelm the user with the entire graph. Summarize the consequence of a
branch decision and retain the full ID mapping in the proposed change set.
Use ordinary product language unless the user has shown technical expertise.

## Recovering intent

When no approved boundary is available:

> The epic currently combines manual export, scheduled delivery, and reporting
> history. Which must work for this release to count as successful? My proposed
> minimum is manual export. Scheduling and history would remain out of scope.

When an approved boundary already exists:

> The approved outcome is a manual CSV export. I found extra scheduled-delivery
> work in the epic. Is that a newly required release outcome, or should we remove
> it from this release?

Do not ask "What are we building?" when the answer is in the user's specification.
Do not re-litigate an explicit decision merely because a different choice is
smaller. Challenge it only when there is a material inconsistency or new evidence.

## Breadth questions

**Optional actor or workflow:** "Are administrators the only users for this
release? Adding member self-service introduces a second workflow and permission
surface. I recommend excluding it unless it is required for acceptance."

**Extra compatibility:** "The deployment target is one database. Is supporting a
second engine required now? Deferring it removes its adapter and compatibility
matrix; adding that engine later would require additional work."

**Adjacent polish:** "Is dashboard customization a release requirement, or is the
existing fixed view sufficient? Keeping the fixed view excludes saved layouts."

## Implementation-depth questions

Investigate technical facts first. Ask the user about the underlying requirement,
not which unfamiliar library sounds best.

**Generic framework:** "Only one provider is required. A direct integration avoids
building a plugin framework. Supporting more providers later would need a new
change. Is that tradeoff acceptable?"

**New infrastructure:** "These tasks add workers, a queue, and persistent job
state. I have not found a workload or latency requirement that needs them. Should
we bound this release to the verified direct path, or is large-job support required?"

**Refactor coupling:** "The feature can use the current module with a local change.
The proposed package-wide rewrite is separable. I recommend excluding the rewrite
unless changing that architecture is itself an approved objective."

Do not recommend a direct path as sufficient when it has not been checked. State
what remains uncertain, or propose a narrowly bounded evidence check. Do not
invent request timeouts, throughput limits, or benchmark results.

## Safeguards and disputed requirements

Never present necessary protections as a menu of easy cuts. Explain their
connection to the retained behavior. For example:

> Export still crosses tenant boundaries, so tenant isolation and its tests remain
> required. We can remove tests for scheduling only if scheduling is excluded.

If the user explicitly wants to relax a requirement, surface the actual risk and
any governing constraint. Record the decision only within applicable policy;
never silently weaken a safety or compatibility obligation to meet a scope target.

When the user keeps an apparently optional branch, accept that authorized scope.
Record why it is in this release and stop asking to remove it. A recommendation
is not a veto over the user's priorities.

## Decision records

One compact record is enough:

```text
D1 — Scheduling is not part of this release.
Source: user's answer in this session, <date or message reference>.
Affected branch: <actual issue IDs>.
Tradeoff accepted: no automatic delivery.
Revisit when: a release explicitly requires scheduled delivery.
Write authority: not yet granted / approved changes C1-C2.
```

Do not create a tracker issue per question. Do not collect personal information
that is irrelevant to the scope decision.

## Approval without repetition

"Exclude scheduling" settles product scope. It does not, by itself, specify how
the tracker should represent every affected task.

A question can settle scope and authorize the exact edits together:

> Approve C1-C2: remove scheduling from the epic's acceptance criteria, defer the
> three named scheduling-only tasks without an automatic wake date, and remove
> the two identified obsolete blocking edges? The manual-export safeguards remain
> unchanged. Apply these edits now, revise them, or keep this as an audit?

If the user approves this exact set, apply it without asking again. A later "apply
C1-C2" likewise needs no repeated confirmation, provided the state still matches.

## Stop and handoff

Stop when the release boundary and material choices are settled, no supported
cuts remain, the user ends the interview, or the available evidence is exhausted.
Summarize what is settled and what is not. "No justified reduction found" is valid.

On resumption, read the existing decisions and current state first. Do not restart
the interview or duplicate comments and proposals already recorded. New evidence
can reopen a decision; merely changing the reviewing model cannot.
