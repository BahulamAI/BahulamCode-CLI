/**
 * Tests for the canonical slash-command catalog.
 *
 * The pre-PRD-081 version of this test file exercised handler functions
 * that lived alongside the catalog. Those handlers were dead code (the
 * REPL never called them) and were removed as part of consolidating onto
 * ui/slash-commands.mjs. This suite now covers the catalog + normalizer.
 */

import assert from 'node:assert';
import {
  COMMANDS,
  HELP_GROUPS,
  HELP_GROUP_ALIASES,
  LEGACY_COMMAND_HINTS,
  NAMESPACED_COMMANDS,
  normalizeCommandInput,
} from '../src/ui/slash-commands.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`);
    failed++;
  }
}

console.log('\n\x1b[1mtest-slash-commands.mjs\x1b[0m\n');

// ── shape ────────────────────────────────────────────────────────────

test('COMMANDS entries are all { "/name": "description" } strings', () => {
  for (const [name, desc] of Object.entries(COMMANDS)) {
    assert.ok(name.startsWith('/'), `command "${name}" missing leading slash`);
    assert.strictEqual(typeof desc, 'string', `${name} description not a string`);
    assert.ok(desc.length > 0, `${name} description is empty`);
  }
});

test('COMMANDS includes the essential commands', () => {
  for (const c of ['/help', '/exit', '/new', '/clear', '/git', '/model']) {
    assert.ok(c in COMMANDS, `missing essential command ${c}`);
  }
});

test('HELP_GROUPS entries reference known commands', () => {
  for (const group of HELP_GROUPS) {
    assert.ok(group.key, `group missing key: ${JSON.stringify(group)}`);
    assert.ok(group.title, `group missing title`);
    assert.ok(Array.isArray(group.commands), `group.commands not an array`);
    for (const [cmd] of group.commands) {
      const base = cmd.split(/\s+/)[0];
      assert.ok(base.startsWith('/'), `group cmd "${cmd}" missing leading slash`);
    }
  }
});

test('HELP_GROUP_ALIASES resolves keys and lowercased titles', () => {
  for (const group of HELP_GROUPS) {
    assert.strictEqual(HELP_GROUP_ALIASES.get(group.key), group);
    assert.strictEqual(HELP_GROUP_ALIASES.get(group.title.toLowerCase()), group);
  }
});

// ── normalizeCommandInput ────────────────────────────────────────────

test('normalizeCommandInput: plain command passthrough', () => {
  const n = normalizeCommandInput('/help');
  assert.deepStrictEqual(n, { cmd: '/help', rest: '', rawCmd: '/help', aliasTarget: null });
});

test('normalizeCommandInput: preserves arguments as rest', () => {
  const n = normalizeCommandInput('/tasks add write more tests');
  assert.strictEqual(n.cmd, '/tasks');
  assert.strictEqual(n.rest, 'add write more tests');
});

test('normalizeCommandInput: lowercases the command token', () => {
  const n = normalizeCommandInput('/HELP');
  assert.strictEqual(n.cmd, '/help');
  assert.strictEqual(n.rawCmd, '/help');
});

test('normalizeCommandInput: namespaced /status metrics -> /stats', () => {
  const n = normalizeCommandInput('/status metrics');
  assert.strictEqual(n.cmd, '/stats');
  assert.strictEqual(n.rest, '');
  assert.strictEqual(n.aliasTarget, null); // namespaced hit, not legacy alias
});

test('normalizeCommandInput: namespaced with trailing args', () => {
  const n = normalizeCommandInput('/history expand 3');
  assert.strictEqual(n.cmd, '/expand');
  assert.strictEqual(n.rest, '3');
});

test('normalizeCommandInput: legacy flat cmd carries aliasTarget', () => {
  const n = normalizeCommandInput('/cost');
  assert.strictEqual(n.cmd, '/cost');
  assert.strictEqual(n.aliasTarget, '/status cost');
});

test('normalizeCommandInput: unknown legacy flat cmd has no alias', () => {
  const n = normalizeCommandInput('/help');
  assert.strictEqual(n.aliasTarget, null);
});

test('normalizeCommandInput: handles empty/whitespace input', () => {
  assert.strictEqual(normalizeCommandInput('').cmd, '');
  assert.strictEqual(normalizeCommandInput('   ').cmd, '');
});

// ── LEGACY_COMMAND_HINTS + NAMESPACED_COMMANDS integrity ────────────

test('LEGACY_COMMAND_HINTS targets resolve through NAMESPACED_COMMANDS', () => {
  // Every legacy alias should reverse-resolve — e.g. /cost => /status cost,
  // and /status cost should namespace-resolve back to /cost.
  for (const [legacy, hint] of Object.entries(LEGACY_COMMAND_HINTS)) {
    const [namespace, sub] = hint.split(/\s+/);
    const namespacedMap = NAMESPACED_COMMANDS[namespace];
    assert.ok(namespacedMap, `LEGACY hint "${legacy}" -> "${hint}" but no namespace ${namespace}`);
    assert.strictEqual(namespacedMap[sub], legacy,
      `LEGACY hint "${legacy}" -> "${hint}" but namespace does not resolve back`);
  }
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
