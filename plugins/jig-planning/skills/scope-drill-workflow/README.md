# scope-drill-workflow

A Jig Planning skill for simplifying an existing Beads epic without silently
changing what the user asked for. Version 1.0.0.

It reviews two different problems: **feature breadth** (unrequested capabilities)
and **implementation depth** (unnecessary frameworks, infrastructure, or other
obligations for otherwise valid features).

The default workflow is: inspect -> establish the release boundary -> recommend
cuts or simpler approaches -> interview the user -> propose exact changes.
Applying those changes requires explicit approval. Existing approvals are reused.

## Install

Install the `jig-planning` plugin or use the repository's direct-copy installer:

```sh
scripts/install.sh codex scope-drill-workflow
```

Use `claude` instead of `codex` for Claude Code. See the
[repository installation guide](../../../../README.md#installation).

For a manual copy, put this folder in your agent host's skills directory. The
resulting path must be:

```text
<your-skills-directory>/scope-drill-workflow/SKILL.md
```

Keep `references/` and `assets/` beside `SKILL.md`. Do not install only the main
Markdown file, and do not add another nested `scope-drill-workflow` directory.
Follow the host's normal skill reload/discovery procedure.

No package installation, executable scripts, API keys, or runtime dependencies are
bundled. Live tracker access requires your existing Beads setup. The skill can
also review a pasted plan or exported epic with clearly stated access limits.

## Use

For a marketplace install, invoke `$jig-planning:scope-drill-workflow`.
For a direct copy, use `$scope-drill-workflow`, or ask naturally:

```text
Use scope-drill-workflow on epic br-abc.
Interview me about optional scope and over-engineering.
Do not change beads until I approve the proposed changes.
```

For a non-interactive review:

```text
Use scope-drill-workflow on epic br-abc, audit only.
Do not ask questions or write anything. Flag conditional recommendations
and show the smallest plausible release with its unresolved assumptions.
```

For a subsequent, already reviewed change set:

```text
Apply approved changes C1 and C2 from the scope review of br-abc.
Leave C3 unchanged. Re-check the current tracker state before writing.
```

These are natural-language requests, not new `br` commands or flags. Structured
user-input tools are preferred when the host exposes them; ordinary chat is the
fallback. Neither `grill-me` nor another installed skill is required.

## What is included

| File | Purpose |
| --- | --- |
| `SKILL.md` | Main workflow, modes, authority rules, and completion criteria. |
| `references/INTERVIEW.md` | Focused questions, tradeoffs, and decisions that stop expansion. |
| `references/BEADS.md` | Version-aware `br` guidance, safe reads, changes, dependencies, and verification. |
| `references/PLANNING-INTEGRATION.md` | Lightweight scope checkpoint plus replacement planning/review prompts. |
| `references/EXAMPLES.md` | Fictional worked examples, including required complexity and shared prerequisites. |
| `references/EVALUATION.md` | Behavioral test scenarios for evaluating an agent using the skill. |
| `assets/SCOPE-REVIEW.template.md` | Optional single-document scope agreement, decision log, change set, and receipt. |
| `references/SOURCES.md` | Primary technical sources and source-verification limitations. |

## Pair with planning-workflow

The standalone drill corrects an existing epic. The optional integration guide
helps prevent the same problem during new planning: agree on scope before detailed
decomposition, constrain review suggestions to that scope, and check for changes
before creating beads.

The guide was written for an older, user-supplied planning workflow. Its suggested
edits are historical examples; the sibling `planning-workflow` skill already
includes scope controls. Adapt the guidance only when relevant to the installed
workflow, and do not automatically rewrite it.

## Design and verification limits

The skill has no automatic tracker-mutation script. It requires live capability
checks because installed `br` versions and project policies differ. A `bd`
installation must be inspected on its own terms, not treated as an alias.

The package was checked for valid frontmatter, internal file references, and ZIP
integrity. Its behavioral scenarios are an evaluation suite, not a claim of
completed agent runs. No live Beads workspace was supplied or modified, and no
end-to-end tracker test was performed during packaging.
