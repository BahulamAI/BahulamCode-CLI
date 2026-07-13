/**
 * Tests for slash commands.
 */

import { handleSlashCommand, COMMANDS } from '../src/ui/slash-commands.mjs';
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

console.log('\n\x1b[1mtest-slash-commands.mjs\x1b[0m\n');

// Capture output
const origStderr = process.stderr.write.bind(process.stderr);
const origStdout = process.stdout.write.bind(process.stdout);
let captured = '';
function capture() { captured = ''; process.stderr.write = (s) => { captured += s; }; process.stdout.write = (s) => { captured += s; }; }
function restore() { process.stderr.write = origStderr; process.stdout.write = origStdout; }

test('COMMANDS has 18 entries', () => {
    assert.strictEqual(Object.keys(COMMANDS).length, 18);
});

test('/help lists commands', () => {
    capture();
    handleSlashCommand('/help', {});
    restore();
    assert.ok(captured.includes('/help'));
    assert.ok(captured.includes('/help worktree'));
    assert.ok(captured.includes('/exit'));
    assert.ok(captured.includes('ESC'));
});

test('/help category lists focused commands', () => {
    capture();
    handleSlashCommand('/help worktree', {});
    restore();
    assert.ok(captured.includes('Worktree'));
    assert.ok(captured.includes('/git'));
    assert.ok(captured.includes('/diff'));
});

test('/git shows git status', () => {
    capture();
    handleSlashCommand('/git', {});
    restore();
    // Should output something (we're in a git repo)
    assert.ok(captured.length > 0);
});

test('/diff shows git diff', () => {
    capture();
    handleSlashCommand('/diff', {});
    restore();
    // Should not crash
    assert.ok(true);
});

test('/clear resets formatter state', () => {
    const formatter = { toolCalls: [1, 2], toolCount: 2, phases: new Map([['a', 'b']]), changes: [1] };
    capture();
    handleSlashCommand('/clear', { formatter });
    restore();
    assert.strictEqual(formatter.toolCount, 0);
    assert.strictEqual(formatter.phases.size, 0);
    assert.strictEqual(formatter.changes.length, 0);
});

test('/sessions works without session dir', () => {
    capture();
    handleSlashCommand('/sessions', {});
    restore();
    assert.ok(captured.includes('No sessions') || captured.includes('Recent'));
});

test('/model shows model info', () => {
    capture();
    handleSlashCommand('/model', { model: 'claude-sonnet-4' });
    restore();
    assert.ok(captured.includes('claude-sonnet-4'));
});

test('/tokens shows token count', () => {
    const formatter = { tokenCount: { input: 100, output: 50 } };
    capture();
    handleSlashCommand('/tokens', { formatter });
    restore();
    assert.ok(captured.includes('100'));
    assert.ok(captured.includes('150'));
});

test('/cost shows estimated cost', () => {
    const formatter = { tokenCount: { input: 1000, output: 500 } };
    capture();
    handleSlashCommand('/cost', { formatter });
    restore();
    assert.ok(captured.includes('$'));
});

test('/index shows indexing message', () => {
    capture();
    handleSlashCommand('/index', {});
    restore();
    assert.ok(captured.includes('index') || captured.includes('Index') || captured.includes('BM25'));
});

test('unknown command shows error', () => {
    capture();
    handleSlashCommand('/unknown_xyz', {});
    restore();
    assert.ok(captured.includes('Unknown command'));
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
