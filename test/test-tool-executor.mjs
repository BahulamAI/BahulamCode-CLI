/**
 * Unit tests for Tool Executor Bridge.
 */

import { createToolExecutor } from '../src/core/tool-executor.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
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

console.log('\n\x1b[1mtest-tool-executor.mjs\x1b[0m\n');

const executor = createToolExecutor();

// Test 1: listTools returns all 14 tool names
await test('listTools returns 14 tools', async () => {
    const tools = executor.listTools();
    assert.strictEqual(tools.length, 14);
    assert.ok(tools.includes('shell'));
    assert.ok(tools.includes('read_file'));
    assert.ok(tools.includes('write_file'));
    assert.ok(tools.includes('edit_file'));
    assert.ok(tools.includes('list_files'));
    assert.ok(tools.includes('search_code'));
    assert.ok(tools.includes('read_files'));
    assert.ok(tools.includes('delete_file'));
    assert.ok(tools.includes('get_file_info'));
});

// Test 2: read_file reads existing file
await test('read_file reads package.json', async () => {
    const result = await executor.execute('read_file', { path: 'package.json' });
    assert.strictEqual(result.success, true);
    assert.ok(result.content.includes('@devtarang/orca'));
});

// Test 3: read_file on missing file returns error
await test('read_file on missing file returns error', async () => {
    const result = await executor.execute('read_file', { path: 'nonexistent_file_xyz.txt' });
    assert.strictEqual(result.success, false);
});

// Test 4: shell runs echo
await test('shell runs echo', async () => {
    const result = await executor.execute('shell', { command: 'echo hello_tarang' });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('hello_tarang'));
});

// Test 5: list_files returns file array
await test('list_files returns files', async () => {
    const result = await executor.execute('list_files', { pattern: '*.json' });
    assert.strictEqual(result.success, true);
    assert.ok(Array.isArray(result.files));
    assert.ok(result.files.length > 0);
});

// Test 6: get_file_info returns stat data
await test('get_file_info returns stat', async () => {
    const result = await executor.execute('get_file_info', { path: 'package.json' });
    assert.strictEqual(result.success, true);
    assert.ok(result.size > 0);
    assert.strictEqual(result.type, 'file');
});

// Test 7: write_file + delete_file round-trip
await test('write_file + delete_file round-trip', async () => {
    const testPath = '__test_write_delete__.txt';
    const writeResult = await executor.execute('write_file', { path: testPath, content: 'test content' });
    assert.strictEqual(writeResult.success, true);
    assert.ok(fs.existsSync(testPath));

    const deleteResult = await executor.execute('delete_file', { path: testPath });
    assert.strictEqual(deleteResult.success, true);
    assert.ok(!fs.existsSync(testPath));
});

// Test 8: unknown tool returns error
await test('unknown tool returns error', async () => {
    const result = await executor.execute('nonexistent_tool', {});
    assert.strictEqual(result.success, false);
    assert.ok(result.output.includes('Unknown tool'));
});

// Test 9: validate_structure checks files
await test('validate_structure checks files', async () => {
    const result = await executor.execute('validate_structure', {
        expected: ['package.json', 'src/index.mjs', 'missing_file.xyz'],
    });
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(result.missing, ['missing_file.xyz']);
});

// Test 10: search_files with query
await test('search_files returns results', async () => {
    const result = await executor.execute('search_files', { query: 'index' });
    assert.strictEqual(result.success, true);
    assert.ok(Array.isArray(result.files));
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
