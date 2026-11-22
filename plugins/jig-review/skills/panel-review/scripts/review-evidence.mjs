import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureDiff } from "./diff-evidence.mjs";

const PAGE_BYTES = 16 * 1024;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_PAGES = 2048;

// Each page fits ordinary Read tool line/size limits, including very long diff
// lines. Concatenating textFragments, then successive pages, restores the patch.
class ReviewEvidence {
  constructor({ deadlineAt, signal, maxBytes = MAX_EVIDENCE_BYTES, requireReceipts = false, isolatedWorkspace = false, omitEnvFiles = false } = {}) {
    this.root = mkdtempSync(path.join(os.tmpdir(), "jig-review-evidence-"));
    this.directory = isolatedWorkspace ? path.join(this.root, "workspace") : this.root;
    if (isolatedWorkspace) mkdirSync(this.directory, { mode: 0o700 });
    this.deadlineAt = deadlineAt;
    this.signal = signal;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.receipts = new Map();
    this.limitations = new Set();
    this.required = requireReceipts;
    this.omitEnvFiles = omitEnvFiles;
    this.cleanup = () => {
      rmSync(this.root, { recursive: true, force: true });
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

  startDiff(section) {
    const stream = this.start(section);
    const omit = (reason) => {
      this.required = true;
      this.limitations.add(`${section}: ${reason}`);
    };
    const diff = captureDiff({
      checkTime: () => this.checkTime(),
      omit,
      accept: (patch, label) => {
        // The provider reads evidence pages under new names. A Read(**/.env*)
        // rule on the provider alone cannot protect a patch copied to a page.
        // Check the full Git header, including either side of a rename.
        if (this.omitEnvFiles) {
          const nl = patch.indexOf(10);
          const header = patch.subarray(0, nl < 0 ? patch.length : nl).toString("utf8");
          if (/(?:^|[/" ])\.env/.test(header)) {
            omit(`${label}: credential-file patch excluded`);
            return;
          }
        }
        // Admit a whole file or none of it. A rejected file cannot consume the
        // remaining budget or stop Git before later file patches arrive.
        if (patch.length > this.maxBytes - this.bytes) {
          omit(`${label}: file patch omitted (evidence byte limit reached)`);
          return;
        }
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(patch);
        } catch {
          omit(`${label}: non-UTF-8 file patch omitted`);
          return;
        }
        try {
          stream.write(patch);
        } catch (error) {
          if (!error.evidenceLimit) throw error;
        }
      },
    });
    return {
      write: diff.write,
      end: () => {
        diff.end();
        try {
          stream.end();
        } catch (error) {
          if (!error.evidenceLimit) throw error;
        }
      },
    };
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

  requireComplete(context) {
    if (context.incomplete) throw Object.assign(
      new Error("Incomplete review evidence cannot produce a complete structured review."),
      { code: "INCOMPLETE_REVIEW_EVIDENCE" },
    );
  }

  structuredReport(report, context) {
    this.requireComplete(context);
    if (!context.evidence) throw new Error("Structured review requires evidence coverage receipts.");
    this.annotateReport(report, context, { requireComplete: true });
    return report.replace(/<review-coverage>\s*[\s\S]*?<\/review-coverage>\s*$/, "").trim();
  }

  annotateReport(report, context, { requireComplete = false, requireReviewedPage = false } = {}) {
    if (!context.evidence) return context.incomplete
      ? `${report}\n\nEvidence coverage: limited. ${(context.limitations ?? []).join(" ")}` : report;
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
    const limited = invalid || reviewed.size === 0 || missing.length > 0 || context.incomplete;
    if (requireReviewedPage && reviewed.size === 0) {
      throw Object.assign(new Error(`No review: evidence coverage limited; 0/${this.receipts.size} pages verified.`),
        { code: "INCOMPLETE_REVIEW_EVIDENCE" });
    }
    // Use the existing panel report contract as positive evidence. A model
    // can open every page, quote its receipts, and still decline to review.
    if (requireReviewedPage) {
      const body = report.replaceAll("**", "");
      // Cursor's result can join progress text directly to the final bullet.
      const finding = /(?:[-*]|\d+[.)])\s+\[(?:critical|high|medium|low)\]\s+\[[^\]\n]+\]\s+\S/i;
      const clean = /(?:^|[.!?\n])\s*(?:[-*#]+\s*)?(?:(?:I (?:found|identified) |there (?:are|were) )?no (?:actionable |substantive )?(?:findings|issues|defects)\b|findings:\s*none\b)/i;
      if (!finding.test(body) && !clean.test(body)) throw Object.assign(
        new Error("No review: evidence was accessed without a finding or an explicit no-findings conclusion."),
        { code: "INCOMPLETE_REVIEW_EVIDENCE" },
      );
    }
    if (requireComplete && limited) throw Object.assign(
      new Error("No review: structured review requires complete valid coverage receipts."),
      { code: "INCOMPLETE_REVIEW_EVIDENCE" },
    );
    this.coverage = limited ? "limited" : "reviewer-attested";
    const notes = [
      `Evidence coverage: ${this.coverage}; ${reviewed.size}/${this.receipts.size} pages reported reviewed with valid receipts.`,
      "Receipts attest page access and the reviewer's coverage claim, not review quality. Scope fingerprint status is separate.",
    ];
    if (invalid) notes.push("Coverage receipt missing or invalid; complete coverage is not verified.");
    if (missing.length) notes.push(`Pages without review attestation: ${missing.join(", ")}.`);
    if (context.limitations.length) notes.push(`Capture limitations: ${context.limitations.join("; ")}.`);
    return `${report}\n\n${notes.join("\n")}`;
  }
}

export { ReviewEvidence };
