import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { captureFingerprint } from "../skills/comprehensive-review/scripts/scope-fingerprint.mjs";
import { assertScopeMatchesFingerprint } from "../skills/comprehensive-review/scripts/adapter-runtime.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
function repository(directory, name) {
  const root = path.join(directory, name); mkdirSync(root);
  git(root, "init", "-q"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(path.join(root, "value.txt"), `${name}_BASE\n`); git(root, "add", "."); git(root, "commit", "-qm", "base");
  writeFileSync(path.join(root, "value.txt"), `${name}_STAGED\n`); git(root, "add", ".");
  writeFileSync(path.join(root, "value.txt"), `${name}_WORKTREE\n`);
  return root;
}
for (const provider of ["claude", "cursor"]) for (const redirect of ["repository", "index", "pathspecs"]) {
  test(`${provider} evidence and provider Git commands ignore inherited ${redirect} redirection`, async t => {
    const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jig-adapter-env-")));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const requested = repository(directory, "REQUESTED"), other = repository(directory, "UNRELATED_SECRET");
    const excludePaths = redirect === "pathspecs" ? ["excluded.txt"] : [];
    if (excludePaths.length) { writeFileSync(path.join(requested, "excluded.txt"), "EXCLUDED_SYNTHETIC_CONTENT\n"); git(requested, "add", "excluded.txt"); }
    const fingerprint = await captureFingerprint({ cwd: requested, scope: "working-tree", excludePaths });
    const alternate = path.join(directory, "alternate-index");
    execFileSync("git", ["read-tree", "HEAD"], { cwd: requested, env: { ...process.env, GIT_INDEX_FILE: alternate } });
    const fake = path.join(directory, "provider"), capture = path.join(directory, "capture.json");
    writeFileSync(fake, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
(async()=>{
let input='';for await(const chunk of process.stdin)input+=chunk;
const args=process.argv.slice(2), at=args.indexOf('--add-dir'), dir=at<0?null:args[at+1];
const pages=dir?fs.readdirSync(dir).filter(n=>n.endsWith('.md')).map(n=>fs.readFileSync(path.join(dir,n),'utf8')).join('\\n'):'';
fs.writeFileSync(process.env.JIG_TEST_CAPTURE,JSON.stringify({evidence:input+'\\n'+pages,root:cp.execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim(),staged:cp.execFileSync('git',['diff','--cached'],{encoding:'utf8'}),gitDir:process.env.GIT_DIR,index:process.env.GIT_INDEX_FILE,configCount:process.env.GIT_CONFIG_COUNT,credential:process.env.ANTHROPIC_API_KEY}));
console.log(${JSON.stringify(provider)}==='claude'?JSON.stringify({result:'No findings.'}):'No findings.');
})();
`);
    chmodSync(fake, 0o755);
    const cli = fileURLToPath(new URL(`../skills/comprehensive-review/scripts/${provider}-review.mjs`, import.meta.url));
    const result = spawnSync(process.execPath, [cli, "--cwd", requested, "--scope", "working-tree", "--expected-fingerprint", fingerprint.fingerprint, "--timeout-ms", "15000", ...excludePaths.flatMap(p => ["--exclude-path", p])], {
      env: { ...process.env, [`JIG_${provider.toUpperCase()}_BIN`]: fake, JIG_TEST_CAPTURE: capture, ANTHROPIC_API_KEY: "synthetic-test-credential",
        ...(redirect === "pathspecs" ? { GIT_LITERAL_PATHSPECS: "1", GIT_GLOB_PATHSPECS: "1", GIT_NOGLOB_PATHSPECS: "1", GIT_ICASE_PATHSPECS: "1" } : { GIT_INDEX_FILE: redirect === "index" ? alternate : path.join(other, ".git/index") }),
        ...(redirect === "repository" ? { GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: other } : {}),
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.filemode", GIT_CONFIG_VALUE_0: "false" },
      encoding: "utf8", timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(readFileSync(capture, "utf8"));
    assert.equal(realpathSync(observed.root), requested);
    assert.match(observed.evidence, /REQUESTED_WORKTREE/);
    assert.match(observed.evidence, /REQUESTED_STAGED/);
    assert.doesNotMatch(observed.evidence, /UNRELATED_SECRET/);
    assert.doesNotMatch(observed.evidence, /EXCLUDED_SYNTHETIC_CONTENT/);
    assert.match(observed.staged, /REQUESTED_STAGED/);
    assert.equal(observed.gitDir, undefined); assert.equal(observed.index, undefined); assert.equal(observed.configCount, undefined);
    assert.equal(observed.credential, "synthetic-test-credential");
    assert.equal((await captureFingerprint({ cwd: requested, scope: "working-tree", excludePaths })).fingerprint, fingerprint.fingerprint);
  });
}
test("evidence metadata must match every pinned scope field", () => {
  const scope = { repoRoot: realpathSync(os.tmpdir()), scope: "branch", headOid: "head", baseOid: "base", mergeBaseOid: "merge", includeWorkingTree: true, excludePaths: ["excluded"] };
  const pinned = { ...scope, complete: true };
  assert.doesNotThrow(() => assertScopeMatchesFingerprint(scope, pinned));
  for (const field of ["scope", "headOid", "baseOid", "mergeBaseOid", "includeWorkingTree", "excludePaths"]) {
    assert.throws(() => assertScopeMatchesFingerprint(scope, { ...pinned, [field]: null }), /does not match/);
  }
  assert.throws(() => assertScopeMatchesFingerprint(scope, { ...pinned, repoRoot: process.cwd() }), /does not match/);
  assert.throws(() => assertScopeMatchesFingerprint(scope, { ...pinned, complete: false, issues: ["unavailable submodule"] }), error => error.code === "CAPTURE_INCOMPLETE" && !error.scopeChanged && /unavailable submodule/.test(error.message));
});

for (const provider of ["claude", "cursor"]) test(`${provider} rejects an unavailable submodule as incomplete capture, without launching the provider`, async t => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jig-partial-adapter-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = repository(directory, "requested");
  writeFileSync(path.join(root, ".gitmodules"), '[submodule "module"]\n\tpath = module\n\turl = https://example.invalid/module.git\n');
  git(root, "add", ".gitmodules");
  git(root, "update-index", "--add", "--cacheinfo", `160000,${git(root, "rev-parse", "HEAD")},module`);
  mkdirSync(path.join(root, "module"));
  git(root, "config", "submodule.module.url", "https://example.invalid/module.git");
  const fingerprint = await captureFingerprint({ cwd: root, scope: "working-tree" });
  assert.equal(fingerprint.complete, false); assert.ok(fingerprint.issues.length);
  const fake = path.join(directory, "provider"), marker = path.join(directory, "executed");
  writeFileSync(fake, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');\n`); chmodSync(fake, 0o755);
  const cli = fileURLToPath(new URL(`../skills/comprehensive-review/scripts/${provider}-review.mjs`, import.meta.url));
  const result = spawnSync(process.execPath, [cli, "--cwd", root, "--scope", "working-tree", "--expected-fingerprint", fingerprint.fingerprint], {
    env: { ...process.env, [`JIG_${provider.toUpperCase()}_BIN`]: fake }, encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /CAPTURE_INCOMPLETE/);
  assert.match(result.stderr, /module/); assert.doesNotMatch(result.stderr, /scope.*changed|does not match/);
  assert.equal(existsSync(marker), false); assert.equal(result.stdout, "");
});
