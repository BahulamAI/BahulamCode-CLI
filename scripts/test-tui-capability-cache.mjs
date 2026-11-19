import assert from 'node:assert/strict';
import { terminalIdentity, cachedCapabilities, rememberCapabilities } from '../src/daemon/rust-tui-capability-cache.mjs';

const env = { TERM: 'xterm-256color', TERM_PROGRAM: 'test', TERM_PROGRAM_VERSION: '1' };
const key = terminalIdentity(env);
const probe = { complete: true, status: 'active (DA1 received)', synchronized_output: true,
  keyboard_protocol: false, cell_pixels: [9, 18], window_pixels: [900, 720], background_rgb: [255,255,255] };
rememberCapabilities(key, probe, 1000);
const cached = JSON.parse(cachedCapabilities(key, 1001));
assert.equal(cached.synchronized_output, true);
assert.equal(cached.keyboard_protocol, false);
assert.equal(cached.cell_pixels, undefined, 'Never reuse stale viewport geometry');
assert.equal(cached.background_rgb, undefined, 'Never reuse a stale background color');
assert.equal(cachedCapabilities(terminalIdentity({ ...env, TERM_PROGRAM_VERSION: '2' }), 1001), '');
assert.equal(cachedCapabilities(terminalIdentity({ ...env, SSH_TTY: '/dev/test' }), 1001), '');
assert.equal(terminalIdentity({ ...env, API_KEY: 'must-not-affect-cache' }), key);
rememberCapabilities(key, { ...probe, synchronized_output: 'yes' }, 2000);
assert.equal(JSON.parse(cachedCapabilities(key, 2001)).synchronized_output, true);
rememberCapabilities(key, { ...probe, complete: false }, 2000);
assert.equal(cachedCapabilities(key, 301000), '', 'Timeouts and reads must not extend TTL');
for (let n = 0; n < 9; n++) rememberCapabilities(`terminal-${n}`, probe, 1000);
assert.equal(cachedCapabilities('terminal-0', 1001), '', 'Cache is bounded');
assert.notEqual(cachedCapabilities('terminal-8', 1001), '');
console.log('Rust terminal capability cache: passed');
