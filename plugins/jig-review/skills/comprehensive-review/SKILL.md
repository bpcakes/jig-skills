---
name: comprehensive-review
description: Run a comprehensive code review by combining the Claude Code cc:review skill with an independent native Codex review pass, then deduplicate and print merged findings. Use when the user asks for a comprehensive review, combined review, merged review, Claude plus Codex review, or wants both cc:review and Codex /review-style findings in one result.
---

# Comprehensive Review

Use this skill when the user wants one consolidated code review from both Claude Code and Codex.

This skill is review-only. Do not fix issues, apply patches, or change files unless the user explicitly asks for a separate follow-up fix after the review is complete.

## Core Workflow

1. Determine the review scope from the user's request.
   - Preserve explicit flags such as `--base <ref>`, `--scope working-tree`, `--scope branch`, or `--model <model>`.
   - If the user does not specify a scope, review the current working tree.
   - If there is no reviewable diff, say that clearly and stop.
2. Run the Claude Code review using `$cc:review`.
   - Prefer foreground execution with `--wait`, because this skill must merge Claude findings with Codex findings in the same response.
   - Pass through the user's supported `$cc:review` arguments.
   - If the user explicitly asks to run Claude in the background, start `$cc:review --background`, explain that merged findings require the Claude result, and stop without inventing merged output.
3. Independently perform a native Codex review of the exact same scope.
   - Treat this as Codex's built-in `/review` style behavior, not as a slash command invocation.
   - Prioritize bugs, behavioral regressions, security risks, data loss risks, concurrency hazards, performance cliffs, and missing tests.
   - Ground each finding in file and line references when possible.
4. Merge the Claude and Codex findings.
   - Deduplicate findings that point to the same root cause, even if wording or line numbers differ.
   - Preserve a finding if either reviewer found it actionable.
   - Keep the stronger severity when reviewers disagree.
   - Attribute each merged finding as `Source: Claude`, `Source: Codex`, or `Source: Both`.
5. Print the consolidated review.

## Output Format

Start with findings, ordered by severity. Do not bury issues under a summary.

For each finding, use this shape:

```markdown
- [severity] [file:line] Short issue title
  Source: Claude|Codex|Both
  Why it matters: ...
  Recommendation: ...
```

Use severities: `critical`, `high`, `medium`, `low`.

After findings, add:

```markdown
Open questions:
- ...

Test gaps:
- ...

Review notes:
- Claude Code review: completed|not completed|failed
- Codex review: completed
```

If there are no actionable findings, say:

```markdown
No actionable findings from the merged Claude Code and Codex review.
```

Then still mention any residual test gaps or review limitations.

## Merging Rules

- If both reviewers report the same defect, emit one finding with `Source: Both`.
- If Claude reports a finding and Codex confirms it during independent review, use `Source: Both`.
- If Codex reports a finding that Claude missed, use `Source: Codex`.
- If Claude reports a finding that Codex cannot verify from the diff, include it only when it is still plausible and actionable; note the uncertainty in `Why it matters`.
- Do not include style preferences, broad refactor suggestions, or speculative concerns unless they create a concrete defect or review risk.
- Do not paste raw Claude output in full. Summarize and normalize it into the merged format.

## Failure Handling

- If `$cc:review` fails, continue with the native Codex review and include `Claude Code review: failed` in `Review notes` with the key failure message.
- If the diff is too large to review thoroughly, review the highest-risk files first and state the limitation.
- If line numbers are unavailable, use the narrowest stable file or symbol reference available.
