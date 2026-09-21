import { createRun } from "../../skills/review-fix-loop/scripts/review-fix-loop.mjs";
import { parseArgs } from "../../skills/review-fix-loop/scripts/loop-options.mjs";

// Preservation/recovery fixtures exercise the explicit non-committing mode.
// The default per-round lifecycle is exercised separately in round-commits.
export const createWorkingTreeRun = args => createRun({ ...args,
  options: { ...parseArgs([]), ...args.options, commitMode: "none" } });
