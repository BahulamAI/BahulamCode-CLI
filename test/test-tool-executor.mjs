/**
 * Unit tests for Tool Executor Bridge.
 */

import { createToolExecutor } from '../src/core/tool-executor.mjs';
import { ProjectRegistry } from '../src/tools/project-overview.mjs';
import * as fs from 'node:fs';
import * as os from 'node:os';
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
const unregisteredExecutor = createToolExecutor();
await test('file tools reject paths before project registration', async () => {
    const result = await unregisteredExecutor.execute('read_file', {
        path: path.join(process.cwd(), 'package.json'),
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.output.includes('outside registered project roots'));
});

const overview = await executor.execute('get_project_overview', { path: process.cwd() });
assert.strictEqual(overview.success, true);
const projectId = overview.project_resource.project_id;

// Test 1: listTools returns the complete bridge inventory
await test('listTools returns all 23 tools', async () => {
    const tools = executor.listTools();
    assert.strictEqual(tools.length, 23);
    assert.ok(tools.includes('shell'));
    assert.ok(tools.includes('read_file'));
    assert.ok(tools.includes('write_file'));
    assert.ok(tools.includes('edit_file'));
    assert.ok(tools.includes('list_files'));
    assert.ok(tools.includes('search_code'));
    assert.ok(tools.includes('read_files'));
    assert.ok(tools.includes('delete_file'));
    assert.ok(tools.includes('get_file_info'));
    assert.ok(tools.includes('run_tests'));
    assert.ok(tools.includes('git_diff'));
    assert.ok(tools.includes('git_status'));
    assert.ok(tools.includes('analyze_code'));
    assert.ok(tools.includes('get_project_overview'));
    assert.ok(tools.includes('skills_list'));
    assert.ok(tools.includes('skill_view'));
});

await test('project overview is session-stable and exposes project_id', async () => {
    const repeated = await executor.execute('get_project_overview', { path: process.cwd() });
    assert.strictEqual(repeated.success, true);
    assert.strictEqual(repeated.already_registered, true);
    assert.strictEqual(repeated.project_resource.project_id, projectId);
    assert.ok(repeated.project_resource.environment);
    assert.strictEqual(repeated.project_resource.environment.node, process.version);
    assert.ok(repeated.project_resource.environment.platform);
});

await test('search_code routes through the registered project index', async () => {
    const result = await executor.execute('search_code', {
        project_id: projectId,
        query: 'createToolExecutor',
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('tool-executor'));
});

// Test 2: read_file reads existing file
await test('read_file reads package.json', async () => {
    const result = await executor.execute('read_file', { path: 'package.json' });
    assert.strictEqual(result.success, true);
    assert.ok(result.content.includes('@axplusb/kepler'));
});

// Test 3: read_file on missing file returns error
await test('read_file on missing file returns error', async () => {
    const result = await executor.execute('read_file', { path: 'nonexistent_file_xyz.txt' });
    assert.strictEqual(result.success, false);
});

await test('read_file allows OS temp scratch files', async () => {
    const scratchFile = path.join(os.tmpdir(), `kepler-scratch-${Date.now()}.txt`);
    fs.writeFileSync(scratchFile, 'scratch output\n');
    try {
        const result = await executor.execute('read_file', { path: scratchFile });
        assert.strictEqual(result.success, true);
        assert.ok(result.content.includes('scratch output'));
    } finally {
        fs.rmSync(scratchFile, { force: true });
    }
});

await test('read_file allows registered custom scratch roots', async () => {
    const root = path.join(process.cwd(), '__kepler_custom_scratch__');
    fs.mkdirSync(root, { recursive: true });
    const scratchFile = path.join(root, 'agent-output.txt');
    fs.writeFileSync(scratchFile, 'custom scratch output\n');
    try {
        const projectRegistry = new ProjectRegistry();
        projectRegistry.addScratchRoot(root);
        const scratchExecutor = createToolExecutor({ projectRegistry });
        const result = await scratchExecutor.execute('read_file', { path: scratchFile });
        assert.strictEqual(result.success, true);
        assert.ok(result.content.includes('custom scratch output'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

await test('read_file allows project .kepler/tmp scratch files', async () => {
    const scratchDir = path.join(process.cwd(), '.kepler', 'tmp');
    const scratchFile = path.join(scratchDir, `agent-output-${Date.now()}.txt`);
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(scratchFile, 'project scratch output\n');
    try {
        const result = await executor.execute('read_file', { path: scratchFile });
        assert.strictEqual(result.success, true);
        assert.ok(result.content.includes('project scratch output'));
    } finally {
        fs.rmSync(scratchFile, { force: true });
    }
});

// Test 4: shell runs echo
await test('shell runs echo', async () => {
    const result = await executor.execute('shell', { command: 'echo hello_tarang' });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('hello_tarang'));
});

await test('shell observes likely long-running commands and returns tail', async () => {
    const previous = process.env.KEPLER_LONG_RUNNING_TIMEOUT_MS;
    process.env.KEPLER_LONG_RUNNING_TIMEOUT_MS = '300';
    try {
        const result = await executor.execute('shell', {
            command: 'node -e "console.log(\'ready_tail\'); setInterval(() => {}, 1000)"',
        });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result._observation_timeout, true);
        assert.strictEqual(result._timed_out, true);
        assert.strictEqual(result.exit_code, 124);
        assert.ok(result.output.includes('Observation timeout after 300ms'));
        assert.ok(result.output.includes('ready_tail'));
    } finally {
        if (previous == null) delete process.env.KEPLER_LONG_RUNNING_TIMEOUT_MS;
        else process.env.KEPLER_LONG_RUNNING_TIMEOUT_MS = previous;
    }
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
    assert.strictEqual(writeResult.lines_added, 1);
    assert.strictEqual(writeResult.lines_removed, 0);
    assert.ok(writeResult.file_diff?.unified.includes('+test content'));
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

await test('search_files passes regex alternation literally', async () => {
    const result = await executor.execute('search_files', {
        query: 'proxy|PAC|profile|router',
        path: '.',
    });
    assert.strictEqual(result.success, true);
    assert.ok(!result.output.includes('command not found'));
    assert.ok(!result.output.includes('usage: route'));
});

await test('multiple projects are routed explicitly and undeclared siblings stay blocked', async () => {
    const root = path.join(process.cwd(), '__kepler_project_registry_test__');
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const undeclared = path.join(root, 'undeclared');
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    fs.mkdirSync(undeclared, { recursive: true });
    fs.writeFileSync(path.join(first, 'first.js'), 'export const firstValue = 1;\n');
    fs.writeFileSync(path.join(second, 'second.py'), 'def second_value():\n    return 2\n');
    fs.writeFileSync(path.join(undeclared, 'secret.txt'), 'not registered\n');

    try {
        const multi = createToolExecutor();
        const firstOverview = await multi.execute('get_project_overview', { path: first });
        const secondOverview = await multi.execute('get_project_overview', { path: second });
        assert.strictEqual(firstOverview.success, true);
        assert.strictEqual(secondOverview.success, true);

        const secondSearch = await multi.execute('search_code', {
            project_id: secondOverview.project_resource.project_id,
            query: 'second_value',
        });
        assert.strictEqual(secondSearch.success, true);
        assert.ok(secondSearch.output.includes('second.py'));

        const blocked = await multi.execute('read_file', {
            path: path.join(undeclared, 'secret.txt'),
        });
        assert.strictEqual(blocked.success, false);
        assert.ok(blocked.output.includes('outside registered project roots'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
