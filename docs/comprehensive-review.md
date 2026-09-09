# Comprehensive Review

[Back to the skill catalog](../README.md#jig-review)

`jig-review:comprehensive-review` runs independent reviews of the same Git changes and merges their findings. It runs inside Codex, using Codex subagents to perform the native review and forward assignments to selected external CLIs.

The default reviewers are Claude Code and Codex. Cursor is optional. The skill produces a review report; fixes require a separate follow-up request.

## Setup and Invocation

Install `jig-review` using the [marketplace instructions](../README.md#install-with-codex). You need Node.js 22 or newer and a Codex host with subagents. External adapters support Linux, macOS, and Windows through WSL.

Each selected external reviewer needs its installed, authenticated CLI: `claude` for Claude Code, `cursor-agent` for Cursor. These passes consume provider usage. A Codex-only review does not need either external CLI.

Enter these prompts in Codex from the repository being reviewed:

| Task | Prompt |
|---|---|
| Review working changes with the defaults | `$jig-review:comprehensive-review` |
| Use only native Codex | `$jig-review:comprehensive-review --reviewers codex` |
| Add Cursor | `$jig-review:comprehensive-review --reviewers claude,codex,cursor` |
| Use Codex and Cursor | `$jig-review:comprehensive-review --reviewers codex,cursor` |
| Review a branch against a named base | `$jig-review:comprehensive-review --base main` |
| Choose Cursor effort | `$jig-review:comprehensive-review --reviewers codex,cursor --cursor-effort xhigh` |
| Enable Cursor fast mode | `$jig-review:comprehensive-review --reviewers codex,cursor --cursor-effort xhigh --cursor-speed fast` |
| Set native Codex effort | `$jig-review:comprehensive-review --reviewers codex --codex-effort high` |
| Use a separate Claude profile | `$jig-review:comprehensive-review --claude-config-dir ~/.claude-appleid` |
| Exclude one path for this run | `$jig-review:comprehensive-review --scope branch --exclude-path .agent/` |
| Exclude several paths | `$jig-review:comprehensive-review --exclude-path .agent/ --exclude-path generated/reports/` |

For a direct-copy install, replace `$jig-review:comprehensive-review` with `$comprehensive-review`. Direct installation into Claude Code is unsupported because orchestration depends on Codex subagents.

## Scope

The default is working-tree scope: staged, unstaged, and untracked changes, including changes in initialized tracked submodules. An empty diff ends the review without starting reviewers.

`--base <ref>` selects branch scope. It requires a clean checkout, including untracked files and initialized submodules, so reviewers inspect files corresponding to the pinned commit. Do not combine `--base` with `--scope working-tree`.

`--scope branch` detects the default branch when no base is supplied. `--scope auto` chooses working-tree scope when changes exist and branch scope otherwise. Use explicit scope when the distinction matters.

Use repeatable `--exclude-path <path>` arguments for one review. Each value is a literal repository-relative path and excludes that path plus everything below it, whether tracked or untracked. Globs and negation are intentionally unsupported.

For permanent repository policy, commit a root `.reviewignore` file:

```text
# Large agent transcripts are not product code.
.agent/
generated/reports/
```

Blank lines and `#` comments are ignored; entries use the same literal path semantics as `--exclude-path`. Working-tree reviews read `.reviewignore` from `HEAD`. Branch reviews read it from the selected base commit, so a branch cannot hide its own files by adding an ignore entry. A new or edited policy therefore takes effect once it is in the trusted revision; use `--exclude-path` for the current run. `.reviewignore` cannot exclude itself, and exclusions never waive branch scope's clean-check.

This skill reviews diffs. For unchanged code, select a focused skill that supports repository or path assessment.

## Reading the Result

The report leads with findings and identifies which reviewers independently reported each issue. Review notes disclose reviewer failures, intentional path exclusions and their policy source, coverage limitations, Claude file access, and whether the scope fingerprint was verified unchanged. With only one completed review, the result is labeled as a single-reviewer report.

For large external reviews, the adapters supply numbered pages of patch evidence. The `Evidence coverage` summary distinguishes:

- `reviewer-attested`: the reviewer returned valid receipts for every captured page and claimed to review them. This demonstrates page access and a claim of review, not review quality.
- `limited`: pages were missing or had invalid receipts, or capture omitted evidence. A limited review must retain those qualifications even if no findings were reported.

Fingerprint verification establishes scope stability. It does not prove complete coverage or a bug-free change. If the scope changes during the review, the results cannot be presented as reviews of the same changes.

The runtime switches to pages when a diff exceeds 384 KiB or combined inline context exceeds 768 KiB. Capture is bounded to 16 MiB of source text and 2,048 pages. Each included file patch is limited to 2 MiB. A patch that exceeds that limit or the remaining total budget is omitted in full, with its header and reason recorded; capture continues to later files. No path category is excluded automatically. Untracked files have separate limits of 64 KiB per file and 128 KiB in aggregate; omissions are disclosed. See the [runtime reference](../plugins/jig-review/skills/comprehensive-review/references/parallel-review-runtime.md) for capture details, deadlines, and cleanup.

## File Access and Project Hooks

Claude defaults to `--claude-file-access restricted`: its read-only file tools are confined to the reviewed working directory and, for paged evidence, the adapter's private temporary evidence directory. The adapter enables Claude safe mode and exposes only `Read`, `Glob`, and `Grep`.

Use `--claude-config-dir <absolute-path|~/path>` to select a Claude Code profile for one review:

```text
$jig-review:comprehensive-review --reviewers claude,codex --claude-config-dir ~/.claude-appleid
```

The adapter expands `~/`, then sets `CLAUDE_CONFIG_DIR` only for the spawned Claude process. Relative paths and `~other-user` forms are rejected. This option requires Claude in `--reviewers`; it does not affect Codex or Cursor. Claude Code uses that directory for its settings, session history, and plugins, as documented in the [Claude Code settings guide](https://code.claude.com/docs/en/settings).

When the review intentionally requires access elsewhere on the machine, request:

```text
$jig-review:comprehensive-review --claude-file-access host
```

`host` removes the directory restriction while retaining read-only tools. The review notes disclose this expanded boundary. Large diffs do not require host access.

Cursor runs with `--mode ask --sandbox enabled --trust --workspace <repository>`. Workspace trust allows non-interactive startup, but ask mode and sandboxing do not establish isolation for project hooks. This is an accepted limitation; future hook isolation is tracked as `jig-skills-h18` in [Beads](../.beads/issues.jsonl). The current adapter does not disable project hooks.

Cursor uses standard Grok 4.6 models by default. Pass `--cursor-speed fast` to select the `-fast` variant for the chosen `--cursor-effort`:

```text
$jig-review:comprehensive-review --reviewers codex,cursor --cursor-effort xhigh --cursor-speed fast
```

## Troubleshooting

| Symptom | What to do |
|---|---|
| A selected CLI is missing or unauthenticated | Install and authenticate that CLI through its normal setup, or explicitly select available reviewers with `--reviewers`. |
| Claude uses the wrong account or profile | Pass `--claude-config-dir ~/.claude-profile-name`; verify that directory already contains the intended Claude Code configuration. |
| Branch review refuses a dirty checkout | Commit or otherwise resolve the changes yourself, use a clean checkout, or choose `--scope working-tree` to review the pending changes. |
| A large tracked directory overwhelms review evidence | Add a literal `--exclude-path <directory>` for one run, or commit it to the root `.reviewignore` for permanent policy. |
| Review stops because there is no diff | Select the intended branch/base, or use a repository-capable focused skill for unchanged code. |
| Evidence coverage is limited | Read the reported omissions or missing pages. Narrow the change set and rerun if fuller coverage is needed. |
| Scope fingerprint changes | Finish other edits or background writers, then rerun the review over a stable scope. |
| A model, effort, or speed is rejected | Choose a supported value explicitly. The skill does not silently substitute models, effort levels, or Cursor speed. |
| Cursor still requests interactive workspace trust | Check that the installed `jig-review` includes the `--trust` adapter change; follow the [plugin update steps](../README.md#update-marketplace-plugins). |

The [skill entrypoint](../plugins/jig-review/skills/comprehensive-review/SKILL.md) defines all reviewer controls and the report contract. The [runtime reference](../plugins/jig-review/skills/comprehensive-review/references/parallel-review-runtime.md) documents orchestration and evidence handling for maintainers.
