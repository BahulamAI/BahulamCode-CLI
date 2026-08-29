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
    assert.ok(prompt.includes('Bahulam'));
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

await test('local tool result event carries full output and display preview separately', async () => {
    const toolResult = {
        success: true,
        output: 'full shell output\nline 2',
        output_preview: 'full shell output\n... (truncated)',
        _tool: 'shell',
    };
    const fakeExecutor = {
        async execute(name, input) {
            assert.strictEqual(name, 'shell');
            assert.deepStrictEqual(input, { command: 'diff sample' });
            return toolResult;
        },
    };
    const agent = new LocalAgent({
        apiKey: 'test',
        toolExecutor: fakeExecutor,
        maxTurns: 2,
    });

    let callCount = 0;
    let secondTurnMessages = [];
    agent._callLLM = async (_systemPrompt, messages) => {
        callCount++;
        if (callCount === 1) {
            return {
                content: [{
                    type: 'tool_use',
                    id: 'call_shell_1',
                    name: 'shell',
                    input: { command: 'diff sample' },
                }],
                stopReason: 'tool_use',
                usage: null,
            };
        }
        secondTurnMessages = messages;
        return {
            content: [{ type: 'text', text: 'done' }],
            stopReason: 'end_turn',
            usage: null,
        };
    };

    const events = [];
    for await (const event of agent.execute('inspect diff')) events.push(event);

    const done = events.find(event => event.type === 'tool_done');
    assert.ok(done, 'expected tool_done event');
    assert.strictEqual(done.data.call_id, 'call_shell_1');
    assert.strictEqual(done.data.tool, 'shell');
    assert.strictEqual(done.data.output, toolResult.output);
    assert.strictEqual(done.data.output_preview, toolResult.output_preview);

    const modelToolResult = secondTurnMessages
        .flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(block => block.type === 'tool_result' && block.tool_use_id === 'call_shell_1');
    assert.ok(modelToolResult, 'expected tool_result to be passed back to model');
    assert.strictEqual(modelToolResult.content, toolResult.output);
    assert.strictEqual(modelToolResult.content.includes(toolResult.output_preview), false);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
