# Sources and compatibility notes

Technical sources checked on **2026-09-17**. Upstream `main` pages are evolving
references, not a promise that the user's installed binary supports every example.
Inspect the local version, help, schemas, and project policy before tracker access.

The scope-reduction workflow, prompts, question patterns, and approval protocol in
this package are original task-specific design recommendations. They are not
claims that Beads or another upstream project mandates this process.

## Beads technical references

**S1 — Beads Rust README**

[Official repository documentation](https://github.com/Dicklesworthstone/beads_rust)

Used for basic command families, automatic JSONL import/export considerations,
typed dependency handling, and explicit sync/export semantics.

**S2 — Beads Rust CLI definitions**

[Official CLI source](https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/src/cli/mod.rs)

Used to check audit switches, dependency-list direction, typed removal arguments,
ready-query limits, and the existence of version-dependent update safeguards.
The skill intentionally does not assume a single JSON envelope or hard-code a
complete mutation script against this evolving contract.

**S3 — Beads Rust's own agent skill**

[Official br skill](https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/.claude/skills/br/SKILL.md)

Used to cross-check basic dependency direction and graph-inspection conventions.
Where documentation and installed behavior differ, inspect current local help and
evidence. Upstream agent instructions do not authorize this skill to commit,
write, or bypass user approval.

**S4 — Deferral implementation**

[Official defer command source](https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/src/cli/commands/defer.rs)

Used to check the optional date and indefinite-deferral behavior. Still verify
effective exclusion under the actual project's selection workflow.

**S5 — Ready-query implementation**

[Official ready command source](https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/src/cli/commands/ready.rs)

Used to check that configuration, filters, and external dependencies can affect
ready results. The safety requirement to inspect actual post-change work queues
is this skill's own design rule.

## Skill format and interview reference

**S6 — Agent Skills specification**

[Official specification](https://agentskills.io/specification)

Used for the `SKILL.md` frontmatter, directory naming, and separation of core
instructions from optional reference/template files. Host discovery and invocation
mechanisms remain host-specific.

**S7 — grill-me and grilling**

[grill-me entry point](https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md)

[grilling implementation](https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/grilling/SKILL.md)

The user referenced this interview style. The checked entry point delegates to
`grilling`, whose instructions distinguish environment fact-finding from user
choices and pursue a complete decision tree. This package does not copy or depend
on that skill. Its narrower objective is to settle material release decisions,
prune excluded branches, and stop without exhaustive future-design exploration.

## User-supplied source

**U1 — `planning-wokflow.zip`**

Reviewed the supplied `planning-wokflow/SKILL.md` and
`planning-wokflow/references/PROMPTS.md`, `FAQ.md`, and `EXAMPLES.md`.
The integration guide targets the attachment's volume requirements, fixed review
rounds, open-ended improvement prompts, and blending instructions. The original
files are not redistributed or changed by this package.

## Validation scope

No live Beads workspace was supplied or modified while building this ZIP. The
packaging environment did not have a `br` binary, so command examples were checked
against primary documentation/source rather than executed end to end. Behavioral
evaluation cases are provided as test specifications, not passing test claims.

Package validation covers frontmatter constraints, referenced local-file presence,
Markdown fence balance, safe ZIP paths, and archive integrity. It does not certify
agent compliance or compatibility with every host and tracker version.
