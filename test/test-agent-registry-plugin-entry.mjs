import assert from 'node:assert';

import { createAgentRegistry } from '../src/agents/registry.mjs';

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
      console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.stack || err.message}`);
      failed++;
    });
}

function pluginRegistry() {
  return {
    listAgents() {
      return [
        {
          slug: 'excalidraw-spec',
          name: 'Excalidraw Spec',
          role: 'specialist',
          description: 'Entry agent',
          tools: ['scan_repository'],
          entry_agent: true,
          _plugin_name: 'excalidraw-spec',
        },
        {
          slug: 'architecture-cartographer',
          name: 'Architecture Cartographer',
          role: 'specialist',
          description: 'Helper agent',
          tools: ['get_architecture'],
          _plugin_name: 'excalidraw-spec',
        },
      ];
    },
  };
}

function settingsLoader(allowlist = []) {
  return () => ({
    settings: {
      plugins: {
        agent_allowlist: allowlist,
      },
    },
  });
}

console.log('\n\x1b[1mtest-agent-registry-plugin-entry.mjs\x1b[0m\n');

await test('main channel admits plugin entry agents without allowlist', async () => {
  const registry = createAgentRegistry({
    cwd: process.cwd(),
    pluginRegistry: pluginRegistry(),
    channel: 'main',
    settingsLoader: settingsLoader([]),
  });

  const slugs = registry.listRunnables().map(agent => agent.slug);
  assert.ok(slugs.includes('excalidraw-spec'));
  assert.ok(!slugs.includes('architecture-cartographer'));
});

await test('main channel admits non-entry plugin agents when allowlisted', async () => {
  const registry = createAgentRegistry({
    cwd: process.cwd(),
    pluginRegistry: pluginRegistry(),
    channel: 'main',
    settingsLoader: settingsLoader(['architecture-cartographer']),
  });

  const slugs = registry.listRunnables().map(agent => agent.slug);
  assert.ok(slugs.includes('excalidraw-spec'));
  assert.ok(slugs.includes('architecture-cartographer'));
});

await test('workspace channel admits all plugin agents', async () => {
  const registry = createAgentRegistry({
    cwd: process.cwd(),
    pluginRegistry: pluginRegistry(),
    channel: 'workspace',
    settingsLoader: settingsLoader([]),
  });

  const slugs = registry.listRunnables().map(agent => agent.slug);
  assert.ok(slugs.includes('excalidraw-spec'));
  assert.ok(slugs.includes('architecture-cartographer'));
});

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}

console.log(`\n${passed} passed, ${failed} failed`);
