/**
 * Tests for LocalAgent — stagnation detection, event format.
 * (No real LLM calls — tests internal logic only.)
 */

import { LocalAgent } from '../src/core/local-agent.mjs';
import { createToolExecutor } from '../src/core/tool-executor.mjs';
import assert from 'node:assert';

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
        passed++;
    } catch (err) {
        console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err.message}`);
        failed++;
    }
}

console.log('\n\x1b[1mtest-local-agent.mjs\x1b[0m\n');

const executor = createToolExecutor();

await test('constructor sets defaults', async () => {
    const agent = new LocalAgent({ apiKey: 'sk-ant-test', toolExecutor: executor });
    assert.strictEqual(agent.model, 'claude-sonnet-4-20250514');
    assert.strictEqual(agent.verbose, false);
    assert.strictEqual(agent._cancelled, false);
});

await test('cancel sets flag', async () => {
    const agent = new LocalAgent({ apiKey: 'sk-ant-test', toolExecutor: executor });
    agent.cancel();
    assert.strictEqual(agent._cancelled, true);
});

await test('execute without API key yields error', async () => {
    const agent = new LocalAgent({ apiKey: null, openRouterKey: null, toolExecutor: executor });
    const events = [];
    for await (const e of agent.execute('test')) events.push(e);
    assert.ok(events.some(e => e.type === 'error'));
    assert.ok(events.some(e => e.data?.message?.includes('No API key')));
});

await test('_buildToolDefs returns tool definitions', async () => {
    const agent = new LocalAgent({ apiKey: 'test', toolExecutor: executor });
    const defs = agent._buildToolDefs();
    assert.ok(Array.isArray(defs));
    assert.ok(defs.length === 14);
    assert.ok(defs[0].name);
    assert.ok(defs[0].input_schema);
});

await test('_buildSystemPrompt includes context', async () => {
    const agent = new LocalAgent({ apiKey: 'test', toolExecutor: executor });
    const prompt = agent._buildSystemPrompt({ cwd: '/tmp/project', gitBranch: 'main' });
    assert.ok(prompt.includes('Tarang'));
    assert.ok(prompt.includes('/tmp/project'));
    assert.ok(prompt.includes('main'));
});

await test('first event is status with model info', async () => {
    // Mock the LLM call to return immediately
    const agent = new LocalAgent({ apiKey: null, openRouterKey: null, toolExecutor: executor });
    const events = [];
    for await (const e of agent.execute('hi')) {
        events.push(e);
        if (events.length >= 1) break; // just check first event
    }
    assert.strictEqual(events[0].type, 'status');
    assert.ok(events[0].data.message.includes('Local mode'));
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
