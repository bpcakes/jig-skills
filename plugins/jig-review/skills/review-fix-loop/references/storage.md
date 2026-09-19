# Storage admission and explicit pruning

Read for `STORAGE_LIMIT`, custom storage limits, archival, or an explicit pruning request. Review/fix authorization does not authorize pruning.

Configuration `storage` accepts positive integer byte limits: `maxSourceBytes` (default 1 GiB), `maxRunBytes` (4 GiB), `maxRetainedBytes` (8 GiB), and `minFreeBytes` (64 MiB). Source <= run <= retained limits are required. Source capture is bounded before storing each file. Controller allocation boundaries count retained records and external copies without following symlinks, include metadata/output headroom, and check free space on both filesystems. Capacity failures record `STORAGE_LIMIT` and stop; they never prune data, consume another repair attempt, or relax fingerprints. These are conservative admission limits for controller allocations, not OS quotas on unrelated writers or arbitrary validation output. Full content checks remain at mutation and terminal boundaries.

`node <skill>/scripts/review-fix-loop.mjs prune --run <exact-run-directory>` explicitly deletes that settled run's entire record, including source blobs, transcripts, patches, and settled backups, and its owned temporary workspace. This cannot be undone through the controller; archive the record first if needed. Active runs, pending cleanup, and unresolved application recovery are refused. Pruning is never automatic or implied by a review/fix request. Merely reaching a terminal state retains the full record.

Before release or archival, inspect the retained-backup obligations in [recovery.md](recovery.md).
