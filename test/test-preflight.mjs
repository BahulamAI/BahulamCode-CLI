/**
 * Tests for preflight auth/backend diagnostics.
 */

import assert from 'node:assert';
import http from 'node:http';
import { checkAuthAndBackend, checkCreditsAndPlan } from '../src/onboarding/preflight.mjs';

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

function authWith(creds) {
    return {
        loadCredentials() {
            return creds;
        },
    };
}

function createServer(handler) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(handler);
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

async function withServer(handler, fn) {
    const { server, url } = await createServer(handler);
    try {
        return await fn(url);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

console.log('\n\x1b[1mtest-preflight.mjs\x1b[0m\n');

await test('no token reports Online when backend is reachable', async () => {
    await withServer((req, res) => {
        res.writeHead(200);
        res.end('ok');
    }, async (url) => {
        const result = await checkAuthAndBackend(authWith({ backendUrl: url }));
        assert.strictEqual(result.status, 'warn');
        assert.strictEqual(result.label, 'Online');
        assert.strictEqual(result.hint, '/login to sign in');
    });
});

await test('no token reports Offline when backend is unreachable', async () => {
    const result = await checkAuthAndBackend(
        authWith({ backendUrl: 'http://127.0.0.1:1' }),
        { timeoutMs: 100 },
    );
    assert.strictEqual(result.status, 'warn');
    assert.strictEqual(result.label, 'Offline');
    assert.ok(!result.hint);
});

await test('valid token reports Online and returns user payload', async () => {
    await withServer((req, res) => {
        assert.strictEqual(req.url, '/api/user/me');
        assert.strictEqual(req.headers.authorization, 'Bearer tok_valid');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ email: 'dev@example.com' }));
    }, async (url) => {
        const result = await checkAuthAndBackend(authWith({ token: 'tok_valid', backendUrl: url }));
        assert.strictEqual(result.status, 'ok');
        assert.strictEqual(result.label, 'Online');
        assert.strictEqual(result.user.email, 'dev@example.com');
    });
});

await test('expired token keeps backend Online with refresh hint', async () => {
    await withServer((req, res) => {
        res.writeHead(401);
        res.end('expired');
    }, async (url) => {
        const result = await checkAuthAndBackend(authWith({ token: 'tok_expired', backendUrl: url }));
        assert.strictEqual(result.status, 'warn');
        assert.strictEqual(result.label, 'Online');
        assert.strictEqual(result.hint, '/login again to refresh');
    });
});

await test('server error reports Offline without verbose backend wording', async () => {
    await withServer((req, res) => {
        res.writeHead(500);
        res.end('error');
    }, async (url) => {
        const result = await checkAuthAndBackend(authWith({ token: 'tok', backendUrl: url }));
        assert.strictEqual(result.status, 'warn');
        assert.strictEqual(result.label, 'Offline');
        assert.ok(!result.hint);
    });
});

await test('localhost backend gets enough default timeout headroom', async () => {
    await withServer((req, res) => {
        setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{}');
        }, 3000);
    }, async (url) => {
        const result = await checkAuthAndBackend(authWith({ token: 'tok_slow', backendUrl: url }));
        assert.strictEqual(result.status, 'ok');
        assert.strictEqual(result.label, 'Online');
    });
});

await test('explicit short timeout can still report Offline', async () => {
    await withServer((req, res) => {
        setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{}');
        }, 100);
    }, async (url) => {
        const result = await checkAuthAndBackend(
            authWith({ token: 'tok_slow', backendUrl: url }),
            { timeoutMs: 10 },
        );
        assert.strictEqual(result.status, 'warn');
        assert.strictEqual(result.label, 'Offline');
    });
});

await test('credits check surfaces normal rolling message window', async () => {
    await withServer((req, res) => {
        assert.strictEqual(req.url, '/api/billing/balance');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            tier: 'free',
            balance: { total: 42 },
            rate_limit: {
                tier: 'free',
                msgs_used_in_window: 5,
                msgs_per_window: 50,
                window_reset_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            },
        }));
    }, async (url) => {
        const result = await checkCreditsAndPlan(authWith({ token: 'tok', backendUrl: url }));
        assert.strictEqual(result.status, 'ok');
        assert.ok(result.label.includes('FREE'));
        assert.ok(result.label.includes('45 / 50 messages this window'));
    });
});

await test('credits check warns on low rolling message window', async () => {
    await withServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            tier: 'pro',
            rate_limit: {
                tier: 'pro',
                msgs_used_in_window: 48,
                msgs_per_window: 50,
            },
        }));
    }, async (url) => {
        const result = await checkCreditsAndPlan(authWith({ token: 'tok', backendUrl: url }));
        assert.strictEqual(result.status, 'warn');
        assert.ok(result.label.includes('2 / 50 messages this window'));
        assert.strictEqual(result.hint, 'low message window — bahulam.ai/pricing');
    });
});

await test('credits check fails on exhausted rolling message window', async () => {
    await withServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            tier: 'free',
            rate_limit: {
                tier: 'free',
                msgs_used_in_window: 50,
                msgs_per_window: 50,
            },
        }));
    }, async (url) => {
        const result = await checkCreditsAndPlan(authWith({ token: 'tok', backendUrl: url }));
        assert.strictEqual(result.status, 'fail');
        assert.ok(result.label.includes('0 / 50 messages this window'));
        assert.strictEqual(result.hint, 'message window exhausted — try again after reset');
    });
});

await test('credits check falls back to credit balance label when no window exists', async () => {
    await withServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tier: 'creator', balance: { total: 24 } }));
    }, async (url) => {
        const result = await checkCreditsAndPlan(authWith({ token: 'tok', backendUrl: url }));
        assert.strictEqual(result.status, 'warn');
        assert.strictEqual(result.label, 'Plan: CREATOR · 24 credits remaining');
        assert.strictEqual(result.hint, 'low balance — bahulam.ai/pricing');
    });
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
