import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { availableUpdate, promptUpdate } from '../src/terminal/cli-update.mjs';

const pkg = { name: '@bahulam/code', version: '0.2.2-beta.2' };
async function check(current, candidate, tag) {
  return availableUpdate({ ...pkg, version: current }, async url => {
    assert.equal(url, 'https://registry.npmjs.org/%40bahulam%2Fcode/' + tag);
    return { ok: true, json: async () => ({ version: candidate }) };
  });
}
assert.equal(await check(pkg.version, '0.2.2-beta.10', 'beta'), '0.2.2-beta.10');
assert.equal(await check('0.2.2-beta.10', pkg.version, 'beta'), undefined);
assert.equal(await check(pkg.version, pkg.version, 'beta'), undefined);
assert.equal(await check('0.2.1', '0.2.2-beta.3', 'latest'), undefined);
assert.equal(await check('0.2.1', '0.2.2', 'latest'), '0.2.2');
const home = await mkdtemp(path.join(os.tmpdir(), 'bahulam-update-'));
try {
  const notices = [];
  const installs = [];
  const options = { pkg, version: '0.2.2-beta.3', home, notify: (...args) => notices.push(args), install: spec => installs.push(spec) };
  for (const value of ['cancel', null, 'skip']) {
    await promptUpdate({ ...options, choose: (_title, choices) => {
      assert.deepEqual(choices.map(choice => choice.value), ['cancel', 'install', 'skip']);
      return value;
    } });
  }
  await promptUpdate({ ...options, choose: () => assert.fail('skipped version prompted again') });
  assert.deepEqual(installs, []);
  await promptUpdate({ ...options, version: '0.2.2-beta.4', choose: () => 'install' });
  assert.deepEqual(installs, ['@bahulam/code@0.2.2-beta.4']);
  assert.match(notices.at(-1)[0], /Installed/);
  await promptUpdate({ ...options, version: '0.2.2-beta.4', choose: () => 'install', install: () => { throw Error('npm failed'); } });
  assert.match(notices.at(-1)[1], /npm install -g @bahulam\/code@0\.2\.2-beta\.4/);
} finally {
  await rm(home, { force: true, recursive: true });
}
console.log('CLI update channel, picker choices, skip persistence and install outcomes passed.');
