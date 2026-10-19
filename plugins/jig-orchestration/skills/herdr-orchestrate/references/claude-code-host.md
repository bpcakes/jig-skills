# Claude Code host

Read this when the coordinator or a task driver runs in Claude Code. It covers only host mechanics; scope, authority, state, gates, and reporting are unchanged.

## Profiles and installation

A Claude Code profile is the `CLAUDE_CONFIG_DIR` in effect when Claude starts, or `~/.claude` when it is unset. Record that directory as the profile's `agent_home` and set the profile's `agent` to `claude`; [preflight](runtime.md#initialize-and-inspect) then requires the `claude` CLI instead of Codex for a review role. `herdr agent start --kind claude` starts Claude from the pane's shell, so that shell's environment selects the profile.

Direct installation into a profile is `scripts/install.sh claude --dest "<profile>/skills" herdr-orchestrate`. Marketplace skills are under the profile's versioned plugin cache, `<profile>/plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill>`. Record those directories in `skill_paths`, and refresh them and any pinned hashes after a plugin update.

## Native identity

Herdr reports a Claude session's `agent_session` only when Herdr's Claude integration is installed in that profile. Check `herdr integration status` with that profile's `CLAUDE_CONFIG_DIR`. Without the integration, `herdr agent get` returns `"agent": "claude"` but no native identity: the scheduler cannot accept that coordinator, and pane, terminal, and name alone cannot show which session occupies a pane. Installing it (`herdr integration install claude` with that `CLAUDE_CONFIG_DIR`) adds Herdr's hook to the profile's settings; perform it only as a setup operation under existing authority.

## Approvals and sandbox

Claude Code's permission rules and sandbox are its native approval settings. A reconciliation pass runs the helper and tracker, GitHub, Git, Herdr, and SSH commands. A command that prompts leaves the coordinator blocked until the user answers in its pane. During a scheduled pass the delivered wake stays pending, so ticks do not inspect the coordinator; `health` reports the unresolved wake once twice the cadence has passed since that wake's attempt. When no wake is pending, the next tick finds the coordinator `blocked` (Herdr recognizes Claude's command permission prompt) and records a health failure that names the pane. Permitting those commands in advance is the user's setup decision. Never answer the prompt through Herdr or change permission modes to escape it. If the sandbox blocks the Herdr socket, the private run directory, network access, or SSH, request the host's approval to run that command outside the sandbox.

## Turns and background work

A foreground command is limited to 10 minutes. Run longer waits in the background and act on their completion notifications; do not poll with `sleep`. Keep each reconciliation pass bounded and end the turn when it completes: worker replies and scheduled wakes arrive as new prompts. Background commands outlive the turn, so an `idle` or `done` Claude agent may still own running jobs; observe them settled before parking or releasing a slot.

## Review drivers

A Claude Code driver runs the installed review pair with `--host claude` and follows that skill's Claude Code host instructions: start each controller `run` in the background and read its result after the completion notification. Register the controller `runId` and run directory as usual. Stopping the background `run` leaves its reviewer and validation jobs owned by the controller run. Resume that same run rather than starting another, and treat cancellation as unconfirmed until those jobs are observed settled.
