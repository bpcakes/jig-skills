import assert from "node:assert/strict";
import test from "node:test";
import { createGitlinkCapture } from "../skills/comprehensive-review/scripts/gitlink-capture.mjs";

const oid = "a".repeat(40);
const file = Buffer.from(`100644 ${oid} 0\tordinary.txt\0`);
const link = Buffer.concat([
  Buffer.from(`160000 ${oid} 0\tspace tab\tnewline\n`),
  Buffer.from([0xff, 0]),
]);

test("gitlink capture preserves raw paths across every split in the input", () => {
  const input = Buffer.concat([file, link, file, link]);
  for (let split = 0; split <= input.length; split += 1) {
    const capture = createGitlinkCapture();
    capture.write(input.subarray(0, split));
    capture.write(input.subarray(split));
    assert.deepEqual(capture.finish(), Buffer.concat([link, link]), `split ${split}`);
  }
  const capture = createGitlinkCapture();
  for (const byte of input) capture.write(Buffer.from([byte]));
  assert.deepEqual(capture.finish(), Buffer.concat([link, link]));
});

test("ordinary records do not consume the retained gitlink budget", () => {
  const capture = createGitlinkCapture(link.length);
  for (let i = 0; i < 10000; i += 1) capture.write(file);
  capture.write(link);
  assert.deepEqual(capture.finish(), link);
});

test("gitlink capture bounds selected records and unfinished records", () => {
  const selected = createGitlinkCapture(link.length);
  selected.write(link);
  assert.throws(() => selected.write(link), { outputLimit: true });
  const unfinished = createGitlinkCapture(16);
  unfinished.write(Buffer.alloc(16, 65));
  assert.throws(() => unfinished.write(Buffer.from("A")), { outputLimit: true });
  assert.throws(() => createGitlinkCapture(16).write(file), { outputLimit: true });
});

test("gitlink capture rejects an unterminated final record", () => {
  const capture = createGitlinkCapture();
  capture.write(link.subarray(0, -1));
  assert.throws(
    () => capture.finish(),
    (error) => error.outputIncomplete === true
      && error.outputLimit == null
      && /unterminated index record/.test(error.message),
  );
  assert.deepEqual(createGitlinkCapture().finish(), Buffer.alloc(0));
});
