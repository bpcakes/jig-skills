import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { scanPath } from "../scripts/scan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");

test("finds representative TypeScript/React abstraction leak candidates", async () => {
  const result = await scanPath(path.join(fixtures, "leaky.tsx"));
  const ids = new Set(result.candidates.map((candidate) => candidate.ruleId));

  for (const expected of [
    "AP-TSR-104",
    "AP-TSR-201",
    "AP-TSR-203",
    "AP-TSR-204",
    "AP-TSR-205",
    "AP-TSR-206",
    "AP-TSR-207",
    "AP-TSR-301",
    "AP-TSR-302",
    "AP-TSR-304",
    "AP-TSR-401",
  ]) {
    assert(ids.has(expected), `expected candidate ${expected}`);
  }
});

test("does not flag normal controlled props or a private Context", async () => {
  const result = await scanPath(path.join(fixtures, "clean.tsx"));
  const ids = new Set(result.candidates.map((candidate) => candidate.ruleId));

  assert(!ids.has("AP-TSR-201"));
  assert(!ids.has("AP-TSR-203"));
  assert(!ids.has("AP-TSR-205"));
  assert(!ids.has("AP-TSR-206"));
});
