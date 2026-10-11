import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = file => readFileSync(path.join(repo, file), 'utf8');
const json = file => JSON.parse(read(file));

// These plugins orchestrate Codex subagents, so they have no Claude Code manifest and are absent
// from the Claude marketplace. scripts/install.sh rejects their skills for Claude for the same reason.
const codexOnlyPlugins = ['jig-review'];

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
