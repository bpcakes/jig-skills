import { readFileSync } from "node:fs";
import path from "node:path";

export function fixtureCursorKey(t) {
  const previous = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = "fixture-cursor-key";
  t.after(() => {
    if (previous === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previous;
  });
}

export function readEvidence(directory) {
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json")));
  const reviewed = [];
  const sections = [];
  for (let i = 1; i <= manifest.pageCount; i++) {
    const id = `page-${String(i).padStart(4, "0")}`;
    const page = JSON.parse(readFileSync(path.join(directory, `${id}.json`)));
    reviewed.push({ id: page.id, receipt: page.receipt });
    sections.push(page.textFragments.join(""));
  }
  return { text: sections.join("\n"), reviewed };
}

export function withCoverage(report, reviewed) {
  return `${report}\n<review-coverage>${JSON.stringify({ reviewed })}</review-coverage>`;
}

export function sendReport(provider, report, model = process.argv[process.argv.indexOf("--model") + 1]) {
  if (provider === "claude") {
    console.log(JSON.stringify({ type: "result", result: report, is_error: false }));
    return;
  }
  console.log(JSON.stringify({ type: "system", subtype: "init", model }));
  console.log(JSON.stringify({ type: "result", subtype: "success", result: report, is_error: false }));
}
