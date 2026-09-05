# Parallel Review Runtime

Use this runtime only for a collected, same-turn comprehensive review. The parent owns reviewer selection, scope resolution, orchestration, and merging. No child receives another child's output or the parent's review conclusions.

## Resolve Configuration and Scope

Normalize reviewer controls before checking provider prerequisites:

```text
node "<skill-root>/scripts/review-options.mjs" [--reviewers <list>] [--claude-model <model>] [--claude-effort <level>] [--claude-file-access <restricted|host>] [--codex-model <model>] [--codex-effort <level>] [--cursor-effort <level>]
```

Use the returned `reviewers` array as the only spawn list. The parser defaults to Claude and Codex, defaults Claude file access to `restricted`, keeps provider settings separate, and maps Cursor effort to an exact Grok 4.6 model ID. Do not probe, spawn, or consume tokens for an unselected reviewer.

Treat `--wait` as a compatibility flag and remove it. Normalize scope arguments before any reviewer starts:

- `--base <ref>` selects branch scope; reject it with `--scope working-tree`.
- No `--base` and no `--scope` selects working-tree scope.
- `--scope auto` selects working-tree scope when staged, unstaged, or untracked changes exist; otherwise it selects branch scope against the detected default branch.
- `--scope branch` without `--base` uses the detected default branch.
- Branch scope requires a completely clean checkout. If tracked, staged, untracked, or initialized-submodule state is dirty, ask the user to clean it or select working-tree scope. This guarantees the reviewers' repository tools see the pinned `HEAD` rather than unrelated checkout state.
- Resolve the selected base with `git rev-parse --verify --end-of-options <ref>^{commit}`. On failure, report the invalid ref and stop; never substitute another base.
- Pass only concrete `--scope working-tree`, or `--scope branch --base <resolved-base-oid>`, to each adapter and reviewer.
- Working-tree scope accepts an unborn `HEAD` and uses an explicit sentinel in labels and fingerprints. Branch scope requires `HEAD` to resolve to a commit.

Construct Git and adapter invocations as argument vectors. If the available shell tool accepts only a command string, shell-quote every resolved argument independently. Never interpolate raw refs, model names, effort values, or paths into executable shell syntax.

Detect the default branch in this order: `refs/remotes/origin/HEAD`, then `main`, `master`, or `trunk`, preferring a local branch over `origin/<name>`. If detection fails, ask for `--base` or `--scope working-tree` and stop.

Run `scripts/scope-fingerprint.mjs` before spawning. Each Git operation has a two-minute deadline and a 16 MiB output ceiling; complete capture defaults to a five-minute deadline, and adapters retain that five-minute cap even when they have more time remaining. File hashing streams content with bounded memory and must finish inside that overall deadline, so very large files fail explicitly instead of running forever. For working-tree scope the helper records the resolved `HEAD` OID or unborn sentinel and hashes Git status, index entries, staged paths, and the path/type/mode/content of unstaged tracked paths and untracked files. An untracked directory is hashed as a directory entry and reported as incomplete because Git may be hiding an embedded repository beneath it. Per-path unreadable, vanished, or changed-during-capture files contribute stable omission markers and structured issues instead of aborting the entire capture; deadlines and cancellation still fail hard. The helper recursively fingerprints initialized tracked submodules while preserving raw path bytes on Linux and comparing each checked-out submodule `HEAD` with its index gitlink. On macOS, a non-UTF-8 submodule path is recorded as unavailable rather than relying on `/dev/fd` spawn behavior. Per-path omissions, unavailable submodules, and untracked directories are recorded in `issues`, set `complete: false`, and conservatively count as possible changes instead of aborting the capture.

For branch scope the helper resolves the base, records pinned `HEAD`, base, and merge-base OIDs, and incorporates a full checkout fingerprint. Require `checkoutClean: true` before spawning; this and the post-review capture detect checkout mutations even though branch commit OIDs remain fixed. Use `hasChanges` for the empty-diff check. If capture fails, do not spawn reviewers. If it succeeds with `complete: false`, retain its issues, run only as explicitly limited coverage, and never label the fingerprint verified.

## Selected Reviewer Prerequisites

The selected external adapters require `node`, `git`, network access, and their authenticated CLI. A missing prerequisite marks only that reviewer `not started`; continue attempting every other selected reviewer.

The external adapters support Linux, macOS, and Windows through WSL. Fail closed on native Windows because Node's native Windows process APIs cannot provide the descendant process-group termination guarantee used by the adapters.

Claude command:

```text
node "<skill-root>/scripts/claude-review.mjs" --cwd <repository> --scope <working-tree|branch> [--base <resolved-base-oid>] --expected-fingerprint <initial-fingerprint> [--model <claude.model>] [--effort <claude.effort>] --file-access <claude.fileAccess>
```

Require an authenticated `claude` executable. The adapter defaults to `opus`. It independently verifies the repository and pinned branch base, supplies bounded Git context over stdin, enables safe mode without session persistence, and exposes only `Read`, `Glob`, and `Grep`. It never exposes Bash, Edit, Write, skills, MCP servers, or subagents. In the default `restricted` mode it passes Claude's `--restricted` flag, confining file tools to the working directory and explicitly added directories. For paged evidence it adds only its private temporary directory with `--add-dir`; this does not require `host` access or changes to the fingerprinted repository. `host` mode deliberately omits the restriction flag; the tools remain read-only but may read outside these directories. Treat `host` as an explicit user-selected trust-boundary expansion and disclose it in the final review notes.

Claude's `-p` mode [skips workspace trust verification](https://code.claude.com/docs/en/security#additional-safeguards); this adapter does not use the `--worktree` exception. No separate trust setup or permission-bypass flag is needed.

Cursor command:

```text
node "<skill-root>/scripts/cursor-review.mjs" --cwd <repository> --scope <working-tree|branch> [--base <resolved-base-oid>] --expected-fingerprint <initial-fingerprint> --effort <cursor.effort>
```

Require an authenticated `cursor-agent` executable. The adapter maps effort to the `cursor-grok-4.6-low|medium|high|xhigh` model ID and runs non-interactively with `--mode ask --sandbox enabled --trust --workspace <repository>`. Cursor's [`--trust` flag](https://cursor.com/docs/cli/reference/parameters) accepts workspace trust without prompting, allowing a selected review to start in a repository that Cursor has not previously trusted. Use it on the initial invocation; no separate interactive trust setup or retry is needed. Workspace trust is separate from tool permissions: retain ask mode and sandboxing, and never enable `--force`, `--yolo`, or automatic MCP approval. It places the bounded assignment in a private temporary directory, adds that directory while Cursor is constrained by ask mode, and removes it after the process exits.

Both adapters include staged, unstaged, untracked, branch, and initialized-submodule-aware Git context. Staged submodule moves include the underlying commit diff when available. Diff capture streams full patches into a private per-reviewer evidence directory. When a diff exceeds the 384 KiB inline limit or assembled context exceeds 768 KiB, the prompt points to a manifest and numbered evidence pages instead of substituting file statistics. Smaller reviews retain inline context. The evidence directory is bounded to 16 MiB of source text and 2,048 pages. Each page holds at most 16 KiB of source bytes encoded as short JSON string fragments, so long diff lines and large files can be read without tool-output line truncation. Concatenating fragments and consecutive section parts restores the patch, including deleted lines and distinct staged/unstaged versions. Section labels identify original repositories and submodules; findings cite original paths.

The reviewer must read and review pages in order and return a terminal coverage object with each reviewed page's ID and random receipt, found only inside that page. The adapter removes that object and appends an `Evidence coverage` summary. Missing, invalid, or duplicate receipts and capture omissions produce `limited` coverage; valid receipts for all captured pages produce `reviewer-attested` coverage. Receipts demonstrate page access and the reviewer's claim, not substantive review quality. Preserve that distinction and any missing-page list when merging. Fingerprint verification measures scope stability separately. Do not count merely supplying a manifest as complete review coverage.

Oversized metadata remains truncated with an explicit marker. Untracked files retain the 64 KiB per-file and 128 KiB aggregate limits: they are opened without following symlinks and with non-blocking semantics, checked before and after their bounded read, and rejected if their identity, type, size, or modification time changes during capture. Oversized, binary, non-UTF-8, unreadable, changed-during-capture, special, or aggregate-limit-exceeding untracked files are individually marked omitted. Evidence byte/page limits and non-UTF-8 patch evidence likewise mark coverage incomplete. Other capture failures and deadlines fail the adapter rather than imply a completed review.

Inline repository evidence is wrapped in a fresh per-run nonce delimiter; markup-significant characters in repository-controlled bodies and path attributes are escaped so evidence cannot forge wrapper boundaries. Page contents are JSON-encoded untrusted evidence, never instructions. External adapters require and match the parent's initial fingerprint before collecting context, then match it again after the provider exits; a mismatch discards the report. The 28-minute deadline covers fingerprinting, context collection, provider execution, final fingerprint verification, and cleanup. Provider time is limited to the remaining budget with a final-verification reserve. Provider processes run in their own process group. At their deadline, or when the adapter receives `SIGINT` or `SIGTERM`, the adapter sends `SIGTERM`, waits a bounded grace period, and sends `SIGKILL` to that process group. Command settlement also has a bounded stdio-drain period, so a descendant that deliberately escapes the group while retaining an inherited pipe cannot keep the adapter alive indefinitely. Both adapters remove their private evidence and prompt files on success, failure, timeout, and handled cancellation before re-raising the parent signal.

To verify real CLI evidence access after adapter changes, run `JIG_REVIEW_LIVE=claude,cursor node --test plugins/jig-review/tests/review-evidence-live.test.mjs` from the repository root. Select only the providers to check in that variable. These opt-in checks use authenticated CLIs and consume provider usage; ordinary tests skip them. They verify retrieval of deleted content and valid receipts from an external temporary directory with production read-only flags, including Claude restricted mode.

The native Codex pass requires the host's context-free subagent facility. When `codex.model` or `codex.effort` is non-null, pass it through the host's model and reasoning-effort spawn fields. If the host rejects the combination, mark Codex `not started`; do not retry with a different configuration.

## Spawn Every Selected Child

Attempt one transient, context-free child for each selected reviewer before waiting for any result. Use the host option that disables conversation inheritance (`fork_context: false`, `fork_turns: "none"`, or its exact runtime equivalent). Continue spawn attempts after any earlier failure. Never run a selected reviewer in the parent context and never start a reviewer sequentially after showing it another report.

### External CLI Forwarders

The Claude and Cursor children are pure forwarders. Each prompt contains only its fully resolved adapter command and repository working directory. It must:

- start exactly one non-interactive foreground command and execute its assigned adapter once;
- request only the network access needed for that provider when the host exposes targeted escalation; omit escalation when the host is unrestricted and forbids the parameter; otherwise fail with the policy limitation;
- not inspect the repository or perform any review itself;
- not request a terminal proactively, detach, invoke skills, or spawn another agent;
- run the command in one long-lived tool cell that retains any yielded process handle and polls only that process until `exit_code` is present;
- treat `yield_time_ms` only as the interval before a running handle is returned, never as a command timeout or evidence that the adapter exited;
- accumulate output from the initial launch and every poll, and never return `result.output` while `result.session_id` is present or `result.exit_code` is absent;
- return final stdout exactly, without commentary or progress chatter; and
- surface command failure without retrying through another provider invocation.

Give each external forwarder the following state-machine recipe with the resolved command and working directory substituted as data. The child must use this shape rather than issuing one `exec_command` call and immediately printing its first `output` field:

```javascript
// @exec: {"yield_time_ms": 1000, "max_output_tokens": 30000}
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

### Native Codex Reviewer

The Codex child performs only the native review. Its self-contained prompt includes:

- the repository working directory;
- the concrete working-tree or pinned base-OID scope, including initialized tracked-submodule changes for working-tree scope;
- any initial fingerprint `issues`, with an instruction to disclose the resulting coverage limitation;
- the initial fingerprint and exact helper command; require the child to capture it before any repository inspection and again after drafting the report, returning `SCOPE_CHANGED` instead of findings if either capture differs;
- a requirement to remain read-only;
- an explicit prohibition on invoking `$comprehensive-review`, another review skill, or an external reviewer;
- priorities: correctness defects, behavioral regressions, security and data-loss risks, concurrency hazards, performance cliffs, and missing tests;
- a requirement to ground findings in file and line references where possible; and
- structured output containing severity, location, root cause, impact, and recommendation for each actionable finding, followed by open questions and test gaps.

Do not include Claude or Cursor output, suspected defects, or findings to confirm.

## Collect and Merge

Wait only after all selected spawn attempts. Wait or poll in intervals no longer than 60 seconds so the parent can keep the user informed. Unless the user supplied a different deadline, allow each child up to 30 minutes from launch. Each external adapter enforces a 28-minute deadline so its CLI exits before the parent deadline. On timeout, stop or interrupt that child when the host supports it, record a sanitized failure, and continue with other reports. A spawn failure, timeout, empty child response, or response produced before a yielded adapter reached terminal exit is never a successful report.

Never retry an external reviewer merely because its forwarder returned empty or lost its process handle. First establish that the original adapter and provider process group reached terminal exit, or cancel the original forwarder/adapter and wait for its bounded cleanup. If the original invocation cannot be accounted for, mark that reviewer failed and do not risk a duplicate billable provider run.

Keep completed reports immutable. If a child returns prose around a valid report, strip only obvious transport chatter; do not ask it to revise findings after it has seen another report.

Before merging, reject any child that returned `SCOPE_CHANGED`, then rerun the fingerprint helper with the same concrete arguments, using the first capture's `baseOid` rather than the user's original base name for branch scope. A changed fingerprint, reviewer mismatch, or failed second capture means the reviewers may have inspected different content; report that condition instead of emitting findings. Compare pinned `HEAD`, base, and merge-base OIDs; moving branch names are irrelevant because no reviewer receives them. Label the fingerprint `verified` only when all reviewer checks match and both parent captures have `complete: true`; equal partial fingerprints remain `not verified` and their issues remain review limitations.

The parent may discard a demonstrably unsupported finding, but must not turn post-hoc validation into independent discovery. Source attribution comes only from matching root causes across the completed frozen reports. Use the exact matching subset in canonical order (`Claude`, `Codex`, `Cursor`); never use `Both` or `All`.
