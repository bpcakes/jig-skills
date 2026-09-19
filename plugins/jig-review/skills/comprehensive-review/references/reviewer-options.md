# Reviewer controls

Accept these reviewer options:

- `--reviewers <claude,codex,cursor>` selects one or more reviewers. Default: `claude,codex`.
- `--all-reviewers` selects Claude, Codex, and Cursor. It cannot be combined with `--reviewers`.
- `--claude-model <model>` and `--claude-effort <low|medium|high|xhigh|max>` configure Claude. Default model: `opus`; effort is not forced by default.
- `--claude-file-access <restricted|host>` controls Claude's filesystem boundary. Default: `restricted`, limited to the reviewed repository and, for large reviews, the adapter's private evidence directory. `host` is an explicit trust-boundary opt-out that still exposes only read-only tools but does not confine them to those directories.
- `--claude-config-dir <absolute-path|~/path>` runs only the Claude reviewer with that `CLAUDE_CONFIG_DIR`. Use it to select a separate Claude Code profile without changing the Codex process environment.
- `--codex-model <model>` and `--codex-effort <low|medium|high|xhigh|max|ultra>` configure the native Codex child. Both inherit host defaults when omitted.
- `--cursor-effort <low|medium|high|xhigh>` selects the Grok 4.6 effort level. Default: `high` when Cursor is selected.
- `--cursor-speed <standard|fast>` selects the corresponding standard or `-fast` Cursor model. Default: `standard`.
- `--log-to-beads` stores final actionable findings in the existing Beads tracker at the end of the turn. Logging is off by default. Read [Beads logging](beads-logging.md) before scope capture when selected; retain this flag in the parent when routing repairs to review-fix-loop.
- `--exclude-path <repository-relative-path>` excludes one exact path and all its descendants. Repeat the flag to exclude multiple paths. This is additive with the repository's `.reviewignore` policy.

Selecting Cursor runs it with workspace trust for the reviewed repository (`--trust`), read-only ask mode, and sandboxing. Claude's non-interactive `-p` mode already skips its workspace trust dialog.

`--codex-effort` is passed to the host's native subagent reasoning-effort control, not to the Codex CLI `model_reasoning_effort` configuration key. `max` and `ultra` are available only when the selected host/model combination exposes them; if the host rejects the combination, mark Codex `not started` without substituting another effort.

Run `node scripts/review-options.mjs` from this skill directory with the reviewer options and every `--exclude-path` supplied by the user, then use its JSON exactly. It rejects unknown or duplicate reviewers, combining `--all-reviewers` with `--reviewers`, ambiguous legacy `--model` and `--effort` flags, settings for unselected reviewers, unsupported Cursor speed values, unsafe exclusion paths, and relative Claude config directories. Do not silently substitute a model, effort, speed, or Claude profile rejected by a provider or the host.

A value cannot begin with `--`. For a literal exclusion path beginning with `--`, use its repository-root form, such as `--exclude-path /--output`.
