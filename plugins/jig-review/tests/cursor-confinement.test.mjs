import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { captureFingerprint } from "../skills/panel-review/scripts/scope-fingerprint.mjs";

const cli = fileURLToPath(new URL("../skills/panel-review/scripts/cursor-review.mjs", import.meta.url));
const fixtureModule = new URL("./fixtures/provider-evidence.mjs", import.meta.url).href;

test("Cursor confines a review with unrestricted parent settings and unrelated credentials", async t => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "jig-cursor-confinement-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = path.join(directory, "checkout");
  const home = path.join(directory, "host-home");
  const config = path.join(home, ".cursor");
  const data = path.join(home, ".local", "share", "cursor");
  mkdirSync(config, { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(path.join(repo, ".cursor"), { recursive: true });
  const ambient = { version: 1, sandbox: { mode: "disabled" }, approvalMode: "unrestricted",
    permissions: { allow: ["Shell(*)", "Write(**)", "Mcp(*:*)"], deny: [] } };
  writeFileSync(path.join(config, "cli-config.json"), JSON.stringify(ambient));
  const mcp = JSON.stringify({ mcpServers: { fixtureAmbientServer: { command: "synthetic-unused-command" } } });
  writeFileSync(path.join(config, "mcp.json"), mcp);
  writeFileSync(path.join(repo, ".cursor", "mcp.json"), mcp);
  writeFileSync(path.join(repo, "value.txt"), "initial value\n");
  const git = (...args) => execFileSync("git", args, { cwd: repo });
  git("init", "-q"); git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline");
  writeFileSync(path.join(repo, "value.txt"), "review this change\n");
  const pinned = await captureFingerprint({ cwd: repo, scope: "working-tree" });
  const capture = path.join(directory, "capture.json");
  const stub = path.join(directory, "cursor-stub.mjs");
  writeFileSync(stub, `#!${process.execPath}
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readEvidence, sendReport, withCoverage } from ${JSON.stringify(fixtureModule)};
const env = process.env;
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const workspace = realpathSync(value("--workspace"));
const configuration = path.join(env.CURSOR_CONFIG_DIR, "cli-config.json");
const assignment = value("--add-dir");
const paged = existsSync(path.join(assignment, "manifest.json"));
const evidence = paged ? readEvidence(assignment)
  : { text: readFileSync(path.join(assignment, "review-prompt.md"), "utf8"), reviewed: [] };
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  args, env, cwd: process.cwd(), workspace, evidence: evidence.text,
  mcp: JSON.parse(readFileSync(path.join(env.CURSOR_CONFIG_DIR, "mcp.json"))),
  config: JSON.parse(readFileSync(configuration)), configMode: statSync(configuration).mode & 0o777,
  directoryModes: [env.HOME, env.CURSOR_DATA_DIR, env.CURSOR_CONFIG_DIR, workspace].map(dir => statSync(dir).mode & 0o777),
  seesCheckout: existsSync(path.join(workspace, ".git")) || existsSync(path.join(workspace, "value.txt")),
  seesParentMcp: [env.CURSOR_CONFIG_DIR, path.join(env.HOME, ".cursor"), path.join(workspace, ".cursor")]
    .some(dir => existsSync(path.join(dir, "mcp.json")) && readFileSync(path.join(dir, "mcp.json"), "utf8").includes("fixtureAmbientServer")),
}));
const result = paged ? withCoverage("Fixture review complete. No actionable findings.", evidence.reviewed) : "Fixture review complete.";
if (value("--output-format") === "stream-json") sendReport("cursor", result, "fixture-actual-model");
else console.log(result);
`, { mode: 0o700 });
  const foreign = {
    ANTHROPIC_API_KEY: "fixture-claude", OPENAI_API_KEY: "fixture-openai", GITHUB_TOKEN: "fixture-github",
    AWS_SESSION_TOKEN: "fixture-cloud", SSH_AUTH_SOCK: "/fake/ssh.sock", ORCHESTRATION_CREDENTIAL_FILE: "/fake/orchestrator",
    CURSOR_UNRECOGNIZED_SETTING: "future-override", JIG_TEST_CAPTURE: capture, ORDINARY_VARIABLE: "canary",
  };
  const launchWith = (overrides, ...args) => spawnSync(process.execPath, [cli, "--cwd", repo, "--scope", "working-tree",
    "--expected-fingerprint", pinned.fingerprint, "--model", "fixture-model", "--timeout-ms", "15000",
    ...args], {
    encoding: "utf8", timeout: 20000,
    env: { PATH: process.env.PATH, TMPDIR: directory, HOME: home, CURSOR_CONFIG_DIR: config, CURSOR_DATA_DIR: data, CURSOR_API_KEY: "fixture-cursor",
      JIG_CURSOR_BIN: stub, ...foreign, ...overrides },
  });
  const launch = (...args) => launchWith({}, ...args);
  // The default invocation and stub support the previous text transport, so
  // this regression comparison reaches the provider on either adapter.
  const launched = launch();
  assert.equal(launched.status, 0, launched.stderr);
  const observed = JSON.parse(readFileSync(capture));
  assert.match(observed.evidence, /\+review this change/);
  await t.test("private configuration overrides an unrestricted host", () => {
    assert.equal(observed.config.sandbox.mode, "enabled");
    assert.equal(observed.config.approvalMode, "allowlist");
    assert.equal(observed.config.sandbox.readBoundary, "workspace");
    assert.deepEqual(observed.config.permissions.allow, []);
    assert.notEqual(observed.env.HOME, home);
    assert.notEqual(observed.env.CURSOR_CONFIG_DIR, config);
    assert.notEqual(observed.env.CURSOR_DATA_DIR, data);
    assert.deepEqual(observed.directoryModes.map(mode => mode & 0o077), [0, 0, 0, 0]);
    assert.equal(observed.configMode & 0o077, 0);
    for (const rule of ["Shell(*)", "Write(**)", "Read(**/.env*)", `Read(${path.join(home, ".ssh")}/**)`, `Read(${config}/**)`]) {
      assert.ok(observed.config.permissions.deny.includes(rule), rule);
    }
  });
  await t.test("ambient MCP servers are absent and MCP tools are denied", () => {
    assert.deepEqual(observed.mcp.mcpServers, {});
    assert.ok(observed.config.permissions.deny.includes("Mcp(*:*)"));
    assert.equal(observed.seesParentMcp, false);
    assert.ok(!observed.args.some(arg => ["--approve-mcps", "--force", "--yolo"].includes(arg)));
  });
  await t.test("the working directory and workspace roots expose only private evidence", () => {
    assert.notEqual(observed.cwd, repo);
    assert.notEqual(observed.workspace, repo);
    assert.equal(observed.cwd, observed.workspace);
    assert.equal(observed.seesCheckout, false);
    const directories = observed.args.filter((_, i, args) => ["--add-dir", "--workspace"].includes(args[i - 1]));
    assert.ok(directories.length > 0);
    assert.ok(directories.every(dir => path.resolve(dir) === path.resolve(observed.args[observed.args.indexOf("--workspace") + 1])));
    for (const dir of [observed.workspace, observed.env.HOME, observed.env.CURSOR_CONFIG_DIR, observed.env.CURSOR_DATA_DIR]) {
      assert.equal(existsSync(dir), false, dir);
    }
  });
  await t.test("only Cursor authentication reaches the provider", () => {
    assert.equal(observed.env.CURSOR_API_KEY, "fixture-cursor");
    assert.deepEqual(Object.keys(foreign).filter(key => observed.env[key] !== undefined), []);
  });
  await t.test("the successful report records the reported model and effective policy", () => {
    assert.match(launched.stdout, /Fixture review complete\./);
    assert.match(launched.stdout, /Evidence coverage: reviewer-attested; [1-9]\d*\/[1-9]\d*/);
    const metaPath = launched.stdout.match(/^Metadata: (.+)$/m)?.[1];
    assert.ok(metaPath, "the report identifies the metadata artifact");
    const metadata = JSON.parse(readFileSync(metaPath));
    assert.equal(metadata.model, "fixture-actual-model");
    assert.equal(metadata.requestedModel, "fixture-model");
    assert.equal(metadata.approvalMode, "allowlist");
    assert.equal(metadata.sandboxMode, "enabled");
    assert.equal(metadata.confinement, "restricted");
  });
  await t.test("explicit host mode reports the borrowed policy and keeps MCP disabled", () => {
    const hostMetaFile = path.join(directory, "host.meta.json");
    const optOut = launch("--file-access", "host", "--meta-file", hostMetaFile);
    assert.equal(optOut.status, 0, optOut.stderr);
    assert.match(optOut.stdout, /unconfined/i);
    const host = JSON.parse(readFileSync(capture));
    const hostMetadata = JSON.parse(readFileSync(hostMetaFile));
    assert.equal(hostMetadata.confinement, "unconfined");
    assert.equal(hostMetadata.approvalMode, "unrestricted");
    assert.equal(hostMetadata.sandboxMode, "disabled");
    assert.equal(host.config.approvalMode, "unrestricted");
    assert.equal(host.config.sandbox.mode, "disabled");
    assert.ok(host.config.permissions.deny.includes("Mcp(*:*)"));
    assert.equal(host.seesParentMcp, false);
    assert.equal(host.seesCheckout, false);
    for (const key of Object.keys(foreign)) assert.equal(host.env[key], undefined, key);
  });
  await t.test("a custom executable without an explicit credential never starts", () => {
    rmSync(capture);
    const result = launchWith({ CURSOR_API_KEY: "" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /authentication required for private configuration/);
    assert.equal(existsSync(capture), false);
  });
  assert.deepEqual(JSON.parse(readFileSync(path.join(config, "cli-config.json"))), ambient);
});
