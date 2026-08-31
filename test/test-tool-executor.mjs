/**
 * Unit tests for Tool Executor Bridge.
 */

import { createToolExecutor } from '../src/core/tool-executor.mjs';
import { ProjectRegistry } from '../src/tools/project-overview.mjs';
import { PluginRegistry } from '../src/plugins/registry.mjs';
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
await executor.waitForAutoRegister();

function createExecutorWithoutAutoRegister(options = {}) {
    const previous = process.env.BAHULAM_SKIP_AUTO_REGISTER;
    process.env.BAHULAM_SKIP_AUTO_REGISTER = 'true';
    try {
        return createToolExecutor(options);
    } finally {
        if (previous == null) delete process.env.BAHULAM_SKIP_AUTO_REGISTER;
        else process.env.BAHULAM_SKIP_AUTO_REGISTER = previous;
    }
}

const unregisteredExecutor = createExecutorWithoutAutoRegister();
await test('directory tools reject paths before project registration', async () => {
    const result = await unregisteredExecutor.execute('list_files', {
        path: path.join(process.cwd(), 'package.json'),
    });
    assert.strictEqual(result.success, false);
    assert.ok(result.output.includes('outside registered project roots'));
});

const overview = await executor.execute('get_project_overview', { path: process.cwd() });
assert.strictEqual(overview.success, true);
const projectId = overview.project_resource.project_id;

// Test 1: listTools returns the complete bridge inventory
await test('listTools returns core and agent tools', async () => {
    const tools = executor.listTools();
    assert.ok(tools.length >= 30);
    assert.ok(tools.includes('shell'));
    assert.ok(tools.includes('read_file'));
    assert.ok(tools.includes('write_file'));
    assert.ok(tools.includes('edit_file'));
    assert.ok(tools.includes('list_files'));
    assert.ok(tools.includes('search_code'));
    assert.ok(tools.includes('read_files'));
    assert.ok(tools.includes('read_batch'));
    assert.ok(tools.includes('delete_file'));
    assert.ok(tools.includes('get_file_info'));
    assert.ok(tools.includes('run_tests'));
    assert.ok(tools.includes('git_diff'));
    assert.ok(tools.includes('git_status'));
    assert.ok(tools.includes('analyze_code'));
    assert.ok(tools.includes('get_project_overview'));
    assert.ok(tools.includes('skills_list'));
    assert.ok(tools.includes('skill_view'));
    assert.ok(tools.includes('skill_install'));
    assert.ok(tools.includes('skill_update'));
    assert.ok(tools.includes('skill_remove'));
    assert.ok(tools.includes('agents_list'));
    assert.ok(tools.includes('agent_create'));
    assert.ok(tools.includes('agent_sync'));
});

await test('project overview is session-stable and exposes project_id', async () => {
    const repeated = await executor.execute('get_project_overview', { path: process.cwd() });
    assert.strictEqual(repeated.success, true);
    assert.strictEqual(repeated.already_registered, true);
    assert.strictEqual(repeated.refreshed, false);
    assert.strictEqual(repeated.project_resource.project_id, projectId);
    assert.ok(repeated.project_resource.environment);
    assert.strictEqual(repeated.project_resource.environment.node, process.version);
    assert.ok(repeated.project_resource.environment.platform);
});

await test('project overview re-registration refreshes live project context', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-project-context-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"ctx"}\n');
    fs.mkdirSync(path.join(root, '.bahulam'), { recursive: true });
    fs.writeFileSync(path.join(root, '.bahulam', 'project.md'), 'initial context\n');

    try {
        const ctxExecutor = createToolExecutor();
        const first = await ctxExecutor.execute('get_project_overview', { path: root });
        assert.strictEqual(first.success, true);
        assert.match(first.project_resource.project_context, /initial context/);

        fs.writeFileSync(path.join(root, '.bahulam', 'project.md'), 'updated context\n');
        const second = await ctxExecutor.execute('get_project_overview', { path: root });
        assert.strictEqual(second.success, true);
        assert.strictEqual(second.already_registered, true);
        assert.strictEqual(second.refreshed, false);
        assert.match(second.project_resource.project_context, /updated context/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

await test('registerProjectRoots makes prompt roots available to file tools', async () => {
    const root = path.join(process.cwd(), '__bahulam_prompt_roots_test__');
    const docs = path.join(root, 'docs');
    const cli = path.join(root, 'codekepler-npm');
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(docs, { recursive: true });
    fs.mkdirSync(cli, { recursive: true });
    fs.writeFileSync(path.join(docs, 'index.mdx'), '# Docs\n');
    fs.writeFileSync(path.join(cli, 'package.json'), '{"name":"cli"}\n');

    try {
        const multi = createToolExecutor();
        const docsOnly = await multi.registerProjectRoots([docs]);
        assert.deepStrictEqual(docsOnly.map(r => r.success), [true]);

        const blocked = await multi.execute('list_files', { path: cli, pattern: 'package.json' });
        assert.strictEqual(blocked.success, false);
        assert.ok(blocked.output.includes('outside registered project roots'));

        const registered = await multi.registerProjectRoots([cli]);
        assert.deepStrictEqual(registered.map(r => r.success), [true]);

        const readable = await multi.execute('read_file', { path: path.join(cli, 'package.json') });
        assert.strictEqual(readable.success, true);
        assert.ok(readable.content.includes('"cli"'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

await test('read_file registers exact outside file under its own project', async () => {
    const root = path.join(process.cwd(), '__kepler_outside_file_read_test__');
    const workspace = path.join(root, 'appstak-platform');
    const docs = path.join(workspace, 'apps', 'kepler-docs');
    const workspaceFile = path.join(workspace, 'pnpm-workspace.yaml');
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'package.json'), '{"name":"workspace"}\n');
    fs.writeFileSync(workspaceFile, 'packages:\n  - apps/*\n');
    fs.writeFileSync(path.join(docs, 'package.json'), '{"name":"docs"}\n');

    try {
        const outside = createToolExecutor();
        const registered = await outside.registerProjectRoots([docs]);
        assert.deepStrictEqual(registered.map(r => r.success), [true]);

        const blockedList = await outside.execute('list_files', {
            path: workspace,
            pattern: 'pnpm-workspace.yaml',
        });
        assert.strictEqual(blockedList.success, false);
        assert.ok(blockedList.output.includes('outside registered project roots'));

        const read = await outside.execute('read_file', { path: workspaceFile });
        assert.strictEqual(read.success, true);
        assert.ok(read.content.includes('apps/*'));

        const workspaceResource = outside.getProjectResources()
            .find(resource => resource.root === workspace);
        assert.ok(workspaceResource);
        assert.deepStrictEqual(workspaceResource.files_read, [workspaceFile]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

await test('project overview re-registration refreshes index when project drifts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-project-drift-'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"drift"}\n');

    try {
        const driftExecutor = createToolExecutor();
        const first = await driftExecutor.execute('get_project_overview', { path: root });
        assert.strictEqual(first.success, true);
        const firstVersion = first.project_resource.index_version;

        await new Promise(resolve => setTimeout(resolve, 5));
        fs.writeFileSync(path.join(root, 'new-file.js'), 'export const drifted = true;\n');

        const second = await driftExecutor.execute('get_project_overview', { path: root });
        assert.strictEqual(second.success, true);
        assert.strictEqual(second.already_registered, true);
        assert.strictEqual(second.refreshed, true);
        assert.notStrictEqual(second.project_resource.index_version, firstVersion);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

await test('read_attachment renders Jupyter notebooks instead of rejecting octet-stream', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-notebook-read-'));
    const notebookPath = path.join(root, 'powerbi-data-extractor-testing.ipynb');
    fs.writeFileSync(notebookPath, JSON.stringify({
        metadata: { language_info: { name: 'python' } },
        cells: [
            { cell_type: 'markdown', source: ['# Power BI extractor\n', 'Testing notes.'] },
            {
                cell_type: 'code',
                execution_count: 1,
                source: ['import pandas as pd\n', 'print("loaded")\n'],
                outputs: [{ output_type: 'stream', name: 'stdout', text: ['loaded\n'] }],
            },
        ],
    }));

    try {
        const result = await executor.execute('read_attachment', { path: notebookPath });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result._mime, 'application/x-ipynb+json');
        assert.ok(result.output.includes('Jupyter notebook (2 cells, language=python)'));
        assert.ok(result.output.includes('Cell 2 [code execution_count=1]'));
        assert.ok(result.output.includes('```python'));
        assert.ok(!result.output.includes('Unsupported or empty file'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

await test('search_code routes through the registered project index', async () => {
    const result = await executor.execute('search_code', {
        project_id: projectId,
        query: 'createToolExecutor',
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('tool-executor'));
});

await test('agent_create returns runnable spec for same-turn delegation refresh', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-agent-create-'));
    const previousCwd = process.cwd();
    try {
        const agentExecutor = createToolExecutor();
        process.chdir(root);
        const result = await agentExecutor.execute('agent_create', {
            name: 'Probe Specialist',
            description: 'Same-turn delegation probe',
            tools: ['read_file'],
            system_prompt: 'Return the requested marker.',
            force: true,
        });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.agent.slug, 'probe-specialist');
        assert.ok(result.agent.spec);
        assert.strictEqual(result.agent.spec.slug, 'probe-specialist');
        assert.ok(result.agent.spec.config);
    } finally {
        process.chdir(previousCwd);
        fs.rmSync(root, { recursive: true, force: true });
    }
});

await test('plugin agents are merged into available_agents with full specs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-plugin-agent-'));
    const previousCwd = process.cwd();
    const pluginDir = path.join(root, '.bahulam', 'plugins', 'seo-toolkit');
    const otherPluginDir = path.join(root, '.bahulam', 'plugins', 'content-tools');
    fs.mkdirSync(path.join(pluginDir, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(otherPluginDir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'plugin.yaml'), [
        'apiVersion: bahulam.plugin/1',
        'kind: Plugin',
        'metadata:',
        '  name: seo-toolkit',
        '  version: 1.0.0',
        'spec:',
        '  agents:',
        '    - slug: seo-manager',
        '      name: SEO Manager',
        '      description: SEO specialist',
        '      role: specialist',
        '      handler: agents/seo-manager.yaml',
        '  tools:',
        '    - name: hello_world',
        '      description: Greet someone',
        '      handler: tools/hello.mjs',
        '      parameters:',
        '        type: object',
        '        properties:',
        '          name:',
        '            type: string',
        '  workspace:',
        '    views: []',
        '',
    ].join('\n'));
    fs.writeFileSync(path.join(pluginDir, 'agents', 'seo-manager.yaml'), [
        'apiVersion: agent.framework/v1',
        'kind: SubAgent',
        'metadata:',
        '  name: seo-manager',
        '  role: specialist',
        '  description: SEO specialist from handler',
        'agent:',
        '  max_tokens: 512',
        '  max_iterations: 5',
        '  system_prompt: Use hello_world when greeting.',
        'tools:',
        '  - hello_world',
        '',
    ].join('\n'));
    fs.writeFileSync(
        path.join(pluginDir, 'tools', 'hello.mjs'),
        'export async function call(input) { return { success: true, output: `hello ${input?.name || "world"}` }; }\n',
    );
    fs.writeFileSync(path.join(otherPluginDir, 'plugin.yaml'), [
        'apiVersion: bahulam.plugin/1',
        'kind: Plugin',
        'metadata:',
        '  name: content-tools',
        '  version: 1.0.0',
        'spec:',
        '  tools:',
        '    - name: content_score',
        '      description: Score content',
        '      handler: tools/score.mjs',
        '  workspace:',
        '    views: []',
        '',
    ].join('\n'));
    fs.writeFileSync(
        path.join(otherPluginDir, 'tools', 'score.mjs'),
        'export async function call() { return { success: true, output: "score" }; }\n',
    );

    try {
        process.chdir(root);
        const pluginRegistry = new PluginRegistry({
            pluginDirs: [path.join(root, '.bahulam', 'plugins')],
            enabled: ['seo-toolkit'],
        }).scan();
        assert.strictEqual(pluginRegistry.count(), 1);
        assert.deepStrictEqual(pluginRegistry.listTools().map(tool => tool.name), ['hello_world']);

        const pluginExecutor = createExecutorWithoutAutoRegister({ pluginRegistry });
        const ctx = pluginExecutor.getAgentContext();
        const agent = ctx.available_agents.find(item => item.slug === 'seo-manager');

        assert.ok(agent, 'plugin agent should be present in hot-path available_agents');
        assert.strictEqual(agent.source_scope, 'plugin');
        assert.strictEqual(agent.source, 'plugin:seo-toolkit');
        assert.deepStrictEqual(agent.tools, ['hello_world']);
        assert.ok(agent.spec, 'plugin agent should include a full spec for backend delegation');
        assert.strictEqual(agent.spec.slug, 'seo-manager');
        assert.match(agent.spec.system_prompt, /Use hello_world/);
        assert.strictEqual(agent.spec.source_scope, 'plugin');
        assert.strictEqual(agent.spec.source, 'plugin:seo-toolkit');
        assert.strictEqual(agent.spec.config.metadata.source_scope, 'plugin');
        assert.strictEqual(agent.spec.config.metadata.source, 'plugin:seo-toolkit');
        assert.deepStrictEqual(agent.spec.tools, ['hello_world']);
        assert.strictEqual(ctx.available_agents.some(item => item.slug === 'content-tools'), false);

        const toolResult = await pluginExecutor.execute('hello_world', { name: 'Sree' });
        assert.strictEqual(toolResult.success, true);
        assert.match(toolResult.output, /hello Sree/);

        const listed = await pluginExecutor.execute('agents_list', { scope: 'plugin' });
        assert.strictEqual(listed.success, true);
        assert.ok(listed.agents.some(item => item.slug === 'seo-manager'));
    } finally {
        process.chdir(previousCwd);
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// Test 2: read_file reads existing file
await test('read_file reads package.json', async () => {
    const result = await executor.execute('read_file', { path: 'package.json' });
    assert.strictEqual(result.success, true);
    // Package is dual-published under @bahulamai/code and @bahulam/code;
    // publish flow swaps the `name` field in-place. Accept either scope so
    // a mid-publish package.json doesn't break the test suite. read_file
    // returns `content` for small files and `output` (AST summary + first
    // 20 lines) for files >50 lines — accept either field.
    const body = result.content ?? result.output ?? '';
    assert.ok(
        body.includes('@bahulamai/code') || body.includes('@bahulam/code'),
        'package.json name should be @bahulamai/code or @bahulam/code',
    );
});

await test('read_file reuses unchanged repeated reads and read_batch reads line ranges', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-read-cache-'));
    const file = path.join(root, 'sample.txt');
    fs.writeFileSync(file, 'one\ntwo\nthree\nfour\n');
    try {
        const cacheExecutor = createToolExecutor();
        const first = await cacheExecutor.execute('read_file', { path: file, start_line: 1, end_line: 3 });
        const second = await cacheExecutor.execute('read_file', { path: file, start_line: 1, end_line: 3 });
        assert.strictEqual(first.success, true);
        assert.strictEqual(second.success, true);
        assert.strictEqual(second._cache_reused, true);
        assert.ok(second.output.includes('reused prior read_file result'));

        const batch = await cacheExecutor.execute('read_batch', {
            items: [
                { file_path: file, start_line: 2, end_line: 2 },
                { file_path: file, start_line: 4, end_line: 4 },
            ],
        });
        assert.strictEqual(batch.success, true);
        assert.strictEqual(batch._tool, 'read_batch');
        assert.strictEqual(batch.files.length, 2);
        assert.ok(batch.output.includes('sample.txt'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// Test 3: read_file on missing file returns error
await test('read_file on missing file returns error', async () => {
    const result = await executor.execute('read_file', { path: 'nonexistent_file_xyz.txt' });
    assert.strictEqual(result.success, false);
});

await test('read_file allows OS temp scratch files', async () => {
    const scratchFile = path.join(os.tmpdir(), `bahulam-scratch-${Date.now()}.txt`);
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
    const root = path.join(process.cwd(), '__bahulam_custom_scratch__');
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

await test('read_file allows project .bahulam/tmp scratch files', async () => {
    const scratchDir = path.join(process.cwd(), '.bahulam', 'tmp');
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

await test('shell keeps full output for the agent and filtered preview for display', async () => {
    const command = `node -e "for (let i = 0; i < 120; i++) console.log('line ' + i + ' ' + 'x'.repeat(80))"`;
    const result = await executor.execute('shell', { command });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('line 119'), 'full agent output should include tail lines');
    assert.ok(result.output_preview.includes('truncated'), 'display preview should still be capped');
    assert.ok(!result.output_preview.includes('line 119'), 'display preview should not be the full output');
});

await test('shell marks agent output when the hard 1MB capture limit is reached', async () => {
    const command = `node -e "process.stdout.write('x'.repeat(1024 * 1024 + 128))"`;
    const result = await executor.execute('shell', { command });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('[output truncated at 1MB]'), 'agent output should include truncation marker');
});

await test('shell command substitution is approval-gated, not blocked', async () => {
    // Reclassified 2026-08-19: backticks/$() → contained + highRisk
    // (explicit approval) instead of hard-blocked. Dangerous payloads
    // inside the substitution still hard-block via BLOCKED_PATTERNS.
    const result = await executor.execute('shell', { command: 'echo `whoami`' });
    assert.strictEqual(result.success, true);
    assert.notStrictEqual(result._blocked, true);
    assert.ok(String(result.output || '').trim().length > 0);
});

await test('shell substitution with dangerous payload stays blocked', async () => {
    const result = await executor.execute('shell', { command: 'echo $(rm -rf /)' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result._blocked, true);
});

await test('shell rm with tilde target runs after approval path', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-home-rm-'));
    const lockFile = path.join(fakeHome, '.agent_framework', '.license_lock');
    const previousHome = process.env.HOME;
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, 'locked\n');

    try {
        process.env.HOME = fakeHome;
        const result = await executor.execute('shell', {
            command: 'rm ~/.agent_framework/.license_lock',
        });
        assert.strictEqual(result.success, true);
        assert.strictEqual(fs.existsSync(lockFile), false);
        assert.ok(!result._skipped);
    } finally {
        if (previousHome == null) delete process.env.HOME;
        else process.env.HOME = previousHome;
        fs.rmSync(fakeHome, { recursive: true, force: true });
    }
});

await test('shell observes likely long-running commands and returns tail', async () => {
    const previous = process.env.BAHULAM_LONG_RUNNING_TIMEOUT_MS;
    // 1500ms: enough for the subprocess to start and emit output reliably
    // under concurrent test load, well below the 15s default.
    process.env.BAHULAM_LONG_RUNNING_TIMEOUT_MS = '1500';
    try {
        const result = await executor.execute('shell', {
            command: 'node -e "console.log(\'ready_tail\'); setInterval(() => {}, 10000)"',
        });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result._observation_timeout, true);
        assert.strictEqual(result._timed_out, true);
        assert.strictEqual(result.exit_code, 124);
        assert.ok(result.output.includes('Observation timeout after 1500ms'));
        assert.ok(result.output.includes('ready_tail'));
    } finally {
        if (previous == null) delete process.env.BAHULAM_LONG_RUNNING_TIMEOUT_MS;
        else process.env.BAHULAM_LONG_RUNNING_TIMEOUT_MS = previous;
    }
});

await test('shell cancels active process when abort signal fires', async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 250);

    const result = await executor.execute('shell', {
        command: 'node -e "setTimeout(() => console.log(\'done\'), 5000)"',
        timeout: 10000,
    }, { signal: ac.signal });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result._cancelled, true);
    assert.strictEqual(result.exit_code, 130);
    assert.ok(/cancelled by user/i.test(result.output));
    assert.ok(Date.now() - started < 2000, 'cancel should not wait for command timeout');
});

// Test 5: list_files returns file array
await test('list_files returns files', async () => {
    const result = await executor.execute('list_files', { pattern: '*.json' });
    assert.strictEqual(result.success, true);
    assert.ok(Array.isArray(result.files));
    assert.ok(result.files.length > 0);
});

await test('list_files can return a bounded directory tree', async () => {
    const result = await executor.execute('list_files', {
        path: '.',
        format: 'tree',
        max_depth: 1,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result._format, 'tree');
    assert.ok(result.output.includes('codekepler-npm/'));
    assert.ok(result.output.includes('package.json'));
    assert.ok(Array.isArray(result.directories));
    assert.ok(Array.isArray(result.files));
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

await test('write_file allows sensitive config with redacted diff', async () => {
    const dir = '__test_sensitive_env_write__';
    const testPath = path.join(dir, '.env.local');
    fs.rmSync(dir, { recursive: true, force: true });
    try {
        const result = await executor.execute('write_file', {
            path: testPath,
            content: 'API_KEY=secret-before\n',
        });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.file_diff?.redacted, true);
        assert.strictEqual(result.file_diff?.unified, '');
        assert.ok(result.output.includes('Diff redacted'));
        assert.ok(!result.output.includes('secret-before'));
        assert.ok(!JSON.stringify(result.file_diff).includes('secret-before'));
        assert.ok(fs.existsSync(testPath));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await test('edit_file returns idempotent success on no-op edits without running lint', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-edit-noop-'));
    const file = path.join(root, 'sources.py');
    fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname="noop-edit"\n');
    fs.writeFileSync(file, 'VALUE = "already done"\n');

    try {
        const editExecutor = createToolExecutor();
        const registered = await editExecutor.execute('get_project_overview', { path: root });
        assert.strictEqual(registered.success, true);

        const result = await editExecutor.execute('edit_file', {
            path: file,
            search: 'VALUE = "already done"',
            replace: 'VALUE = "already done"',
        });
        // success:true — desired state already in place, idempotent operation
        assert.strictEqual(result.success, true);
        assert.strictEqual(result._no_change, true);
        assert.strictEqual(result.lines_added, 0);
        assert.strictEqual(result.lines_removed, 0);
        assert.ok(result.output.includes('no changes'));
        // lint must not run — file unchanged, no point linting
        assert.strictEqual(result.lint, undefined);
        assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'VALUE = "already done"\n');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

await test('edit_file accepts legacy old_string/new_string aliases', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-edit-alias-'));
    const file = path.join(root, 'sources.py');
    fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname="alias-edit"\n');
    fs.writeFileSync(file, 'name = "old"\nother = "old"\n');

    try {
        const editExecutor = createToolExecutor();
        const registered = await editExecutor.execute('get_project_overview', { path: root });
        assert.strictEqual(registered.success, true);

        const result = await editExecutor.execute('edit_file', {
            file_path: file,
            old_string: '"old"',
            new_string: '"new"',
            replace_all: true,
        });
        assert.strictEqual(result.success, true);
        assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'name = "new"\nother = "new"\n');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

await test('edit_file auto-lint keeps the event loop responsive', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-edit-async-lint-'));
    const bin = path.join(root, 'bin');
    const file = path.join(root, 'app.js');
    const marker = path.join(root, 'lint-started');
    const done = path.join(root, 'lint-done');
    const fakeNode = path.join(bin, 'node');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"async-lint"}\n');
    fs.writeFileSync(file, 'const value = "old";\n');
    fs.writeFileSync(fakeNode, [
        '#!/bin/sh',
        `printf started > "${marker.replace(/"/g, '\\"')}"`,
        'sleep 1',
        `printf done > "${done.replace(/"/g, '\\"')}"`,
        'echo "All checks passed!"',
    ].join('\n'));
    fs.chmodSync(fakeNode, 0o755);

    const previousPath = process.env.PATH;
    let sawLintWhileRunning = false;
    let interval = null;
    try {
        const editExecutor = createToolExecutor();
        const registered = await editExecutor.execute('get_project_overview', { path: root });
        assert.strictEqual(registered.success, true);

        process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`;
        interval = setInterval(() => {
            if (fs.existsSync(marker) && !fs.existsSync(done)) {
                sawLintWhileRunning = true;
            }
        }, 5);

        const result = await editExecutor.execute('edit_file', {
            path: file,
            search: '"old"',
            replace: '"new"',
        });

        assert.strictEqual(result.success, true);
        assert.ok(result.lint.includes('All checks passed'));
        assert.strictEqual(sawLintWhileRunning, true);
        assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'const value = "new";\n');
    } finally {
        if (interval) clearInterval(interval);
        if (previousPath == null) delete process.env.PATH;
        else process.env.PATH = previousPath;
        fs.rmSync(root, { recursive: true, force: true });
    }
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
        expected: ['package.json', 'src/terminal/main.mjs', 'missing_file.xyz'],
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

await test('analyze_code rejects directories with actionable guidance', async () => {
    const result = await executor.execute('analyze_code', { path: process.cwd() });
    assert.strictEqual(result.success, false);
    assert.ok(result.output.includes('expects a file'));
    assert.ok(result.output.includes('Use list_files/search_code'));
    assert.ok(!result.output.includes('EISDIR'));
});

await test('multiple projects require explicit routing, while exact outside reads register their file project', async () => {
    const root = path.join(process.cwd(), '__bahulam_project_registry_test__');
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
    // Project markers — get_project_overview now refuses roots without them.
    // `undeclared` deliberately omits any marker so the read_file on-the-fly
    // path (which bypasses the check) is what registers it.
    fs.writeFileSync(path.join(first, 'package.json'), '{"name":"first"}\n');
    fs.writeFileSync(path.join(second, 'pyproject.toml'), '[project]\nname="second"\n');

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

        const blocked = await multi.execute('list_files', {
            path: undeclared,
            pattern: 'secret.txt',
        });
        assert.strictEqual(blocked.success, false);
        assert.ok(blocked.output.includes('outside registered project roots'));

        const read = await multi.execute('read_file', {
            path: path.join(undeclared, 'secret.txt'),
        });
        assert.strictEqual(read.success, true);
        assert.ok(read.content.includes('not registered'));
        assert.ok(multi.getProjectResources().some(resource => resource.root === undeclared));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
