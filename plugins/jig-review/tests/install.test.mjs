import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const installer = path.join(repo, "scripts/install.sh");

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jig-install-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "skills with spaces");
  return {
    destination,
    install: (...args) => spawnSync("sh", [installer, "codex", "--dest", destination, ...args], {
      cwd: directory,
      encoding: "utf8",
    }),
  };
}

function assertInstalledParser(destination) {
  const result = JSON.parse(execFileSync(process.execPath, [
    path.join(destination, "review-fix-loop/scripts/loop-options.mjs"),
    "--all-reviewers", "--fix-mode", "comprehensive", "--max-rounds", "1",
  ], { encoding: "utf8" }));
  assert.deepEqual(result.review.reviewers, ["claude", "codex", "cursor"]);
  assert.equal(result.fixMode, "comprehensive");
  assert.equal(result.maxRounds, 1);
}

test("fresh direct installation includes a usable review dependency", (t) => {
  const { destination, install } = fixture(t);
  const result = install("review-fix-loop");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Required dependency: comprehensive-review/);
  assertInstalledParser(destination);
});

test("differing dependencies fail before modifying either skill", async (t) => {
  for (const args of [
    ["review-fix-loop"],
    ["--force", "review-fix-loop"],
    ["comprehensive-review", "review-fix-loop"],
  ]) {
    await t.test(args.join(" "), (t) => {
      const { destination, install } = fixture(t);
      const dependency = path.join(destination, "comprehensive-review");
      const loop = path.join(destination, "review-fix-loop");
      mkdirSync(dependency, { recursive: true });
      mkdirSync(loop);
      writeFileSync(path.join(dependency, "local.md"), "older customized dependency\n");
      writeFileSync(path.join(loop, "local.md"), "existing loop\n");
      const result = install(...args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /differs from this checkout/);
      assert.match(result.stderr, /No skills were changed/);
      assert.equal(readFileSync(path.join(dependency, "local.md"), "utf8"), "older customized dependency\n");
      assert.equal(readFileSync(path.join(loop, "local.md"), "utf8"), "existing loop\n");
      assert.equal(existsSync(path.join(loop, "SKILL.md")), false);
    });
  }
});

test("a matching automatic dependency survives --force on the selected loop", (t) => {
  const { destination, install } = fixture(t);
  assert.equal(install("review-fix-loop").status, 0);
  const dependency = path.join(destination, "comprehensive-review");
  const identity = statSync(dependency);
  writeFileSync(path.join(destination, "review-fix-loop/local.md"), "replace selected loop\n");
  const result = install("--force", "review-fix-loop");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Keeping matching dependency/);
  assert.equal(statSync(dependency).ino, identity.ino);
  assert.equal(statSync(dependency).ctimeMs, identity.ctimeMs);
  assert.equal(existsSync(path.join(destination, "review-fix-loop/local.md")), false);
  assertInstalledParser(destination);
});

test("explicit --force replacement updates both selected skills", (t) => {
  const { destination, install } = fixture(t);
  assert.equal(install("review-fix-loop").status, 0);
  const customized = path.join(destination, "comprehensive-review/local.md");
  writeFileSync(customized, "custom copy\n");
  const result = install("--force", "review-fix-loop", "comprehensive-review");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(customized), false);
  assertInstalledParser(destination);
});

test("a differing dependency cannot leave a newly installed loop behind", (t) => {
  const { destination, install } = fixture(t);
  assert.equal(install("comprehensive-review").status, 0);
  writeFileSync(path.join(destination, "comprehensive-review/scripts/review-options.mjs"), "throw new Error('old parser');\n");
  const result = install("review-fix-loop");
  assert.equal(result.status, 1);
  assert.equal(existsSync(path.join(destination, "review-fix-loop")), false);
});

test("all-skills installs include the Codex loop and filter Claude orchestration skills", (t) => {
  const { destination, install } = fixture(t);
  const codex = install();
  assert.equal(codex.status, 0, codex.stderr);
  assertInstalledParser(destination);
  const claudeDestination = path.join(destination, "claude-skills");
  const claude = spawnSync("sh", [installer, "claude", "--dest", claudeDestination], { encoding: "utf8" });
  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(existsSync(path.join(claudeDestination, "review-fix-loop")), false);
  assert.equal(existsSync(path.join(claudeDestination, "comprehensive-review")), false);
  assert.equal(existsSync(path.join(claudeDestination, "rust-error-handling-review/SKILL.md")), true);
  const rejected = spawnSync("sh", [installer, "claude", "--dest", claudeDestination, "review-fix-loop"], { encoding: "utf8" });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Unsupported for Claude direct install: review-fix-loop/);
});

test("all-skills installs skip an incompatible loop and preserve existing copies", async (t) => {
  for (const existingLoop of [false, true]) {
    await t.test(existingLoop ? "existing loop" : "new loop", (t) => {
      const { destination, install } = fixture(t);
      assert.equal(install("comprehensive-review").status, 0);
      const oldParser = "export function parseArgs() { return { reviewers: ['claude', 'codex'] }; }\n";
      const dependencyParser = path.join(destination, "comprehensive-review/scripts/review-options.mjs");
      writeFileSync(dependencyParser, oldParser);
      const loop = path.join(destination, "review-fix-loop");
      if (existingLoop) {
        mkdirSync(loop);
        writeFileSync(path.join(loop, "SKILL.md"), "existing customized loop\n");
      }
      const existingSkill = path.join(destination, "rust-error-handling-review");
      mkdirSync(existingSkill);
      writeFileSync(path.join(existingSkill, "SKILL.md"), "existing customized skill\n");

      const result = install();

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /Skipping review-fix-loop:.*comprehensive-review/);
      assert.equal(readFileSync(dependencyParser, "utf8"), oldParser);
      assert.equal(readFileSync(path.join(existingSkill, "SKILL.md"), "utf8"), "existing customized skill\n");
      if (existingLoop) {
        assert.equal(readFileSync(path.join(loop, "SKILL.md"), "utf8"), "existing customized loop\n");
        assert.equal(existsSync(path.join(loop, "scripts")), false);
      } else {
        assert.equal(existsSync(loop), false);
      }
      assert.equal(
        readFileSync(path.join(destination, "rust-architecture-review/SKILL.md"), "utf8"),
        readFileSync(path.join(repo, "plugins/jig-rust/skills/rust-architecture-review/SKILL.md"), "utf8"),
      );
    });
  }
});

test("all-skills --force replaces a differing dependency and installs a usable loop", (t) => {
  const { destination, install } = fixture(t);
  assert.equal(install("comprehensive-review").status, 0);
  const customized = path.join(destination, "comprehensive-review/local.md");
  writeFileSync(customized, "custom copy\n");
  const result = install("--force");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Skipping review-fix-loop/);
  assert.equal(existsSync(customized), false);
  assertInstalledParser(destination);
});

test("destination option rejects missing values before installation", () => {
  for (const args of [["--dest"], ["--dest", "--force"]]) {
    const result = spawnSync("sh", [installer, "codex", ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Missing directory for --dest/);
  }
});
