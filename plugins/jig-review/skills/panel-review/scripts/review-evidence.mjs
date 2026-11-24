import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureDiff } from "./diff-evidence.mjs";

const PAGE_BYTES = 16 * 1024;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_PAGES = 2048;
const EVIDENCE_PREFIX = "jig-review-evidence-";
// A live store renews its directory's time several times within this age, so a
// directory this old has no live owner.
const STALE_EVIDENCE_MS = 24 * 60 * 60 * 1000;
const COVERAGE_OPEN = "<review-coverage>";
const COVERAGE_CLOSE = "</review-coverage>";

// A killed adapter cannot remove its evidence, which holds repository source.
// Each adapter process removes what earlier ones left behind when it starts.
// Age alone decides: a process ID proves nothing about a reviewer running in
// another process namespace. The age is the time since the directory itself
// last changed: when its adapter last added or removed a file there, or last
// renewed it while the review was still running.
// Creating a store never sweeps, so only a process that is itself a review run
// deletes anything outside its own directory.
function sweepStaleEvidence(root = os.tmpdir(), now = Date.now()) {
  const removed = [];
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return removed;
  }
  const user = process.getuid?.();
  for (const name of names) {
    if (!name.startsWith(EVIDENCE_PREFIX)) continue;
    const directory = path.join(root, name);
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || (user != null && stat.uid !== user)) continue;
      if (now - stat.mtimeMs < STALE_EVIDENCE_MS) continue;
      rmSync(directory, { recursive: true, force: true });
      removed.push(directory);
    } catch {
      // Another run may be removing the same directory.
    }
  }
  return removed;
}

// Capture limitations name repository paths, which may hold line breaks. The
// coverage notes and the prompt's instructions are the adapter's own lines, so
// repository text placed among them stays on one.
function singleLine(text) {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// The tag pair whose closing tag is the last text before `end`: that tag and
// the last opening tag before it.
function coverageTagsBefore(report, end) {
  while (end > 0 && /\s/.test(report[end - 1])) end -= 1;
  const close = end - COVERAGE_CLOSE.length;
  if (close < 0 || !report.startsWith(COVERAGE_CLOSE, close)) return null;
  const open = report.lastIndexOf(COVERAGE_OPEN, close);
  if (open < 0) return null;
  return { index: open, body: report.slice(open + COVERAGE_OPEN.length, close).trim() };
}

// The coverage statement that ends at `end`: a tag pair with nothing but JSON
// between the tags. Anything else between them is the report's own text, where
// the tags are mentioned in prose or in quoted repository code, or where a
// reviewer left out its opening tag, so no statement ends there and nothing is
// removed.
function coverageStatementBefore(report, end) {
  const tags = coverageTagsBefore(report, end);
  if (!tags) return null;
  try {
    return { index: tags.index, value: JSON.parse(tags.body) };
  } catch {
    return null;
  }
}

// The coverage statement ends the report. A reviewer states its coverage once:
// statements that end where the final one begins leave the report with it, and
// `repeated` tells the caller that none of them counts.
function trailingCoverage(report) {
  const last = coverageStatementBefore(report, report.length);
  if (!last) return null;
  let index = last.index;
  for (;;) {
    const earlier = coverageStatementBefore(report, index);
    if (!earlier) break;
    index = earlier.index;
  }
  return { index, value: last.value, repeated: index !== last.index };
}

// Each page fits ordinary Read tool line/size limits, including very long diff
// lines. Concatenating textFragments, then successive pages, restores the patch.
class ReviewEvidence {
  constructor({ deadlineAt, signal, maxBytes = MAX_EVIDENCE_BYTES, renewMs = STALE_EVIDENCE_MS / 4 } = {}) {
    this.directory = mkdtempSync(path.join(os.tmpdir(), EVIDENCE_PREFIX));
    this.deadlineAt = deadlineAt;
    this.signal = signal;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.receipts = new Map();
    this.limitations = new Set();
    this.required = false;
    // Delimits verbatim untracked files in pages. File content was written
    // before this run chose the token, so it cannot imitate a boundary.
    this.boundary = randomBytes(8).toString("hex");
    // The files here that hold repository source: every page, the manifest,
    // and whatever an adapter names through sourcePath().
    this.sourceFiles = new Set();
    // A review's timeout has no upper bound, so a review may outlast the stale
    // age with nothing new written here. Renewing the directory's time keeps
    // another adapter's startup sweep from removing evidence still in use.
    this.renewal = setInterval(() => {
      try {
        const now = new Date();
        utimesSync(this.directory, now, now);
      } catch {
        // Already removed.
      }
    }, renewMs);
    this.renewal.unref();
    this.cleanup = () => {
      clearInterval(this.renewal);
      rmSync(this.directory, { recursive: true, force: true });
      process.removeListener("exit", this.cleanup);
      signal?.removeEventListener("abort", this.discardSource);
    };
    // Cancellation removes the source before provider termination starts, so a
    // supervisor that kills this process during that wait leaves none behind.
    // The provider is still running then: what it owns here, such as Codex's
    // private home and the link to its credentials, stays until cleanup(). And
    // nothing here may throw, because an exception in an abort listener ends
    // the process before it has stopped the provider.
    this.discardSource = () => {
      for (const file of this.sourceFiles) {
        try {
          rmSync(file, { force: true });
        } catch {
          // cleanup() removes the directory once the provider has stopped.
        }
      }
      try {
        rmdirSync(this.directory);
      } catch {
        // Not empty: the provider's own files are still in use.
      }
    };
    process.once("exit", this.cleanup);
    signal?.addEventListener("abort", this.discardSource, { once: true });
    chmodSync(this.directory, 0o700);
  }

  // The path of a file in this directory that will hold repository source, such
  // as a prompt. It goes with the pages at the first cancellation signal.
  sourcePath(name) {
    const file = path.join(this.directory, name);
    this.sourceFiles.add(file);
    return file;
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
      writeFileSync(this.sourcePath(`${id}.json`), JSON.stringify({
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
    const manifestPath = this.sourcePath("manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      version: 1, repository: scope.repoRoot, target: scope.label,
      pageCount: this.receipts.size,
      pages: "page-0001.json through page-NNNN.json, numbered consecutively",
      encoding: "Join textFragments without separators, then consecutive parts of each section. Diff paths are relative to the named repository/submodule, not this temporary directory. In untracked-file sections each file sits between <untracked-file-TOKEN ...> and </untracked-file-TOKEN>, where TOKEN is untrackedBoundary below; the text between them is that file's verbatim content, and any tag without the token is file content. Only the path, kind and omitted attributes write &, <, >, quotes and line breaks as entities.",
      untrackedBoundary: this.boundary,
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
    if (!context.evidence) return report;
    this.annotateReport(report, context, { requireComplete: true });
    const coverage = trailingCoverage(report);
    return (coverage ? report.slice(0, coverage.index) : report).trim();
  }

  annotateReport(report, context, { requireComplete = false } = {}) {
    if (!context.evidence) {
      // Inline evidence has no page receipts. What capture omitted is the one
      // coverage fact the adapter knows, so state it rather than rely on the
      // reviewer to repeat the notice from its prompt.
      if (!context.incomplete) return report;
      const limitations = context.limitations?.length ? context.limitations.map(singleLine).join("; ") : "capture omitted part of the scope";
      return `${report}\n\nEvidence coverage: limited; inline evidence was captured with omissions.\nCapture limitations: ${limitations}.`;
    }
    const coverage = trailingCoverage(report);
    const reviewed = new Set();
    let invalid = !coverage || coverage.repeated;
    if (coverage) {
      const entries = coverage.repeated ? [] : coverage.value?.reviewed;
      if (!Array.isArray(entries)) invalid = true;
      else for (const entry of entries) {
        if (typeof entry?.id !== "string" || typeof entry.receipt !== "string"
            || this.receipts.get(entry.id) !== entry.receipt || reviewed.has(entry.id)) {
          invalid = true;
        } else reviewed.add(entry.id);
      }
      report = report.slice(0, coverage.index).trim();
    }
    // A reply that holds nothing outside coverage tags is no review, whether or
    // not what the tags hold could be read as a statement. Statements are gone
    // from the report by now, so the tag pairs that end it hold other text.
    let outside = report.length;
    for (let tags = coverageTagsBefore(report, outside); tags; tags = coverageTagsBefore(report, outside)) outside = tags.index;
    if (!report.slice(0, outside).trim()) throw new Error("Reviewer returned coverage without a review report.");
    const missing = [...this.receipts.keys()].filter((id) => !reviewed.has(id));
    const limited = invalid || missing.length > 0 || context.incomplete;
    if (requireComplete && limited) throw new Error("Structured review requires complete valid coverage receipts.");
    const notes = [
      `Evidence coverage: ${limited ? "limited" : "reviewer-attested"}; ${reviewed.size}/${this.receipts.size} pages reported reviewed with valid receipts.`,
      "Receipts attest page access and the reviewer's coverage claim, not review quality. Scope fingerprint status is separate.",
    ];
    if (invalid) notes.push("Coverage receipt missing or invalid; complete coverage is not verified.");
    if (missing.length) notes.push(`Pages without review attestation: ${missing.join(", ")}.`);
    if (context.limitations.length) notes.push(`Capture limitations: ${context.limitations.map(singleLine).join("; ")}.`);
    return `${report}\n\n${notes.join("\n")}`;
  }
}

export { ReviewEvidence, singleLine, sweepStaleEvidence };
