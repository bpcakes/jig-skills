// Content applicability is separate from the immutable exact-scope fingerprint.
// Working-tree and incomplete captures deliberately have no reusable identity.
export function reviewApplicability(capture, contractHash, policy, reviewer, coverage) {
  if (capture.scope !== "branch" || capture.includeWorkingTree || !capture.checkoutClean
      || !capture.complete || !capture.reviewedContent) return null;
  return {
    version: 1, content: capture.reviewedContent, fixedBase: capture.baseOid,
    mergeBase: capture.mergeBaseOid, exclusions: capture.excludePaths,
    exclusionRevision: capture.reviewIgnoreRevision, contractHash, policy, reviewer, coverage,
  };
}
