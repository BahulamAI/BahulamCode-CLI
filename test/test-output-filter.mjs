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

test('detects git inspection commands', () => {
    assert.strictEqual(detectCommandType('git diff --name-status main...feature'), 'git');
    assert.strictEqual(detectCommandType('git show --stat HEAD'), 'git');
    assert.strictEqual(detectCommandType('git status --short'), 'git');
});

test('defaults to generic output profile', () => {
    assert.strictEqual(detectCommandType('echo hello'), 'default');
    assert.strictEqual(detectCommandType('ls -la'), 'default');
});

test('filterOutput preserves important npm WARN lines for install', () => {
    const output = [
        'npm WARN deprecated some-pkg',
        'npm WARN peer dep missing',
        '',
        'added 100 packages in 5s',
        'actual content here',
    ].join('\n');
    const filtered = filterOutput(output, 'npm install');
    assert.ok(filtered.output.includes('npm WARN deprecated some-pkg'));
    assert.strictEqual(filtered.commandType, 'install');
});

test('filterOutput truncates long output', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const output = lines.join('\n');
    const filtered = filterOutput(output, 'npm install');
    assert.ok(filtered.output.includes('truncated'));
    assert.strictEqual(filtered.truncated, true);
});

test('git diff output gets a larger review budget than generic shell output', () => {
    const output = Array.from({ length: 300 }, (_, i) => `+ changed line ${i} `.padEnd(80, 'x')).join('\n');
    const generic = filterOutput(output, 'cat diff.txt');
    const git = filterOutput(output, 'git diff development...feature');
    assert.strictEqual(generic.truncated, true);
    assert.strictEqual(git.truncated, false);
    assert.ok(git.output.includes('+ changed line 299'));
});

test('filterOutput passes through short output', () => {
    const output = 'hello\nworld';
    const filtered = filterOutput(output, 'echo hello');
    assert.strictEqual(filtered.output, output);
    assert.strictEqual(filtered.commandType, 'default');
});

test('null output returns empty metadata result', () => {
    assert.deepStrictEqual(filterOutput(null, 'echo'), {
        output: '',
        commandType: 'default',
        truncated: false,
        originalLines: 0,
        filteredLines: 0,
    });
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
