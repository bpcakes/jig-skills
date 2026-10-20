import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const installer = path.join(repo, "scripts/install.sh");
const herdrSkill = '---\nname: herdr\ndescription: Control the installed Herdr release.\n---\n\n# Herdr\nRequire a genuine managed pane before control.\n';
function legacyReviewOnly(destination) {
  mkdirSync(destination, { recursive: true });
  cpSync(path.join(repo, "plugins/jig-review/skills/panel-review"), path.join(destination, "panel-review"), { recursive: true });
}

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jig-install-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "skills with spaces");
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  const herdr = path.join(bin, "herdr");
  const herdrLog = path.join(directory, "herdr-calls");
  writeFileSync(herdr, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HERDR_TEST_LOG"\n[ "$#" = 1 ] && [ "$1" = --skill ] || exit 98\ncat <<'SKILL'\n${herdrSkill}SKILL\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HERDR_TEST_LOG: herdrLog };
  return {
    destination, bin, herdr, herdrLog, env,
    install: (...args) => spawnSync("sh", [installer, "codex", "--dest", destination, ...args], {
      cwd: directory,
      encoding: "utf8",
      env,
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
  assert.equal(result.commitMode, "per-round");
}

test("fresh direct installation includes a usable review dependency", (t) => {
  const { destination, install } = fixture(t);
  const result = install("review-fix-loop");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Required dependency: panel-review/);
  assertInstalledParser(destination);
});

test("standalone panel review installs both usable workflow entrypoints", t => {
  const { destination, install } = fixture(t);
  const result = install("panel-review");
  assert.equal(result.status, 0, result.stderr); assertInstalledParser(destination);
  const project = path.join(path.dirname(destination), "project"); mkdirSync(project);
  execFileSync("git", ["init", "-q", project]);
  const plan = spawnSync(process.execPath, [path.join(destination, "review-fix-loop/scripts/review-fix-loop.mjs"), "plan-validation", "--cwd", project], { encoding: "utf8" });
  assert.equal(plan.status, 0, plan.stderr); assert.ok(JSON.parse(plan.stdout));
});

for (const selected of ["review-fix-loop", "panel-review"]) {
  for (const existing of ["review-fix-loop", "panel-review"]) {
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
        assert.equal(install("--force", "review-fix-loop", "panel-review").status, 0);
      }
      assertInstalledParser(destination);
    });
  }
}

test("automatic loop dependencies are never overwritten by force on panel review", t => {
  const { destination, install } = fixture(t);
  assert.equal(install("panel-review").status, 0);
  const marker = path.join(destination, "review-fix-loop/custom.txt"); writeFileSync(marker, "keep\n");
  for (const args of [["panel-review"], ["--force", "panel-review"]]) {
    const result = install(...args); assert.equal(result.status, 1); assert.match(result.stderr, /No skills were changed/);
    assert.equal(readFileSync(marker, "utf8"), "keep\n");
  }
  assert.equal(install("--force", "panel-review", "review-fix-loop").status, 0);
  assert.equal(existsSync(marker), false);
});

test("differing dependencies fail before modifying either skill", async (t) => {
  for (const args of [
    ["review-fix-loop"],
    ["--force", "review-fix-loop"],
    ["panel-review", "review-fix-loop"],
  ]) {
    await t.test(args.join(" "), (t) => {
      const { destination, install } = fixture(t);
      const dependency = path.join(destination, "panel-review");
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
  const dependency = path.join(destination, "panel-review");
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
  const customized = path.join(destination, "panel-review/local.md");
  writeFileSync(customized, "custom copy\n");
  const result = install("--force", "review-fix-loop", "panel-review");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(customized), false);
  assertInstalledParser(destination);
});

test("a differing dependency cannot leave a newly installed loop behind", (t) => {
  const { destination, install } = fixture(t);
  legacyReviewOnly(destination);
  writeFileSync(path.join(destination, "panel-review/scripts/review-options.mjs"), "throw new Error('old parser');\n");
  const result = install("review-fix-loop");
  assert.equal(result.status, 1);
  assert.equal(existsSync(path.join(destination, "review-fix-loop")), false);
});

test("all-skills installs include the review pair and orchestration for both hosts", (t) => {
  const { destination, install, env } = fixture(t);
  const codex = install();
  assert.equal(codex.status, 0, codex.stderr);
  assertInstalledParser(destination);
  assert.equal(existsSync(path.join(destination, "herdr-orchestrate/SKILL.md")), true);
  const claudeDestination = path.join(destination, "claude-skills");
  const claude = spawnSync("sh", [installer, "claude", "--dest", claudeDestination], { encoding: "utf8", env });
  assert.equal(claude.status, 0, claude.stderr);
  assertInstalledParser(claudeDestination);
  for (const relative of ["panel-review/references/claude-code-host.md", "herdr-orchestrate/references/claude-code-host.md",
    "rust-error-handling-review/SKILL.md"]) {
    assert.equal(existsSync(path.join(claudeDestination, relative)), true, relative);
  }
  assert.equal(readFileSync(path.join(claudeDestination, "herdr/SKILL.md"), "utf8"), herdrSkill);
  // Selecting either review entrypoint for Claude installs the pair.
  const loopDestination = path.join(destination, "claude-loop");
  const loop = spawnSync("sh", [installer, "claude", "--dest", loopDestination, "review-fix-loop"], { encoding: "utf8", env });
  assert.equal(loop.status, 0, loop.stderr);
  assertInstalledParser(loopDestination);
});

test("orchestration installation includes both usable review entrypoints and its complete helper directory", t => {
  const { destination, install, herdrLog } = fixture(t);
  const result = install("herdr-orchestrate");
  assert.equal(result.status, 0, result.stderr);
  assertInstalledParser(destination);
  assert.equal(readFileSync(path.join(destination, "herdr/SKILL.md"), "utf8"), herdrSkill);
  assert.equal(readFileSync(herdrLog, "utf8"), "--skill\n");
  for (const relative of ["SKILL.md", "scripts/supervise.py", "scripts/state.py", "references/recovery.md", "references/trackers.md"]) {
    assert.equal(existsSync(path.join(destination, "herdr-orchestrate", relative)), true, relative);
  }
  const help = spawnSync("python3", ["-B", path.join(destination, "herdr-orchestrate/scripts/supervise.py"), "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
});

for (const dependency of ["review-fix-loop", "panel-review"]) {
  test(`orchestration refuses incompatible ${dependency} before copying, including --force`, t => {
    const { destination, install } = fixture(t);
    mkdirSync(destination, { recursive: true });
    cpSync(path.join(repo, "plugins/jig-review/skills", dependency), path.join(destination, dependency), { recursive: true });
    const marker = path.join(destination, dependency, "custom.txt");
    writeFileSync(marker, "keep custom dependency\n");
    for (const args of [["herdr-orchestrate"], ["--force", "herdr-orchestrate"]]) {
      const result = install(...args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /No skills were changed/);
      assert.deepEqual(readdirSync(destination), [dependency]);
      assert.equal(readFileSync(marker, "utf8"), "keep custom dependency\n");
    }
    const replaced = install("--force", "herdr-orchestrate", "review-fix-loop", "panel-review");
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.equal(existsSync(marker), false);
    assertInstalledParser(destination);
  });

  test(`all-skills install skips orchestration through incompatible ${dependency}`, t => {
    const { destination, install } = fixture(t);
    mkdirSync(path.join(destination, dependency), { recursive: true });
    writeFileSync(path.join(destination, dependency, "SKILL.md"), "keep custom dependency\n");
    const result = install();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Skipping herdr-orchestrate:.*review-fix-loop/);
    assert.equal(existsSync(path.join(destination, "herdr-orchestrate")), false);
    assert.equal(existsSync(path.join(destination, "rust-error-handling-review/SKILL.md")), true);
    assert.equal(readFileSync(path.join(destination, dependency, "SKILL.md"), "utf8"), "keep custom dependency\n");
  });
}

test("force replacing orchestration preserves matching automatic review copies", t => {
  const { destination, install } = fixture(t);
  assert.equal(install("herdr-orchestrate").status, 0);
  const identities = Object.fromEntries(["review-fix-loop", "panel-review"].map(name => [name, statSync(path.join(destination, name))]));
  writeFileSync(path.join(destination, "herdr-orchestrate/custom.txt"), "replace this\n");
  const result = install("--force", "herdr-orchestrate");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(destination, "herdr-orchestrate/custom.txt")), false);
  for (const [name, identity] of Object.entries(identities)) {
    assert.equal(statSync(path.join(destination, name)).ino, identity.ino);
    assert.equal(statSync(path.join(destination, name)).ctimeMs, identity.ctimeMs);
  }
});

test("Claude orchestration installation includes the review pair, Herdr skill, and host references", t => {
  const { destination, herdrLog, env } = fixture(t);
  const result = spawnSync("sh", [installer, "claude", "--dest", destination, "rust-error-handling-review", "herdr-orchestrate"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assertInstalledParser(destination);
  assert.equal(readFileSync(path.join(destination, "herdr/SKILL.md"), "utf8"), herdrSkill);
  assert.equal(readFileSync(herdrLog, "utf8"), "--skill\n");
  for (const relative of ["herdr-orchestrate/SKILL.md", "herdr-orchestrate/scripts/supervise.py",
    "herdr-orchestrate/references/claude-code-host.md", "panel-review/references/claude-code-host.md",
    "rust-error-handling-review/SKILL.md"]) {
    assert.equal(existsSync(path.join(destination, relative)), true, relative);
  }
});

test("explicit destination provisions only the selected orchestration profile", t => {
  const { destination, env } = fixture(t);
  const siblingHome = path.join(path.dirname(destination), "other codex home");
  const result = spawnSync("sh", [installer, "codex", "--dest", destination, "herdr-orchestrate"], {
    encoding: "utf8", env: { ...env, CODEX_HOME: siblingHome },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(siblingHome), false);
  assert.equal(existsSync(path.join(destination, "herdr-orchestrate/SKILL.md")), true);
  assert.equal(readFileSync(path.join(destination, "herdr/SKILL.md"), "utf8"), herdrSkill);
  assertInstalledParser(destination);
});

test("orchestration default destination follows the selected CODEX_HOME", t => {
  const { destination, env } = fixture(t);
  const profileHome = path.join(path.dirname(destination), "selected codex home");
  const result = spawnSync("sh", [installer, "codex", "herdr-orchestrate"], {
    encoding: "utf8", env: { ...env, CODEX_HOME: profileHome },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(destination), false);
  assert.equal(existsSync(path.join(profileHome, "skills/herdr-orchestrate/SKILL.md")), true);
  assert.equal(readFileSync(path.join(profileHome, "skills/herdr/SKILL.md"), "utf8"), herdrSkill);
  assertInstalledParser(path.join(profileHome, "skills"));
});

test("Claude default destination follows CLAUDE_CONFIG_DIR, then the legacy CLAUDE_HOME", t => {
  const { destination, env } = fixture(t);
  const profile = path.join(path.dirname(destination), "selected claude profile");
  const legacy = path.join(path.dirname(destination), "legacy claude home");
  const selected = spawnSync("sh", [installer, "claude", "herdr-orchestrate"], {
    encoding: "utf8", env: { ...env, CLAUDE_CONFIG_DIR: profile, CLAUDE_HOME: legacy },
  });
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(existsSync(legacy), false);
  assert.equal(existsSync(path.join(profile, "skills/herdr-orchestrate/SKILL.md")), true);
  assert.equal(readFileSync(path.join(profile, "skills/herdr/SKILL.md"), "utf8"), herdrSkill);
  assertInstalledParser(path.join(profile, "skills"));
  // Never fall through to the developer's real profile.
  const legacyEnv = { ...env, CLAUDE_HOME: legacy };
  delete legacyEnv.CLAUDE_CONFIG_DIR;
  const fallback = spawnSync("sh", [installer, "claude", "rust-simplify"], { encoding: "utf8", env: legacyEnv });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(existsSync(path.join(legacy, "skills/rust-simplify/SKILL.md")), true);
});

test("Herdr alone supports plugin setup without copying the orchestration or review skills", t => {
  const { destination, install } = fixture(t);
  assert.equal(install("herdr").status, 0);
  assert.deepEqual(readdirSync(destination), ["herdr"]);
  assert.equal(readFileSync(path.join(destination, "herdr/SKILL.md"), "utf8"), herdrSkill);
});

test("orchestration force preserves a matching Herdr symlink and supplementary files", t => {
  const { destination, install } = fixture(t);
  const shared = path.join(path.dirname(destination), "shared herdr skill");
  mkdirSync(shared);
  writeFileSync(path.join(shared, "SKILL.md"), herdrSkill);
  writeFileSync(path.join(shared, "local.md"), "keep local guidance\n");
  mkdirSync(destination);
  symlinkSync(shared, path.join(destination, "herdr"));
  const before = statSync(path.join(shared, "SKILL.md"));
  const result = install("--force", "herdr-orchestrate");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Keeping matching dependency: herdr/);
  assert.equal(statSync(path.join(destination, "herdr/SKILL.md")).ino, before.ino);
  assert.equal(readFileSync(path.join(shared, "local.md"), "utf8"), "keep local guidance\n");
});

test("a differing Herdr dependency needs its own explicit replacement", t => {
  const { destination, install } = fixture(t);
  mkdirSync(path.join(destination, "herdr"), { recursive: true });
  const existing = `${herdrSkill}\nLocally customized.\n`;
  writeFileSync(path.join(destination, "herdr/SKILL.md"), existing);
  for (const args of [["herdr-orchestrate"], ["--force", "herdr-orchestrate"], ["herdr-orchestrate", "herdr"]]) {
    const result = install(...args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Existing herdr differs from the installed Herdr binary/);
    assert.match(result.stderr, /No skills were changed/);
    assert.deepEqual(readdirSync(destination), ["herdr"]);
    assert.equal(readFileSync(path.join(destination, "herdr/SKILL.md"), "utf8"), existing);
  }
  const result = install("--force", "herdr-orchestrate", "herdr");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(destination, "herdr/SKILL.md"), "utf8"), herdrSkill);
  assertInstalledParser(destination);
});

test("all-skills install skips orchestration with a conflicting Herdr dependency", t => {
  const { destination, install } = fixture(t);
  mkdirSync(path.join(destination, "herdr"), { recursive: true });
  writeFileSync(path.join(destination, "herdr/SKILL.md"), "keep my Herdr skill\n");
  const result = install();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Skipping herdr-orchestrate:.*herdr/);
  assert.doesNotMatch(result.stdout, /Keeping matching dependency: herdr/);
  assert.equal(existsSync(path.join(destination, "herdr-orchestrate")), false);
  assert.equal(readFileSync(path.join(destination, "herdr/SKILL.md"), "utf8"), "keep my Herdr skill\n");
  assert.equal(existsSync(path.join(destination, "rust-error-handling-review/SKILL.md")), true);
});

for (const [failure, body] of [
  ["failed", "printf 'partial export\\n'; exit 1"],
  ["empty", "exit 0"],
  ["help text", "printf 'Herdr --skill is unsupported\\n'"],
  ["wrong skill", "printf '%s\\n' --- 'name: other' 'description: Wrong skill.' --- '# Other'"],
]) test(`a ${failure} Herdr export fails before modifying any selected skills`, t => {
  const { destination, install, herdr } = fixture(t);
  mkdirSync(path.join(destination, "herdr"), { recursive: true });
  writeFileSync(path.join(destination, "herdr/SKILL.md"), herdrSkill);
  writeFileSync(herdr, `#!/bin/sh\n${body}\n`);
  const result = install("--force", "rust-simplify", "herdr-orchestrate", "herdr");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Cannot install Herdr skill:.*No skills were changed/);
  assert.deepEqual(readdirSync(destination), ["herdr"]);
  assert.equal(readFileSync(path.join(destination, "herdr/SKILL.md"), "utf8"), herdrSkill);
});

test("a missing Herdr binary fails explicit installation but only skips orchestration in bulk", t => {
  const { destination, bin, herdr, env } = fixture(t);
  rmSync(herdr);
  // Limit PATH to ordinary installer tools so this remains a missing-binary
  // check even on developer machines that already have Herdr installed.
  for (const tool of ["sh", "dirname", "find", "basename", "sort", "mktemp", "mkdir", "cp", "rm", "diff", "awk"]) {
    const executable = execFileSync("sh", ["-c", 'command -v "$1"', "sh", tool], { encoding: "utf8" }).trim();
    symlinkSync(executable, path.join(bin, tool));
  }
  const run = (...args) => spawnSync(path.join(bin, "sh"), [installer, "codex", "--dest", destination, ...args], {
    encoding: "utf8", env: { ...env, PATH: bin },
  });
  for (const selected of ["herdr-orchestrate", "herdr"]) {
    const result = run("rust-simplify", selected);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /No skills were changed/);
    assert.equal(existsSync(destination), false);
  }
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Herdr skill unavailable/);
  assert.match(result.stderr, /Skipping herdr-orchestrate/);
  assert.equal(existsSync(path.join(destination, "herdr")), false);
  assert.equal(existsSync(path.join(destination, "herdr-orchestrate")), false);
  assert.equal(existsSync(path.join(destination, "rust-simplify/SKILL.md")), true);
  assertInstalledParser(destination);
});

test("unrelated selections never invoke Herdr, and Claude bulk installation only exports its skill", t => {
  const { destination, install, herdrLog, env } = fixture(t);
  assert.equal(install("review-fix-loop").status, 0);
  const unrelated = spawnSync("sh", [installer, "claude", "--dest", path.join(destination, "claude"), "rust-simplify"], { encoding: "utf8", env });
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.equal(existsSync(herdrLog), false);
  const result = spawnSync("sh", [installer, "claude", "--dest", path.join(destination, "claude-all")], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(herdrLog, "utf8"), "--skill\n");
});

test("all-skills installs skip an incompatible loop and preserve existing copies", async (t) => {
  for (const existingLoop of [false, true]) {
    await t.test(existingLoop ? "existing loop" : "new loop", (t) => {
      const { destination, install } = fixture(t);
      legacyReviewOnly(destination);
      const oldParser = "export function parseArgs() { return { reviewers: ['claude', 'codex'] }; }\n";
      const dependencyParser = path.join(destination, "panel-review/scripts/review-options.mjs");
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
      assert.match(result.stderr, /Skipping review-fix-loop:.*panel-review/);
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
  assert.equal(install("panel-review").status, 0);
  const customized = path.join(destination, "panel-review/local.md");
  writeFileSync(customized, "custom copy\n");
  const result = install("--force");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Skipping review-fix-loop/);
  assert.equal(existsSync(customized), false);
  assertInstalledParser(destination);
});

test("all-skills --force preserves a differing Herdr dependency and refreshes unrelated skills", t => {
  const { destination, install } = fixture(t);
  assert.equal(install("herdr-orchestrate", "rust-simplify").status, 0);
  const herdr = path.join(destination, "herdr/SKILL.md");
  const orchestration = path.join(destination, "herdr-orchestrate/SKILL.md");
  const rust = path.join(destination, "rust-simplify/SKILL.md");
  writeFileSync(herdr, "Herdr skill from a different release\n");
  writeFileSync(orchestration, "preserve existing orchestration\n");
  writeFileSync(rust, "old unrelated skill\n");
  const result = install("--force");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Skipping herdr-orchestrate/);
  assert.match(result.stderr, /Skipping herdr:/);
  assert.equal(readFileSync(herdr, "utf8"), "Herdr skill from a different release\n");
  assert.equal(readFileSync(orchestration, "utf8"), "preserve existing orchestration\n");
  assert.equal(readFileSync(rust, "utf8"),
    readFileSync(path.join(repo, "plugins/jig-rust/skills/rust-simplify/SKILL.md"), "utf8"));
  assertInstalledParser(destination);
});

test("destination option rejects missing values before installation", () => {
  for (const args of [["--dest"], ["--dest", "--force"]]) {
    const result = spawnSync("sh", [installer, "codex", ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Missing directory for --dest/);
  }
});

test("invalid or unknown selected targets fail before any copying", t => {
  const { destination, install } = fixture(t);
  for (const target of ["../skills", "unknown-skill"]) {
    const result = install("rust-simplify", target);
    assert.equal(result.status, 1);
    assert.equal(existsSync(destination), false);
  }
});
