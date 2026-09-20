# Legacy inline repair results

Read only when a configured adapter supplies inline file images instead of workspace edits. For ordinary repairs, use the assignment schema and [workspace edits](assignments.md).

Legacy inline `edits` results remain supported for adapters that supply file images without modifying their assignment repository. These results cannot be combined with `workspaceEdits`. Each inline edit has `path`, `reason`, `findingIds`, and complete replacement `content`, or `delete: true`. Regular-file edits accept an optional `mode` string of `"0644"` or `"0755"`. Include it with `content` to create an executable script or change contents and permissions together. For a permission-only repair of an existing included regular file, omit `content` and supply `mode`; its bytes are preserved. For example:

```json
{"assignmentId":"<id>","fingerprint":"<hash>","edits":[{"path":"scripts/check.sh","mode":"0755","reason":"The required validation directly executes this script","findingIds":["<finding-id>"]}]}
```

Modes with special bits or other permission values, modes on deletions, and mode-only edits of missing or excluded files are rejected. Permission changes participate in candidate identity, validation, recoverable application, and no-progress checks just like content changes. The Git index remains unchanged.

Use `delete: true` instead of `content` for a necessary deletion. The runtime enforces the published result schema before interpreting successful reports: both fields together, unknown fields, and invalid variants consume a failed attempt without constructing a candidate. Every path must cite verified actionable findings. When `mode` is omitted, replacements preserve the original permissions and new files default to `0644`. The controller rejects symlink edits, excluded paths, duplicate paths, unsafe paths, and candidate files hidden by Git ignore rules. Ignore-file changes are checked as part of the whole candidate before publication; already tracked files remain managed despite ignore patterns. The [shared candidate and recovery rules](controller.md#validation-and-waiting) also apply to inline edits.
