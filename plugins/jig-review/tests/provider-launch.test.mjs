import assert from "node:assert/strict";
import test from "node:test";

import {
  PARENT_SESSION_VARIABLES,
  childEnvironment,
  launchExecutable,
  normalizeLauncher,
  preflightExecutables,
  resolveProviderLaunch,
} from "../skills/comprehensive-review/scripts/provider-launch.mjs";

test("launcher values normalize to none, auto, or a Jig home", () => {
  assert.equal(normalizeLauncher(null), "none");
  assert.equal(normalizeLauncher(undefined), "none");
  assert.equal(normalizeLauncher(" auto "), "auto");
  assert.equal(normalizeLauncher("none"), "none");
  assert.equal(normalizeLauncher("home:work"), "home:work");
  assert.equal(normalizeLauncher("home:~/.claude-work"), "home:~/.claude-work");
  assert.throws(() => normalizeLauncher("", "--claude-launcher"), /--claude-launcher must not be blank/);
  assert.throws(() => normalizeLauncher("home:"), /requires a Jig home name or path/);
  assert.throws(() => normalizeLauncher("home:-x"), /must not begin with -/);
  assert.throws(() => normalizeLauncher("home:a\nb"), /single name or path/);
  assert.throws(() => normalizeLauncher("picker"), /Use none, auto, or home:<name>/);
});

test("launch resolution forwards adapter arguments exactly after the Jig launch command", () => {
  const args = ["-p", "--output-format", "json"];
  assert.deepEqual(
    resolveProviderLaunch({ provider: "claude", launcher: "none", executable: "claude", args, inherited: {} }),
    { command: "claude", args, launcher: "none" },
  );
  assert.deepEqual(
    resolveProviderLaunch({ provider: "claude", launcher: "auto", executable: "claude", args, inherited: {} }),
    { command: "jig", args: ["claude", "launch", "--auto", "--", ...args], launcher: "auto" },
  );
  assert.deepEqual(
    resolveProviderLaunch({ provider: "codex", launcher: "home:work", executable: "codex", args: ["exec", "-"], inherited: { JIG_LAUNCHER_BIN: "/opt/jig" } }),
    { command: "/opt/jig", args: ["codex", "launch", "work", "--", "exec", "-"], launcher: "home:work" },
  );
  assert.equal(
    resolveProviderLaunch({ provider: "codex", launcher: "auto", executable: "codex", args: [], inherited: { JIG_LAUNCHER_BIN: "/opt/jig" }, jigBin: "/tmp/jig" }).command,
    "/tmp/jig",
  );
  assert.throws(
    () => resolveProviderLaunch({ provider: "cursor", launcher: "auto", executable: "cursor-agent", args: [], inherited: {} }),
    /support Claude and Codex, not cursor/,
  );
  assert.throws(
    () => resolveProviderLaunch({ provider: "claude", launcher: "auto", executable: "claude", args: [], inherited: { JIG_LAUNCHER_BIN: " " } }),
    /JIG_LAUNCHER_BIN must not be blank/,
  );
});

test("preflight resolves the executable a launch will start", () => {
  assert.equal(launchExecutable("claude", "none", "claude", {}), "claude");
  assert.equal(launchExecutable("claude", "auto", "claude", {}), "jig");
  assert.equal(launchExecutable("codex", "home:work", "codex", { JIG_LAUNCHER_BIN: "/opt/jig" }), "/opt/jig");
  assert.equal(launchExecutable("cursor", "none", "cursor-agent", {}), "cursor-agent");
  assert.throws(() => launchExecutable("cursor", "auto", "cursor-agent", {}), /not cursor/);
});

test("preflight lists every executable a bundled launch needs", () => {
  assert.deepEqual(preflightExecutables("claude", "none", "claude", {}), ["claude"]);
  assert.deepEqual(preflightExecutables("codex", "none", "codex", {}), ["codex"]);
  assert.deepEqual(preflightExecutables("claude", "auto", "claude", {}), ["jig"]);
  assert.deepEqual(preflightExecutables("codex", "auto", "codex", { JIG_LAUNCHER_BIN: "/opt/jig" }), ["/opt/jig", "codex"], "the Codex adapter renders with codex before Jig launches it");
  assert.throws(() => preflightExecutables("cursor", "auto", "cursor-agent", {}), /not cursor/);
});

test("child environment drops parent session markers but keeps provider configuration", () => {
  const inherited = Object.fromEntries(PARENT_SESSION_VARIABLES.map((name) => [name, "parent"]));
  Object.assign(inherited, {
    PATH: "/usr/bin",
    CLAUDE_CONFIG_DIR: "/home/user/.claude-work",
    CLAUDE_CODE_OAUTH_TOKEN: "token",
    CODEX_HOME: "/home/user/.codex-work",
    ANTHROPIC_API_KEY: "key",
  });
  const environment = childEnvironment(inherited, { CLAUDE_CONFIG_DIR: "/tmp/profile", CODEX_HOME: null });
  for (const name of PARENT_SESSION_VARIABLES) assert.equal(environment[name], undefined, name);
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.CLAUDE_CONFIG_DIR, "/tmp/profile");
  assert.equal(environment.CLAUDE_CODE_OAUTH_TOKEN, "token");
  assert.equal(environment.ANTHROPIC_API_KEY, "key");
  assert.equal(Object.hasOwn(environment, "CODEX_HOME"), false);
  assert.equal(inherited.CLAUDECODE, "parent", "the inherited object is not mutated");
});
