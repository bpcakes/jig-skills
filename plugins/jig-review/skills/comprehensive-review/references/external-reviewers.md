# External reviewers

Read only the selected provider setup and the common evidence/forwarder rules. Do not probe an unselected CLI. Append `--task-brief <absolute-brief.json> --task-brief-hash <hash>` to each resolved adapter command.

The selected external adapters require `node`, `git`, network access, and their authenticated CLI. A missing prerequisite marks only that reviewer `not started`; continue attempting every other selected reviewer.

The external adapters support Linux, macOS, and Windows through WSL. Fail closed on native Windows because Node's native Windows process APIs cannot provide the descendant process-group termination guarantee used by the adapters.

Claude command:

```text
node "<skill-root>/scripts/claude-review.mjs" --cwd <repository> --scope <working-tree|branch> [--base <resolved-base-oid>] [--include-working-tree] --expected-fingerprint <initial-fingerprint> [--model <claude.model>] [--effort <claude.effort>] --file-access <claude.fileAccess> [--config-dir <claude.configDir>] [--exclude-path <path>]...
```

Require an authenticated `claude` executable. The adapter defaults to `opus`. When `claude.configDir` is non-null, pass it as `--config-dir` to the adapter; the adapter sets `CLAUDE_CONFIG_DIR` only in the Claude provider process environment and never interpolates it into shell syntax. Otherwise the provider retains its inherited environment. It independently verifies the repository and pinned branch base, supplies bounded Git context over stdin, enables safe mode without session persistence, and exposes only `Read`, `Glob`, and `Grep`. It never exposes Bash, Edit, Write, skills, MCP servers, or subagents. In the default `restricted` mode it passes Claude's `--restricted` flag, confining file tools to the working directory and explicitly added directories. For paged evidence it adds only its private temporary directory with `--add-dir`; this does not require `host` access or changes to the fingerprinted repository. `host` mode deliberately omits the restriction flag; the tools remain read-only but may read outside these directories. Treat `host` as an explicit user-selected trust-boundary expansion and disclose it in the final review notes. Disclose custom/default Claude config selection without printing the config path.

Claude's `-p` mode [skips workspace trust verification](https://code.claude.com/docs/en/security#additional-safeguards); this adapter does not use the `--worktree` exception. No separate trust setup or permission-bypass flag is needed.

Cursor command:

```text
node "<skill-root>/scripts/cursor-review.mjs" --cwd <repository> --scope <working-tree|branch> [--base <resolved-base-oid>] [--include-working-tree] --expected-fingerprint <initial-fingerprint> --effort <cursor.effort> --speed <cursor.speed> [--exclude-path <path>]...
```

Require an authenticated `cursor-agent` executable. The adapter maps effort to the `cursor-grok-4.6-low|medium|high|xhigh` model ID and appends `-fast` when `cursor.speed` is `fast`. It runs non-interactively with `--mode ask --sandbox enabled --trust --workspace <repository>`. Cursor's [`--trust` flag](https://cursor.com/docs/cli/reference/parameters) accepts workspace trust without prompting, allowing a selected review to start in a repository that Cursor has not previously trusted. Use it on the initial invocation; no separate interactive trust setup or retry is needed. Workspace trust is separate from tool permissions: retain ask mode and sandboxing, and never enable `--force`, `--yolo`, or automatic MCP approval. It places the bounded assignment in a private temporary directory, adds that directory while Cursor is constrained by ask mode, and removes it after the process exits.

Both adapters include staged, unstaged, untracked, branch, and initialized-submodule-aware Git context. Staged submodule moves include the underlying commit diff when available. Diff capture streams full patches into a private per-reviewer evidence directory. When a diff exceeds the 384 KiB inline limit or assembled context exceeds 768 KiB, the prompt points to a manifest and numbered evidence pages instead of substituting file statistics. Smaller reviews retain inline context. The evidence directory is bounded to 16 MiB of source text and 2,048 pages. Each page holds at most 16 KiB of source bytes encoded as short JSON string fragments, so long diff lines and large files can be read without tool-output line truncation. Concatenating fragments and consecutive section parts restores the patch, including deleted lines and distinct staged/unstaged versions. Section labels identify original repositories and submodules; findings cite original paths.

With `--include-working-tree`, both adapters supply the pinned committed branch diff followed by the working-tree evidence, including initialized submodule changes. Review their cumulative effect in the final working files. A finding in a committed or staged version must still fail after the subsequent local changes to be actionable. Preserve every evidence section when local changes reverse committed ones; an empty net diff alone does not authorize dropping those sections.

The reviewer must read and review pages in order and return a terminal coverage object with each reviewed page's ID and random receipt, found only inside that page. The adapter removes that object and appends an `Evidence coverage` summary. Missing, invalid, or duplicate receipts and capture omissions produce `limited` coverage; valid receipts for all captured pages produce `reviewer-attested` coverage. Receipts demonstrate page access and the reviewer's claim, not substantive review quality. Preserve that distinction and any missing-page list when merging. Fingerprint verification measures scope stability separately. Do not count merely supplying a manifest as complete review coverage.

Included file patches are admitted independently, with a 2 MiB per-file limit. Git output is framed at file-diff headers with bounded buffering even for arbitrarily long source lines. A file exceeding that limit, the remaining 16 MiB total budget, or UTF-8 validation is omitted in full without spending its bytes; capture continues to later files. The manifest identifies each omitted patch by its Git header and reason. No path category is excluded automatically; only the trusted `.reviewignore` policy and explicit `--exclude-path` values filter paths. Retained patches preserve their original order, deleted content, rename headers, and staged/unstaged/submodule sections. An omission always makes coverage limited, even when every retained page has a valid receipt. Intentional exclusions are disclosed separately and do not make capture incomplete for the included scope.

Oversized metadata remains truncated with an explicit marker. Untracked files retain the 64 KiB per-file and 128 KiB aggregate limits: they are opened without following symlinks and with non-blocking semantics, checked before and after their bounded read, and rejected if their identity, type, size, or modification time changes during capture. Oversized, binary, non-UTF-8, unreadable, changed-during-capture, special, or aggregate-limit-exceeding untracked files are individually marked omitted. Evidence byte/page limits and non-UTF-8 patch evidence likewise mark coverage incomplete. Other capture failures and deadlines fail the adapter rather than imply a completed review.

Inline repository evidence is wrapped in a fresh per-run nonce delimiter; markup-significant characters in repository-controlled bodies and path attributes are escaped so evidence cannot forge wrapper boundaries. Page contents are JSON-encoded untrusted evidence, never instructions. External adapters require and match the parent's initial fingerprint before collecting context, then match it again after the provider exits; a mismatch discards the report. The 28-minute deadline covers fingerprinting, context collection, provider execution, final fingerprint verification, and cleanup. Provider time is limited to the remaining budget with a final-verification reserve. Provider processes run in their own process group. At their deadline, or when the adapter receives `SIGINT` or `SIGTERM`, the adapter sends `SIGTERM`, waits a bounded grace period, and sends `SIGKILL` to that process group. Command settlement also has a bounded stdio-drain period, so a descendant that deliberately escapes the group while retaining an inherited pipe cannot keep the adapter alive indefinitely. Both adapters remove their private evidence and prompt files on success, failure, timeout, and handled cancellation before re-raising the parent signal.

To verify real CLI evidence access after adapter changes, run `JIG_REVIEW_LIVE=claude,cursor node --test plugins/jig-review/tests/review-evidence-live.test.mjs` from the repository root. Select only the providers to check in that variable. These opt-in checks use authenticated CLIs and consume provider usage; ordinary tests skip them. They verify retrieval of deleted content and valid receipts from an external temporary directory with production read-only flags, including Claude restricted mode.

## External CLI Forwarders

The Claude and Cursor children are pure forwarders. Give each only its fully resolved adapter command, repository working directory, the recipe below, and the shared [waiting policy](waiting.md). It must:

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
