import { hash } from "./run-store.mjs";

// Signals request investigation. They are not diagnoses, severity changes, or
// permission to reset a checkout. The controller owns all evidence bindings.
export const RECOVERY_ROUTES = Object.freeze({
  productive: "repair", "local-repair": "repair", "wrong-design": "reimplement",
  "reviewer-noise": "follow-up", "scope-dependency": "split",
  "disputed-finding": "adjudicate", "execution-blocked": "park",
});
export const atRoundLimit = run => run.options.maxRounds !== null && run.round >= run.options.maxRounds;
export function signalRecovery(run, kind, findingIds, evidence) {
  const signal = { kind, round: run.round, pass: run.pass, findingIds: [...new Set(findingIds)].sort(), evidence };
  signal.id = `signal-${hash(signal).slice(0, 16)}`;
  const signals = run.recoverySignals ??= [];
  if (!signals.some(item => item.id === signal.id)) signals.push(signal);
  return signal;
}
export function recoveryContext(run) {
  const covered = new Set((run.recoveries ?? []).flatMap(item => item.signalIds));
  return { signals: (run.recoverySignals ?? []).filter(item => !covered.has(item.id)),
    decisions: run.recoveries ?? [], progress: run.progress ?? [],
    // Validation receipts already travel in the triage assignment's validation
    // field; retain one copy and use the existing mutation history here.
    mutations: run.mutations };
}
export function recoveryDecision(run, decision, assignment, decisions, inThreshold) {
  if (![decision.evidence, decision.nextAction].every(value => typeof value === "string" && value.trim())) throw new Error("Recovery requires nonblank diagnostic evidence and a concrete next action.");
  if (decision.strategy !== undefined) decision = { ...decision, strategy: decision.strategy.trim().toLowerCase() };
  const route = RECOVERY_ROUTES[decision.diagnosis];
  const findings = decision.findingIds.map(id => run.ledger[id]);
  const actionableIds = new Set(decisions.filter(d => d.status === "actionable" && inThreshold(run.ledger[d.id])).map(d => d.id));
  const coveredSignals = recoveryContext(run).signals.filter(signal => signal.findingIds.every(id =>
    !actionableIds.has(id) || decision.findingIds.includes(id)));
  if (!route || findings.some(item => !item)) throw new Error("Recovery must name a supported diagnosis and existing findings.");
  if (["repair", "reimplement"].includes(route)) {
    if (!decision.strategy || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(decision.strategy)) throw new Error("Local recovery requires a stable strategy key (lowercase words joined by hyphens); change it only for a causally different approach.");
    if (!findings.length || findings.some(f => !decisions.some(d => d.id === f.id && d.status === "actionable") || !inThreshold(f))) throw new Error("Local recovery must address actionable in-threshold findings.");
    const strategies = (run.recoveries ?? []).filter(item => ["repair", "reimplement"].includes(item.route));
    const repeats = strategies.filter(item => item.strategy === decision.strategy
        && item.findingIds.some(id => decision.findingIds.includes(id)));
    if (decision.diagnosis === "productive") {
      // Selecting a strategy during recovery is not evidence that it failed.
      // Continuation must still belong to the current approach for each finding;
      // an abandoned strategy cannot return under a productive label.
      const changedStrategy = decision.findingIds.some(id => {
        const latest = strategies.findLast(item => item.findingIds.includes(id));
        return latest && latest.strategy !== decision.strategy;
      });
      if (recoveryContext(run).signals.some(s => s.findingIds.some(id => decision.findingIds.includes(id))
          && ["oscillation", "no-change", "finding-returned", "rejection-disputed"].includes(s.kind))
          || changedStrategy || repeats.some(item => item.contentHash === assignment.contentHash || item.evidence === decision.evidence)) {
        throw new Error("Productive continuation requires changed source and new progress evidence; it cannot waive a repeated failure or oscillation.");
      }
    } else if (repeats.length) {
      throw new Error("This recovery strategy already failed for these findings; diagnose a different cause or route the task.");
    }
  }
  if (route === "follow-up" && findings.some(f => inThreshold(f)
      && !decisions.some(d => d.id === f.id && d.status === "rejected" && !f.required))) {
    throw new Error("Reviewer noise cannot defer in-threshold defects or required acceptance/validation.");
  }
  if (route === "adjudicate" && (!findings.length || findings.some(f => f.required
      || !f.history.some(item => item.status === "rejected")))) throw new Error("Adjudication requires disputed, previously rejected code findings; it cannot waive required gates.");
  if (route === "adjudicate" && findings.some(f => currentAdjudication(run, f))) {
    throw new Error("An applicable adjudication is binding; changed code or claim evidence, or an explicit reopening, is required before another judge.");
  }
  const record = { ...decision, route, id: `recovery-${assignment.id}`, runId: run.id,
    assignmentId: assignment.id, fingerprint: assignment.fingerprint, contentHash: assignment.contentHash,
    round: run.round, pass: run.pass, signalIds: coveredSignals.map(item => item.id) };
  return record;
}
export function recordRecovery(run, record) {
  (run.recoveries ??= []).push(record);
  run.recovery = record;
}
export function findingAnchor(run, finding) {
  // Bind conservatively to all source and the claim's evidence. Source changes
  // anywhere can invalidate a contract assumption; absence is not resolution.
  return hash({ contentHash: run.expected.contentHash, contractHash: run.contractHash, answers: run.answers ?? [],
    key: finding.key, path: finding.path, title: finding.title, evidence: finding.reportEvidence ?? finding.evidence,
    newEvidence: finding.history.filter(item => item.event === "adjudication-reopened").map(item => item.evidence) });
}
export function currentAdjudication(run, finding) {
  return (run.adjudications ?? []).findLast(item => item.findingId === finding.id && item.anchor === findingAnchor(run, finding));
}
export function parkedRecovery(run, reason, code) {
  const budget = run.phase === "ROUND_LIMIT" || atRoundLimit(run) && /repair limit|repair rounds|round limit/i.test(reason);
  return { id: `recovery-${run.id}-${run.round}-${run.pass}-${code ?? run.phase}`, runId: run.id,
    diagnosis: budget ? "budget" : "execution-blocked", route: "park", evidence: reason,
    nextAction: budget ? "Preserve this attempt; resume only within an explicitly extended cumulative budget."
      : "Inspect the retained evidence and route the diagnosed cause; do not replay uncertain execution.",
    findingIds: Object.values(run.ledger).filter(f => !["fixed", "rejected"].includes(f.status)).map(f => f.id),
    fingerprint: run.fingerprint.fingerprint, contentHash: run.expected.contentHash,
    round: run.round, pass: run.pass, signalIds: recoveryContext(run).signals.map(item => item.id) };
}
