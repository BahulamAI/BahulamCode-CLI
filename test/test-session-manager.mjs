/**
 * Tests for SessionManager.
 */

import { SessionManager } from '../src/core/session-manager.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert';

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

console.log('\n\x1b[1mtest-session-manager.mjs\x1b[0m\n');

// Use a temp directory for tests
const testDir = path.join(process.cwd(), '__test_session_tmp__');

function cleanup() {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
}

cleanup(); // clean before
fs.mkdirSync(testDir, { recursive: true });

test('start creates state.json', () => {
    const mgr = new SessionManager(testDir);
    mgr.start('add auth');
    const statePath = path.join(testDir, '.tarang', 'state.json');
    assert.ok(fs.existsSync(statePath));
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.strictEqual(state.instruction, 'add auth');
    assert.strictEqual(state.status, 'running');
});

test('setSessionInfo updates state', () => {
    const mgr = new SessionManager(testDir);
    mgr.start('test');
    mgr.setSessionInfo({ task_id: 't1', session_id: 's1' });
    const state = mgr.loadState();
    assert.strictEqual(state.task_id, 't1');
    assert.strictEqual(state.session_id, 's1');
});

test('recordToolCall increments counter', () => {
    const mgr = new SessionManager(testDir);
    mgr.start('test');
    mgr.recordToolCall('read_file');
    mgr.recordToolCall('shell');
    assert.strictEqual(mgr.currentState.tool_count, 2);
});

test('complete saves to history', () => {
    const mgr = new SessionManager(testDir);
    mgr.start('test complete');
    mgr.complete('All done');
    const state = mgr.loadState();
    assert.strictEqual(state.status, 'completed');
    assert.strictEqual(state.summary, 'All done');

    const sessions = mgr.listSessions();
    assert.ok(sessions.length > 0);
    assert.ok(sessions.some(s => s.instruction === 'test complete'));
});

test('fail saves error', () => {
    const mgr = new SessionManager(testDir);
    mgr.start('test fail');
    mgr.fail('Something broke');
    const state = mgr.loadState();
    assert.strictEqual(state.status, 'failed');
    assert.strictEqual(state.error, 'Something broke');
});

test('cancel saves status', () => {
    const mgr = new SessionManager(testDir);
    mgr.start('test cancel');
    mgr.cancel();
    const state = mgr.loadState();
    assert.strictEqual(state.status, 'cancelled');
});

test('pause saves status', () => {
    const mgr = new SessionManager(testDir);
    mgr.start('test pause');
    mgr.pause();
    const state = mgr.loadState();
    assert.strictEqual(state.status, 'paused');
});

test('listSessions returns recent sessions', () => {
    const mgr = new SessionManager(testDir);
    const sessions = mgr.listSessions();
    assert.ok(Array.isArray(sessions));
    assert.ok(sessions.length >= 3); // complete, fail, cancel
});

test('loadState returns null when no state', () => {
    const emptyDir = path.join(testDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    const mgr = new SessionManager(emptyDir);
    const state = mgr.loadState();
    assert.strictEqual(state, null);
});

// Cleanup
cleanup();

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
