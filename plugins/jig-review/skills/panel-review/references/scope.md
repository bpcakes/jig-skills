# Scope and fingerprint capture

Treat `--wait` as a compatibility flag and remove it. Normalize scope arguments before any reviewer starts:

- `--base <ref>` selects branch scope; reject it with `--scope working-tree`.
- No `--base` and no `--scope` selects working-tree scope.
- Reject `--scope auto` combined with `--include-working-tree` before inspecting Git state. Explain that inclusion requires an explicit `--scope branch` or `--base`; do not let checkout cleanliness determine whether the same arguments are valid.
- `--scope auto` selects working-tree scope when staged, unstaged, or untracked changes exist; otherwise it selects branch scope against the detected default branch.
- `--scope branch` without `--base` uses the detected default branch.
- Branch scope defaults to a completely clean checkout. With `--include-working-tree`, it includes committed branch changes and all local changes together and permits a dirty checkout. The review-fix loop always uses this flag in branch mode. Without it, retain the full clean-check so repository tools see pinned `HEAD`.
- A dirty-checkout rejection does not authorize creating a clean worktree, switching branches, stashing, or discarding local work. Keep the user's checkout. Use `--include-working-tree` when the requested scope includes local changes; otherwise report the scope conflict and explain that combined scope is available. Exclusions do not waive the committed-only clean-check.
- Resolve the selected base with `git rev-parse --verify --end-of-options <ref>^{commit}`. On failure, report the invalid ref and stop; never substitute another base.
- Pass only concrete `--scope working-tree`, or `--scope branch --base <resolved-base-oid> [--include-working-tree]`, to each adapter, fingerprint helper, and reviewer. Reject the inclusion flag outside resolved branch scope. Keep the inclusion mode identical across all captures and providers.
- Working-tree scope accepts an unborn `HEAD` and uses an explicit sentinel in labels and fingerprints. Branch scope requires `HEAD` to resolve to a commit.
- Normalize each repeatable `--exclude-path` as a repository-relative literal path. It excludes that exact path and descendants. Reject blank paths, `.`/`..` segments, globs, negation, backslashes, and `.reviewignore` itself.

The root `.reviewignore` provides permanent exclusions with the same literal path syntax; blank lines and lines beginning with `#` are ignored. Working-tree scope reads it from pinned `HEAD`. Branch scope reads it from the resolved base commit, not branch `HEAD`, so a change cannot hide itself by adding a policy entry. If the trusted revision has no `.reviewignore`, no permanent rules apply. The effective exclusions are the sorted union of policy and CLI paths. They filter tracked and untracked evidence but never filter the branch clean-check. A policy change takes effect after it becomes part of the trusted revision; use `--exclude-path` when an immediate explicit override is intended.

Construct Git and adapter invocations as argument vectors. If the available shell tool accepts only a command string, shell-quote every resolved argument independently. Never interpolate raw refs, model names, effort values, or paths into executable shell syntax.

Detect the default branch in this order: `refs/remotes/origin/HEAD`, then `main`, `master`, or `trunk`, preferring a local branch over `origin/<name>`. If detection fails, ask for `--base` or `--scope working-tree` and stop.

Capture with the resolved arguments before spawning and again after collection:

```text
node "<skill-root>/scripts/scope-fingerprint.mjs" --cwd <repository> --scope <working-tree|branch> [--base <resolved-base-oid>] [--include-working-tree] [--exclude-path <path>]...
```

Pass the same explicit exclusion arguments to every selected reviewer and capture. Retain the returned scope, OIDs, fingerprint, effective exclusions, policy revision, completeness, issues, and path inventories. Compare the captures; do not hand-roll a weaker fingerprint.

Each Git operation has a two-minute deadline and a 16 MiB output ceiling; complete capture defaults to five minutes. The helper hashes source, index, modes, Git state, and initialized tracked submodules. Per-path omissions, unavailable submodules, hidden untracked directories, and capture races set `complete: false` with structured `issues`; deadlines and cancellation fail explicitly. Stop before spawning on either failure or incomplete capture, without provider fallback or claiming drift from incomplete evidence.

The returned `workingTreePathsDifferingFromIndex`, `workingTreePathsAbsentFromIndex`, and `dirtySubmodulePaths` include nested paths. Arrays are capped at 256 entries or 32 KiB; exact `Count`, `Truncated`, and aggregate `pathInventoryComplete` fields disclose omissions. Inventory truncation alone does not invalidate a fully hashed fingerprint. Preserve these fields for [the output contract](review-output.md), which owns staging advice and path-display handling. Implementation details remain in the fingerprint helper; do not reconstruct its checks in conversation.

For branch scope the helper resolves the base and records pinned `HEAD`, base, and merge-base OIDs. Without `--include-working-tree`, it incorporates a full checkout fingerprint and requires `checkoutClean: true` before spawning. With the flag, require `includeWorkingTree: true`; the fingerprint incorporates local state under the effective exclusions and distinguishes this mode from committed-only branch scope. It omits `checkoutClean`, since this mode permits dirty checkouts. `hasChanges` covers either committed or local included changes: a local reversal of a committed change still requires review of both deltas. Both modes detect mutations with the post-review capture. If capture fails, do not spawn reviewers. If it succeeds with `complete: false`, stop before reviewer invocation with `CAPTURE_INCOMPLETE` and its issues. Do not proceed through partial review or provider fallback.
