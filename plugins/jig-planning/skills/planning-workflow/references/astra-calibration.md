# GPT-6 Astra Calibration

Verified against official OpenAI guidance on **2026-09-16**. Recheck model-specific parameters and product behavior before embedding them in a long-lived harness.

## Skill design

- Keep the skill description short and narrowly triggered. Skill names and descriptions share the initial context budget, and long or overlapping descriptions can be shortened or misrouted.
- Use progressive disclosure. Keep `SKILL.md` as the core workflow and load references only when their branch applies.
- Avoid elaborate itineraries written to compensate for weaker models. Astra can infer routine steps; excessive recipes consume context and can overconstrain good judgment.
- Do not require a full repository map or a stack of documents for every task. Point to each source at the decision where it matters.
- Make the user's explicit instructions higher priority than general skill guidance. If the skill blocks or diverts work, surface the exact conflicting instruction.

## Planning behavior

Astra is more likely to ask when missing information could materially change the result. Tell it to:

- infer routine intent and proceed with reasonable labeled assumptions;
- complete authorized read-only and reversible work before asking;
- reserve questions or approval for consequential decisions and external side effects;
- continue until the plan meets explicit completion gates rather than returning after a first draft.

Astra tends toward detailed Markdown. Specify the desired plan schema and ask for the minimum sufficient detail; do not use line counts as a quality target.

## Delegation

Astra can delegate parallel work but may do so less than a harness expects. State the policy:

- delegate independent evidence gathering or focused reviews when it saves time or increases coverage;
- do not delegate work that shares mutable state or an unstable interface;
- assign one integrator to reconcile outputs;
- use actual domain or tool differences, not fictional role specialization.

## Verification

Astra is thorough and may over-test small changes. Calibrate verification to blast radius:

- use focused checks for reversible, low-impact work;
- broaden tests when interfaces, data, security, deployment, or unresolved failures justify it;
- stop repeating checks once relevant gates pass and no new evidence creates concern.

Apply the same principle to plan review: targeted gates replace mandatory review counts.

## Reasoning effort

When the harness exposes `reasoning.effort`:

| Effort | Planning use |
|---|---|
| `low` | Light plans, routine decomposition, quick graph checks |
| `medium` | Default for Standard plans, repository-grounded planning, normal integrations |
| `high` | Critical architecture, migrations, deep adversarial review, high-value decisions |
| `xhigh` / `max` | Use only when evaluations show a material gain that justifies latency and cost |

Change effort during a conversation with `configuration_update` where supported rather than rewriting a cached prompt prefix. Use the Responses API for GPT-6 Astra tool calling. Remove unsupported sampling controls such as `temperature` and `top_p` when migrating an Astra request.

## Context economics

GPT-6 Astra supports a 1,050,000-token context window, but long context is not free. Requests above 272K input tokens carry higher token rates. More importantly, irrelevant instructions and duplicated plans still reduce signal quality. Retrieve the smallest evidence set that can settle the current decision.

Use a model snapshot when reproducible behavior matters, and evaluate changes on representative planning cases rather than assuming a newer or higher-effort model always improves the workflow.

## Official sources

- GPT-6 Astra model guide: https://developers.openai.com/api/docs/guides/latest-model
- GPT-6 Astra model reference: https://developers.openai.com/api/docs/models/gpt-6-astra
- Rethinking skills and prompts for GPT-6 Astra: https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra
- Reasoning models and effort guidance: https://developers.openai.com/api/docs/guides/reasoning
- Build skills: https://learn.chatgpt.com/docs/build-skills
- Evaluation best practices: https://developers.openai.com/api/docs/guides/evaluation-best-practices
- Evaluate agent workflows: https://developers.openai.com/api/docs/guides/agent-evals
