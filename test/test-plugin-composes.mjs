import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifySource } from '../src/commands/plugin-manage.mjs';
import { parsePluginManifest, parsePluginManifestFile } from '../src/plugins/manifest.mjs';
import { parsePiSource } from '../src/plugins/pi-compose.mjs';
import { preflightPlugin } from '../src/plugins/preflight.mjs';
import { PluginRegistry } from '../src/plugins/registry.mjs';
import { createToolRegistry } from '../src/tools/registry.mjs';

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

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-plugin-composes-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function writePlugin(dir, manifest) {
  fs.writeFileSync(path.join(dir, 'plugin.yaml'), manifest);
}

function writeTool(dir, name = 'local') {
  const toolsDir = path.join(dir, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(
    path.join(toolsDir, `${name}.mjs`),
    'export async function call() { return { success: true, output: "ok" }; }\n',
  );
}

console.log('\n\x1b[1mtest-plugin-composes.mjs\x1b[0m\n');

await test('parses scoped pi sources with version ranges', async () => {
  const parsed = parsePiSource('pi:@ffmpeg/transitions@^2.0.0');
  assert.deepStrictEqual(parsed, {
    kind: 'pi',
    source: 'pi:@ffmpeg/transitions@^2.0.0',
    spec: '@ffmpeg/transitions@^2.0.0',
    package_name: '@ffmpeg/transitions',
    packageName: '@ffmpeg/transitions',
    version_range: '^2.0.0',
    versionRange: '^2.0.0',
  });
});

await test('classifies pi install sources without treating malformed pi specs as registry names', async () => {
  assert.strictEqual(classifySource('pi:@seo/keyword-research@^3.1.0').kind, 'pi');
  assert.deepStrictEqual(classifySource('pi:not valid'), {
    kind: 'invalid',
    reason: 'invalid pi source',
  });
});

await test('normalizes config.composes into the plugin manifest', async () => {
  const manifest = parsePluginManifest(`
apiVersion: bahulam.plugin/1
metadata:
  name: composed-studio
  version: 1.0.0
config:
  composes:
    - source: pi:@ffmpeg/transitions@^2.0.0
      as: fx
      expose: [add_transitions, add_captions]
      verified: true
`);
  assert.strictEqual(manifest.config.composes.length, 1);
  assert.strictEqual(manifest.config.composes[0].package_name, '@ffmpeg/transitions');
  assert.strictEqual(manifest.config.composes[0].as, 'fx');
  assert.deepStrictEqual(manifest.config.composes[0].expose, ['add_transitions', 'add_captions']);
});

await test('legacy top-level spec does not populate plugin config', async () => {
  const manifest = parsePluginManifest(`
apiVersion: bahulam.plugin/1
metadata:
  name: legacy-studio
  version: 1.0.0
spec:
  tools:
    - name: legacy_tool
      tool: ./tools/legacy.mjs
  composes:
    - source: pi:@ffmpeg/transitions@^2.0.0
      expose: [add_captions]
      verified: true
`);
  assert.deepStrictEqual(manifest.config.tools, []);
  assert.deepStrictEqual(manifest.config.composes, []);
});

await test('preflight accepts agent references to namespaced composed tools', async () => {
  await withTempDir(async (dir) => {
    writePlugin(dir, `
apiVersion: bahulam.plugin/1
metadata:
  name: video-studio-pro
  version: 1.0.0
config:
  composes:
    - source: pi:@ffmpeg/transitions@^2.0.0
      as: fx
      expose: [add_captions]
      verified: true
  agents:
    - slug: video-producer
      system_prompt: Produce videos.
      tools: [fx__add_captions]
`);
    const result = await preflightPlugin(dir);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.ok, true);
  });
});

await test('preflight rejects composed tool collisions', async () => {
  await withTempDir(async (dir) => {
    writeTool(dir, 'research');
    writePlugin(dir, `
apiVersion: bahulam.plugin/1
metadata:
  name: collision-studio
  version: 1.0.0
config:
  tools:
    - name: research_keywords
      tool: ./tools/research.mjs
      description: Local keyword research.
  composes:
    - source: pi:@seo/keyword-research@^3.1.0
      expose: [research_keywords]
      verified: true
`);
    const result = await preflightPlugin(dir);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('collides with a composed pi tool')));
  });
});

await test('preflight rejects composed namespaces that collide with MCP server names', async () => {
  await withTempDir(async (dir) => {
    writePlugin(dir, `
apiVersion: bahulam.plugin/1
metadata:
  name: namespace-collision
  version: 1.0.0
config:
  mcpServers:
    fx:
      command: node
      args: [server.mjs]
  composes:
    - source: pi:@ffmpeg/transitions@^2.0.0
      as: fx
      expose: [add_captions]
      verified: true
`);
    const result = await preflightPlugin(dir);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('collides with an MCP server name')));
  });
});

await test('registry exposes composed pi tools with attribution metadata', async () => {
  await withTempDir(async (root) => {
    const pluginDir = path.join(root, 'video-studio-pro');
    fs.mkdirSync(pluginDir);
    writePlugin(pluginDir, `
apiVersion: bahulam.plugin/1
metadata:
  name: video-studio-pro
  version: 1.0.0
config:
  composes:
    - source: pi:@ffmpeg/transitions@^2.0.0
      as: fx
      expose: [add_captions]
      verified: true
`);
    const manifest = parsePluginManifestFile(path.join(pluginDir, 'plugin.yaml'));
    assert.strictEqual(manifest.config.composes.length, 1);

    const registry = new PluginRegistry({ pluginDirs: [root] }).scan();
    const tool = registry.listTools().find(item => item.name === 'fx__add_captions');
    assert.ok(tool);
    assert.strictEqual(tool._composed.kind, 'pi');
    assert.strictEqual(tool._composed.package_name, '@ffmpeg/transitions');
    assert.strictEqual(tool._composed.original_name, 'add_captions');
  });
});

await test('tool registry returns a clear base-runtime result for composed tools', async () => {
  await withTempDir(async (root) => {
    const pluginDir = path.join(root, 'video-studio-pro');
    fs.mkdirSync(pluginDir);
    writePlugin(pluginDir, `
apiVersion: bahulam.plugin/1
metadata:
  name: video-studio-pro
  version: 1.0.0
config:
  composes:
    - source: pi:@ffmpeg/transitions@^2.0.0
      as: fx
      expose: [add_captions]
      verified: true
`);
    const pluginRegistry = new PluginRegistry({ pluginDirs: [root] }).scan();
    const tools = createToolRegistry({ pluginRegistry, exposePluginTools: true });
    assert.strictEqual(tools.has('fx__add_captions'), true);
    const result = await tools.call('fx__add_captions', {});
    assert.strictEqual(result.success, false);
    assert.strictEqual(result._blocked, true);
    assert.strictEqual(result._composed.package_name, '@ffmpeg/transitions');
    assert.ok(result.output.includes('pi runtime execution is not wired yet'));
  });
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
