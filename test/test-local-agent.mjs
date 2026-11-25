/**
 * Tests for LocalAgent — stagnation detection, event format.
 * (No real LLM calls — tests internal logic only.)
 */

import { LocalAgent } from '../src/core/local-agent.mjs';
import { DEFAULT_REASONING_MODEL } from '../src/config/model-defaults.mjs';
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
    // Assert against the shipped default rather than a literal: the old
    // hardcoded 'claude-sonnet-4-20250514' outlived the default model swap.
    assert.strictEqual(agent.model, DEFAULT_REASONING_MODEL);
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
    assert.equal(defs.length, 18);
    assert.deepEqual(defs.find(tool => tool.name === 'query_code_graph')?.input_schema.required,
        ['project_id', 'operation', 'file']);
    assert.ok(defs.some(tool => tool.name === 'get_project_overview'));
    assert.deepEqual(defs.find(tool => tool.name === 'skill_view')?.input_schema.required, ['name']);
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

await test('batches a multi-tool response without duplicating assistant history', async () => {
    const fakeExecutor = {
        async execute(name) {
            return { success: true, output: `${name} complete` };
        },
    };
    const agent = new LocalAgent({
        apiKey: 'test',
        toolExecutor: fakeExecutor,
        maxTurns: 2,
    });

    let callCount = 0;
    let nextTurnMessages = [];
    agent._callLLM = async (_systemPrompt, messages) => {
        callCount++;
        if (callCount === 1) {
            return {
                content: [
                    { type: 'tool_use', id: 'call_1', name: 'shell', input: { command: 'one' } },
                    { type: 'tool_use', id: 'call_2', name: 'shell', input: { command: 'two' } },
                    { type: 'tool_use', id: 'call_3', name: 'shell', input: { command: 'three' } },
                ],
                stopReason: 'tool_use',
                usage: null,
            };
        }
        nextTurnMessages = [...messages];
        return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: null };
    };

    for await (const _event of agent.execute('run three tools')) { /* consume */ }

    const assistantMessages = nextTurnMessages.filter(message => message.role === 'assistant');
    assert.strictEqual(assistantMessages.length, 1);
    assert.strictEqual(assistantMessages[0].content.filter(block => block.type === 'tool_use').length, 3);

    const toolResultMessages = nextTurnMessages.filter(message =>
        message.role === 'user' && Array.isArray(message.content)
        && message.content.some(block => block.type === 'tool_result')
    );
    assert.strictEqual(toolResultMessages.length, 3);
    assert.deepStrictEqual(
        toolResultMessages.map(message => message.content[0].tool_use_id),
        ['call_1', 'call_2', 'call_3'],
    );
});

await test('a short oversized history hands off a summary and intact recent tool batch', async () => {
    const agent = new LocalAgent({ apiKey: 'test', toolExecutor: executor, model: 'deepseek-v4-flash-0731' });
    const prompt = { role: 'user', content: 'Inspect the project' };
    const call = { role: 'assistant', content: [{ type: 'tool_use', id: 'one', name: 'read_file', input: {file_path: 'src/router.tsx', start_line: 3} }] };
    const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content: 'first\nERROR missing route\nEOF' }] };
    const latest = { role: 'user', content: 'Continue from the findings' };
    let handoff;
    agent._callLLM = async (_prompt, messages) => {
        handoff = messages[0].content;
        return { content: [{ type: 'text', text: 'The file was inspected.' }] };
    };
    const commentary = {role: 'assistant', content: 'checking routes. '.repeat(280_000)};
    const events = agent._reduceContext([prompt, commentary, call, result, latest], { phase: 'mid_turn' });
    const start = await events.next();
    assert.equal(start.value.type, 'summarize_progress');
    assert.equal(start.value.data.state, 'started');
    const { value: reduction, done } = await events.next();
    assert.ok(done);
    assert.equal(reduction.event.phase, 'mid_turn');
    assert.ok(reduction.event.kept_recent >= 1);
    for (const evidence of ['src/router.tsx', 'start_line', 'ERROR missing route', 'EOF']) assert.ok(JSON.stringify(reduction.messages).includes(evidence));
    assert.ok(handoff.length < 12_000);
    assert.ok(reduction.messages[0].content.includes('The file was inspected.'));
    assert.deepEqual(reduction.messages.at(-1), latest);
    // A single pending tool batch remains indivisible.
    assert.deepEqual(await agent._reduceContext([call, result]).next(), { done: true, value: null });
    agent._callLLM = async () => { throw new Error('unavailable'); };
    const skipped = agent._reduceContext([prompt, commentary, call, result, latest]);
    assert.equal((await skipped.next()).value.data.state, 'started');
    const fallback = await skipped.next();
    assert.ok(fallback.done);
    assert.equal(fallback.value.event.strategy, 'local_distillation');
    assert.ok(fallback.value.messages[0].content.includes('Inspect the project'));
});

await test('constrained coding handoff preserves successes and graph evidence across two reductions', async () => {
    const agent = new LocalAgent({apiKey: 'test', toolExecutor: executor, model: 'deepseek-v4-flash-0731'});
    agent._callLLM = async () => ({content: [{type: 'text', text: 'Continue from the import finding.'}]});
    const action = (i, name, content, is_error = false) => [
        {role: 'assistant', content: [{type: 'tool_use', id: String(i), name, input: {file: 'src/a.ts'}}]},
        {role: 'user', content: [{type: 'tool_result', tool_use_id: String(i), is_error, content}]},
    ];
    const graph = JSON.stringify({results: [{file:'src/a.ts', line:37, target:'src/b.ts', edge_type:'imports', status:'resolved'}]});
    const intent = 'Find the dependency and fix the caller.';
    let rows = [{role: 'user', content: intent}, ...action(0, 'query_code_graph', graph),
        {role: 'assistant', content: 'Keep the public API because old callers import it.'},
        ...action(1, 'shell', JSON.stringify({error:'bad input', exit_code:1, output:'partial success\n' + 'ERROR again\n'.repeat(430000)}), true)];
    for (let i = 2; i < 9; i++) rows.push(...action(i, 'read_file', i === 2 ? '{"error":"literal"}' : 'source ' + i));
    for (let pass = 0; pass < 2; pass++) {
        const events = agent._reduceContext(rows);
        assert.equal((await events.next()).value.type, 'summarize_progress');
        const reduced = (await events.next()).value;
        rows = reduced.messages;
        const state = JSON.parse(rows[0].content.split('\n[Coding handoff v1]\n').at(-1));
        assert.equal(state.original_task, intent);
        assert.equal(state.last_actions.length, 5);
        assert.deepEqual(state.last_actions.map(a => a.id), Array.from({length:5}, (_, i) => String(4 + pass + i)));
        assert.ok(state.decision_notes.some(note => note.includes('because old callers')));
        assert.equal(state.graph_lineage[0].result_call_id, '0');
        const results = rows.flatMap(row => Array.isArray(row.content) ? row.content.filter(b => b.type === 'tool_result') : []);
        assert.equal(results.length, 9 + pass);
        assert.equal(results[0].content, graph);
        assert.ok(!results[1].content.includes('ERROR again'));
        assert.ok(results[1].content.includes('partial success'));
        assert.equal(results[2].content, '{"error":"literal"}');
        assert.deepEqual(await agent._reduceContext(rows).next(), {done:true, value:null});
        rows.push(...action(9, 'shell', 'ERROR again\n'.repeat(430000), true),
            ...Array.from({length:12}, () => ({role:'assistant', content:'Continue investigating.'})));
    }
});

await test('180k budget summarizes older discussion and skips repeated evidence-only attempts', async () => {
    const agent = new LocalAgent({apiKey: 'test', toolExecutor: executor, model: 'deepseek-v4-flash-0731'});
    let calls = 0;
    agent._callLLM = async () => {
        calls++;
        return {content: [{type: 'text', text: 'Keep the legacy interface.'}]};
    };
    const first = {role: 'user', content: 'Preserve compatibility.'};
    const latest = {role: 'user', content: 'Continue from the last check.'};
    const body = '0123456789'.repeat(73000);
    const reduce = agent._reduceContext([first, {role:'assistant', content:body}, latest]);
    assert.equal((await reduce.next()).value.data.threshold, 180000);
    const reduced = (await reduce.next()).value;
    assert.deepEqual(reduced.messages.at(-1), latest);
    const evidence = [first, {role:'assistant', content:[{type:'tool_use', name:'read_file', id:'file', input:{path:'src/routes.ts'}}]},
        {role:'user', content:[{type:'tool_result', tool_use_id:'file', content:body}]}, latest];
    for (let i = 0; i < 2; i++) assert.deepEqual(await agent._reduceContext(evidence).next(), {done:true, value:null});
    assert.equal(calls, 1);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
