/**
 * E2E Tool Round-Trip Tests — real tool execution via bridge.
 */

import { createToolExecutor } from '../src/core/tool-executor.mjs';
import assert from 'node:assert';

let passed = 0;
let failed = 0;

function test(name, fn) {
    return fn().then(() => {
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
        passed++;
    }).catch(err => {
        console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`);
        failed++;
    });
}

console.log('\n\x1b[1me2e-tool-roundtrip.mjs\x1b[0m\n');

const executor = createToolExecutor();

// Test: read_file reads real file and returns content
await test('read_file reads package.json with content', async () => {
    const result = await executor.execute('read_file', { path: 'package.json' });
    assert.strictEqual(result.success, true);
    assert.ok(result.content.includes('@tarang/cli'));
    assert.strictEqual(result._tool, 'read_file');
});

// Test: shell runs echo and captures output
await test('shell echo captures output', async () => {
    const result = await executor.execute('shell', { command: 'echo roundtrip_test_123' });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('roundtrip_test_123'));
    assert.strictEqual(result._tool, 'shell');
});

// Test: list_files returns file list from glob
await test('list_files returns array of files', async () => {
    const result = await executor.execute('list_files', { pattern: 'src/**/*.mjs' });
    assert.strictEqual(result.success, true);
    assert.ok(Array.isArray(result.files));
    assert.ok(result.files.length > 0, 'should find .mjs files');
    assert.ok(result.files.some(f => f.includes('index.mjs')));
});

// Test: search_code finds pattern in files
await test('search_code finds TarangStreamClient', async () => {
    const result = await executor.execute('search_code', {
        pattern: 'TarangStreamClient',
        path: 'src/core',
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('TarangStreamClient'));
});

// Test: get_file_info returns file metadata
await test('get_file_info returns size and type', async () => {
    const result = await executor.execute('get_file_info', { path: 'package.json' });
    assert.strictEqual(result.success, true);
    assert.ok(result.size > 0);
    assert.strictEqual(result.type, 'file');
});

// Test: read_files batch reads multiple files
await test('read_files reads multiple files', async () => {
    const result = await executor.execute('read_files', { paths: ['package.json', 'README.md'] });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.files.length, 2);
    assert.ok(result.files[0].success);
});

// Test: validate_structure with existing and missing files
await test('validate_structure detects missing files', async () => {
    const result = await executor.execute('validate_structure', {
        expected: ['package.json', 'does_not_exist.xyz'],
    });
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(result.missing, ['does_not_exist.xyz']);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
