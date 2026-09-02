import assert from 'node:assert';
import * as fs from 'node:fs';
import {
  classifyField,
  restoreSession,
  snapshotSession,
} from '../src/daemon/session-core.mjs';

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

console.log('\n\x1b[1mtest-session-core.mjs\x1b[0m\n');

test('active sub-agent lanes stay client-owned and do not snapshot', () => {
  const source = {
    id: 'sess_1',
    activeSubAgentRuns: new Map([['run_1', { type: 'explore' }]]),
  };
  const snapshot = snapshotSession(source);

  assert.strictEqual(classifyField('activeSubAgentRuns'), 'client');
  assert.strictEqual(snapshot.id, 'sess_1');
  assert.ok(!Object.prototype.hasOwnProperty.call(snapshot, 'activeSubAgentRuns'));

  const target = { activeSubAgentRuns: new Map([['live', { type: 'review' }]]) };
  restoreSession({ activeSubAgentRuns: {} }, target);
  assert.ok(target.activeSubAgentRuns instanceof Map);
  assert.strictEqual(target.activeSubAgentRuns.size, 1);
});

test('REPL does not call Map methods through unsafe optional chains', () => {
  const replSource = fs.readFileSync(new URL('../src/terminal/repl.mjs', import.meta.url), 'utf-8');
  assert.ok(replSource.includes('function activeSubAgentRunsMap()'));
  assert.ok(!/activeSubAgentRuns\?\.\s*(get|set|delete|clear)\s*\(/.test(replSource));
  assert.ok(!/activeSubAgentRuns\?\.\s*size\b/.test(replSource));
  assert.ok(!/activeSubAgentRuns\.\s*(get|set|delete|clear|values)\s*\(/.test(replSource));
  assert.ok(!/activeSubAgentRuns\.\s*size\b/.test(replSource));
});

console.log(`\n${passed} tests passed\n`);
