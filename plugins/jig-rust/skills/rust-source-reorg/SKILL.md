---
name: rust-source-reorg
description: Reorganize Rust source files without behavior changes, focusing on canonical top-level item ordering and precise use-statement grouping/merging/cleanup. Use when asked to reorder imports, restructure Rust file layout, or apply style rules to Rust source reorganization.
---

# Rust Source Reorg

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
6. Output the full reorganized file.

## Notes

- If uncertain about an import's usage (e.g., macro/doc/cfg), keep it and add `// TODO: verify if this import is still needed`.
- Do not change runtime behavior, names, signatures, or visibility.

## Resources

- `references/rust-source-reorg-rules.md` (full rules)
