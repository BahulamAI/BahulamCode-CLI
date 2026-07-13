/**
 * Unit tests for TarangStreamClient SSE parsing.
 */

import { TarangStreamClient, EVENT_TYPES } from '../src/core/stream-client.mjs';
import * as http from 'node:http';
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

/** Create a mock SSE server that returns a predefined event sequence. */
function createMockServer(events) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (req.url === '/api/execute' && req.method === 'POST') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'X-Task-ID': 'test_task_001',
                });
                for (const evt of events) {
                    res.write(`event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`);
                }
                res.end();
            } else if (req.url?.startsWith('/api/callback') && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('{"ok":true}');
                });
            } else if (req.url === '/health') {
                res.writeHead(200);
                res.end('ok');
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: server.address().port });
        });
    });
}

const mockToolExecutor = {
    async execute(name, args) {
        return { success: true, output: `mock result for ${name}`, _tool: name };
    },
};

console.log('\n\x1b[1mtest-sse-client.mjs\x1b[0m\n');

// Test 1: Status event parsed correctly
await test('parses status event', async () => {
    const { server, port } = await createMockServer([
        { event: 'status', data: { message: 'Starting...' } },
        { event: 'complete', data: { summary: 'Done', changes: 1 } },
    ]);
    const client = new TarangStreamClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: 'test',
        openRouterKey: 'test',
        toolExecutor: mockToolExecutor,
    });
    const events = [];
    for await (const evt of client.execute('test')) {
        events.push(evt);
    }
    server.close();
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].type, 'status');
    assert.strictEqual(events[0].data.message, 'Starting...');
    assert.strictEqual(events[1].type, 'complete');
});

// Test 2: Tool call triggers execution + callback and exposes the local result
await test('tool_call triggers execution, callback, and tool_result', async () => {
    let callbackReceived = false;
    const server = http.createServer((req, res) => {
        if (req.url === '/api/execute') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Task-ID': 'task1' });
            res.write(`event: tool_call\ndata: ${JSON.stringify({ call_id: 'tc1', tool: 'read_file', args: { path: 'test.txt' } })}\n\n`);
            // Delay complete to allow callback
            setTimeout(() => {
                res.write(`event: complete\ndata: ${JSON.stringify({ summary: 'Done' })}\n\n`);
                res.end();
            }, 100);
        } else if (req.url === '/api/callback') {
            callbackReceived = true;
            res.writeHead(200);
            res.end('{}');
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const client = new TarangStreamClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: 'test',
        openRouterKey: 'test',
        toolExecutor: mockToolExecutor,
    });
    const events = [];
    for await (const evt of client.execute('test')) {
        events.push(evt);
    }
    server.close();
    // tool_call IS yielded (to show the user what tool is running), then handled internally
    assert.ok(events.some(e => e.type === 'tool_call'), 'tool_call should be yielded to show user');
    const resultEvent = events.find(e => e.type === 'tool_result');
    assert.ok(resultEvent, 'local tool_result should be yielded for terminal rendering');
    assert.strictEqual(resultEvent.data.call_id, 'tc1');
    assert.strictEqual(resultEvent.data.tool, 'read_file');
    assert.strictEqual(resultEvent.data.output, 'mock result for read_file');
    assert.ok(Number.isInteger(resultEvent.data.duration_ms));
    assert.ok(callbackReceived, 'callback should have been sent');
});

// Test 3: Error event yielded with message
await test('error event yielded', async () => {
    const { server, port } = await createMockServer([
        { event: 'error', data: { message: 'Something went wrong', fatal: true } },
    ]);
    const client = new TarangStreamClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: 'test',
        openRouterKey: 'test',
        toolExecutor: mockToolExecutor,
    });
    const events = [];
    for await (const evt of client.execute('test')) {
        events.push(evt);
    }
    server.close();
    assert.strictEqual(events[0].type, 'error');
    assert.strictEqual(events[0].data.message, 'Something went wrong');
});

// Test 4: 401 yields auth error
await test('401 yields auth error', async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(401);
        res.end('Unauthorized');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const client = new TarangStreamClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: 'bad',
        openRouterKey: 'test',
        toolExecutor: mockToolExecutor,
    });
    const events = [];
    for await (const evt of client.execute('test')) {
        events.push(evt);
    }
    server.close();
    assert.strictEqual(events[0].type, 'error');
    assert.ok(events[0].data.message.includes('Authentication failed'));
});

// Test 5: 429 yields message-window error
await test('429 yields friendly rate limit error', async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            detail: {
                code: 'message_limit_reached',
                retry_after: 3660,
                rate_limit: {
                    tier: 'pro',
                    msgs_used_in_window: 500,
                    msgs_per_window: 500,
                    retry_after: 3660,
                },
            },
        }));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const client = new TarangStreamClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: 'test',
        toolExecutor: mockToolExecutor,
    });
    const events = [];
    for await (const evt of client.execute('test')) events.push(evt);
    server.close();
    assert.strictEqual(events[0].type, 'error');
    assert.strictEqual(events[0].data.code, 'message_limit_reached');
    assert.ok(events[0].data.message.includes('Message window exhausted'));
    assert.ok(events[0].data.message.includes('1h 1m'));
});

await test('429 credit exhaustion preserves billing guidance', async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            detail: {
                code: 'credit_balance_exhausted',
                message: 'Credit balance exhausted — add credits, upgrade your plan, or switch to BYOK in Settings.',
                action: 'buy_credits_or_byok',
                pricing_url: 'codekepler.ai/pricing',
            },
        }));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const client = new TarangStreamClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: 'test',
        toolExecutor: mockToolExecutor,
    });
    const events = [];
    for await (const evt of client.execute('test')) events.push(evt);
    server.close();
    assert.strictEqual(events[0].type, 'error');
    assert.strictEqual(events[0].data.code, 'credit_balance_exhausted');
    assert.ok(events[0].data.message.includes('Credit balance exhausted'));
    assert.strictEqual(events[0].data.action, 'buy_credits_or_byok');
    assert.strictEqual(events[0].data.pricing_url, 'codekepler.ai/pricing');
});

// Test 5: Plan event with milestones
await test('plan event with milestones', async () => {
    const { server, port } = await createMockServer([
        { event: 'plan', data: { milestones: [{ name: 'Setup', status: 'pending' }, { name: 'Build', status: 'pending' }] } },
        { event: 'complete', data: { summary: 'Done' } },
    ]);
    const client = new TarangStreamClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: 'test',
        openRouterKey: 'test',
        toolExecutor: mockToolExecutor,
    });
    const events = [];
    for await (const evt of client.execute('test')) {
        events.push(evt);
    }
    server.close();
    assert.strictEqual(events[0].type, 'plan');
    assert.strictEqual(events[0].data.milestones.length, 2);
});

// Test 6: Server-side tools are displayed but never executed by the CLI
await test('server-side tool_call is not executed locally', async () => {
    let executions = 0;
    const { server, port } = await createMockServer([
        { event: 'tool_call', data: { call_id: 'mcp1', tool: 'mcp_demo', args: { q: 'test' }, server_side: true } },
        { event: 'tool_done', data: { call_id: 'mcp1', tool: 'mcp_demo', success: true, server_side: true } },
        { event: 'complete', data: { summary: 'Done' } },
    ]);
    const client = new TarangStreamClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: 'test',
        toolExecutor: {
            async execute() {
                executions++;
                return { success: true, output: 'should not run' };
            },
        },
    });
    const events = [];
    for await (const evt of client.execute('test')) events.push(evt);
    server.close();
    assert.strictEqual(executions, 0);
    assert.ok(events.some(e => e.type === 'tool_call' && e.data.server_side));
    assert.ok(events.some(e => e.type === 'tool_done' && e.data.server_side));
});

await test('summarizeSession posts transcript with auth and product headers', async () => {
    let received = null;
    const server = http.createServer((req, res) => {
        if (req.url === '/api/summarize/session' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                received = {
                    auth: req.headers.authorization,
                    product: req.headers['x-product'],
                    body: JSON.parse(body),
                };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ summary: 'backend summary', source: 'llm', model: 'gpt-4.1-mini' }));
            });
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const client = new TarangStreamClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: 'test-token',
        product: 'appstak',
        toolExecutor: mockToolExecutor,
    });
    const result = await client.summarizeSession(
        [{ role: 'user', content: 'hello' }],
        { sessionId: 'sess-1', projectPath: '/tmp/project', maxTokens: 500 },
    );
    server.close();

    assert.strictEqual(result.summary, 'backend summary');
    assert.strictEqual(result.source, 'llm');
    assert.strictEqual(received.auth, 'Bearer test-token');
    assert.strictEqual(received.product, 'appstak');
    assert.strictEqual(received.body.session_id, 'sess-1');
    assert.strictEqual(received.body.project_path, '/tmp/project');
    assert.strictEqual(received.body.max_tokens, 500);
    assert.deepStrictEqual(received.body.messages, [{ role: 'user', content: 'hello' }]);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
