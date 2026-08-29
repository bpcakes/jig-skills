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
