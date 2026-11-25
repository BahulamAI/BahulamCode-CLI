import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { McpClient } from '../src/mcp/client.mjs';
import { loginMcp, McpOAuthProvider, requireSecureUrl, authFetch } from '../src/mcp/oauth.mjs';
import { McpCredentialStore, resolveMcpConfig, redactMcpConfig, safeMcpUrl, mcpError } from '../src/mcp/credentials.mjs';
import { promptMcpKey } from '../src/mcp/credential-prompt.mjs';
import { directCommandSpec, splitCommandWords, runDirectCommand } from '../src/terminal/direct-command.mjs';
import { isSensitiveConfigPath } from '../src/core/safety.mjs';
import { loadMcpServers } from '../src/mcp/loader.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bahulam-mcp-auth-'));
const originalHome = process.env.BAHULAM_HOME;
process.env.BAHULAM_HOME = home;
let base, challenge, callback, refreshes = 0, toolCalls = 0, rejectRefresh = false;
let validToken = 'test-access-1';
let validRefresh = 'test-refresh-1';
let sseResponse;
const requests = [];
const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    requests.push({ url: req.url, authorization: req.headers.authorization, raw });
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/redirect') { res.writeHead(302, { Location: base + '/do-not-forward' }).end(); return; }
    if (req.url === '/sse') {
        if (req.headers.authorization !== 'Bearer masked-key') return json(401, {});
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        sseResponse = res; res.write('event: endpoint\ndata: /sse-messages\n\n'); return;
    }
    if (req.url === '/sse-messages') {
        assert.equal(req.headers.authorization, 'Bearer masked-key');
        const message = JSON.parse(raw);
        if (message.id !== undefined) {
            const result = message.method === 'initialize'
                ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'sse-fixture', version: '1' } }
                : { tools: [] };
            sseResponse.write('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n\n');
        }
        res.writeHead(202).end(); return;
    }
    if (req.url === '/resource-metadata') return json(200, { resource: base + '/mcp', authorization_servers: [base] });
    if (req.url.startsWith('/.well-known/oauth-authorization-server')) return json(200, {
        issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register',
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    });
    if (req.url.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: base + '/mcp', authorization_servers: [base] });
    if (req.url === '/register') {
        const data = JSON.parse(raw); callback = data.redirect_uris[0];
        return json(201, { ...data, client_id: 'test-client' });
    }
    if (req.url === '/token') {
        const params = new URLSearchParams(raw);
        if (params.get('grant_type') === 'refresh_token') {
            refreshes++;
            if (rejectRefresh) return json(400, { error: 'invalid_grant', error_description: 'secret-refresh-value' });
            assert.equal(params.get('refresh_token'), validRefresh, 'rotating refresh token cannot be reused');
            validToken = 'test-access-' + (refreshes + 1);
            validRefresh = 'test-refresh-' + (refreshes + 1);
            return json(200, { access_token: validToken, refresh_token: validRefresh, token_type: 'Bearer', expires_in: 3600 });
        }
        assert.equal(params.get('code'), 'test-authorization-code');
        assert.equal(params.get('redirect_uri'), callback);
        assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), challenge);
        assert.equal(params.get('resource'), base + '/mcp');
        return json(200, { access_token: validToken, refresh_token: 'test-refresh-1', token_type: 'Bearer', expires_in: 3600 });
    }
    if (req.url === '/mcp') {
        if (req.headers.authorization !== 'Bearer ' + validToken && req.headers.authorization !== 'Bearer masked-key') {
            res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${base}/resource-metadata"`);
            return json(401, { error: 'unauthorized', secret: 'never-print-this-key' });
        }
        if (req.method === 'GET') return json(405, {});
        const message = JSON.parse(raw);
        if (!message.id && message.id !== 0) { res.writeHead(202).end(); return; }
        let result;
        if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'auth-fixture', version: '1' } };
        else if (message.method === 'tools/list') result = { tools: [{ name: 'list_items', description: 'fixture', inputSchema: { type: 'object' } }] };
        else if (message.method === 'tools/call') { toolCalls++; return json(200, { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Authorization: Bearer never-print-this-key' } }); }
        return json(200, { jsonrpc: '2.0', id: message.id, result });
    }
    json(404, {});
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;
const config = { url: base + '/mcp', auth: { type: 'oauth' } };
const store = new McpCredentialStore(config.url);
const browser = async url => {
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    challenge = url.searchParams.get('code_challenge');
    const redirect = new URL(url.searchParams.get('redirect_uri'));
    redirect.searchParams.set('code', 'test-authorization-code');
    redirect.searchParams.set('state', 'wrong');
    assert.equal((await fetch(redirect)).status, 400);
    redirect.searchParams.set('state', url.searchParams.get('state'));
    assert.equal((await fetch(redirect)).status, 200);
};
test.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (originalHome === undefined) delete process.env.BAHULAM_HOME; else process.env.BAHULAM_HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
});

test('OAuth login validates state and PKCE, stores issuer-bound tokens privately', async () => {
    await loginMcp(config, { openBrowser: browser });
    assert.equal(store.read().tokens.access_token, validToken);
    assert.ok(store.read().tokens.issuer);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
        assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700);
    }
    assert.ok(isSensitiveConfigPath(store.file));
    assert.equal(store.read().verifier, undefined);
    assert.equal(new McpCredentialStore(base + '/other').read().tokens, undefined);
});

test('runtime reuses tokens, refreshes expired tokens and rotates refresh token', async () => {
    store.update({ expiresAt: Date.now() - 100 });
    const client = new McpClient(config);
    try {
        await client.connect();
        assert.equal((await client.listTools())[0].name, 'list_items');
        assert.equal(refreshes, 1);
        assert.equal(store.read().tokens.refresh_token, 'test-refresh-2');
        await assert.rejects(client.callTool('list_items', {}), error => !error.message.includes('never-print-this-key'));
    } finally { await client.disconnect(); }
});

test('401 during an established session refreshes authentication', async () => {
    const client = new McpClient(config);
    try {
        await client.connect(); const before = refreshes; validToken = 'server-expired-the-token';
        assert.equal((await client.listTools()).length, 1);
        assert.ok(refreshes > before);
        assert.equal(store.read().tokens.refresh_token, validRefresh);
    } finally { await client.disconnect(); }
});

test('invalid refresh requires explicit login without leaking provider errors', async () => {
    rejectRefresh = true; store.update({ expiresAt: Date.now() - 100 });
    await assert.rejects(new McpClient(config).connect(), /sign-in required/);
    assert.equal(store.read().tokens, undefined);
    rejectRefresh = false;
    const before = requests.length;
    await assert.rejects(new McpClient(config).connect(), /mcp login/);
    assert.equal(requests.length, before, 'no registration on runtime startup');
});

test('login cancellation and timeout preserve previous saved credentials', async () => {
    store.write({ apiKey: 'previous-key' });
    const abort = new AbortController();
    await assert.rejects(loginMcp(config, { signal: abort.signal, openBrowser: async () => abort.abort() }), /cancelled/);
    assert.equal(store.read().apiKey, 'previous-key');
    await assert.rejects(loginMcp(config, { timeoutMs: 100, openBrowser: async () => {} }), /timed out/);
});

test('API-key auth and environment references work without global env mutation', async () => {
    store.write({ apiKey: 'masked-key' });
    const client = new McpClient({ url: config.url, auth: { type: 'api-key' } });
    try { await client.connect(); assert.equal((await client.listTools()).length, 1); }
    finally { await client.disconnect(); }
    const resolved = resolveMcpConfig({ env: { TOKEN_FOR_MCP: '${EXTERNAL}' }, headers: { Authorization: 'Bearer ${TOKEN_FOR_MCP}' } }, { EXTERNAL: 'resolved-secret' });
    assert.equal(resolved.headers.Authorization, 'Bearer resolved-secret');
    assert.equal(process.env.TOKEN_FOR_MCP, undefined);
    assert.throws(() => resolveMcpConfig({ headers: { Authorization: '${UNSET}' } }, {}), /Missing MCP environment variable/);
});

test('config/error redaction includes URL credentials, args, headers and env', () => {
    const redacted = JSON.stringify(redactMcpConfig({ url: 'https://user:password@example.test/mcp/secret?key=secret', env: { TOKEN: 'secret' }, args: ['secret'], headers: { Authorization: 'Bearer secret', 'X-Key': '${API_KEY}' } }));
    assert.ok(!redacted.includes('secret')); assert.ok(!redacted.includes('password'));
    assert.ok(redacted.includes('${API_KEY}'));
    assert.ok(!mcpError(new Error('Bearer secret https://example.com/mcp/secret')).includes('secret'));
    assert.equal(safeMcpUrl('https://host/mcp'), 'https://host/mcp');
    assert.throws(() => requireSecureUrl('http://example.com/mcp'), /HTTPS/);
    assert.ok(!mcpError({ mcpSafe: true, message: 'secret' }).includes('secret'));
});

test('HTTP credentials are not forwarded through redirects', async () => {
    const before = requests.length;
    await assert.rejects(authFetch(base + '/redirect', { headers: { Authorization: 'Bearer secret' } }));
    assert.equal(requests.length, before + 1);
    assert.equal(requests.at(-1).url, '/redirect');
});

test('legacy SSE uses the same saved OAuth credentials on GET and POST', async () => {
    const url = base + '/sse';
    new McpCredentialStore(url).write({ tokens: { access_token: 'masked-key', token_type: 'Bearer', issuer: base } });
    const client = new McpClient({ url, auth: { type: 'oauth' } });
    try { await client.connect(); assert.equal(client.serverInfo.serverInfo.name, 'sse-fixture'); assert.deepEqual(await client.listTools(), []); }
    finally { await client.disconnect(); }
});

test('credential store rejects symlinks and permissive credentials on POSIX', { skip: process.platform === 'win32' }, () => {
    const isolated = new McpCredentialStore(base + '/private');
    isolated.write({ apiKey: 'isolated' });
    fs.chmodSync(isolated.file, 0o644);
    assert.throws(() => isolated.read(), /private MCP credentials/);
    isolated.clear();
    fs.symlinkSync(store.file, isolated.file);
    assert.throws(() => isolated.read(), /private MCP credentials/);
    isolated.clear();
});

test('masked prompt never echoes key and restores raw mode on success/cancel', async () => {
    const input = new PassThrough(); input.isTTY = true; input.isRaw = false;
    input.setRawMode = value => { input.isRaw = value; };
    let printed = '';
    const output = new Writable({ write(chunk, _, done) { printed += chunk; done(); } }); output.isTTY = true;
    const promise = promptMcpKey({ input, output }); input.write('hidden-api-key\r');
    assert.equal(await promise, 'hidden-api-key'); assert.equal(input.isRaw, false); assert.ok(!printed.includes('hidden-api-key'));
    const cancel = promptMcpKey({ input, output }); input.write('\x03');
    await assert.rejects(cancel, /cancelled/); assert.equal(input.isRaw, false);
});

test('!bahulam uses this installed CLI and preserves literal env references', async () => {
    const spec = directCommandSpec('!bahulam mcp add demo --url https://example.com/mcp --header \'Authorization: Bearer ${API_KEY}\'');
    assert.equal(spec.shell, false); assert.equal(spec.command, process.execPath);
    assert.equal(spec.args.at(-1), 'Authorization: Bearer ${API_KEY}');
    assert.deepEqual(splitCommandWords('add test --api-key-prefix ""'), ['add', 'test', '--api-key-prefix', '']);
    assert.equal(directCommandSpec('!git status').shell, true);
    const result = await runDirectCommand('!exit 7'); assert.equal(result.code, 7);
});

test('CLI JSON output redacts stored credentials and test does not execute tools', async () => {
    const fakeHome = path.join(home, 'cli-home'); fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.claude/settings.json'), JSON.stringify({ mcpServers: { demo: { url: config.url, headers: { Authorization: 'Bearer masked-key' } } } }));
    const cli = args => new Promise(resolve => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', 'import {handleMcpCommand} from "./src/commands/mcp.mjs"; await handleMcpCommand(process.argv.slice(1));', ...args], { env: { ...process.env, HOME: fakeHome }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
        child.on('close', code => resolve({ code, output }));
    });
    const listed = await cli(['list', '--json']); assert.equal(listed.code, 0); assert.ok(!listed.output.includes('masked-key'));
    const before = toolCalls;
    const tested = await cli(['test', 'demo']); assert.equal(tested.code, 0, tested.output); assert.equal(toolCalls, before);
    assert.match(tested.output, /1 tools available\.\n  list_items\n/);
    const detail = await cli(['test', 'demo', '--json']);
    assert.equal(detail.code, 0, detail.output);
    const parsed = JSON.parse(detail.output);
    assert.equal(parsed.tool_count, 1);
    assert.deepEqual(parsed.tools, [{ name: 'list_items', description: 'fixture', inputSchema: { type: 'object' } }]);
    assert.equal(toolCalls, before, 'inspecting schemas must not execute tools');
    assert.ok(!detail.output.includes('masked-key'));
});

test('startup discovery passes descriptions and input schemas to runtime registration', async () => {
    const registered = [];
    const loaded = await loadMcpServers({ registerMcpTool: (...args) => registered.push(args) }, {
        mcpServers: { demo: { url: config.url, headers: { Authorization: 'Bearer masked-key' } } },
    });
    try {
        assert.equal(loaded.errors.length, 0);
        assert.equal(registered.length, 1);
        assert.deepEqual(registered[0].slice(0, 3), ['settings', 'demo', 'list_items']);
        assert.deepEqual(registered[0][4], { type: 'object' });
        assert.equal(registered[0][5], 'fixture');
    } finally { await loaded.disconnectAll(); }
});
