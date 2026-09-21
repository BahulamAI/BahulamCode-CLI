import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BahulamAuth } from '../src/auth/bahulam-auth.mjs';
import { TarangAuth } from '../src/auth/tarang-auth.mjs';
import { createSessionAuthSync } from '../src/terminal/startup.mjs';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-auth-sessions-'));
const previous = { BAHULAM_HOME: process.env.BAHULAM_HOME, B0_TOKEN: process.env.B0_TOKEN, KEPLER_TOKEN: process.env.KEPLER_TOKEN };
delete process.env.B0_TOKEN;
delete process.env.KEPLER_TOKEN;
let checks = 0;
try {
  for (const Auth of [BahulamAuth, TarangAuth]) {
    process.env.BAHULAM_HOME = path.join(fixture, Auth.name);
    const auth = new Auth();
    auth.loadCredentials(); // This terminal starts before login in the other one.
    const moduleUrl = new URL('../src/auth/bahulam-auth.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { BahulamAuth } from ${JSON.stringify(moduleUrl)}; new BahulamAuth().saveCredentials({token: 'fixture-login', mode: 'remote'});`],
    { cwd: fixture, env: process.env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    auth.saveCredentials({ model_config: { reasoning: 'chosen-model' } });
    assert.equal(auth.loadCredentials().token, 'fixture-login', 'settings from an old process must not erase another process login');
    assert.equal(auth.getRawConfig().mode, 'remote');
    const other = new Auth();
    other.saveCredentials({ token: 'fixture-new-login' });
    auth.saveProviderKey('openrouter', 'fixture-provider');
    assert.equal(other.loadCredentials().token, 'fixture-new-login', 'old token cannot replace newer login');
    assert.equal(other.loadCredentials().openRouterKey, 'fixture-provider');
    other.logout();
    auth.setMode('local');
    assert.equal(auth.loadCredentials().token, null, 'settings must not resurrect a logged-out token');
    assert.equal(auth.loadCredentials().openRouterKey, null);
    other.saveCredentials({ token: 'fixture-disk' });
    process.env.B0_TOKEN = 'fixture-env';
    assert.equal(auth.loadCredentials().token, 'fixture-env', 'explicit environment override remains authoritative');
    auth.setMode('remote');
    delete process.env.B0_TOKEN;
    assert.equal(auth.loadCredentials().token, 'fixture-disk', 'environment override must not be persisted');
    const config = path.join(process.env.BAHULAM_HOME, 'config.json');
    if (process.platform !== 'win32') assert.equal(fs.statSync(config).mode & 0o777, 0o600);
    fs.writeFileSync(config, '{invalid');
    assert.throws(() => auth.saveCredentials({ mode: 'local' }));
    assert.equal(fs.readFileSync(config, 'utf8'), '{invalid', 'unreadable config is never overwritten');
    fs.unlinkSync(config);
    other.saveCredentials({ token: 'fixture-before-sync' });
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        other.saveCredentials({ token: 'fixture-after-sync' });
        return { ok: true, json: async () => ({ models: { reasoning: 'stale-account-model' } }) };
      };
      assert.equal(await auth.syncSettings(), null, 'settings for an old account are ignored');
      assert.equal(auth.loadCredentials().token, 'fixture-after-sync');
      assert.equal(auth.loadCredentials().models.reasoning, undefined);
    } finally { globalThis.fetch = originalFetch; }
    checks++;
  }

  let credentials = { token: null, backendUrl: 'https://fixture.invalid' };
  const state = { user: null, model: 'chosen-model', modelOverrides: {} };
  let requests = 0;
  let release;
  const refresh = createSessionAuthSync({ auth: { loadCredentials: () => ({ ...credentials }) }, session: state,
    fetchProfile: async () => { requests++; return new Promise(resolve => { release = resolve; }); } });
  await refresh();
  assert.equal(requests, 0);
  credentials.token = 'fixture-account-a';
  const first = refresh();
  const duplicate = refresh();
  assert.equal(requests, 1, 'profile requests deduplicate while in flight');
  release({ id: 'a', default_reasoning_model: 'profile-model' });
  await Promise.all([first, duplicate]);
  assert.equal(state.user.id, 'a');
  assert.equal(state.model, 'chosen-model', 'profile refresh preserves explicit model');
  await refresh();
  assert.equal(requests, 1, 'unchanged timer ticks make no network request');
  Object.assign(state, { subscriptionTier: 'pro', creditsTotal: 100, rateLimit: { remaining: 4 } });
  credentials.token = 'fixture-account-b';
  const switched = refresh();
  assert.equal(state.user, null);
  assert.equal(state.creditsTotal, null);
  assert.equal(state.subscriptionTier, null);
  assert.equal(state.rateLimit, null);
  const staleResponse = release;
  credentials.token = null;
  await refresh();
  staleResponse({ id: 'b' });
  await switched;
  assert.equal(state.user, null, 'late profile must not undo shared logout');
  credentials.token = 'fixture-account-c';
  const oldBackend = refresh();
  const oldBackendResponse = release;
  credentials.backendUrl = 'https://another-fixture.invalid';
  const newBackend = refresh();
  release({ id: 'new-backend' });
  await newBackend;
  oldBackendResponse({ id: 'old-backend' });
  await oldBackend;
  assert.equal(state.user.id, 'new-backend', 'late response cannot cross backend identities');
  const explicit = refresh({ force: true });
  release({ id: 'verified-account' });
  await explicit;
  assert.equal(state.user.id, 'verified-account');
  console.log(checks + ' auth implementations passed cross-process persistence; shared login/logout, stale profile, model and environment regressions passed.');
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(fixture, { recursive: true, force: true });
}
