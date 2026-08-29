---
name: comprehensive-review
description: Run configurable, independent Claude Code, native Codex, and Cursor/Grok reviews in parallel over the same Git changes, then deduplicate and merge their findings. Use for comprehensive, combined, merged, multi-model, or Claude-plus-Codex code reviews. Defaults to Claude and Codex; Cursor is opt-in. Each selected external reviewer requires its authenticated CLI. This skill reviews working-tree or branch diffs, not unchanged artifacts from scratch.
---

# Comprehensive Review

Produce one consolidated code review from one or more isolated reviewers. Default to Claude Code and native Codex; include Cursor Agent with Grok 4.6 only when selected.

This skill is review-only. Do not fix issues, apply patches, or change files unless the user explicitly requests a separate follow-up fix after the review is complete.

## Reviewer Controls

Accept these reviewer options:

- `--reviewers <claude,codex,cursor>` selects one or more reviewers. Default: `claude,codex`.
- `--claude-model <model>` and `--claude-effort <low|medium|high|xhigh|max>` configure Claude. Default model: `opus`; effort is not forced by default.
- `--claude-file-access <restricted|host>` controls Claude's filesystem boundary. Default: `restricted`. `host` is an explicit trust-boundary opt-out that still exposes only read-only tools but does not confine them to the reviewed repository.
- `--codex-model <model>` and `--codex-effort <low|medium|high|xhigh|max|ultra>` configure the native Codex child. Both inherit host defaults when omitted.
- `--cursor-effort <low|medium|high|xhigh>` selects the corresponding fixed `cursor-grok-4.6-*` model. Default: `high` when Cursor is selected.

Run `node scripts/review-options.mjs` from this skill directory with only the reviewer options supplied by the user, then use its JSON exactly. It rejects unknown or duplicate reviewers, ambiguous legacy `--model` and `--effort` flags, and settings for unselected reviewers. Do not silently substitute a model or effort rejected by a provider or the host.

## Workflow

1. Resolve one concrete review scope.
   - Accept `--wait`, `--base <ref>`, and `--scope working-tree|branch|auto` in addition to the reviewer controls.
   - Treat `--wait` as a compatibility no-op.
   - `--base` implies branch scope. Reject `--base` combined with `--scope working-tree`; otherwise default to working-tree scope when neither is present.
   - Resolve `auto` or an implicit branch base before spawning reviewers. Resolve every branch base to a commit OID and fail on an invalid ref. Do not let reviewers resolve refs or implicit scopes independently.
   - Branch scope requires a clean checkout, including no untracked files or dirty initialized submodules. This keeps reviewer file inspection aligned with the pinned `HEAD`; ask the user to clean the checkout or choose working-tree scope if this check fails.
   - Treat staged, unstaged, and untracked files, including changes inside initialized tracked submodules, as reviewable working-tree changes.
   - Working-tree scope supports repositories with an unborn `HEAD`; branch scope still requires `HEAD` to resolve to a commit.
   - If the concrete scope has no reviewable diff, say so and stop.
2. Capture a read-only scope fingerprint.
   - Run `node scripts/scope-fingerprint.mjs --cwd <repository> --scope <working-tree|branch> [--base <ref>]` from this skill directory.
   - Use its resolved scope, pinned base OID, and fingerprint. Do not hand-roll a weaker fingerprint.
   - For branch scope, require `checkoutClean: true`. The fingerprint also includes checkout state so later mutations are detectable.
   - Preserve `complete` and `issues`. If `complete` is false, reviewers may proceed only as a limited-coverage review: pass the issues to the native Codex child, retain the adapters' own coverage warnings, disclose the limitations in the final report, and use `not verified` rather than `verified` for fingerprint status.
   - Pass the same concrete scope description to every selected reviewer. Never pass findings, hypotheses, or conclusions between reviewers.
   - Pass the initial fingerprint to every reviewer. External adapters must match it before context capture and again after the provider exits. The native Codex child must capture and compare the same fingerprint before inspection and after drafting its report. A mismatch is a failed same-scope review, not a completed report.
3. Read [references/parallel-review-runtime.md](references/parallel-review-runtime.md), then attempt to start every selected reviewer as a context-free subagent before waiting for any result.
   - Claude and Cursor children are pure forwarders for their bundled adapters.
   - The Codex child performs a native `/review`-style pass and must not invoke this or another reviewer.
   - Every child is read-only and returns one frozen report to the parent.
4. After all selected children finish or reach terminal failure, recompute the scope fingerprint.
   - If the scope changed, or any reviewer reports a fingerprint mismatch, do not present the reports as a same-scope review. Report the drift and stop.
   - Mark the fingerprint `verified` only when both captures report `complete: true`; matching partial fingerprints remain `not verified`.
5. Merge the completed frozen reports.
   - Deduplicate findings that identify the same root cause, even if wording or line numbers differ.
   - Preserve a finding if any completed reviewer found it actionable and the cited evidence remains plausible.
   - Keep the stronger evidence-supported severity when reviewers disagree.
   - Attribute each finding to the exact reviewers whose frozen reports independently identified it.
6. Print the consolidated review. With only one completed report, label it a single-reviewer result, not a merged review.

## Output Format

Start with findings, ordered by severity. Do not bury issues under a summary.

For each finding, use:

```markdown
- [severity] [file:line] Short issue title
  Source: <comma-separated reviewer names>
  Why it matters: ...
  Recommendation: ...
```

List only the applicable source names in canonical order: `Claude`, `Codex`, `Cursor`. Use severities: `critical`, `high`, `medium`, `low`.

After findings, add:

```markdown
Open questions:
- ...

Test gaps:
- ...

Review notes:
- Reviewers requested: <comma-separated reviewer names>
- <selected reviewer> review: completed|failed|timed out|not started
- Claude file access: restricted|host
- Scope fingerprint: verified|changed|not verified
```

Include the Claude file-access line when Claude was selected. If `host` was selected, explicitly disclose that Claude's read-only file tools were not confined to the reviewed repository. Include one status line for each selected reviewer. For a failure, append one sanitized key message. If there are no actionable findings, say `No actionable findings from the completed reviewer pass(es).` and identify the completed reviewers in `Review notes`. Still mention residual test gaps and review limitations.

## Merging Rules

- Include a reviewer in `Source` only when that reviewer's frozen report independently identifies the same defect.
- Parent-side verification of a finding does not add another source.
- Do not add new findings during merging. The parent is an orchestrator and adjudicator, not another reviewer.
- Include a single-reviewer finding only when it remains plausible and actionable; state material uncertainty in `Why it matters`.
- Do not include style preferences, broad refactor suggestions, or speculative concerns unless they create a concrete defect or review risk.
- Do not paste raw reports in full. Summarize and normalize findings into the consolidated format.

## Failure Handling

- Start and consume tokens only for selected reviewers. Do not require or probe an unselected external CLI.
- If some selected reviewers fail, continue with completed reports. Call the output merged only when at least two reports completed.
- If no selected reviewer completes, report each failure and do not claim that a review completed.
- If a child cannot be started, mark it `not started`; if it exceeds the runtime deadline, stop it when the host supports cancellation and mark it `timed out`.
- Treat an empty external-forwarder response as a transport failure, not a completed review. Do not retry until the original adapter invocation is known to have exited or has been cancelled and cleaned up; otherwise a retry can duplicate billable provider work.
- If supplied context, an untracked file, a submodule, or the fingerprint is incomplete, state exactly what was omitted and do not claim complete coverage.
- If line numbers are unavailable, use the narrowest stable file or symbol reference available.
