import assert from 'node:assert';
import { AgentHistoryTurnBuilder } from '../src/core/agent-history.mjs';
import { llmToolResultContent } from '../src/core/callback-client.mjs';

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

console.log('\n\x1b[1mtest-agent-history.mjs\x1b[0m\n');

await test('records assistant tool_use and user tool_result in provider order', async () => {
    const turn = new AgentHistoryTurnBuilder();
    turn.addAssistantText('I will inspect it.\n');
    turn.addToolUse({
        call_id: 'call-1',
        tool: 'read_file',
        args: { file_path: 'src/auth.ts' },
    });
    turn.addToolResult({
        call_id: 'call-1',
        success: true,
        output: 'export function auth() {}',
    });
    turn.addAssistantText('I found the auth helper.');

    const messages = turn.finish();
    assert.strictEqual(messages.length, 3);
    assert.strictEqual(messages[0].role, 'assistant');
    assert.deepStrictEqual(messages[0].content[0], { type: 'text', text: 'I will inspect it.\n' });
    assert.deepStrictEqual(messages[0].content[1], {
        type: 'tool_use',
        id: 'call-1',
        name: 'read_file',
        input: { file_path: 'src/auth.ts' },
    });
    assert.strictEqual(messages[1].role, 'user');
    assert.deepStrictEqual(messages[1].content, [{
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: 'export function auth() {}',
    }]);
    assert.deepStrictEqual(messages[2], {
        role: 'assistant',
        content: [{ type: 'text', text: 'I found the auth helper.' }],
    });
});

await test('ignores orphan tool_result blocks without a tool name', async () => {
    const turn = new AgentHistoryTurnBuilder();
    assert.strictEqual(turn.addToolResult({ call_id: 'missing', output: 'orphan' }), false);
    assert.deepStrictEqual(turn.finish(), []);
});

await test('synthesizes server-side tool_use for non-internal tool_result continuity', async () => {
    const turn = new AgentHistoryTurnBuilder();
    assert.strictEqual(turn.addToolResult({
        call_id: 'meta_explore',
        tool: 'explore',
        args: { query: 'find auth flow' },
        output: 'explore summary',
    }), true);

    const messages = turn.finish();
    assert.strictEqual(messages.length, 2);
    assert.deepStrictEqual(messages[0], {
        role: 'assistant',
        content: [{
            type: 'tool_use',
            id: 'meta_explore',
            name: 'explore',
            input: { query: 'find auth flow' },
        }],
    });
    assert.deepStrictEqual(messages[1], {
        role: 'user',
        content: [{
            type: 'tool_result',
            tool_use_id: 'meta_explore',
            content: 'explore summary',
        }],
    });
});

await test('ignores internal sub-agent tool events for parent continuity', async () => {
    const turn = new AgentHistoryTurnBuilder();
    turn.addToolUse({
        call_id: 'sub-call-1',
        tool: 'read_file',
        args: { file_path: 'large.txt' },
        sub_agent: 'explore',
        internal: true,
    });
    turn.addToolResult({
        call_id: 'sub-call-1',
        success: true,
        output: 'large internal output',
        sub_agent: 'explore',
        internal: true,
    });
    turn.addToolUse({
        call_id: 'parent-call-1',
        tool: 'explore',
        args: { query: 'find auth flow' },
    });
    turn.addToolResult({
        call_id: 'parent-call-1',
        success: true,
        output: 'summary only',
    });

    const messages = turn.finish();
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[0].content[0].name, 'explore');
    assert.strictEqual(messages[1].content[0].content, 'summary only');
});

await test('truncates only oversized tool results', async () => {
    const turn = new AgentHistoryTurnBuilder({ maxToolResultChars: 5 });
    turn.addToolUse({ call_id: 'call-1', tool: 'run', args: {} });
    turn.addToolResult({ call_id: 'call-1', output: '0123456789' });
    const result = turn.finish()[1].content[0].content;
    assert.ok(result.startsWith('01234'));
    assert.ok(result.includes('truncated this tool result'));
});

await test('prefers backend llm_content over display output', async () => {
    const turn = new AgentHistoryTurnBuilder();
    turn.addToolUse({ call_id: 'call-1', tool: 'read_file', args: {} });
    turn.addToolResult({
        call_id: 'call-1',
        output: 'display text',
        llm_content: '{"output":"display text"}',
    });

    const messages = turn.finish();
    assert.strictEqual(messages[1].content[0].content, '{"output":"display text"}');
});

await test('serializes local tool results in compact backend-compatible form', async () => {
    assert.strictEqual(
        llmToolResultContent('read_file', { success: true, output: 'abc', _meta: 'hidden' }),
        '{"output":"abc"}',
    );
    assert.strictEqual(
        llmToolResultContent('get_project_overview', {
            success: true,
            output: 'registered',
            project_resource: { project_id: 'p1' },
            already_registered: true,
        }),
        '{"output":"registered","project_resource":{"project_id":"p1"},"already_registered":true}',
    );
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
