/**
 * Test that PluginLoader / PluginRegistry correctly handles the three
 * plugin categories:
 *   1. Tool-only   — config.tools only, no agents
 *   2. Agent-only  — config.agents only, no tools
 *   3. Mixed       — both config.tools and config.agents
 *
 * Verifies that listTools() and listAgents() return exactly the right
 * tools and agents from each category, with no cross-contamination.
 *
 * Writes plugin.json (not YAML) to avoid requiring a YAML serializer in test.
 * Each tool definition includes `tool:` (handler path) so validation passes.
 *
 * Run: node test/test-plugin-loader-categories.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PluginRegistry } from '../src/plugins/registry.mjs';
import { PluginLoader } from '../src/plugins/loader.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      passed++;
    })
    .catch(err => {
      console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`);
      failed++;
    });
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-plugin-cat-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

// ── helpers ──────────────────────────────────────────────────────────────

function writePlugin(pluginsDir, name, overrides) {
  const dir = path.join(pluginsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  // The normalizer reads from `config.*`. The config key holds tools,
  // agents, composes, state, etc.
  const manifest = {
    apiVersion: 'bahulam.plugin/1',
    kind: 'Plugin',
    metadata: { name, version: '1.0.0', description: `Test: ${name}` },
    config: overrides.config || {},
  };
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

function tool(name) {
  return { name, description: `The ${name} tool`, tool: `./tools/${name}.mjs`, parameters: { type: 'object', properties: {} } };
}

function agent(slug) {
  return { slug, name: slug, role: 'assistant', description: `Agent ${slug}`, tools: [], system_prompt: `Be ${slug}` };
}

// ── tests ────────────────────────────────────────────────────────────────

console.log('\n\x1b[1mtest-plugin-loader-categories.mjs\x1b[0m\n');

await test('tool-only plugin: listTools returns tools, listAgents returns empty', async () => {
  await withTempDir(async (dir) => {
    writePlugin(dir, 'tool-only', {
      config: {
        tools: [tool('ping'), tool('echo')],
      },
    });

    const registry = new PluginRegistry({ pluginDirs: [dir] });
    registry.scan();

    const tools = registry.listTools();
    const agents = registry.listAgents();

    assert.strictEqual(tools.length, 2, 'tool-only plugin should expose 2 tools');
    assert.strictEqual(agents.length, 0, 'tool-only plugin should expose 0 agents');
    const toolNames = tools.map(t => t.name).sort();
    assert.deepStrictEqual(toolNames, ['echo', 'ping']);
    for (const t of tools) {
      assert.strictEqual(t._plugin_name, 'tool-only');
    }
  });
});

await test('agent-only plugin: listAgents returns agents, listTools returns empty', async () => {
  await withTempDir(async (dir) => {
    writePlugin(dir, 'agent-only', {
      config: {
        agents: [agent('helper'), agent('researcher')],
      },
    });

    const registry = new PluginRegistry({ pluginDirs: [dir] });
    registry.scan();

    const tools = registry.listTools();
    const agents = registry.listAgents();

    assert.strictEqual(tools.length, 0, 'agent-only plugin should expose 0 tools');
    assert.strictEqual(agents.length, 2, 'agent-only plugin should expose 2 agents');
    const agentSlugs = agents.map(a => a.slug).sort();
    assert.deepStrictEqual(agentSlugs, ['helper', 'researcher']);
    for (const a of agents) {
      assert.strictEqual(a._plugin_name, 'agent-only');
    }
  });
});

await test('mixed plugin: both tools and agents are listed', async () => {
  await withTempDir(async (dir) => {
    writePlugin(dir, 'mixed', {
      config: {
        tools: [tool('fetch_data')],
        agents: [agent('data-analyst')],
      },
    });

    const registry = new PluginRegistry({ pluginDirs: [dir] });
    registry.scan();

    const tools = registry.listTools();
    const agents = registry.listAgents();

    assert.strictEqual(tools.length, 1, 'mixed plugin should expose 1 tool');
    assert.strictEqual(agents.length, 1, 'mixed plugin should expose 1 agent');
    assert.strictEqual(tools[0].name, 'fetch_data');
    assert.strictEqual(tools[0]._plugin_name, 'mixed');
    assert.strictEqual(agents[0].slug, 'data-analyst');
    assert.strictEqual(agents[0]._plugin_name, 'mixed');
  });
});

await test('all three categories in one scan: no cross-contamination', async () => {
  await withTempDir(async (dir) => {
    writePlugin(dir, 'tools-a', {
      config: { tools: [tool('ta1')] },
    });
    writePlugin(dir, 'agents-b', {
      config: { agents: [agent('ab1')] },
    });
    writePlugin(dir, 'mixed-c', {
      config: {
        tools: [tool('mc1')],
        agents: [agent('mc-agent')],
      },
    });

    const registry = new PluginRegistry({ pluginDirs: [dir] });
    registry.scan();

    const tools = registry.listTools();
    const agents = registry.listAgents();
    const toolNames = tools.map(t => t.name).sort();
    const agentSlugs = agents.map(a => a.slug).sort();

    assert.strictEqual(tools.length, 2, 'expected 2 tools total');
    assert.deepStrictEqual(toolNames, ['mc1', 'ta1']);
    assert.strictEqual(agents.length, 2, 'expected 2 agents total');
    assert.deepStrictEqual(agentSlugs, ['ab1', 'mc-agent']);

    for (const t of tools) {
      const expected = t.name === 'ta1' ? 'tools-a' : 'mixed-c';
      assert.strictEqual(t._plugin_name, expected);
    }
    for (const a of agents) {
      const expected = a.slug === 'ab1' ? 'agents-b' : 'mixed-c';
      assert.strictEqual(a._plugin_name, expected);
    }
  });
});

await test('PluginLoader.load() discovers all three categories', async () => {
  await withTempDir(async (dir) => {
    writePlugin(dir, 'only-tools', {
      config: { tools: [tool('t1')] },
    });
    writePlugin(dir, 'only-agents', {
      config: { agents: [agent('a1')] },
    });
    writePlugin(dir, 'both', {
      config: {
        tools: [tool('t2')],
        agents: [agent('a2')],
      },
    });

    const loader = new PluginLoader({ pluginDirs: [dir] });
    loader.load();

    const plugins = loader.getInstalledPlugins();
    assert.strictEqual(plugins.length, 3, 'loader should discover all 3 plugins');

    const tools = loader.registry.listTools();
    const agents = loader.registry.listAgents();

    const toolNames = tools.map(t => t.name).sort();
    const agentSlugs = agents.map(a => a.slug).sort();

    assert.strictEqual(tools.length, 2, 'expected 2 tools across all plugins');
    assert.deepStrictEqual(toolNames, ['t1', 't2']);
    assert.strictEqual(agents.length, 2, 'expected 2 agents across all plugins');
    assert.deepStrictEqual(agentSlugs, ['a1', 'a2']);
  });
});

await test('legacy spec manifest exposes tools and agents', async () => {
  await withTempDir(async (dir) => {
    const pluginDir = path.join(dir, 'legacy-spec');
    fs.mkdirSync(pluginDir, { recursive: true });
    const manifest = {
      apiVersion: 'bahulam.plugin/1',
      kind: 'Plugin',
      metadata: { name: 'legacy-spec', version: '1.0.0' },
      spec: {
        tools: [tool('legacy_tool')],
        agents: [agent('legacy-agent')],
      },
    };
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2));

    const registry = new PluginRegistry({ pluginDirs: [dir] });
    registry.scan();

    assert.strictEqual(registry.count(), 1, 'legacy spec plugin should register');
    assert.deepStrictEqual(registry.listTools().map(t => t.name), ['legacy_tool']);
    assert.deepStrictEqual(registry.listAgents().map(a => a.slug), ['legacy-agent']);
  });
});

await test('plugin with neither tools nor agents is listed but has empty surfaces', async () => {
  await withTempDir(async (dir) => {
    writePlugin(dir, 'empty', { config: {} });

    const registry = new PluginRegistry({ pluginDirs: [dir] });
    registry.scan();

    assert.strictEqual(registry.count(), 1, 'empty plugin should still be registered');
    assert.strictEqual(registry.listTools().length, 0);
    assert.strictEqual(registry.listAgents().length, 0);
  });
});

// ── summary ──────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
