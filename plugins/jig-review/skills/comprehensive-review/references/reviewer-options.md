# Reviewer controls

Accept these reviewer options:

- `--reviewers <claude,codex,cursor>` selects one or more reviewers. Default: `claude,codex`.
- `--all-reviewers` selects Claude, Codex, and Cursor. It cannot be combined with `--reviewers`.
- `--claude-model <model>` and `--claude-effort <low|medium|high|xhigh|max>` configure Claude. Default model: `opus`; effort is not forced by default.
- `--claude-file-access <restricted|host>` controls Claude's filesystem boundary. Default: `restricted`, limited to the reviewed repository and, for large reviews, the adapter's private evidence directory. `host` is an explicit trust-boundary opt-out that still exposes only read-only tools but does not confine them to those directories.
- `--claude-config-dir <absolute-path|~/path>` runs only the Claude reviewer with that `CLAUDE_CONFIG_DIR`. Use it to select a separate Claude Code profile without changing the Codex process environment. It cannot be combined with `--claude-launcher`.
- `--claude-launcher <none|auto|home:NAME>` starts the Claude reviewer through [Jig](https://github.com/bpcakes/jig-sh): `auto` selects the Claude home with the most remaining subscription headroom at launch, `home:NAME` selects a named Jig home. Default: `none`, which runs the `claude` executable directly.
- `--codex-runtime <native|cli>` selects how Codex reviews. `native` (default) uses the host's context-free subagent. `cli` runs the `codex-review.mjs` adapter as an independent `codex exec` process; a host without a Codex subagent facility must select it.
- `--codex-model <model>` and `--codex-effort` configure Codex. Both inherit defaults when omitted. The native runtime accepts `low|medium|high|xhigh|max|ultra`; the CLI runtime accepts the Codex CLI's `minimal|low|medium|high|xhigh`.
- `--codex-launcher <none|auto|home:NAME>` starts the Codex CLI through Jig, with the same values as `--claude-launcher`. Any value other than `none` selects the `cli` runtime; combining it with an explicit `--codex-runtime native` is rejected.
- `--cursor-effort <low|medium|high|xhigh>` selects the Grok 4.6 effort level. Default: `high` when Cursor is selected.
- `--cursor-speed <standard|fast>` selects the corresponding standard or `-fast` Cursor model. Default: `standard`.
- `--log-to-beads` stores final actionable findings in the existing Beads tracker at the end of the turn. Logging is off by default. Read [Beads logging](beads-logging.md) before scope capture when selected; retain this flag in the parent when routing repairs to review-fix-loop.
- `--exclude-path <repository-relative-path>` excludes one exact path and all its descendants. Repeat the flag to exclude multiple paths. This is additive with the repository's `.reviewignore` policy.

Selecting Cursor runs it with workspace trust for the reviewed repository (`--trust`), read-only ask mode, and sandboxing. Claude's non-interactive `-p` mode already skips its workspace trust dialog.

With the native runtime, `--codex-effort` is passed to the host's native subagent reasoning-effort control, not to the Codex CLI `model_reasoning_effort` configuration key. `max` and `ultra` are available only when the selected host/model combination exposes them; if the host rejects the combination, mark Codex `not started` without substituting another effort. With the CLI runtime, the adapter passes the effort as `model_reasoning_effort`.

Launchers need the `jig` executable on `PATH`, or the path in `JIG_LAUNCHER_BIN`, from a Jig release that includes `launch --auto`. Jig selects the home per launch without caching or reservations, so reviewers started together may select the same home. If no home has headroom, Jig exits before the provider starts and that reviewer is `not started`. Disclose the launcher mode in the final review notes without printing home paths.

Run `node scripts/review-options.mjs` from this skill directory with the reviewer options and every `--exclude-path` supplied by the user, then use its JSON exactly. It rejects unknown or duplicate reviewers, combining `--all-reviewers` with `--reviewers`, ambiguous legacy `--model` and `--effort` flags, settings for unselected reviewers, unsupported Cursor speed values, unsupported launcher values, a Claude launcher combined with a config directory, a Codex launcher combined with the native runtime, unsafe exclusion paths, and relative Claude config directories. Do not silently substitute a model, effort, speed, or Claude profile rejected by a provider or the host.

A value cannot begin with `--`. For a literal exclusion path beginning with `--`, use its repository-root form, such as `--exclude-path /--output`.
