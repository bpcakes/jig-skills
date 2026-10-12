import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = file => readFileSync(path.join(repo, file), 'utf8');
const json = file => JSON.parse(read(file));

// jig-review uses Codex subagents; jig-orchestration currently requires a Codex
// coordinator and installs that review pair. Neither has a Claude manifest or
// marketplace entry. Keep these exclusions aligned with scripts/install.sh.
const codexOnlyPlugins = ['jig-review', 'jig-orchestration'];

const plugins = readdirSync(path.join(repo, 'plugins')).sort();
const codexMarketplace = json('.agents/plugins/marketplace.json');
const claudeMarketplace = json('.claude-plugin/marketplace.json');
const codexManifest = plugin => json(`plugins/${plugin}/.codex-plugin/plugin.json`);

test('both marketplaces list every plugin directory except the Codex-only exclusions', () => {
  assert.deepEqual(codexMarketplace.plugins.map(plugin => plugin.name).sort(), plugins);
  assert.deepEqual(claudeMarketplace.plugins.map(plugin => plugin.name).sort(),
    plugins.filter(plugin => !codexOnlyPlugins.includes(plugin)));
  assert.equal(claudeMarketplace.name, codexMarketplace.name);
  for (const entry of claudeMarketplace.plugins) {
    assert.equal(entry.source, `./plugins/${entry.name}`);
    assert.equal(entry.category, codexMarketplace.plugins.find(plugin => plugin.name === entry.name).category, entry.name);
    assert.equal(entry.description, codexManifest(entry.name).description, entry.name);
    assert.equal(entry.version, undefined, `${entry.name}: plugin.json owns the version`);
  }
});

test('Claude plugin manifests carry the Codex metadata', () => {
  for (const plugin of plugins) {
    const file = `plugins/${plugin}/.claude-plugin/plugin.json`;
    if (codexOnlyPlugins.includes(plugin)) {
      assert.equal(existsSync(path.join(repo, file)), false, `${plugin} is Codex-only`);
      continue;
    }
    const codex = codexManifest(plugin), claude = json(file);
    assert.equal(claude.name, plugin);
    for (const field of ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license']) {
      assert.deepEqual(claude[field], codex[field], `${plugin} ${field}`);
    }
    assert.deepEqual(claude.keywords, codex.keywords.filter(keyword => keyword !== 'codex-skills'), `${plugin} keywords`);
    assert.equal(claude.skills, undefined, `${plugin}: skills/ is discovered by default`);
  }
});

const claudeCli = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;

test('the Claude Code CLI validates the marketplace and every listed plugin', {
  skip: claudeCli ? false : 'claude unavailable: install Claude Code to validate the manifests with its CLI.',
}, () => {
  for (const target of ['.', ...claudeMarketplace.plugins.map(plugin => `plugins/${plugin.name}`)]) {
    const result = spawnSync('claude', ['plugin', 'validate', '--strict', target], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, `${target}\n${result.stdout}${result.stderr}`);
  }
});

const skills = plugins.flatMap(plugin => readdirSync(path.join(repo, 'plugins', plugin, 'skills'))
  .map(skill => `plugins/${plugin}/skills/${skill}`)).sort();

// Codex reads agents/openai.yaml; Claude Code reads the SKILL.md frontmatter. Both default to implicit invocation.
function codexAllowsImplicitInvocation(skill) {
  const file = path.join(repo, skill, 'agents/openai.yaml');
  const match = existsSync(file) && readFileSync(file, 'utf8').match(/^\s+allow_implicit_invocation:\s*(true|false)\s*$/m);
  return match ? match[1] === 'true' : true;
}

function claudeAllowsImplicitInvocation(skill) {
  const frontmatter = read(`${skill}/SKILL.md`).match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, `${skill}: SKILL.md frontmatter`);
  const match = frontmatter[1].match(/^disable-model-invocation:\s*(true|false)\s*$/m);
  return match ? match[1] === 'false' : true;
}

test('every skill applies the same implicit-invocation policy in Codex and Claude Code', () => {
  const explicitOnly = skills.filter(skill => !codexAllowsImplicitInvocation(skill));
  assert.ok(explicitOnly.length > 0, 'expected explicit-only skills');
  for (const skill of skills) {
    assert.equal(claudeAllowsImplicitInvocation(skill), codexAllowsImplicitInvocation(skill), skill);
  }
});
