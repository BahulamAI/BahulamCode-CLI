/**
 * E2E SSE Flow Tests — full stream lifecycle against mock server.
 */

import { TarangStreamClient } from '../src/core/stream-client.mjs';
import { createToolExecutor } from '../src/core/tool-executor.mjs';
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

const executor = createToolExecutor();

function createServer(handler) {
    return new Promise(resolve => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: server.address().port });
        });
    });
}

console.log('\n\x1b[1me2e-sse-flow.mjs\x1b[0m\n');

// Test: Happy path — status → tool_call → callback → complete
await test('happy path: status → tool_call → callback → complete', async () => {
    let callbackBody = null;
    const { server, port } = await createServer((req, res) => {
        if (req.url === '/api/execute') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Task-ID': 'task_happy' });
            res.write(`event: status\ndata: {"message":"Reading files..."}\n\n`);
            res.write(`event: tool_call\ndata: {"call_id":"tc1","tool":"get_file_info","args":{"path":"package.json"}}\n\n`);
            // Wait a bit for callback before sending complete
            setTimeout(() => {
                res.write(`event: complete\ndata: {"summary":"All done","changes":1,"duration_s":0.5}\n\n`);
                res.end();
            }, 300);
        } else if (req.url === '/api/callback') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                callbackBody = JSON.parse(body);
                res.writeHead(200);
                res.end('{}');
            });
        }
    });

    const client = new TarangStreamClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: 'test', openRouterKey: 'test', toolExecutor: executor,
    });

    const events = [];
    for await (const evt of client.execute('test')) events.push(evt);
    server.close();

    assert.strictEqual(events[0].type, 'status');
    assert.strictEqual(events[events.length - 1].type, 'complete');
    assert.ok(callbackBody, 'callback must be received');
    assert.strictEqual(callbackBody.task_id, 'task_happy');
    assert.strictEqual(callbackBody.call_id, 'tc1');
    assert.ok(callbackBody.result.success);
});

// Test: Error event ends stream
await test('error event ends stream', async () => {
    const { server, port } = await createServer((req, res) => {
        if (req.url === '/api/execute') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`event: status\ndata: {"message":"Starting..."}\n\n`);
            res.write(`event: error\ndata: {"message":"Internal error","fatal":true}\n\n`);
            res.end();
        }
    });

    const client = new TarangStreamClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: 'test', openRouterKey: 'test', toolExecutor: executor,
    });

    const events = [];
    for await (const evt of client.execute('test')) events.push(evt);
    server.close();

    assert.strictEqual(events[0].type, 'status');
    assert.strictEqual(events[1].type, 'error');
    assert.strictEqual(events[1].data.message, 'Internal error');
});

// Test: Network error produces error event
await test('network error produces error event', async () => {
    const client = new TarangStreamClient({
        baseUrl: 'http://127.0.0.1:1', // nothing listening
        token: 'test', openRouterKey: 'test', toolExecutor: executor,
    });

    const events = [];
    for await (const evt of client.execute('test')) events.push(evt);

    assert.strictEqual(events[0].type, 'error');
    assert.ok(events[0].data.message.includes('Network error') || events[0].data.message.includes('fetch'));
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
