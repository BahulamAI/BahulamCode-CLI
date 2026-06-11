/**
 * Tests for EventFormatter — all 22 SSE event types.
 */

import { EventFormatter } from '../src/ui/formatter.mjs';
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

console.log('\n\x1b[1mtest-formatter.mjs\x1b[0m\n');

// Capture stderr to verify output
const origWrite = process.stderr.write.bind(process.stderr);
const origStdout = process.stdout.write.bind(process.stdout);
let captured = '';
function capture() { captured = ''; process.stderr.write = (s) => { captured += s; }; process.stdout.write = (s) => { captured += s; }; }
function restore() { process.stderr.write = origWrite; process.stdout.write = origStdout; }

test('renders status event', () => {
    const f = new EventFormatter();
    capture();
    const handled = f.render({ type: 'status', data: { message: 'Working...' } });
    restore();
    assert.ok(handled);
    assert.ok(captured.includes('Working...'));
});

test('renders session_info (verbose)', () => {
    const f = new EventFormatter({ verbose: true });
    capture();
    f.render({ type: 'session_info', data: { session_id: 'sess_1', task_id: 'task_1' } });
    restore();
    assert.ok(captured.includes('sess_1'));
    assert.strictEqual(f.sessionInfo.task_id, 'task_1');
});

test('renders plan with milestones', () => {
    const f = new EventFormatter();
    capture();
    f.render({ type: 'plan', data: { milestones: [
        { name: 'Setup', status: 'completed' },
        { name: 'Build', status: 'started' },
        { name: 'Test', status: 'pending' },
    ]}});
    restore();
    assert.ok(captured.includes('Setup'));
    assert.ok(captured.includes('Build'));
});

test('renders content to stdout', () => {
    const f = new EventFormatter();
    capture();
    f.render({ type: 'content', data: { text: 'Hello world' } });
    restore();
    assert.ok(captured.includes('Hello world'));
});

test('renders thinking only when verbose', () => {
    const f1 = new EventFormatter({ verbose: false });
    capture();
    f1.render({ type: 'thinking', data: { text: 'Pondering...' } });
    restore();
    assert.ok(!captured.includes('Pondering'));

    const f2 = new EventFormatter({ verbose: true });
    capture();
    f2.render({ type: 'thinking', data: { text: 'Pondering...' } });
    restore();
    assert.ok(captured.includes('Pondering'));
});

test('renders tool_call with counter', () => {
    const f = new EventFormatter();
    capture();
    f.render({ type: 'tool_call', data: { call_id: 'tc1', tool: 'read_file', args: { path: 'x.js' } } });
    restore();
    assert.strictEqual(f.toolCount, 1);
    assert.ok(captured.includes('Read file'));
    assert.ok(captured.includes('x.js'));
    assert.ok(captured.includes('[1]'));
});

test('renders tool_done (verbose)', () => {
    const f = new EventFormatter({ verbose: true });
    capture();
    f.render({ type: 'tool_done', data: { tool: 'read_file', duration_ms: 50 } });
    restore();
    assert.ok(captured.includes('done'));
});

test('renders phase_update with icons', () => {
    const f = new EventFormatter();
    capture();
    f.render({ type: 'phase_update', data: { phase: 'Planning', status: 'started' } });
    restore();
    assert.ok(captured.includes('Planning'));
    assert.strictEqual(f.phases.get('Planning'), 'started');
});

test('renders phase_start (legacy mapped)', () => {
    const f = new EventFormatter();
    capture();
    f.render({ type: 'phase_start', data: { phase: 'Coding', description: 'Writing code' } });
    restore();
    assert.ok(captured.includes('Coding'));
});

test('renders phase_summary', () => {
    const f = new EventFormatter();
    capture();
    f.render({ type: 'phase_summary', data: { phase: 'Done', summary: 'All good', changes: 3 } });
    restore();
    assert.ok(captured.includes('All good'));
});

test('renders worker_update', () => {
    const f = new EventFormatter();
    capture();
    f.render({ type: 'worker_update', data: { worker: 'Coder', status: 'writing auth module' } });
    restore();
    assert.ok(captured.includes('Coder'));
});

test('renders delegation', () => {
    const f = new EventFormatter();
    capture();
    f.render({ type: 'delegation', data: { from: 'Orchestrator', to: 'Architect', instruction: 'Plan auth' } });
    restore();
    assert.ok(captured.includes('Orchestrator'));
    assert.ok(captured.includes('Architect'));
});

test('renders change (create/edit)', () => {
    const f = new EventFormatter();
    capture();
    f.render({ type: 'change', data: { type: 'create', path: 'src/auth.js' } });
    f.render({ type: 'change', data: { type: 'edit', path: 'src/main.js' } });
    restore();
    assert.strictEqual(f.changes.length, 2);
});

test('renders error', () => {
    const f = new EventFormatter();
    capture();
    f.render({ type: 'error', data: { message: 'Something broke' } });
    restore();
    assert.ok(captured.includes('Something broke'));
});

test('renders complete with summary', () => {
    const f = new EventFormatter();
    f.toolCount = 5;
    capture();
    f.render({ type: 'complete', data: { summary: 'All done', changes: 3, duration_s: 2.5 } });
    restore();
    assert.ok(captured.includes('All done'));
    assert.ok(captured.includes('3 changes'));
    assert.ok(captured.includes('5 tool calls'));
});

test('renders cancelled', () => {
    const f = new EventFormatter();
    capture();
    f.render({ type: 'cancelled', data: { reason: 'user request' } });
    restore();
    assert.ok(captured.includes('Cancelled'));
});

test('renders paused', () => {
    const f = new EventFormatter();
    capture();
    f.render({ type: 'paused', data: { checkpoint: 'cp_1' } });
    restore();
    assert.ok(captured.includes('Paused'));
});

test('renders resumed', () => {
    const f = new EventFormatter();
    capture();
    f.render({ type: 'resumed', data: { instruction: 'focus on auth' } });
    restore();
    assert.ok(captured.includes('Resumed'));
});

test('renders pause_instruction', () => {
    const f = new EventFormatter();
    capture();
    f.render({ type: 'pause_instruction', data: { instruction: 'skip tests' } });
    restore();
    assert.ok(captured.includes('skip tests'));
});

test('unknown event returns false (non-verbose)', () => {
    const f = new EventFormatter();
    capture();
    const handled = f.render({ type: 'unknown_future_event', data: {} });
    restore();
    assert.strictEqual(handled, false);
});

test('unknown event logged in verbose', () => {
    const f = new EventFormatter({ verbose: true });
    capture();
    f.render({ type: 'future_event', data: { x: 1 } });
    restore();
    assert.ok(captured.includes('future_event'));
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
