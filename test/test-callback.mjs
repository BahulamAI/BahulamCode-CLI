/**
 * Unit tests for Callback Client.
 */

import { llmToolResultContent, sendCallback, sendSkippedCallback } from '../src/core/callback-client.mjs';
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

console.log('\n\x1b[1mtest-callback.mjs\x1b[0m\n');

// Test 1: Successful callback returns true
await test('successful callback returns true', async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(200);
        res.end('{}');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const result = await sendCallback(
        `http://127.0.0.1:${port}`, 'token', 'task1', 'call1',
        { success: true, output: 'hello' }
    );
    server.close();
    assert.strictEqual(result, true);
});

// Test 2: 400 error returns false without retry
await test('400 returns false without retry', async () => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
        requestCount++;
        res.writeHead(400);
        res.end('Bad request');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const result = await sendCallback(
        `http://127.0.0.1:${port}`, 'token', 'task1', 'call1',
        { success: true, output: 'test' }
    );
    server.close();
    assert.strictEqual(result, false);
    assert.strictEqual(requestCount, 1, 'should not retry on 4xx');
});

// Test 3: 500 error retries and fails
await test('500 retries 3 times then fails', async () => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
        requestCount++;
        res.writeHead(500);
        res.end('Server error');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const result = await sendCallback(
        `http://127.0.0.1:${port}`, 'token', 'task1', 'call1',
        { success: true, output: 'test' }
    );
    server.close();
    assert.strictEqual(result, false);
    assert.strictEqual(requestCount, 3, 'should retry 2 times (3 total)');
});

// Test 4: Skipped callback sends correct payload
await test('skipped callback sends correct payload', async () => {
    let receivedBody = null;
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            receivedBody = JSON.parse(body);
            res.writeHead(200);
            res.end('{}');
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    await sendSkippedCallback(
        `http://127.0.0.1:${port}`, 'token', 'task1', 'call1', 'User said no'
    );
    server.close();
    assert.strictEqual(receivedBody.task_id, 'task1');
    assert.strictEqual(receivedBody.call_id, 'call1');
    assert.strictEqual(receivedBody.result.skipped, true);
    assert.strictEqual(receivedBody.result.message, 'User said no');
});

await test('LLM shell result uses full output instead of display preview', async () => {
    const payload = JSON.parse(llmToolResultContent('shell', {
        success: true,
        output: 'full shell output\nline 2',
        output_preview: 'short UI preview',
    }));

    assert.deepStrictEqual(payload, { output: 'full shell output\nline 2' });
    assert.strictEqual(JSON.stringify(payload).includes('short UI preview'), false);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
