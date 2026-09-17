import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const installer = path.join(repo, "scripts/install.sh");
function legacyReviewOnly(destination) {
  mkdirSync(destination, { recursive: true });
  cpSync(path.join(repo, "plugins/jig-review/skills/comprehensive-review"), path.join(destination, "comprehensive-review"), { recursive: true });
}

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
    "--all-reviewers", "--review-policy", "strict", "--max-rounds", "1", "--fix-mode", "comprehensive",
  ], { encoding: "utf8" }));
  assert.deepEqual(result.review.reviewers, ["claude", "codex", "cursor"]);
  assert.equal(result.reviewPolicy, "strict");
  assert.equal(result.maxRounds, 1);
  assert.equal(result.fixMode, "comprehensive");
}

test("fresh direct installation includes a usable review dependency", (t) => {
  const { destination, install } = fixture(t);
  const result = install("review-fix-loop");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Required dependency: comprehensive-review/);
  assertInstalledParser(destination);
});

test("standalone comprehensive review installs both usable workflow entrypoints", t => {
  const { destination, install } = fixture(t);
  const result = install("comprehensive-review");
  assert.equal(result.status, 0, result.stderr); assertInstalledParser(destination);
  const project = path.join(path.dirname(destination), "project"); mkdirSync(project);
  execFileSync("git", ["init", "-q", project]);
  const plan = spawnSync(process.execPath, [path.join(destination, "review-fix-loop/scripts/review-fix-loop.mjs"), "plan-validation", "--cwd", project], { encoding: "utf8" });
  assert.equal(plan.status, 0, plan.stderr); assert.ok(JSON.parse(plan.stdout));
});

for (const selected of ["review-fix-loop", "comprehensive-review"]) {
  for (const existing of ["review-fix-loop", "comprehensive-review"]) {
    for (const differing of [false, true]) test(`partial pair: select ${selected}, existing ${existing}, differing=${differing}`, t => {
      const { destination, install } = fixture(t);
      mkdirSync(destination, { recursive: true });
      cpSync(path.join(repo, "plugins/jig-review/skills", existing), path.join(destination, existing), { recursive: true });
      const marker = path.join(destination, existing, "custom.txt");
      if (differing) writeFileSync(marker, "preserve customized skill\n");
      const result = install(selected);
      assert.equal(result.status, differing ? 1 : 0, result.stderr);
      if (differing) {
        assert.match(result.stderr, /No skills were changed/);
        assert.deepEqual(readdirSync(destination), [existing]);
        assert.equal(readFileSync(marker, "utf8"), "preserve customized skill\n");
        const forced = install("--force", selected);
        assert.equal(forced.status, selected === existing ? 0 : 1, forced.stderr);
        if (forced.status !== 0) assert.deepEqual(readdirSync(destination), [existing]);
        assert.equal(install("--force", "review-fix-loop", "comprehensive-review").status, 0);
      }
      assertInstalledParser(destination);
    });
  }
}

test("automatic loop dependencies are never overwritten by force on comprehensive review", t => {
  const { destination, install } = fixture(t);
  assert.equal(install("comprehensive-review").status, 0);
  const marker = path.join(destination, "review-fix-loop/custom.txt"); writeFileSync(marker, "keep\n");
  for (const args of [["comprehensive-review"], ["--force", "comprehensive-review"]]) {
    const result = install(...args); assert.equal(result.status, 1); assert.match(result.stderr, /No skills were changed/);
    assert.equal(readFileSync(marker, "utf8"), "keep\n");
  }
  assert.equal(install("--force", "comprehensive-review", "review-fix-loop").status, 0);
  assert.equal(existsSync(marker), false);
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
  legacyReviewOnly(destination);
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
      legacyReviewOnly(destination);
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

test("all-skills --force replaces a customized privacy dependency", t => {
  const { destination, install } = fixture(t);
  assert.equal(install("audit-common").status, 0);
  const customized = path.join(destination, "audit-common/local.md");
  writeFileSync(customized, "custom copy\n");
  const result = install("--force");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(customized), false);
  assert.equal(existsSync(path.join(destination, "network-payload-zero-knowledge-test/SKILL.md")), true);
});

test("destination option rejects missing values before installation", () => {
  for (const args of [["--dest"], ["--dest", "--force"]]) {
    const result = spawnSync("sh", [installer, "codex", ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Missing directory for --dest/);
  }
});

const privacySkills = readdirSync(path.join(repo, "plugins/jig-privacy-audit/skills"))
  .filter(name => name !== "audit-common");

test("each standalone privacy skill contains its required common resources", async t => {
  for (const skill of privacySkills) await t.test(skill, t => {
    const { destination, install } = fixture(t);
    const result = install(skill);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(destination, "audit-common/SKILL.md"), "utf8"),
      readFileSync(path.join(repo, "plugins/jig-privacy-audit/skills/audit-common/SKILL.md"), "utf8"));
    const schema = JSON.parse(readFileSync(path.join(destination, "audit-common/templates/finding.schema.json")));
    assert.ok(schema.properties);
    assert.equal(existsSync(path.join(destination, skill, "SKILL.md")), true);
  });
});

test("privacy dependency conflicts fail before writes and require explicit replacement", async t => {
  for (const args of [["network-payload-zero-knowledge-test"], ["--force", "network-payload-zero-knowledge-test"],
    ["audit-common", "network-payload-zero-knowledge-test"]]) await t.test(args.join(" "), t => {
    const { destination, install } = fixture(t);
    assert.equal(install("audit-common").status, 0);
    const customized = path.join(destination, "audit-common/local.md");
    writeFileSync(customized, "preserve me");
    const result = install(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No skills were changed/);
    assert.equal(readFileSync(customized, "utf8"), "preserve me");
    assert.equal(existsSync(path.join(destination, "network-payload-zero-knowledge-test")), false);
    assert.equal(install("--force", "audit-common", "network-payload-zero-knowledge-test").status, 0);
    assert.equal(existsSync(customized), false);
  });
});

test("matching automatic privacy dependency is preserved and installed helpers run outside the checkout", t => {
  const { destination, install } = fixture(t);
  assert.equal(install("network-payload-zero-knowledge-test").status, 0);
  const common = path.join(destination, "audit-common");
  const before = statSync(common);
  assert.equal(install("--force", "network-payload-zero-knowledge-test").status, 0);
  assert.equal(statSync(common).ino, before.ino);
  assert.equal(statSync(common).ctimeMs, before.ctimeMs);
  for (const [skill, script] of [["network-payload-zero-knowledge-test", "zknet_scan.py"],
    ["crypto-implementation-static-review", "crypto_static_scan.py"],
    ["vulnerability-disclosure-and-retest-manager", "vdrm_register.py"]]) {
    assert.equal(install(skill).status, 0);
    const result = spawnSync("python3", [path.join(destination, skill, "scripts", script), "--help"],
      { cwd: path.dirname(destination), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage:/i);
  }
});

test("all-skills privacy conflict skips dependents, not unrelated skills", t => {
  const { destination, install } = fixture(t);
  assert.equal(install("audit-common").status, 0);
  const customized = path.join(destination, "audit-common/local.md");
  writeFileSync(customized, "preserve me");
  const result = install();
  assert.equal(result.status, 0, result.stderr);
  for (const skill of privacySkills) assert.equal(existsSync(path.join(destination, skill)), false, skill);
  assert.equal(readFileSync(customized, "utf8"), "preserve me");
  assertInstalledParser(destination);
});

test("all-skills isolates simultaneous review and privacy dependency conflicts", t => {
  const { destination, install } = fixture(t);
  legacyReviewOnly(destination);
  assert.equal(install("audit-common").status, 0);
  const reviewMarker = path.join(destination, "comprehensive-review/local.md");
  const privacyMarker = path.join(destination, "audit-common/local.md");
  writeFileSync(reviewMarker, "preserve review dependency\n");
  writeFileSync(privacyMarker, "preserve privacy dependency\n");

  const result = install();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Skipping review-fix-loop:.*comprehensive-review/);
  assert.match(result.stderr, /Skipping .*audit-common/);
  assert.equal(readFileSync(reviewMarker, "utf8"), "preserve review dependency\n");
  assert.equal(readFileSync(privacyMarker, "utf8"), "preserve privacy dependency\n");
  assert.equal(existsSync(path.join(destination, "review-fix-loop")), false);
  for (const skill of privacySkills) assert.equal(existsSync(path.join(destination, skill)), false, skill);
  assert.equal(existsSync(path.join(destination, "rust-error-handling-review/SKILL.md")), true);
});

test("invalid or unknown selected targets fail before any copying", t => {
  const { destination, install } = fixture(t);
  for (const target of ["../skills", "unknown-skill"]) {
    const result = install("rust-simplify", target);
    assert.equal(result.status, 1);
    assert.equal(existsSync(destination), false);
  }
});

test("Claude standalone privacy installation also includes common resources", t => {
  const { destination } = fixture(t);
  const result = spawnSync("sh", [installer, "claude", "--dest", destination, "network-payload-zero-knowledge-test"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(destination, "audit-common/templates/finding.schema.json")), true);
});

test("Claude explicit privacy install preserves a conflicting common dependency", t => {
  const { destination } = fixture(t);
  const run = (...args) => spawnSync("sh", [installer, "claude", "--dest", destination, ...args], { encoding: "utf8" });
  assert.equal(run("audit-common").status, 0);
  const customized = path.join(destination, "audit-common/local.md");
  writeFileSync(customized, "preserve me\n");
  const result = run("network-payload-zero-knowledge-test");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No skills were changed/);
  assert.equal(readFileSync(customized, "utf8"), "preserve me\n");
  assert.equal(existsSync(path.join(destination, "network-payload-zero-knowledge-test")), false);
});

test("Claude all-skills skips privacy dependents when common dependency conflicts", t => {
  const { destination } = fixture(t);
  const run = (...args) => spawnSync("sh", [installer, "claude", "--dest", destination, ...args], { encoding: "utf8" });
  assert.equal(run("audit-common").status, 0);
  const customized = path.join(destination, "audit-common/local.md");
  writeFileSync(customized, "preserve me\n");
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Skipping .*audit-common/);
  for (const skill of privacySkills) assert.equal(existsSync(path.join(destination, skill)), false, skill);
  assert.equal(readFileSync(customized, "utf8"), "preserve me\n");
  assert.equal(existsSync(path.join(destination, "rust-error-handling-review/SKILL.md")), true);
});
