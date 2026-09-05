import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PAGE_BYTES = 16 * 1024;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_PAGES = 2048;

// Each page fits ordinary Read tool line/size limits, including very long diff
// lines. Concatenating textFragments, then successive pages, restores the patch.
class ReviewEvidence {
  constructor({ deadlineAt, signal, maxBytes = MAX_EVIDENCE_BYTES } = {}) {
    this.directory = mkdtempSync(path.join(os.tmpdir(), "jig-review-evidence-"));
    this.deadlineAt = deadlineAt;
    this.signal = signal;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.receipts = new Map();
    this.limitations = new Set();
    this.required = false;
    this.cleanup = () => {
      rmSync(this.directory, { recursive: true, force: true });
      process.removeListener("exit", this.cleanup);
    };
    process.once("exit", this.cleanup);
    chmodSync(this.directory, 0o700);
  }

  checkTime() {
    if (this.signal?.aborted) throw this.signal.reason ?? new Error("Evidence capture cancelled");
    if (this.deadlineAt != null && Date.now() >= this.deadlineAt) {
      throw Object.assign(new Error("Evidence capture exceeded the adapter deadline"), { timedOut: true });
    }
  }

  start(section) {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let pending = Buffer.alloc(0);
    let part = 0;
    let failed = false;
    const omit = (reason) => {
      failed = true;
      this.required = true;
      this.limitations.add(`${section}: ${reason}`);
      return Object.assign(new Error(reason), { evidenceLimit: true });
    };
    const flush = (final = false) => {
      if (!pending.length && !final) return;
      if (this.receipts.size >= MAX_EVIDENCE_PAGES) throw omit("evidence page limit reached");
      let text;
      try {
        text = decoder.decode(pending, { stream: !final });
      } catch {
        throw omit("non-UTF-8 evidence omitted");
      }
      pending = Buffer.alloc(0);
      if (!text) return;
      const id = `page-${String(this.receipts.size + 1).padStart(4, "0")}`;
      const receipt = randomBytes(12).toString("hex");
      const textFragments = [];
      for (let offset = 0; offset < text.length; offset += 200) {
        textFragments.push(text.slice(offset, offset + 200));
      }
      writeFileSync(path.join(this.directory, `${id}.json`), JSON.stringify({
        id, section, part: ++part, textFragments, receipt,
      }, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
      this.receipts.set(id, receipt);
    };
    return {
      write: (chunk) => {
        this.checkTime();
        if (failed) return;
        for (let offset = 0; offset < chunk.length;) {
          const size = Math.min(PAGE_BYTES - pending.length, chunk.length - offset,
            this.maxBytes - this.bytes);
          if (size <= 0) {
            flush();
            throw omit("evidence byte limit reached");
          }
          pending = Buffer.concat([pending, chunk.subarray(offset, offset + size)]);
          offset += size;
          this.bytes += size;
          if (pending.length === PAGE_BYTES) flush();
        }
      },
      end: () => {
        this.checkTime();
        if (!failed) flush(true);
      },
    };
  }

  add(section, text) {
    if (!text) return;
    const stream = this.start(section);
    try {
      stream.write(Buffer.from(text));
      stream.end();
    } catch (error) {
      if (!error.evidenceLimit) throw error;
    }
  }

  finish(scope, context) {
    if (!this.required) return context;
    this.checkTime();
    const limitations = [...new Set([...context.limitations, ...this.limitations])];
    const manifestPath = path.join(this.directory, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      version: 1, repository: scope.repoRoot, target: scope.label,
      pageCount: this.receipts.size,
      pages: "page-0001.json through page-NNNN.json, numbered consecutively",
      encoding: "Join textFragments without separators, then consecutive parts of each section. Diff paths are relative to the named repository/submodule, not this temporary directory.",
      captureComplete: limitations.length === 0, limitations,
    }, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
    return {
      ...context,
      // Do not send a near-limit preview AND ask the model to read it again in
      // pages. The manifest is the entrypoint for every section in this mode.
      text: "[Review evidence is in the paged manifest supplied above.]",
      incomplete: limitations.length > 0, truncated: limitations.length > 0,
      limitations, evidence: { manifestPath, pageCount: this.receipts.size },
    };
  }

  annotateReport(report, context) {
    if (!context.evidence) return report;
    const match = report.match(/<review-coverage>\s*([\s\S]*?)\s*<\/review-coverage>\s*$/);
    const reviewed = new Set();
    let invalid = !match;
    if (match) {
      try {
        const entries = JSON.parse(match[1]).reviewed;
        if (!Array.isArray(entries)) throw new Error("Missing reviewed pages");
        for (const entry of entries) {
          if (typeof entry?.id !== "string" || typeof entry.receipt !== "string"
              || this.receipts.get(entry.id) !== entry.receipt || reviewed.has(entry.id)) {
            invalid = true;
          } else reviewed.add(entry.id);
        }
      } catch { invalid = true; }
      report = report.slice(0, match.index).trim();
    }
    if (!report) throw new Error("Reviewer returned coverage without a review report.");
    const missing = [...this.receipts.keys()].filter((id) => !reviewed.has(id));
    const limited = invalid || missing.length > 0 || context.incomplete;
    const notes = [
      `Evidence coverage: ${limited ? "limited" : "reviewer-attested"}; ${reviewed.size}/${this.receipts.size} pages reported reviewed with valid receipts.`,
      "Receipts attest page access and the reviewer's coverage claim, not review quality. Scope fingerprint status is separate.",
    ];
    if (invalid) notes.push("Coverage receipt missing or invalid; complete coverage is not verified.");
    if (missing.length) notes.push(`Pages without review attestation: ${missing.join(", ")}.`);
    if (context.limitations.length) notes.push(`Capture limitations: ${context.limitations.join("; ")}.`);
    return `${report}\n\n${notes.join("\n")}`;
  }
}

export { ReviewEvidence };
