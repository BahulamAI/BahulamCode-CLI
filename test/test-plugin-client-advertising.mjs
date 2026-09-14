import assert from 'node:assert';

import { BahulamStreamClient } from '../src/core/stream-client.mjs';

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
  const agents = [
    {
      slug: 'excalidraw-spec',
      name: 'Excalidraw Spec',
      description: 'Entry architecture agent',
      tools: ['scan_repository', 'export_diagram'],
      entry_agent: true,
      _plugin_name: 'excalidraw-spec',
    },
    {
      slug: 'options-analyst',
      name: 'Options Analyst',
      description: 'Hidden helper agent',
      tools: ['opt_price', 'opt_chain'],
      _plugin_name: 'options-terminal',
    },
  ];
  const tools = [
    { name: 'scan_repository', description: 'scan', input_schema: { type: 'object', properties: {} }, _plugin_name: 'excalidraw-spec' },
    { name: 'export_diagram', description: 'export', input_schema: { type: 'object', properties: {} }, _plugin_name: 'excalidraw-spec' },
    { name: 'opt_price', description: 'price', input_schema: { type: 'object', properties: {} }, _plugin_name: 'options-terminal' },
    { name: 'opt_chain', description: 'chain', input_schema: { type: 'object', properties: {} }, _plugin_name: 'options-terminal' },
  ];
  return {
    listAgents: () => agents,
    listTools: () => tools,
  };
}

console.log('\n\x1b[1mtest-plugin-client-advertising.mjs\x1b[0m\n');

await test('advertises admitted plugin agents and direct tools owned only by hidden helpers', async () => {
  const registry = pluginRegistry();
  const client = new BahulamStreamClient({
    baseUrl: 'http://example.invalid',
    token: 'test',
    pluginRegistry: registry,
    toolExecutor: {
      listRunnables: () => [
        { slug: 'excalidraw-spec', source_scope: 'plugin' },
      ],
    },
  });

  const clientAgents = client._getPluginAgentSchemas();
  const clientTools = client._getUnclaimedPluginToolSchemas();

  assert.deepStrictEqual(clientAgents.map(agent => agent.slug), ['excalidraw-spec']);
  assert.deepStrictEqual(clientTools.map(tool => tool.name).sort(), ['opt_chain', 'opt_price']);
});

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}

console.log(`\n${passed} passed, ${failed} failed`);
