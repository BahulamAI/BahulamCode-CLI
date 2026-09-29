/**
 * Tests for the plugin Shared Blackboard (src/plugins/state.mjs).
 *
 * Runs each case in a fresh temp $HOME so plugin state files land in
 * a scoped directory and never touch the user's real ~/.bahulam/data.
 * The module caches DB handles process-wide, so _resetForTests() is
 * called between cases to force re-open under the new $HOME.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makePluginState, _resetForTests } from '../src/plugins/state.mjs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-state-'));
  const savedHome = process.env.HOME;
  process.env.HOME = tmp;
  _resetForTests();
  try {
    await fn(tmp);
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failed++;
  } finally {
    _resetForTests();
    process.env.HOME = savedHome;
    // Best-effort cleanup; tmp dirs are per-test so no shared state.
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log('\nplugin state — makePluginState()');

await test('bootstrap creates ~/.bahulam/data/<plugin>/state.db idempotently', async (tmp) => {
  const s1 = makePluginState('hello-world');
  const s2 = makePluginState('hello-world');
  const expected = path.join(tmp, '.bahulam', 'data', 'hello-world', 'state.db');
  assert.strictEqual(s1.path, expected);
  assert.strictEqual(s2.path, expected);
  assert.ok(fs.existsSync(expected), 'state.db should exist on disk');
});

await test('rejects a bogus plugin name to keep the data dir untraversable', async () => {
  assert.throws(() => makePluginState('../etc/passwd'), /invalid plugin name/);
  assert.throws(() => makePluginState('bad name with spaces'), /invalid plugin name/);
  assert.throws(() => makePluginState(''), /invalid plugin name/);
});

await test('kv: get/set/delete round-trips arbitrary JSON', async () => {
  const s = makePluginState('demo');
  assert.strictEqual(s.get('missing'), null);
  assert.strictEqual(s.get('missing', 42), 42);
  s.set('watchlist', ['AAPL', 'TSLA']);
  assert.deepStrictEqual(s.get('watchlist'), ['AAPL', 'TSLA']);
  s.set('prefs', { theme: 'dark', density: 3 });
  assert.deepStrictEqual(s.get('prefs'), { theme: 'dark', density: 3 });
  assert.strictEqual(s.delete('prefs'), true);
  assert.strictEqual(s.get('prefs'), null);
  assert.strictEqual(s.delete('prefs'), false, 'delete on absent key is a no-op');
});

await test('kv.patch deep-merges nested objects and replaces arrays', async () => {
  const s = makePluginState('demo');
  s.set('prefs', { theme: 'dark', nested: { a: 1, b: 2 } });
  const p1 = s.patch('prefs', { nested: { b: 20, c: 3 } });
  assert.deepStrictEqual(p1, { theme: 'dark', nested: { a: 1, b: 20, c: 3 } });
  // Arrays replace, not merge — index-wise merges are usually a bug.
  s.set('order', [1, 2, 3]);
  const p2 = s.patch('order', [9]);
  assert.deepStrictEqual(p2, [9]);
});

await test('records: append+list preserves order and payloads', async () => {
  const s = makePluginState('demo');
  const id1 = s.append('runs', { start: 6, steps: 8 });
  const id2 = s.append('runs', { start: 27, steps: 111 });
  assert.strictEqual(id2, id1 + 1, 'record ids should auto-increment');
  const desc = s.list('runs');
  assert.strictEqual(desc.length, 2);
  assert.strictEqual(desc[0].payload.start, 27, 'default order is newest-first');
  const asc = s.list('runs', { order: 'asc' });
  assert.strictEqual(asc[0].payload.start, 6);
  const capped = s.list('runs', { limit: 1 });
  assert.strictEqual(capped.length, 1);
});

await test('query() exposes raw SQL for SELECTs and DML', async () => {
  const s = makePluginState('demo');
  s.append('runs', { x: 1 });
  s.append('runs', { x: 2 });
  const rows = s.query('SELECT COUNT(*) AS n FROM records WHERE stream = ?', ['runs']);
  assert.strictEqual(rows[0].n, 2);
  const del = s.query('DELETE FROM records WHERE stream = ?', ['runs']);
  assert.strictEqual(del.changes, 2);
  assert.strictEqual(s.list('runs').length, 0);
});

await test('emit hook fires (debounced) after writes and flushes on close', async () => {
  const events = [];
  const s = makePluginState('demo', { emit: e => events.push(e) });
  s.set('a', 1);
  s.set('a', 2); // debounced with the first → still one event for kv:a
  s.set('b', 1); // separate key → its own event
  s.append('log', { m: 'hi' });
  s.append('log', { m: 'yo' }); // debounced → one event for records:log
  s.close(); // flushes pending timers synchronously
  const seen = events.map(e => `${e.kind}:${e.target}`).sort();
  assert.deepStrictEqual(seen, ['kv:a', 'kv:b', 'records:log']);
  // Every event should carry the plugin name and a well-formed timestamp.
  for (const e of events) {
    assert.strictEqual(e.plugin, 'demo');
    assert.match(e.at, /^\d{4}-\d{2}-\d{2}T/);
  }
});

await test('emit hook is optional — writes work without one', async () => {
  const s = makePluginState('demo');
  s.set('anything', 'ok');
  assert.strictEqual(s.get('anything'), 'ok');
});

await test('plugin isolation: plugin A cannot see plugin B\'s data', async () => {
  const a = makePluginState('alpha');
  const b = makePluginState('beta');
  a.set('secret', 'A-only');
  a.append('log', { who: 'alpha' });
  b.set('secret', 'B-only');
  // Different DB files → each plugin sees only its own writes.
  assert.strictEqual(a.get('secret'), 'A-only');
  assert.strictEqual(b.get('secret'), 'B-only');
  assert.strictEqual(a.list('log')[0].payload.who, 'alpha');
  assert.strictEqual(b.list('log').length, 0);
  // Paths reflect the boundary too.
  assert.notStrictEqual(a.path, b.path);
});

await test('keys() lists every kv key currently set, sorted', async () => {
  const s = makePluginState('demo');
  s.set('z', 1); s.set('a', 1); s.set('m', 1);
  assert.deepStrictEqual(s.keys(), ['a', 'm', 'z']);
  s.delete('m');
  assert.deepStrictEqual(s.keys(), ['a', 'z']);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
