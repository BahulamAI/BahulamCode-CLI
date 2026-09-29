import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginRegistry } from '../src/plugins/registry.mjs';
import { SkillsLoader } from '../src/skills/loader.mjs';
import { loadMcpServers } from '../src/mcp/loader.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-plugin-runtime-'));
try {
  const pluginDir = path.join(root, 'fixture');
  fs.mkdirSync(path.join(pluginDir, 'skills', 'fixture-skill'), { recursive: true });
  const server = path.join(pluginDir, 'tools', 'mcp.mjs');
  fs.mkdirSync(path.dirname(server), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'skills', 'fixture-skill', 'SKILL.md'), `---
name: fixture-skill
description: A skill shipped by a plugin.
---
Use the plugin-owned procedure.
`);
  fs.writeFileSync(server, `
import readline from 'node:readline';
const rl=readline.createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);let result={};if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};if(m.method==='tools/list')result={tools:[{name:'ping',description:'Ping',inputSchema:{type:'object'}}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});
`);
  fs.writeFileSync(path.join(pluginDir, 'plugin.yaml'), `
apiVersion: bahulam.plugin/1
metadata: { name: runtime-fixture, version: 1.0.0 }
config:
  skills:
    - id: fixture-skill
      source: ./skills/fixture-skill
  mcpServers:
    fixture:
      command: node
      args: [./tools/mcp.mjs]
`);
  const registry = new PluginRegistry({ pluginDirs: [root] }).scan();
  assert.equal(registry.listSkillSources().length, 1);
  const skills = new SkillsLoader({ homeDir: path.join(root, 'home') }).load(root).loadPluginSkills(registry);
  assert.match(skills.view('fixture-skill').instructions, /plugin-owned/);
  assert.equal(skills.list()[0].source, 'plugin:runtime-fixture:fixture-skill');

  const registered = [];
  const loaded = await loadMcpServers({ registerMcpTool(plugin, name, tool) { registered.push({ plugin, name, tool }); } }, {}, { pluginRegistry: registry });
  assert.deepEqual(registered, [{ plugin: 'runtime-fixture', name: 'fixture', tool: 'ping' }]);
  await loaded.disconnectAll();
  console.log('plugin runtime loader tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
