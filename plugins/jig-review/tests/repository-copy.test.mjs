import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyFile, entry, git, makeOverlay, pathsDifferFromIndex, readRegularFile, snapshot } from "../skills/review-fix-loop/scripts/repository.mjs";
import { storeBlob } from "../skills/review-fix-loop/scripts/run-store.mjs";
import { advance, createRun } from "../skills/review-fix-loop/scripts/review-fix-loop.mjs";
import { gitEnvironment } from "../skills/comprehensive-review/scripts/git-environment.mjs";

function fixture(t) {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jig-git-copy-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "repo"), store = path.join(directory, "run"); mkdirSync(root); mkdirSync(store);
  git(root, "init", "-q", "-b", "main"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(path.join(root, "value"), "base\n"); git(root, "add", "."); git(root, "commit", "-qm", "base");
  return { root, directory: store, temporary: directory };
}
const diff = root => [git(root, "diff", "--no-ext-diff", "--no-textconv", "--binary").toString(), git(root, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary").toString()];

for (const nested of [false, true]) test(`snapshots and copies preserve tracked files replaced by directories${nested ? " in submodules" : ""}`, t => {
  const run = fixture(t), prefix = nested ? "module/" : "", root = path.join(run.root, prefix);
  if (nested) {
    mkdirSync(root); git(root, "init", "-q");
    git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
  }
  writeFileSync(path.join(root, "tool"), "old tracked file\n");
  git(root, "add", "tool"); git(root, "commit", "-qm", "track tool");
  if (nested) git(run.root, "add", "module");
  rmSync(path.join(root, "tool")); mkdirSync(path.join(root, "tool"));
  writeFileSync(path.join(root, "tool/index.sh"), "#!/bin/sh\nexit 0\n");
  const index = git(root, "ls-files", "--stage", "-z"), beforeDiff = diff(root);
  run.expected = snapshot(run.root, run.directory);
  assert.equal(run.expected.files[`${prefix}tool`], null);
  assert.equal(run.expected.files[`${prefix}tool/index.sh`].type, "file");
  const overlay = makeOverlay(run, run.expected, "directory-replacement");
  assert.deepEqual(snapshot(overlay).files, run.expected.files);
  assert.deepEqual(diff(path.join(overlay, prefix)), beforeDiff);
  assert.deepEqual(git(root, "ls-files", "--stage", "-z"), index);
  assert.equal(readFileSync(path.join(root, "tool/index.sh"), "utf8"), "#!/bin/sh\nexit 0\n");
  assert.throws(() => entry(root, "tool"), /Unsupported/, "Mutation guards must still distinguish a directory from an absent destination");
});

for (const location of ["root", "submodule", "gitfile"]) test(`snapshot rejects nested repositories in tracked directories (${location})`, t => {
  const run = fixture(t);
  let root = run.root;
  if (location === "submodule") {
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", root, "module");
    root = path.join(root, "module");
    git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
  }
  mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  writeFileSync(path.join(root, "src/deep/file"), "tracked\n");
  git(root, "add", "src/deep/file"); git(root, "commit", "-qm", "track nested file");
  snapshot(run.root);
  const nested = path.join(root, "src"), index = git(root, "ls-files", "--stage", "-z");
  git(nested, "init", "-q", ...(location === "gitfile" ? ["--separate-git-dir", path.join(run.temporary, "nested.git")] : []));
  assert.equal(git(root, "ls-files", "--cached", "--others", "--exclude-standard").toString().includes("src/\n"), false);
  const rejectsNested = error => error.code === "UNSUPPORTED_REPOSITORY" && error.message.includes(nested);
  assert.throws(() => snapshot(run.root), rejectsNested);
  git(nested, "add", "deep/file");
  assert.throws(() => snapshot(run.root), rejectsNested);
  assert.deepEqual(git(root, "ls-files", "--stage", "-z"), index);
});

test("nested repository creation in tracked directories blocks initialization and resume", async t => {
  const f = fixture(t), nested = path.join(f.root, "src"); mkdirSync(nested);
  writeFileSync(path.join(nested, "file"), "tracked\n"); git(f.root, "add", "src/file");
  const start = () => createRun({ cwd: f.root, contract: { goal: "Keep files", acceptanceCriteria: [{ id: "files", description: "Files stay" }],
    nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: [], requiredValidation: [{ id: "unit", argv: [process.execPath, "-e", "process.exit(0)"] }] } });
  const run = await start();
  git(nested, "init", "-q");
  await assert.rejects(start(), error => error.code === "UNSUPPORTED_REPOSITORY");
  const stopped = await advance(run.directory);
  assert.equal(stopped.phase, "BLOCKED"); assert.equal(stopped.outcome.code, "UNSUPPORTED_REPOSITORY");
  assert.equal(stopped.attempts.length, 0);
});

test("all Git-declared repository-local environment variables are isolated", () => {
  const names = git(process.cwd(), "rev-parse", "--local-env-vars").toString().trim().split("\n");
  const inherited = { ...Object.fromEntries([...names, "GIT_NAMESPACE", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"].map(name => [name, "caller"])),
    PATH: "/toolchain", GIT_CONFIG_GLOBAL: "/global-policy", GIT_OPTIONAL_LOCKS: "1" };
  assert.deepEqual(gitEnvironment(inherited), { PATH: "/toolchain", GIT_CONFIG_GLOBAL: "/global-policy", GIT_OPTIONAL_LOCKS: "0" });
});

test("copies preserve local conversion, file modes, attribute precedence, ignores and staged/unstaged diffs", t => {
  const run = fixture(t);
  git(run.root, "config", "core.autocrlf", "true"); git(run.root, "config", "core.filemode", "false");
  const globalAttributes = path.join(run.temporary, "attributes"), globalIgnore = path.join(run.temporary, "ignore");
  writeFileSync(globalAttributes, "*.global text\n*.info -text\n"); writeFileSync(globalIgnore, "global-ignored\n");
  git(run.root, "config", "core.attributesFile", globalAttributes); git(run.root, "config", "core.excludesFile", globalIgnore);
  writeFileSync(path.join(run.root, ".gitattributes"), "*.info -text\n*.local text eol=lf\n");
  writeFileSync(path.join(run.root, ".git/info/attributes"), "*.info text\n");
  writeFileSync(path.join(run.root, ".git/info/exclude"), "local-ignored\n");
  for (const name of ["unchanged", "a.global", "a.info", "a.local"]) writeFileSync(path.join(run.root, name), "same\r\n");
  git(run.root, "add", "."); git(run.root, "commit", "-qm", "comparison inputs");
  // Same bytes and content, changed executable bit: core.filemode=false matters.
  chmodSync(path.join(run.root, "unchanged"), 0o755);
  writeFileSync(path.join(run.root, "value"), "staged\r\n"); git(run.root, "add", "value");
  writeFileSync(path.join(run.root, "value"), "unstaged\r\n");
  for (const name of ["global-ignored", "local-ignored", "untracked"]) writeFileSync(path.join(run.root, name), name);
  const index = readFileSync(path.join(run.root, ".git/index"));
  run.expected = snapshot(run.root, run.directory);
  assert.equal(pathsDifferFromIndex(run.root, ["unchanged", "a.global", "a.info", "a.local"], run.expected.repositories), false);
  assert.equal(pathsDifferFromIndex(run.root, ["value"], run.expected.repositories), true);
  const overlay = makeOverlay(run, run.expected, "review");
  assert.deepEqual(diff(overlay), diff(run.root));
  assert.deepEqual(snapshot(overlay).files, run.expected.files);
  assert.deepEqual(readFileSync(path.join(run.root, ".git/index")), index);
  assert.equal(existsSync(path.join(overlay, "global-ignored")), false);
});

test("each initialized submodule retains its own conversion settings", t => {
  const run = fixture(t), sub = path.join(run.root, "module"); mkdirSync(sub);
  git(sub, "init", "-q"); git(sub, "config", "user.name", "Test"); git(sub, "config", "user.email", "test@example.invalid");
  git(sub, "config", "core.autocrlf", "true");
  writeFileSync(path.join(sub, "kept"), "same\r\n"); git(sub, "add", "."); git(sub, "commit", "-qm", "base"); git(run.root, "add", "module");
  run.expected = snapshot(run.root, run.directory);
  const overlay = makeOverlay(run, run.expected, "review");
  assert.deepEqual(diff(path.join(overlay, "module")), diff(sub));
  assert.equal(git(path.join(overlay, "module"), "config", "core.autocrlf").toString().trim(), "true");
  git(sub, "update-index", "--assume-unchanged", "kept");
  assert.equal(pathsDifferFromIndex(run.root, ["module/kept"], run.expected.repositories), false);
  writeFileSync(path.join(sub, "kept"), "repaired\r\n");
  assert.equal(pathsDifferFromIndex(run.root, ["module/kept"], run.expected.repositories), true);
});

for (const flag of ["assume-unchanged", "skip-worktree"]) test(`index comparison detects contents, mode and deletion behind ${flag}`, t => {
  const run = fixture(t), repositories = snapshot(run.root).repositories;
  git(run.root, "config", "core.filemode", "true");
  git(run.root, "update-index", `--${flag}`, "value");
  const index = readFileSync(path.join(run.root, ".git/index"));
  assert.equal(pathsDifferFromIndex(run.root, ["value"], repositories), false);
  writeFileSync(path.join(run.root, "value"), Buffer.from([0, 1, 2, 255]));
  assert.equal(pathsDifferFromIndex(run.root, ["value"], repositories), true);
  writeFileSync(path.join(run.root, "value"), "base\n");
  chmodSync(path.join(run.root, "value"), 0o755);
  assert.equal(pathsDifferFromIndex(run.root, ["value"], repositories), true);
  rmSync(path.join(run.root, "value"));
  assert.equal(pathsDifferFromIndex(run.root, ["value"], repositories), true);
  writeFileSync(path.join(run.root, "added"), "new\n");
  assert.equal(pathsDifferFromIndex(run.root, ["added"], repositories), true);
  assert.equal(pathsDifferFromIndex(run.root, ["absent"], repositories), false);
  assert.deepEqual(readFileSync(path.join(run.root, ".git/index")), index);
});

test("index comparison treats symlink targets and pathspec characters literally", t => {
  const run = fixture(t), name = "link[1]*", file = path.join(run.root, name);
  symlinkSync("value", file);
  git(run.root, "--literal-pathspecs", "add", "--", name);
  git(run.root, "update-index", "--assume-unchanged", "--", name);
  const repositories = snapshot(run.root).repositories;
  const index = readFileSync(path.join(run.root, ".git/index"));
  assert.equal(pathsDifferFromIndex(run.root, [name], repositories), false);
  rmSync(file); symlinkSync("missing", file);
  assert.equal(pathsDifferFromIndex(run.root, [name], repositories), true);
  rmSync(file); writeFileSync(file, "value");
  assert.equal(pathsDifferFromIndex(run.root, [name], repositories), true);
  git(run.root, "config", "core.symlinks", "false");
  assert.equal(pathsDifferFromIndex(run.root, [name], repositories), false);
  assert.deepEqual(readFileSync(path.join(run.root, ".git/index")), index);
});

for (const source of ["environment", "configuration"]) test(`private copies ignore empty/hook-only Git templates from ${source}`, t => {
  const run = fixture(t), template = path.join(run.temporary, "template"), globalConfig = path.join(run.temporary, "gitconfig");
  mkdirSync(template);
  writeFileSync(globalConfig, `[init]\n\ttemplateDir = ${template}\n`);
  writeFileSync(path.join(run.root, "value"), "changed\n");
  const index = readFileSync(path.join(run.root, ".git/index"));
  const module = new URL("../skills/review-fix-loop/scripts/repository.mjs", import.meta.url).href;
  for (const hooks of [false, true]) {
    if (hooks) { mkdirSync(path.join(template, "hooks")); writeFileSync(path.join(template, "hooks", "post-checkout"), "unwanted template hook"); }
    const code = `import assert from 'node:assert/strict';import {existsSync} from 'node:fs';import {snapshot,makeOverlay} from ${JSON.stringify(module)};const run=${JSON.stringify(run)};const expected=snapshot(run.root,run.directory);const copy=makeOverlay(run,expected,${JSON.stringify(`template-${hooks}`)});assert.deepEqual(snapshot(copy).files,expected.files);assert.equal(existsSync(copy+'/.git/hooks/post-checkout'),false);assert.equal(existsSync(copy+'/.git/info/attributes'),true);`;
    const env = { ...process.env }; delete env.GIT_TEMPLATE_DIR;
    if (source === "environment") env.GIT_TEMPLATE_DIR = template;
    else env.GIT_CONFIG_GLOBAL = globalConfig;
    execFileSync(process.execPath, ["--input-type=module", "-e", code], { env, timeout: 15000 });
  }
  assert.deepEqual(readFileSync(path.join(run.root, ".git/index")), index);
});

test("private root and submodule copies never execute globally configured hooks", t => {
  const run = fixture(t), sub = path.join(run.root, "module"); mkdirSync(sub);
  git(sub, "init", "-q"); git(sub, "config", "user.name", "Test"); git(sub, "config", "user.email", "test@example.invalid");
  writeFileSync(path.join(sub, "kept"), "kept\n"); git(sub, "add", "."); git(sub, "commit", "-qm", "base"); git(run.root, "add", "module");
  const hooks = path.join(run.temporary, "hooks"), marker = path.join(hooks, "executed"), globalConfig = path.join(run.temporary, "gitconfig");
  mkdirSync(hooks);
  writeFileSync(path.join(hooks, "reference-transaction"), '#!/bin/sh\nprintf "%s\\n" "$PWD:$1" >> "$(dirname "$0")/executed"\nexit 1\n', { mode: 0o755 });
  writeFileSync(globalConfig, `[core]\n\thooksPath = ${hooks}\n`);
  const env = { ...gitEnvironment(), GIT_CONFIG_GLOBAL: globalConfig };
  const preserved = [globalConfig, ...[run.root, sub].flatMap(root => [path.join(root, ".git/config"), path.join(root, ".git/index")])];
  const before = preserved.map(file => readFileSync(file));
  // Positive control: this exact hook is executable and would abort ref creation.
  assert.throws(() => execFileSync("git", ["update-ref", "refs/heads/hook-control", "HEAD"], { cwd: run.root, env, stdio: "pipe" }));
  // Newer Git can reject the transaction in "preparing", before "prepared".
  assert.match(readFileSync(marker, "utf8"), /:prepar(?:ing|ed)\n/); rmSync(marker);
  const module = new URL("../skills/review-fix-loop/scripts/repository.mjs", import.meta.url).href;
  const code = `import assert from 'node:assert/strict';import {snapshot,makeOverlay,git} from ${JSON.stringify(module)};
    const run=${JSON.stringify(run)};const expected=snapshot(run.root,run.directory);const copy=makeOverlay(run,expected,'hook-free');
    assert.deepEqual(snapshot(copy).files,expected.files);
    for(const root of [copy,copy+'/module']) {
      assert.equal(git(root,'config','--local','core.hooksPath').toString().trim(),'/dev/null');
      git(root,'update-ref','refs/heads/copy-control','HEAD');
    }`;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], { env, timeout: 15000 });
  assert.equal(existsSync(marker), false);
  assert.deepEqual(preserved.map(file => readFileSync(file)), before);
});

for (const location of ["loose", "packed", "submodule"]) test(`snapshot rejects ${location} replacement refs without changing source history`, t => {
  const run = fixture(t);
  let root = run.root;
  if (location === "submodule") {
    root = path.join(run.root, "module"); mkdirSync(root);
    git(root, "init", "-q"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(path.join(root, "kept"), "kept\n"); git(root, "add", "."); git(root, "commit", "-qm", "base"); git(run.root, "add", "module");
  }
  const head = git(root, "rev-parse", "HEAD").toString().trim();
  const replacement = git(root, "commit-tree", "HEAD^{tree}", "-m", "replacement").toString().trim();
  git(root, "replace", head, replacement);
  if (location !== "loose") git(root, "pack-refs", "--all", "--prune");
  const index = readFileSync(path.join(root, ".git/index"));
  assert.throws(() => snapshot(run.root, run.directory), error => error.code === "UNSUPPORTED_REPOSITORY"
    && error.message.includes(`refs/replace/${head}`) && error.message.includes(root) && /no fallback/.test(error.message));
  assert.equal(git(root, "rev-parse", `refs/replace/${head}`).toString().trim(), replacement);
  assert.deepEqual(readFileSync(path.join(root, ".git/index")), index);
});

for (const location of ["root", "submodule", "linked-worktree"]) test(`snapshot and copy preparation reject ${location} grafts without changing source history`, t => {
  const run = fixture(t);
  for (const value of ["second", "third"]) {
    writeFileSync(path.join(run.root, "value"), `${value}\n`);
    git(run.root, "commit", "-qam", value);
  }
  let root = run.root;
  if (location === "submodule") {
    root = path.join(run.root, "module");
    git(run.root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", run.root, "module");
  } else if (location === "linked-worktree") {
    root = path.join(run.temporary, "linked");
    git(run.root, "worktree", "add", "-q", "-b", "linked", root);
    run.root = root;
  }
  const expected = snapshot(run.root, run.directory);
  const metadata = name => git(root, "rev-parse", "--path-format=absolute", "--git-path", name).toString().trim();
  const grafts = metadata("info/grafts"), indexPath = metadata("index"), index = readFileSync(indexPath);
  assert.equal(git(root, "rev-list", "--count", "HEAD").toString().trim(), "3");
  const contents = git(root, "rev-parse", "HEAD");
  writeFileSync(grafts, contents);
  assert.equal(git(root, "rev-list", "--count", "HEAD").toString().trim(), "1", "The graft must actually change visible ancestry");
  const unsupportedGrafts = error => error.code === "UNSUPPORTED_REPOSITORY" && /graft/.test(error.message) && error.message.includes(grafts);
  assert.throws(() => snapshot(run.root, run.directory), unsupportedGrafts);
  assert.throws(() => makeOverlay(run, expected, "grafted"), unsupportedGrafts);
  assert.equal(existsSync(path.join(run.directory, "overlays")), false);
  assert.equal(existsSync(path.join(run.directory, "resources")), false);
  assert.deepEqual(readFileSync(grafts), contents);
  assert.deepEqual(readFileSync(indexPath), index);
  assert.equal(git(root, "rev-list", "--count", "HEAD").toString().trim(), "1");
});

test("empty and comment-only graft files do not prevent history-preserving copies", t => {
  const run = fixture(t), grafts = git(run.root, "rev-parse", "--path-format=absolute", "--git-path", "info/grafts").toString().trim();
  for (const [label, contents] of [["empty", ""], ["comments", "# No active grafts\n\n  # Another comment\n"]]) {
    writeFileSync(grafts, contents);
    const expected = snapshot(run.root, run.directory), overlay = makeOverlay(run, expected, label);
    assert.deepEqual(git(overlay, "rev-list", "HEAD"), git(run.root, "rev-list", "HEAD"));
  }
});

test("copy preparation rechecks replacement refs before allocating any workspace", t => {
  const run = fixture(t), expected = snapshot(run.root, run.directory);
  const head = git(run.root, "rev-parse", "HEAD").toString().trim();
  const replacement = git(run.root, "commit-tree", "HEAD^{tree}", "-m", "replacement").toString().trim();
  git(run.root, "replace", head, replacement);
  assert.throws(() => makeOverlay(run, expected, "stale"), error => error.code === "UNSUPPORTED_REPOSITORY");
  assert.equal(existsSync(path.join(run.directory, "overlays", "stale")), false);
  assert.equal(existsSync(path.join(run.directory, "resources", "stale.json")), false);
});

test("copy preparation rechecks shallow metadata before allocating any workspace", t => {
  const run = fixture(t), expected = snapshot(run.root, run.directory);
  const head = git(run.root, "rev-parse", "HEAD").toString();
  writeFileSync(git(run.root, "rev-parse", "--path-format=absolute", "--git-path", "shallow").toString().trim(), head);
  assert.equal(git(run.root, "rev-parse", "--is-shallow-repository").toString().trim(), "true");
  assert.throws(() => makeOverlay(run, expected, "stale-shallow"), error => error.code === "UNSUPPORTED_REPOSITORY" && /shallow repository/.test(error.message));
  assert.equal(existsSync(path.join(run.directory, "overlays", "stale-shallow")), false);
  assert.equal(existsSync(path.join(run.directory, "resources", "stale-shallow.json")), false);
});

test("repository redirection inherited from hooks cannot redirect scope capture or overlay writes", t => {
  const run = fixture(t), other = fixture(t), head = git(other.root, "symbolic-ref", "HEAD").toString();
  const index = readFileSync(path.join(other.root, ".git/index")), config = readFileSync(path.join(other.root, ".git/config"));
  writeFileSync(path.join(run.root, "value"), "changed\n");
  const repository = new URL("../skills/review-fix-loop/scripts/repository.mjs", import.meta.url).href;
  const fingerprint = new URL("../skills/comprehensive-review/scripts/scope-fingerprint.mjs", import.meta.url).href;
  const code = `import assert from 'node:assert/strict';import {snapshot,makeOverlay} from ${JSON.stringify(repository)};import {captureFingerprint} from ${JSON.stringify(fingerprint)};const run=${JSON.stringify(run)};run.expected=snapshot(run.root,run.directory);makeOverlay(run,run.expected,'review');const fp=await captureFingerprint({cwd:run.root,scope:'working-tree'});assert.equal(fp.repoRoot,run.root);assert.equal(fp.hasChanges,true);assert.equal(fp.complete,true);`;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env,
    GIT_DIR: path.join(other.root, ".git"), GIT_WORK_TREE: other.root, GIT_INDEX_FILE: path.join(other.root, ".git/index"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.filemode", GIT_CONFIG_VALUE_0: "false",
  }, timeout: 15000 });
  assert.equal(git(other.root, "symbolic-ref", "HEAD").toString(), head);
  assert.deepEqual(readFileSync(path.join(other.root, ".git/index")), index);
  assert.deepEqual(readFileSync(path.join(other.root, ".git/config")), config);
});

test("external conversion drivers fail explicitly instead of silently changing the review", t => {
  const run = fixture(t);
  writeFileSync(path.join(run.root, ".gitattributes"), "value filter=custom\n");
  assert.throws(() => snapshot(run.root, run.directory), /Unsupported executable Git filter attribute on value/);
});

test("bare Git booleans survive copying and mismatched saved diffs are rejected", t => {
  const run = fixture(t), configFile = path.join(run.root, ".git/config");
  writeFileSync(configFile, readFileSync(configFile, "utf8") + "\n[core]\n\tautocrlf\n");
  writeFileSync(path.join(run.root, "value"), "base\r\n");
  run.expected = snapshot(run.root, run.directory);
  assert.equal(git(run.root, "diff").length, 0);
  const overlay = makeOverlay(run, run.expected, "review");
  assert.deepEqual(diff(overlay), diff(run.root));
  assert.throws(() => makeOverlay(run, { ...run.expected, diffs: { "": "mismatched" } }, "wrong"), /does not preserve the source Git diff/);
});

test("local Git policy drift invalidates a pinned run before assignment", async t => {
  const f = fixture(t);
  const run = await createRun({ cwd: f.root, contract: { goal: "Keep the value", acceptanceCriteria: [{ id: "value", description: "Value stays" }],
    nonGoals: [], compatibilityConstraints: [], permittedBehaviorChanges: [], requiredValidation: [{ id: "unit", argv: [process.execPath, "-e", "process.exit(0)"] }] } });
  git(f.root, "config", "core.autocrlf", "true");
  assert.equal((await advance(run.directory)).phase, "SCOPE_CHANGED");
});

for (const published of [false, true]) test(`application preserves changed temporaries ${published ? "after publication" : "before displacement"}`, t => {
  const f = fixture(t), before = entry(f.root, "value", f.directory);
  const edit = { path: "value", before, after: { ...before, blob: storeBlob(f.directory, "candidate\n") }, temporary: ".jig-apply-abcd", backup: path.join(f.directory, "backup") };
  const temporary = path.join(f.root, edit.temporary), destination = path.join(f.root, "value");
  writeFileSync(temporary, "candidate\n");
  if (published) { renameSync(destination, edit.backup); linkSync(temporary, destination); }
  // Replace the temporary's inode, leaving an already published destination intact.
  rmSync(temporary); writeFileSync(temporary, "user work\n");
  assert.throws(() => applyFile(f.root, edit, f.directory), /Temporary contents differ/);
  assert.equal(readFileSync(temporary, "utf8"), "user work\n");
  assert.equal(readFileSync(destination, "utf8"), published ? "candidate\n" : "base\n");
});
test("regular-file reads enforce their byte limit independently of parsing", t => {
  const f = fixture(t); writeFileSync(path.join(f.root, "small"), "12345");
  assert.throws(() => readRegularFile(f.root, "small", 4), error => error.code === "UNSUPPORTED_REPOSITORY");
  assert.equal(readRegularFile(f.root, "small", 5).bytes.toString(), "12345");
});
test("named diff driver configuration is read once per snapshot and never cached across captures", t => {
  const f = fixture(t); writeFileSync(path.join(f.root, ".gitattributes"), "*.md diff=MyDriver\n");
  writeFileSync(path.join(f.root, "one.md"), "one\n");
  const original = childProcess.execFileSync, calls = [];
  childProcess.execFileSync = (...args) => { if (args[0] === "git" && args[1][0] === "config") calls.push(args[1]); return original(...args); };
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFileSync = original; syncBuiltinESMExports(); });
  snapshot(f.root); const initialCount = calls.length;
  for (let i = 0; i < 40; i++) writeFileSync(path.join(f.root, `${i}.md`), "content\n");
  calls.length = 0; snapshot(f.root);
  assert.equal(calls.length, initialCount);
  assert.equal(calls.filter(args => args.includes("--list")).length, 1);
  assert.equal(calls.some(args => args.some(arg => arg.startsWith("diff.MyDriver."))), false);
  git(f.root, "config", "diff.MyDriver.textconv", "must-not-execute");
  assert.throws(() => snapshot(f.root), /Unsupported executable Git diff attribute/);
});
