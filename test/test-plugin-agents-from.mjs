// Test the `config.agents_from` loader path in manifest.mjs.
// A plugin can declare `agents_from: <relative-dir>` and manifest parsing
// will auto-load every *.yaml file in that dir as an agent (each file's
// root is a full agent block: slug, name, role, tools, system_prompt).
// This coexists with inline `config.agents:` — both are merged.
//
// Run: node test/test-plugin-agents-from.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePluginManifestFile } from '../src/plugins/manifest.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; })
    .catch(err => { console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.stack || err.message}`); failed++; });
}

function withTempPlugin(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-agents-from-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf-8');
    }
    return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

console.log('\n\x1b[1mtest-plugin-agents-from.mjs\x1b[0m\n');

await test('agents_from auto-loads *.yaml agents from a subdirectory', async () => {
  await withTempPlugin({
    'plugin.yaml': `apiVersion: bahulam.plugin/1
kind: Plugin
metadata:
  name: agents-from-test
  version: 0.0.1
config:
  tools: []
  agents_from: ./config/agents/
`,
    'config/agents/first.yaml': `slug: first
name: First Agent
role: specialist
tools: [ls]
system_prompt: "You are the first."
`,
    'config/agents/second.yaml': `slug: second
name: Second Agent
role: reviewer
tools: [read_file]
system_prompt: "You are the second."
`,
  }, (dir) => {
    const manifest = parsePluginManifestFile(path.join(dir, 'plugin.yaml'));
    const slugs = (manifest.config.agents || []).map(a => a.slug).sort();
    assert.deepStrictEqual(slugs, ['first', 'second']);
  });
});

await test('agents_from + inline agents both merge into config.agents[]', async () => {
  await withTempPlugin({
    'plugin.yaml': `apiVersion: bahulam.plugin/1
kind: Plugin
metadata:
  name: mixed-test
  version: 0.0.1
config:
  tools: []
  agents_from: ./config/agents/
  agents:
    - slug: inline-only
      name: Inline
      role: specialist
      tools: []
      system_prompt: "inline"
`,
    'config/agents/from-file.yaml': `slug: from-file
name: File Agent
role: specialist
tools: []
system_prompt: "loaded from file"
`,
  }, (dir) => {
    const manifest = parsePluginManifestFile(path.join(dir, 'plugin.yaml'));
    const slugs = (manifest.config.agents || []).map(a => a.slug).sort();
    assert.deepStrictEqual(slugs, ['from-file', 'inline-only']);
  });
});

await test('agents_from silently skips when directory is absent', async () => {
  await withTempPlugin({
    'plugin.yaml': `apiVersion: bahulam.plugin/1
kind: Plugin
metadata:
  name: missing-dir
  version: 0.0.1
config:
  tools: []
  agents_from: ./config/does-not-exist/
`,
  }, (dir) => {
    const manifest = parsePluginManifestFile(path.join(dir, 'plugin.yaml'));
    assert.deepStrictEqual(manifest.config.agents || [], []);
  });
});

await test('agents_from ignores non-yaml files', async () => {
  await withTempPlugin({
    'plugin.yaml': `apiVersion: bahulam.plugin/1
kind: Plugin
metadata:
  name: filter-test
  version: 0.0.1
config:
  tools: []
  agents_from: ./config/agents/
`,
    'config/agents/keep.yaml': `slug: keep
name: Keep
role: specialist
tools: []
system_prompt: "kept"
`,
    'config/agents/README.md': '# ignored',
    'config/agents/notes.txt': 'ignored',
  }, (dir) => {
    const manifest = parsePluginManifestFile(path.join(dir, 'plugin.yaml'));
    const slugs = (manifest.config.agents || []).map(a => a.slug);
    assert.deepStrictEqual(slugs, ['keep']);
  });
});

await test('workspace_agent loads a single yaml file as the primary agent', async () => {
  await withTempPlugin({
    'plugin.yaml': `apiVersion: bahulam.plugin/1
kind: Plugin
metadata:
  name: workspace-agent-test
  version: 0.0.1
config:
  tools: []
  workspace_agent: ./config/workspace.yaml
  agents_from: ./config/agents/
`,
    'config/workspace.yaml': `slug: director
name: The Director
role: primary
tools: [delegate]
system_prompt: "primary/entry agent"
`,
    'config/agents/animator.yaml': `slug: animator
name: The Animator
role: specialist
tools: []
system_prompt: "sub-agent"
`,
  }, (dir) => {
    const manifest = parsePluginManifestFile(path.join(dir, 'plugin.yaml'));
    const slugs = (manifest.config.agents || []).map(a => a.slug).sort();
    assert.deepStrictEqual(slugs, ['animator', 'director']);
    const director = manifest.config.agents.find(a => a.slug === 'director');
    assert.strictEqual(director.role, 'primary');
  });
});

await test('agents_from load order is alphabetical (stable)', async () => {
  await withTempPlugin({
    'plugin.yaml': `apiVersion: bahulam.plugin/1
kind: Plugin
metadata:
  name: order-test
  version: 0.0.1
config:
  tools: []
  agents_from: ./config/agents/
`,
    'config/agents/z-last.yaml':   `slug: z-last\nname: Z\nrole: specialist\ntools: []\nsystem_prompt: z\n`,
    'config/agents/a-first.yaml':  `slug: a-first\nname: A\nrole: specialist\ntools: []\nsystem_prompt: a\n`,
    'config/agents/m-middle.yaml': `slug: m-middle\nname: M\nrole: specialist\ntools: []\nsystem_prompt: m\n`,
  }, (dir) => {
    const manifest = parsePluginManifestFile(path.join(dir, 'plugin.yaml'));
    const slugs = (manifest.config.agents || []).map(a => a.slug);
    assert.deepStrictEqual(slugs, ['a-first', 'm-middle', 'z-last']);
  });
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
