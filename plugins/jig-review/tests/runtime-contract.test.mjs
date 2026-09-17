import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runtimePath = fileURLToPath(new URL(
  "../skills/comprehensive-review/references/parallel-review-runtime.md",
  import.meta.url,
));
const skillPath = fileURLToPath(new URL(
  "../skills/comprehensive-review/SKILL.md",
  import.meta.url,
));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadForwarderRecipe(runtime) {
  const match = runtime.match(/```javascript\n([\s\S]*?)\n```/);
  assert.ok(match, "runtime must contain an executable JavaScript forwarder recipe");
  const source = match[1]
    .replace("RESOLVED_SHELL_QUOTED_COMMAND", JSON.stringify("node fake-adapter.mjs"))
    .replace("RESOLVED_REPOSITORY_DIRECTORY", JSON.stringify("/review/repository"));
  return new AsyncFunction("tools", "text", source);
}

test("external forwarder contract preserves and polls yielded process handles", async () => {
  const runtime = readFileSync(runtimePath, "utf8");
  const recipe = loadForwarderRecipe(runtime);
  const calls = [];
  let report = null;

  await recipe(
    {
      async exec_command(options) {
        calls.push(["exec", options]);
        return { output: "", session_id: 73 };
      },
      async write_stdin(options) {
        calls.push(["poll", options]);
        if (calls.length === 2) {
          return { output: "delayed ", session_id: 73 };
        }
        return { output: "review report", exit_code: 0 };
      },
    },
    (output) => {
      report = output;
    },
  );

  assert.equal(calls.filter(([kind]) => kind === "exec").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "poll").length, 2);
  assert.deepEqual(calls.slice(1).map(([, options]) => options.session_id), [73, 73]);
  assert.equal(report, "delayed review report");
  assert.match(runtime, /never as a command timeout/);
  assert.match(runtime, /wait on that same outer cell until it completes/);
});

test("empty forwarder output cannot trigger an unaccounted provider retry", async () => {
  const runtime = readFileSync(runtimePath, "utf8");
  const skill = readFileSync(skillPath, "utf8");
  const recipe = loadForwarderRecipe(runtime);

  await assert.rejects(
    recipe(
      {
        async exec_command() {
          return { output: "", exit_code: 0 };
        },
        async write_stdin() {
          assert.fail("terminal launch must not be polled");
        },
      },
      () => assert.fail("empty output must not be returned as a review"),
    ),
    /without a review report/,
  );

  assert.match(runtime, /adapter exited successfully without a review report/);
  assert.match(runtime, /Never retry an external reviewer merely because its forwarder returned empty/);
  assert.match(runtime, /duplicate billable provider run/);
  assert.match(skill, /Treat an empty external-forwarder response as a transport failure/);
  assert.match(skill, /duplicate billable provider work/);
});

test("review exclusion contract reaches every reviewer and verification pass", () => {
  const runtime = readFileSync(runtimePath, "utf8");
  const skill = readFileSync(skillPath, "utf8");

  assert.match(skill, /scope-fingerprint\.mjs[^\n]+\[--exclude-path <path>\]\.{3}/);
  assert.match(skill, /Pass the same explicit exclusion arguments to every selected reviewer/);
  assert.match(runtime, /claude-review\.mjs[^\n]+\[--exclude-path <path>\]\.{3}/);
  assert.match(runtime, /cursor-review\.mjs[^\n]+\[--exclude-path <path>\]\.{3}/);
  assert.match(runtime, /rerun the fingerprint helper with the same concrete arguments and every explicit exclusion/);
  assert.match(runtime, /branch cannot hide its own files|cannot hide itself|cannot hide/i);
});

test("combined branch scope has deterministic normalization and index warnings", () => {
  const runtime = readFileSync(runtimePath, "utf8");
  const skill = readFileSync(skillPath, "utf8");

  for (const contract of [runtime, skill]) {
    assert.match(contract, /Reject `--scope auto` combined with `--include-working-tree` before inspecting/);
    assert.match(contract, /workingTreePathsDifferingFromIndex/);
    assert.match(contract, /workingTreePathsAbsentFromIndex/);
    assert.match(contract, /dirtySubmodulePaths/);
    assert.match(contract, /pathInventoryComplete/);
    assert.match(contract, /`Count`/);
    assert.match(contract, /`Truncated`/);
    assert.match(contract, /capped/);
    assert.match(contract, /re-stage tracked paths/);
    assert.match(contract, /add (?:intended )?untracked paths/);
    assert.match(contract, /commit changes inside (?:each )?dirty submodule/);
  }
});
