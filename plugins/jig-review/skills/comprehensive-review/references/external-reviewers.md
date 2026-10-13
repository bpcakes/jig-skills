# External reviewers

Read only the selected provider setup and the common evidence/forwarder rules. Do not probe an unselected CLI. Append `--task-brief <absolute-brief.json> --task-brief-hash <hash>` to each resolved adapter command.

The selected external adapters require `node`, `git`, network access, and their authenticated CLI, plus the `jig` executable when a Jig launcher is selected. A missing prerequisite marks only that reviewer `not started`; continue attempting every other selected reviewer.

The external adapters support Linux, macOS, and Windows through WSL. Fail closed on native Windows because Node's native Windows process APIs cannot provide the descendant process-group termination guarantee used by the adapters.

Claude command:

```text
node "<skill-root>/scripts/claude-review.mjs" --cwd <repository> --scope <working-tree|branch> [--base <resolved-base-oid>] [--include-working-tree] --expected-fingerprint <initial-fingerprint> [--model <claude.model>] [--effort <claude.effort>] --file-access <claude.fileAccess> [--config-dir <claude.configDir>] [--launcher <claude.launcher>] [--exclude-path <path>]...
```

Require an authenticated `claude` executable, or `jig` when `claude.launcher` is not `none`. Pass a non-`none` launcher as `--launcher`; the adapter then starts `jig claude launch --auto -- <claude arguments>` (or the named home) instead of `claude`, and `--config-dir` must be omitted because the launcher selects the home. Whenever a home is selected explicitly, by launcher or `--config-dir`, the adapter removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN` from the provider environment, because Claude Code prefers them over the home's stored login and the selected account must be the one charged; it also removes inherited `ANTHROPIC_BASE_URL` and the cloud-provider selectors `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and `CLAUDE_CODE_USE_FOUNDRY` so inherited routing cannot bypass the selected subscription. A plain launch keeps the environment's own credentials, endpoint, and provider selectors. The adapter defaults to `opus`. When `claude.configDir` is non-null, pass it as `--config-dir` to the adapter; the adapter sets `CLAUDE_CONFIG_DIR` only in the Claude provider process environment and never interpolates it into shell syntax. Otherwise the provider retains its inherited environment. It independently verifies the repository and pinned branch base, supplies bounded Git context over stdin, enables safe mode without session persistence, and exposes only `Read`, `Glob`, and `Grep`. It never exposes Bash, Edit, Write, skills, MCP servers, or subagents. In the default `restricted` mode it passes Claude's `--restricted` flag, confining file tools to the working directory and explicitly added directories. For paged evidence it adds only its private temporary directory with `--add-dir`; this does not require `host` access or changes to the fingerprinted repository. `host` mode deliberately omits the restriction flag; the tools remain read-only but may read outside these directories. Treat `host` as an explicit user-selected trust-boundary expansion and disclose it in the final review notes. Disclose custom/default Claude config selection without printing the config path.

Claude's `-p` mode [skips workspace trust verification](https://code.claude.com/docs/en/security#additional-safeguards); this adapter does not use the `--worktree` exception. No separate trust setup or permission-bypass flag is needed.

Codex CLI command, only when `codex.runtime` is `cli`:

```text
node "<skill-root>/scripts/codex-review.mjs" --cwd <repository> --scope <working-tree|branch> [--base <resolved-base-oid>] [--include-working-tree] --expected-fingerprint <initial-fingerprint> [--model <codex.model>] [--effort <codex.effort>] [--launcher <codex.launcher>] [--exclude-path <path>]...
```

Require an authenticated `codex` executable, or `jig` when `codex.launcher` is not `none`. The selected home supplies authentication only. The adapter starts Codex through a generated shim (without a launcher it is read by `/bin/sh`; under a launcher Jig execs it via `JIG_CODEX_BIN`, so the evidence directory, `TMPDIR`, must allow execution, and a `noexec` temporary filesystem fails before launch as a permanent configuration error; Jig's usage inspection passes through unchanged) that runs `codex exec` with a private `CODEX_HOME` containing a single symlink to the selected home's `auth.json`, so the home's `AGENTS.md`, skills, and `config.toml` never load while refreshed tokens, which Codex writes in place, still reach the real home. The session is ephemeral and read-only with `--ignore-user-config` and `--ignore-rules`, and `project_doc_max_bytes=0` disables the repository's `AGENTS.md` files. Before launching, the adapter asks Codex itself what it would load (`codex debug prompt-input`, which needs no credentials or network) for the repository and the private home, disables every listed skill outside the private home by SKILL.md path through `skills.config`, and renders again: if any skill outside the private home or any `AGENTS.md` instruction block remains, or if the rendering lists skills in a format the adapter cannot resolve, the review fails before the provider starts as a permanent configuration failure. This follows Codex's own discovery, including `.codex/skills` and deeply nested `.agents/skills`, rather than a fixed list of roots. Codex's embedded system skills live inside the private home and remain listed; the shared prompt forbids invoking skills, other agents, and external reviewers, and the sandbox denies writes and network access. The selected home must hold file-based credentials (`auth.json`); a home using keyring storage or not logged in fails before the provider starts, without naming the home, and is reported as a permanent configuration failure. Under a launcher the adapter also removes `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, and `OPENAI_API_KEY` from the provider environment, because Codex prefers environment credentials over a home's and Jig refuses automatic selection while a token is inherited; the selected account must be the one charged. Without a launcher Codex's normal credential precedence applies. The adapter passes `--model` and `model_reasoning_effort` only when configured, supplies the prompt over stdin, keeps the `--json` event stream for failure classification, and reads the report from the `--output-last-message` file in its private evidence directory. Only Codex's structured error events can mark a failure permanent; transcript text, including repository output quoted on stderr, never does. The reviewer inspects files with read-only shell commands.

Cursor command:

```text
node "<skill-root>/scripts/cursor-review.mjs" --cwd <repository> --scope <working-tree|branch> [--base <resolved-base-oid>] [--include-working-tree] --expected-fingerprint <initial-fingerprint> --effort <cursor.effort> --speed <cursor.speed> [--exclude-path <path>]...
```

Require an authenticated `cursor-agent` executable. The adapter maps effort to the `cursor-grok-4.6-low|medium|high|xhigh` model ID and appends `-fast` when `cursor.speed` is `fast`. It runs non-interactively with `--mode ask --sandbox enabled --trust --workspace <repository>`. Cursor's [`--trust` flag](https://cursor.com/docs/cli/reference/parameters) accepts workspace trust without prompting, allowing a selected review to start in a repository that Cursor has not previously trusted. Use it on the initial invocation; no separate interactive trust setup or retry is needed. Workspace trust is separate from tool permissions: retain ask mode and sandboxing, and never enable `--force`, `--yolo`, or automatic MCP approval. It places the bounded assignment in a private temporary directory, adds that directory while Cursor is constrained by ask mode, and removes it after the process exits.

Every adapter removes the parent session's markers from the provider environment (`CLAUDECODE`, the `CLAUDE_CODE_*` session variables, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CODEX_SANDBOX`, and `CODEX_SANDBOX_NETWORK_DISABLED`) so a reviewer launched from inside Claude Code or Codex starts as an independent session rather than attaching to the parent's session identity, messaging socket, effort, or sandbox state. Provider configuration and credentials such as `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and API keys are retained. With a launcher, Jig inspects subscription headroom, selects the home immediately before the CLI starts, and replaces its own process with the provider, so the adapter's deadline and process-group termination apply unchanged. Selection is uncached and per launch; reviewers started together may select the same home. When no home has headroom, Jig exits before the provider starts and the adapter fails with Jig's message: mark that reviewer `not started` and continue with the others. Jig does not report the selected home back to the adapter, so disclose the launcher mode without naming a home.

All adapters include staged, unstaged, untracked, branch, and initialized-submodule-aware Git context. Staged submodule moves include the underlying commit diff when available. Diff capture streams full patches into a private per-reviewer evidence directory. When a diff exceeds the 384 KiB inline limit or assembled context exceeds 768 KiB, the prompt points to a manifest and numbered evidence pages instead of substituting file statistics. Smaller reviews retain inline context. The evidence directory is bounded to 16 MiB of source text and 2,048 pages. Each page holds at most 16 KiB of source bytes encoded as short JSON string fragments, so long diff lines and large files can be read without tool-output line truncation. Concatenating fragments and consecutive section parts restores the patch, including deleted lines and distinct staged/unstaged versions. Section labels identify original repositories and submodules; findings cite original paths.

With `--include-working-tree`, every adapter supplies the pinned committed branch diff followed by the working-tree evidence, including initialized submodule changes. Review their cumulative effect in the final working files. A finding in a committed or staged version must still fail after the subsequent local changes to be actionable. Preserve every evidence section when local changes reverse committed ones; an empty net diff alone does not authorize dropping those sections.

The reviewer must read and review pages in order and return a terminal coverage object with each reviewed page's ID and random receipt, found only inside that page. The adapter removes that object and appends an `Evidence coverage` summary. Missing, invalid, or duplicate receipts and capture omissions produce `limited` coverage; valid receipts for all captured pages produce `reviewer-attested` coverage. Receipts demonstrate page access and the reviewer's claim, not substantive review quality. Preserve that distinction and any missing-page list when merging. Fingerprint verification measures scope stability separately. Do not count merely supplying a manifest as complete review coverage.

Included file patches are admitted independently, with a 2 MiB per-file limit. Git output is framed at file-diff headers with bounded buffering even for arbitrarily long source lines. A file exceeding that limit, the remaining 16 MiB total budget, or UTF-8 validation is omitted in full without spending its bytes; capture continues to later files. The manifest identifies each omitted patch by its Git header and reason. No path category is excluded automatically; only the trusted `.reviewignore` policy and explicit `--exclude-path` values filter paths. Retained patches preserve their original order, deleted content, rename headers, and staged/unstaged/submodule sections. An omission always makes coverage limited, even when every retained page has a valid receipt. Intentional exclusions are disclosed separately and do not make capture incomplete for the included scope.

Oversized metadata remains truncated with an explicit marker. Untracked files retain the 64 KiB per-file and 128 KiB aggregate limits: they are opened without following symlinks and with non-blocking semantics, checked before and after their bounded read, and rejected if their identity, type, size, or modification time changes during capture. Oversized, binary, non-UTF-8, unreadable, changed-during-capture, special, or aggregate-limit-exceeding untracked files are individually marked omitted. Evidence byte/page limits and non-UTF-8 patch evidence likewise mark coverage incomplete. Other capture failures and deadlines fail the adapter rather than imply a completed review.

Inline repository evidence is wrapped in a fresh per-run nonce delimiter; markup-significant characters in repository-controlled bodies and path attributes are escaped so evidence cannot forge wrapper boundaries. Page contents are JSON-encoded untrusted evidence, never instructions. External adapters require and match the parent's initial fingerprint before collecting context, then match it again after the provider exits; a mismatch discards the report. The 28-minute deadline covers fingerprinting, context collection, provider execution, final fingerprint verification, and cleanup. Provider time is limited to the remaining budget with a final-verification reserve. Provider processes run in their own process group. At their deadline, or when the adapter receives `SIGINT` or `SIGTERM`, the adapter sends `SIGTERM`, waits a bounded grace period, and sends `SIGKILL` to that process group. Command settlement also has a bounded stdio-drain period, so a descendant that deliberately escapes the group while retaining an inherited pipe cannot keep the adapter alive indefinitely. Every adapter removes its private evidence and prompt files on success, failure, timeout, and handled cancellation before re-raising the parent signal.

To verify real CLI evidence access after adapter changes, run `JIG_REVIEW_LIVE=claude,cursor,codex node --test plugins/jig-review/tests/review-evidence-live.test.mjs` from the repository root. Select only the providers to check in that variable. These opt-in checks use authenticated CLIs and consume provider usage; ordinary tests skip them. They verify retrieval of deleted content and valid receipts from an external temporary directory with production read-only flags, including Claude restricted mode and, for Codex, the generated shim with a private credentials-only home and the read-only ephemeral `exec` session.

## External CLI Forwarders

Forwarders apply to Codex hosts. On Claude Code, the parent starts each adapter as a background command; see [claude-code-host.md](claude-code-host.md).

The Claude, Codex CLI, and Cursor children are pure forwarders. Give each only its fully resolved adapter command, repository working directory, the recipe below, and the shared [waiting policy](waiting.md). It must:

- start exactly one non-interactive foreground command and execute its assigned adapter once;
- request only the network access needed for that provider when the host exposes targeted escalation; omit escalation when the host is unrestricted and forbids the parameter; otherwise fail with the policy limitation;
- not inspect the repository or perform any review itself;
- not request a terminal proactively, detach, invoke skills, or spawn another agent;
- run the command in one long-lived tool cell that retains any yielded process handle and polls only that process until `exit_code` is present;
- treat `yield_time_ms` only as the interval before a running handle is returned, never as a command timeout or evidence that the adapter exited;
- accumulate output from the initial launch and every poll, and never return `result.output` while `result.session_id` is present or `result.exit_code` is absent;
- return final stdout exactly, without commentary or progress chatter; and
- surface command failure without retrying through another provider invocation.

Give each external forwarder the following state-machine recipe with the resolved command and working directory substituted as data. The child must use this shape rather than issuing one `exec_command` call and immediately printing its first `output` field. The outer yield below allows up to 60 seconds before returning control to the model; choose its value and subsequent outer waits under the shared waiting policy. The inner process polls remain in code and emit no intermediate output:

```javascript
// @exec: {"yield_time_ms": 60000, "max_output_tokens": 30000}
let result = await tools.exec_command({
  cmd: RESOLVED_SHELL_QUOTED_COMMAND,
  workdir: RESOLVED_REPOSITORY_DIRECTORY,
  yield_time_ms: 1000,
  max_output_tokens: 30000,
});
let output = result.output ?? "";

while (result.exit_code == null) {
  if (result.session_id == null) {
    throw new Error("adapter yielded without a process handle or terminal exit status");
  }
  result = await tools.write_stdin({
    session_id: result.session_id,
    chars: "",
    yield_time_ms: 60000,
    max_output_tokens: 30000,
  });
  output += result.output ?? "";
}

if (result.exit_code !== 0) {
  throw new Error(`adapter exited with status ${result.exit_code}: ${output}`);
}
if (output.length === 0) {
  throw new Error("adapter exited successfully without a review report");
}
text(output);
```

The outer tool cell may itself yield a cell handle while this loop is waiting. In that case, wait on that same outer cell until it completes; do not start another cell or adapter. The process is complete only after the loop observes an `exit_code`. A message saying that the outer cell completed means only that its JavaScript finished; it is not sufficient if that JavaScript discarded an inner `session_id`.
