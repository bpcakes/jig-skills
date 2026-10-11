# Setup and host contracts

Read at startup, adoption, or a host/profile change. Save capability receipts in the private run directory and record their paths in configuration; do not repeat full preflight on every tick.

## Scope and installation

Resolve the actual target branch, explicit task IDs or epic descendants, tracker store, worker/reviewer models, existing authority, acceptance owner, registered worktree roots, and any exclusions. An unrelated PR, pane, or checkout stays outside the run. A newly discovered prerequisite may be handled within the existing task only when it is necessary to its authorized outcome; it does not reopen general admission.

Install dependencies in the agent home/profile actually selected for each role. An installation under `~/.codex` does not provision another `CODEX_HOME`, plugin cache, or remote machine.

| Assigned role | Required on that host/profile |
| --- | --- |
| Coordinator | `herdr-orchestrate`, its complete scripts/references, Python runtime, installed Herdr skill/CLI, GitHub CLI/authentication, and the selected tracker access route. |
| Implementation worker | Its native agent CLI/profile, repository toolchain, Git/authentication, and task-specific skills. |
| Review/repair driver | Codex plus the matching `comprehensive-review` and `review-fix-loop` skill pair, their scripts, supported Node/Git/platform runtime, and selected external reviewer CLIs/authentication. |

Both machines need the review pair if both drive review. Installing only `SKILL.md` or only one review skill is insufficient. The orchestration state and scheduler remain on one coordinator. Read the installed review controller's requirements: current repository versions require Node 22+, Git 2.42+, Linux `flock`/`/proc` or the documented macOS Python/process support. Do not infer supported versions from a similarly named executable.

The coordinator and any other agent that controls Herdr need its skill in the selected profile. A coding-only worker does not. Install the Herdr binary separately using Herdr's own setup. From a `jig-skills` checkout, direct installation exports that binary's matching skill using `herdr --skill` and installs it alongside the orchestration skill and review pair:

```sh
scripts/install.sh codex --dest "$HOME/.codex-featherenvy/skills" herdr-orchestrate
```

Use the actual profile's skills directory; without `--dest`, the Codex destination is `${CODEX_HOME:-$HOME/.codex}/skills`. Marketplace installation of `jig-orchestration` does not run this installer or install its dependencies. Install `jig-review` where required and export the Herdr skill separately into the controlling profile:

```sh
scripts/install.sh codex --dest "$HOME/.codex-featherenvy/skills" herdr
```

The export uses the local binary without network access or binary installation. Explicitly selecting `herdr` or `herdr-orchestrate` fails before copying skills if `herdr --skill` is unavailable or unusable; an all-skills installation warns, skips orchestration and continues with unrelated skills. Matching automatic dependencies are preserved. A differing Herdr skill needs explicit replacement with `--force herdr herdr-orchestrate` for a direct orchestration install, or `--force herdr` for a plugin-based install. `--force herdr-orchestrate` alone cannot replace it. Explicitly select differing review dependencies too if those need replacement. Perform these updates during setup, preserving versions needed by active runs.

Check actual skill paths/content versions, executable paths and versions, selected profiles/models, project dependencies, authenticated GitHub repository access, tracker access, and working directories. Do not print secrets. The helper's `preflight` is a local path/version check, not proof of remote installation, reviewer authentication, provider availability, or successful hosted acceptance. Obtain those receipts using each selected environment before dependent work.

Record canonical checkout/worktree-root paths verified on the host that owns them, including symlink resolution. The helper normalizes lexical POSIX aliases such as a trailing `/.`; it cannot resolve remote symlinks on the coordinator. Check that each physical checkout has one writer and is outside protected main working trees before admission or handoff.

Admission and relocation reject equal, ancestor, or descendant paths overlapping the protected repository or another task's checkout on the same host. Similar path prefixes are allowed when they are separate directories; identical paths on different hosts are separate locations. These lexical checks do not replace host-side symlink and physical-checkout verification.

Set `repository.host` to the registered host that owns `repository.path`. Other hosts may declare their protected main checkout with `hosts.<id>.repository_path`. For existing configurations without `repository.host`, the helper uses the sole host with the `coordinator` role, then a host named `local`, then the sole registered host. If none identifies the owner, it conservatively protects the repository path on every host until the coordinator role is identified. Verify these bindings on the owning hosts before admission.

Install or upgrade as an explicit setup operation under existing authority. Do not upgrade active controllers merely to match version strings. Retain the runtime required to resume each saved review run.

## Herdr endpoints

Read the installed Herdr skill before control. Require genuine `HERDR_ENV=1`, including when using a named session. Discover syntax with `herdr --help` and non-mutating command groups; bare `herdr` attaches a TUI, and an incomplete mutating command can execute defaults.

Bind each endpoint using the installed CLI:

- Local: explicit `--session <name>` where supported.
- Remote: installed `--machine <profile-id>` forwarding, with the profile's SSH host and remote session recorded. Do not combine it with `--session` or `--remote`.
- If machine forwarding is unavailable: a verified SSH-wrapped remote CLI invocation with its explicit session, issued from the managed coordinator. Do not inject managed-context variables.

Prove get/prompt/read/wait behavior only against owned test agents within authorized setup scope. Register endpoint, agent name/kind, pane, native identity, session, selected agent home/profile, and checkout. Parse IDs from responses. Names can be reused after replacement; a name alone is not identity. Never use local `--current` remotely. An endpoint/profile change requires rebinding; a host with no verified connection is not dispatchable.

Preflight also records the supported pause boundary and cancellation controls for workers, controllers, reviewer children, and background validation. An implementation assignment or review round may be the smallest available stopping unit.

## Return route and helper authority

Coordinator-to-worker SSH does not prove worker-to-coordinator access. Verify the reverse route separately against isolated state before delegating consequential transitions. Bind caller identity outside the request payload and allow only its assigned task operations. The bundled `serve` command supports a restricted SSH forced-command entry point; [runtime](runtime.md) describes the protocol. Do not give workers the coordinator's unrestricted local `apply` command or arbitrary shell access as a substitute for this boundary.

Without a verified return route, record coordinator-mediated transitions: workers can implement/review and leave durable evidence, while the coordinator checks current gates and performs authorized merges/resource transfers. Do not invent a new transport or claim direct progress on that host.

## Configuration decisions

The user can configure conversationally; translate the agreed values into the helper's actual JSON schema. See [runtime](runtime.md). Distinguish configuration from demonstrated capability: an `enforced` limit requires a verified assignment boundary, and a return-route flag requires a probe receipt.

Record authority for implementation, review, validation, pushes, PR creation, merging, deployment, closure, scheduling, and notifications as applicable. A merge grant does not imply deployment or unrelated cleanup. Preserve exclusions and native approval modes. An authorized alert destination is run-specific; none is inherited from another user's historical workflow.

Retain compact current configuration and task state with external artifact references. Keep full review reports in the controller's own artifacts. The helper is the sole orchestration-state writer; no task or driver edits its JSON files directly. V1 has no automatic cross-host coordinator failover.
