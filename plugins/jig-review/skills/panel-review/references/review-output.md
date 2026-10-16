# Consolidated review output

Start with findings, ordered by severity. Do not bury issues under a summary.

For each finding, use:

```markdown
- [severity] [file:line] Short issue title
  Source: <comma-separated reviewer names>
  Root cause / violated requirement: ...
  Why it matters: ...
  Kind: substantive defect | supporting obligation
  Recommendation: ...
```

List only the applicable source names in canonical order: `Claude`, `Codex`, `Cursor`. Use severities: `critical`, `high`, `medium`, `low`.

## Resolve questions before reporting

Investigate material questions from the task brief and reviewer reports before presenting the consolidated result. Use relevant repository contracts, callers, tests, configuration, history, and dependency implementations; consult authoritative external documentation when needed and permitted. Use a focused read-only probe when it can settle behavior with the available tools. Respect review scope, exclusions, and access limits. If a reviewer lacked the tools or evidence to answer a question, the parent investigates within its own authority. Do not pass researchable questions back to the user as unfinished review work.

Apply each answer to the affected finding and its suggested fix: retain, revise, or reject the finding as warranted, update severity and requirement coverage, and ground the recommendation in the established contract. Cite the answer's evidence in the finding or coverage entry. Recommendations must reflect what the research established; do not leave an obsolete conditional fix beside a resolved question. Preserve the original brief and frozen reports, and distinguish parent verification from independent reviewer attribution.

When a previous fix failed, explain what the new evidence changes in the proposed mechanism. Incorporate prior rejections, adjudications and researched answers as constraints on the suggested correction. State whether the evidence calls for a local repair, a different design, a prerequisite task, independent adjudication, or a human decision. Recommend only the smallest coherent route supported by evidence. Do not prescribe the same failed strategy with a new label, classify a real defect as noise merely for being low severity, or weaken original acceptance to make the task finish. Preserve a judge's source/claim binding; changed code or material evidence requires reassessment.

Request user input only for a material decision, missing access, or unavailable evidence that investigation cannot settle. State what was checked, the specific input needed, the affected finding or requirement, and the recommended choice when supported. Keep dependent recommendations conditional and identify what the answer changes; continue independent review and any already-authorized repairs. An unanswered question is not evidence of a defect or permission to guess. Omit the input section when none is needed. A review-only request still ends with findings and suggested fixes; applying them requires repair authorization.

## Report sections

After findings, add:

```markdown
Requirement coverage:
- <requirement ID>: satisfied|unmet|uncertain — evidence or limitation

Input needed (omit when none):
- <specific decision or unavailable evidence> — checked: ...; affects: ...; recommended choice and reason, if supported: ...

Test gaps:
- ...

Review notes:
- Reviewers requested: <comma-separated reviewer names>
- Scope: working-tree|branch (committed only)|branch (including working tree)
- <selected reviewer> review: completed|failed|timed out|not started
- Claude file access: restricted|host
- Claude config: default|custom
- Scope fingerprint: verified|changed|not verified
- Tracked paths differing from index: <exact count>; none|<comma-separated returned paths>; complete|capped
- Untracked paths absent from index: <exact count>; none|<comma-separated returned paths>; complete|capped
- Dirty submodules: <exact count>; none|<comma-separated returned paths>; complete|capped
- Excluded paths: none|<comma-separated normalized paths>
- .reviewignore source: none|<commit-oid>:.reviewignore
```

Include all three index-state lines for branch scope with `--include-working-tree`, using `workingTreePathsDifferingFromIndex`, `workingTreePathsAbsentFromIndex`, and `dirtySubmodulePaths` from the final matching fingerprint capture. Show each exact `Count`; if a `Truncated` field is true, label the displayed paths as a capped subset. If `pathInventoryComplete` is false, label the staging guidance incomplete and state whether truncation, fingerprint issues, or both caused it. The lists include nested paths; perform each add or re-stage in the repository that owns the path, working from the innermost submodule outward. Ordinary UTF-8 paths appear literally. `raw-path:<hex>` identifies non-UTF-8 bytes, while `utf8-path:<hex>` disambiguates a valid UTF-8 path containing a segment beginning with either reserved tag; tagged values are display identifiers, not literal shell paths. For each nonzero inventory, tell the user the corresponding action: re-stage tracked paths, add intended untracked paths, or commit changes inside each dirty submodule before staging its parent gitlink. With complete zero-count inventories, omit staging advice and the committing warning. When any count is nonzero, state that committing the current index can record code different from the reviewed final working files, and that committed or staged defects superseded by later working changes may therefore remain. Always include the exclusion and policy-source lines, even when neither is active. Include the Claude file-access and config lines when Claude was selected; report whether a custom config was used without exposing its filesystem path. If `host` was selected, explicitly disclose that Claude's read-only file tools were not confined to the reviewed repository. Include one status line for each selected reviewer. For a failure, append one sanitized key message. If there are no actionable findings, say `No actionable findings from the completed reviewer pass(es).` and identify the completed reviewers in `Review notes`. Still mention residual test gaps and review limitations.

## Merging Rules

- Deduplicate by root cause. Preserve an actionable single-reviewer finding when its evidence remains plausible; when severities disagree, use the stronger evidence-supported severity.
- Retain the trigger, violated requirement, responsible boundary, and consequence. Recommendations address the responsible layer and required callers without turning a local defect into a redesign. Preserve counterevidence and uncertainty.
- Separate substantive defects, supporting obligations, and optional suggestions. An actionable test gap names the unproved behavior, a plausible surviving regression, and why equivalent coverage is absent; missing coverage alone does not establish broken behavior or justify a higher severity.
- Include a reviewer in `Source` only when that reviewer's frozen report independently identifies the same defect.
- Parent-side verification of a finding does not add another source.
- Do not add new findings during merging. The parent is an orchestrator and adjudicator, not another reviewer.
- Include a single-reviewer finding only when it remains plausible and actionable; state material uncertainty in `Why it matters`.
- Do not include style preferences, broad refactor suggestions, or speculative concerns unless they create a concrete defect or review risk.
- Do not paste raw reports in full. Summarize and normalize findings into the consolidated format.
