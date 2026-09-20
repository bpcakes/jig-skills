# Waiting for existing work

Use this policy for native reviewers, external forwarders, and the repair controller. Read it once when entering a wait.

- Prefer completion notifications or interruptible waits on the existing agent, process, or outer tool-cell handle. Choose the longest wait allowed by the tool and higher-priority host instructions, bounded by the remaining workflow deadline. A wait returning early is not a reason to delay handling its result.
- After an unchanged wait timeout, resume the same handle directly. Avoid extra status/list calls, rereading files or instructions, and reconsidering the workflow merely because time elapsed. Inspect further when a failure, lost handle, changed state, or deadline requires a decision.
- Report meaningful progress, failures, and requested decisions. If the host requires periodic updates, keep unchanged-status updates brief and resume waiting; this policy does not override that requirement.
- Keep command polling and output accumulation inside one long-lived code execution where supported. If that execution yields, resume its outer handle; do not rerun the command. Native agent waits use the host's agent-wait tool, not a shell sleep or a new monitoring agent.
- A yielded handle, empty poll, or elapsed wait is not completion, failure, or permission to retry. Preserve the workflow's deadlines, cancellation/cleanup rules, result checks, and provider-attempt accounting. Record actual completion before consuming a result.
