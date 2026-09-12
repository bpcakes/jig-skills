---
name: rust-source-reorg
description: Reorder Rust items and imports without behavior changes when source layout cleanup is requested.
---

# Rust Source Reorg

Apply this skill when it serves the user's requested task and target. Discovery or a code change does not authorize an additional review, refactor, or broader scan. For review-only requests, report findings without editing; implement changes only when they are part of the user's request.

## Overview

Reorder Rust source files to a canonical layout while preserving behavior, comments, attributes, and cfg context. Follow the detailed rules in `references/rust-source-reorg-rules.md`.

## Scope

Default to `current working changes`.

- `current working changes`: inspect `git diff` and `git diff --cached`.
- `feature branch`: compare `HEAD` to the merge base with the default branch, then reorganize only relevant changed code.
- `base ref`: compare `<base-ref>...HEAD`, then reorganize only relevant changed code.
- If files or directories are named, restrict edits to those paths.

## Workflow

1. Read the target file and catalog top-level items and all `use` lines (including cfg-gated).
2. Reorganize `use` statements per the rules (groups, sorting, merging, and removal).
3. Reorder all top-level items in canonical section order.
4. Normalize attribute ordering and sort derive lists.
5. Verify no items were dropped, duplicated, or moved across cfg boundaries; keep rustfmt::skip and macro_use constraints.
6. Summarize changed files and relevant validation with file links. Return full source only when requested or when rewriting a supplied snippet.

## Notes

- If uncertain about an import's usage (e.g., macro/doc/cfg), preserve it; report a material limitation without adding speculative TODO comments.
- Do not change runtime behavior, names, signatures, or visibility.

## Resources

- `references/rust-source-reorg-rules.md` (full rules)
