# Native Codex tool output

Keep tool results focused while preserving the assignment's full scope and evidence requirements.

- Use `rg` to locate relevant symbols and callers, then read bounded file ranges with paths and line numbers. Expand to surrounding code, dependencies, or whole files when needed to assess behavior. Avoid repeatedly dumping files already inspected unless their contents changed or a specific question requires another read.
- Inspect large diffs in file or hunk groups, retaining every included change. A file list or diff summary is an index, not review evidence. Follow truncated search or diff output with narrower queries or additional ranges; never treat hidden output as absent or reviewed.
- For verbose diagnostic builds or tests, save complete stdout and stderr to a log outside the reviewed checkout or assignment copy. Return the command, working directory, actual exit status, test summary, relevant failure excerpts, and log path. Preserve the command's exit status when redirecting or filtering output; a successful filter or logger does not prove the command passed. Inspect the log as needed before drawing conclusions.
- Use bounded tool responses and keep full artifacts accessible. Do not silently discard output or claim complete coverage when necessary evidence remains unread. Output handling does not change command permissions, required validation, or what counts as acceptance evidence.
