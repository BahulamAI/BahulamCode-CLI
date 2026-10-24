import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

// Isolate both the legacy homedir-based state store and BAHULAM_HOME consumers.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-plugin-settings-'));
const originalHomedir = os.homedir;
const originalCwd = process.cwd();
const savedEnv = new Map(['BAHULAM_HOME', 'BAHULAM_SKIP_AUTO_REGISTER'].map(key => [key, process.env[key]]));
os.homedir = () => fixture;
syncBuiltinESMExports();
process.env.BAHULAM_HOME = path.join(fixture, '.bahulam');
process.env.BAHULAM_SKIP_AUTO_REGISTER = 'true';
process.chdir(fixture);
let service;
let resetState;

try {
  const pluginName = 'settings-fixture';
  const pluginRoot = path.join(fixture, '.bahulam', 'plugins');
  const pluginDir = path.join(pluginRoot, pluginName);
  fs.mkdirSync(pluginDir, { recursive: true });
  const raw = {
    apiVersion: 'bahulam.plugin/1',
    metadata: { name: pluginName, version: '1.0.0' },
    config: {
      config: { fields: [
        { name: 'api_key', type: 'password', required: true },
        { name: 'default_secret', credential: true, default: 'fixture-default-secret' },
        { name: 'region', default: 'east' },
        { name: 'retries', type: 'integer', default: 0 },
        { name: 'ratio', type: 'number' },
        { name: 'enabled', type: 'boolean', default: false, required: true },
        { name: 'mode', type: 'select', options: ['fast', 'safe'] },
      ] },
      tools: [{ name: 'settings_probe', tool: './probe.mjs' }],
    },
  };
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(raw));
  fs.writeFileSync(path.join(pluginDir, 'probe.mjs'), `
    export async function call(input, { state }) {
      return { success: true, output: JSON.stringify({ region: state.getConfig('region'),
        hasKey: Boolean(state.getConfig('api_key')), enabled: state.getAllConfig().enabled }) };
    }
  `);
  const { PluginRegistry } = await import('../src/plugins/registry.mjs');
  const { makePluginState, _resetForTests } = await import('../src/plugins/state.mjs');
  resetState = _resetForTests;
  const registry = new PluginRegistry({ pluginDirs: [pluginRoot] }).scan();
  assert.deepEqual(registry.errors, []);
  const manifest = registry.get(pluginName);
  assert.ok(manifest);
  assert.equal(manifest.config.config.fields[0].credential, true, 'password fields are always masked');

  const state = makePluginState(pluginName, { configFields: manifest.config.config.fields });
  assert.ok(state.path.startsWith(fixture + path.sep));
  assert.equal(state.getConfig('region'), 'east');
  assert.equal(state.getConfig('constructor'), null);
  assert.equal(state.getAllConfig().enabled, false);
  assert.equal(state.getAllConfig().retries, 0);
  state.set('_config', { api_key: 'fixture-stored-secret' });
  state.set('public', 'visible');
  assert.equal(state.getConfig('api_key'), 'fixture-stored-secret');
  const summary = state.summary([{ kind: 'kv', key: '_config' }, { kind: 'kv', key: 'public' }]);
  assert.equal(summary.kv.public, 'visible');
  assert.equal(Object.hasOwn(summary.kv, '_config'), false);
  const other = makePluginState('other-fixture', { configFields: manifest.config.config.fields });
  assert.equal(other.getConfig('api_key'), null, 'plugin settings are isolated');

  assert.equal(JSON.stringify(registry.listTools()).includes('fixture-default-secret'), false);
  const { createToolRegistry } = await import('../src/tools/registry.mjs');
  const { createToolExecutor } = await import('../src/core/tool-executor.mjs');
  const { createPluginToolExecutor } = await import('../src/plugins/executor.mjs');
  const classic = createToolRegistry({ pluginRegistry: registry, exposePluginTools: true });
  const core = createToolExecutor({ pluginRegistry: registry, deferProjectIndex: true });
  const direct = await createPluginToolExecutor(manifest);
  // Every path a plugin tool can be invoked through must behave identically.
  for (const execute of [classic.call.bind(classic), core.execute.bind(core), direct.execute.bind(direct)]) {
    const result = await execute('settings_probe', {});
    assert.equal(result.success, true, result.output);
    assert.deepEqual(JSON.parse(result.output), { region: 'east', hasKey: true, enabled: false });
  }
  console.log('✓ plugin settings defaults, isolation, and all executor paths');

  const { createLocalWorkspaceSession, touchLocalWorkspaceSession } = await import('../src/local-service/session-store.mjs');
  const { startLocalWorkspaceService } = await import('../src/local-service/server.mjs');
  const { session, token } = createLocalWorkspaceSession({ targetPath: fixture });
  touchLocalWorkspaceSession(session.id, { plugin: { name: pluginName } });
  service = await startLocalWorkspaceService({ session, token, port: 0 });
  async function request(endpoint, body, authenticated = true) {
    const response = await fetch(new URL(endpoint, service.url), {
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'X-Bahulam-Local-Token': token } : {}) },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(JSON.stringify(data).includes('fixture-stored-secret'), false);
    assert.equal(JSON.stringify(data).includes('fixture-default-secret'), false);
    return { status: response.status, data };
  }
  const configPath = `/api/plugin-config/${pluginName}`;
  const statePath = `/api/plugin-state/${pluginName}`;
  assert.equal((await request(configPath, undefined, false)).status, 401);
  assert.equal((await request('/api/plugin-config/other-fixture')).status, 403);
  assert.equal((await request('/api/plugin-state/other-fixture', { op: 'keys' })).status, 403);
  const initial = await request(configPath);
  assert.equal(initial.status, 200);
  assert.equal(initial.data.configured, true, 'false/zero defaults satisfy required fields');
  assert.equal(initial.data.values.api_key, '***set***');
  assert.equal(initial.data.values.default_secret, '***set***');
  assert.equal(initial.data.fields.find(field => field.name === 'default_secret').default, null);
  const saved = await request(configPath, { values: { retries: '3', ratio: '0.25', enabled: true, mode: 'safe', region: 'west' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.values.retries, 3);
  assert.equal(saved.data.values.ratio, 0.25);
  for (const api_key of ['', '***set***']) {
    assert.equal((await request(configPath, { values: { api_key } })).status, 200);
    assert.equal(state.getConfig('api_key'), 'fixture-stored-secret');
  }
  for (const values of [[], { unknown: 'x' }, { enabled: 'false' }, { retries: false }, { retries: '' },
    { retries: 1.2 }, { ratio: 'Infinity' }, { mode: 'invalid' }, { region: {} }]) {
    const previous = state.get('_config');
    assert.equal((await request(configPath, { values })).status, 400);
    assert.deepEqual(state.get('_config'), previous, 'invalid settings must not partially persist');
  }
  for (const op of ['get', 'set', 'patch', 'delete']) {
    const blocked = await request(statePath, { op, key: '_config', value: {}, partial: {} });
    assert.equal(blocked.status, 500);
    assert.match(blocked.data.message, /only available through/);
  }
  for (const op of ['getConfig', 'getAllConfig']) {
    const blocked = await request(statePath, { op, key: 'api_key' });
    assert.equal(blocked.status, 500);
    assert.match(blocked.data.message, /not available/);
  }
  for (const sql of ['SELECT value FROM kv', 'SELECT value FROM "kv" WHERE key = ?', 'SELECT * FROM main.KV']) {
    const blocked = await request(statePath, { op: 'query', sql, params: ['_config'] });
    assert.equal(blocked.status, 500);
    assert.match(blocked.data.message, /protected plugin config/);
  }
  assert.equal((await request(statePath, { op: 'keys' })).data.result.includes('_config'), false);
  assert.equal((await request(statePath, { op: 'set', key: 'public', value: 'updated' })).status, 200);
  assert.equal((await request(statePath, { op: 'get', key: 'public' })).data.result, 'updated');
  const cleared = await request(configPath, { values: { api_key: null } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.configured, false);
  assert.deepEqual(cleared.data.missing, ['api_key']);
  assert.equal(state.getConfig('api_key'), null);
  const restored = await request(configPath, { values: { api_key: 'fixture-stored-secret' } });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.configured, true);
  assert.equal(restored.data.values.api_key, '***set***');
  await service.close();
  service = null;
  resetState();
  const reopened = makePluginState(pluginName, { configFields: manifest.config.config.fields });
  assert.equal(reopened.getConfig('api_key'), 'fixture-stored-secret');
  assert.equal(reopened.getConfig('region'), 'west');
  console.log('✓ authenticated plugin settings API, credential masking, protected state, and scoped access');
} finally {
  if (service) await service.close();
  resetState?.();
  process.chdir(originalCwd);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  os.homedir = originalHomedir;
  syncBuiltinESMExports();
  fs.rmSync(fixture, { recursive: true, force: true });
}
