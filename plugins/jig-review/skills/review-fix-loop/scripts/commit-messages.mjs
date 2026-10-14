export function normalizeCommitMessage(value, field = "commitMessage") {
  if (typeof value !== "string") throw new Error(`${field} must be a nonempty commit message.`);
  const message = value.replace(/\r\n/g, "\n").trim();
  if (!message || /[\x00-\x08\x0b-\x1f\x7f]/.test(message)) throw new Error(`${field} must be nonempty and contain no control characters.`);
  const lines = message.split("\n");
  if (lines.length > 1 && lines[1].trim() !== "") throw new Error(`${field} must separate the subject and body with a blank line.`);
  return message;
}

export function roundCommitMessage(run, contract) {
  // Recovery must publish the exact message frozen with the prepared tree.
  if (run.commitJournal) return run.commitJournal.message;
  const repair = run.mutations.findLast(mutation => mutation.round === run.round);
  if (repair?.commitMessage !== undefined) return normalizeCommitMessage(repair.commitMessage);
  if (!repair && contract.baselineCommitMessage !== undefined) return normalizeCommitMessage(contract.baselineCommitMessage, "baselineCommitMessage");

  // Older adapters and saved candidates may omit authored messages. Describe
  // their accepted edits rather than copying a finding or inventing a type.
  const edits = repair?.attributions ?? [];
  const description = (edits[0]?.reason ?? contract.goal).replace(/\s+/g, " ").trim();
  const subject = description.length <= 72 ? description : `${description.slice(0, 69).trimEnd()}...`;
  const body = edits.length ? edits.map(edit => `${edit.path}: ${edit.reason}`).join("\n")
    : subject === description ? "" : contract.goal;
  return normalizeCommitMessage(`${subject}${body ? `\n\n${body}` : ""}`);
}
