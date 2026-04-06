/**
 * Tests for output filtering and command type detection.
 */

import { detectCommandType, filterOutput } from '../src/core/output-filter.mjs';
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

console.log('\n\x1b[1mtest-output-filter.mjs\x1b[0m\n');

test('detects npm install', () => {
    assert.strictEqual(detectCommandType('npm install express'), 'install');
});

test('detects pip install', () => {
    assert.strictEqual(detectCommandType('pip install flask'), 'install');
});

test('detects npm test', () => {
    assert.strictEqual(detectCommandType('npm test'), 'test');
});

test('detects pytest', () => {
    assert.strictEqual(detectCommandType('pytest tests/'), 'test');
});

test('detects npm run build', () => {
    assert.strictEqual(detectCommandType('npm run build'), 'build');
});

test('detects cargo build', () => {
    assert.strictEqual(detectCommandType('cargo build'), 'build');
});

test('defaults to run', () => {
    assert.strictEqual(detectCommandType('echo hello'), 'run');
    assert.strictEqual(detectCommandType('ls -la'), 'run');
});

test('filterOutput removes npm WARN noise for install', () => {
    const output = [
        'npm WARN deprecated some-pkg',
        'npm WARN peer dep missing',
        '',
        'added 100 packages in 5s',
        'actual content here',
    ].join('\n');
    const filtered = filterOutput(output, 'npm install');
    assert.ok(!filtered.includes('npm WARN'));
});

test('filterOutput truncates long output', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const output = lines.join('\n');
    const filtered = filterOutput(output, 'npm install');
    assert.ok(filtered.includes('truncated'));
});

test('filterOutput passes through short output', () => {
    const output = 'hello\nworld';
    const filtered = filterOutput(output, 'echo hello');
    assert.strictEqual(filtered, output);
});

test('null output returns null', () => {
    assert.strictEqual(filterOutput(null, 'echo'), null);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
