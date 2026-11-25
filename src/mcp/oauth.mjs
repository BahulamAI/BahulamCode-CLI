import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { auth, extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { McpCredentialStore, safeMcpError } from './credentials.mjs';

export function requireSecureUrl(value) {
    const url = new URL(value);
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
        throw safeMcpError('MCP authentication requires HTTPS (HTTP is allowed only on loopback). Do not embed credentials in URLs.');
    }
    return url;
}

// Never forward an Authorization header across a redirect, including discovery.
const refreshRequests = new Map();
export function authFetch(input, init = {}) {
    requireSecureUrl(input instanceof Request ? input.url : input);
    const request = () => fetch(input, { ...init, redirect: 'error', signal: init.signal || AbortSignal.timeout(30_000) });
    const params = init.body instanceof URLSearchParams ? init.body : null;
    if (params?.get('grant_type') !== 'refresh_token') return request();
    // Streamable HTTP can receive a 401 concurrently on its GET event stream
    // and POST request. Reusing the same rotating refresh token twice logs the
    // user out on many providers. Share the response for overlapping requests.
    const key = createHash('sha256').update(String(input) + '\n' + params.toString()).digest('hex');
    if (!refreshRequests.has(key)) {
        const pending = request();
        refreshRequests.set(key, pending);
        pending.finally(() => setTimeout(() => refreshRequests.delete(key), 5000).unref()).catch(() => {});
    }
    return refreshRequests.get(key).then(response => response.clone());
}

export class McpOAuthProvider {
    constructor(config, { store = new McpCredentialStore(config.url), redirectUrl, openBrowser } = {}) {
        requireSecureUrl(config.url);
        this.config = config;
        this.store = store;
        this.callback = redirectUrl;
        this.openBrowser = openBrowser;
        this.nonce = randomBytes(32).toString('hex');
    }
    get redirectUrl() { return this.callback || this.store.read().redirectUrl || 'http://127.0.0.1/callback'; }
    get clientMetadata() {
        return { client_name: 'Bahulam Code', redirect_uris: [this.redirectUrl],
            grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
            ...(this.config.auth?.scope ? { scope: this.config.auth.scope } : {}) };
    }
    state() { return this.nonce; }
    clientInformation() {
        return this.store.read().client || (this.config.auth?.clientId ? { client_id: this.config.auth.clientId } : undefined);
    }
    saveClientInformation(client) { this.store.update({ client, redirectUrl: this.redirectUrl }); }
    tokens() { return this.store.read().tokens; }
    saveTokens(tokens) {
        const previous = this.tokens();
        // Refresh responses may omit a replacement refresh token.
        if (!tokens.refresh_token && previous?.issuer === tokens.issuer && previous?.refresh_token) tokens = { ...tokens, refresh_token: previous.refresh_token };
        this.store.update({ tokens, expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null, redirectUrl: this.redirectUrl });
    }
    saveCodeVerifier(value) { this.verifier = value; }
    saveDiscoveryState(value) { this.store.update({ discovery: value }); }
    discoveryState() { return this.store.read().discovery; }
    codeVerifier() {
        if (!this.verifier) throw safeMcpError('OAuth login expired. Run bahulam mcp login <name> again.');
        return this.verifier;
    }
    async redirectToAuthorization(url) {
        if (!this.openBrowser) throw safeMcpError('MCP sign-in required. Run bahulam mcp login <name>, then reconnect the server.');
        requireSecureUrl(url);
        await this.openBrowser(url);
    }
    invalidateCredentials(scope) {
        if (scope === 'all') this.store.clear();
        else if (scope === 'client') this.store.update({ client: undefined });
        else if (scope === 'tokens') this.store.update({ tokens: undefined, expiresAt: undefined });
        else if (scope === 'verifier') this.verifier = undefined;
        else if (scope === 'discovery') this.store.update({ discovery: undefined });
    }
    async refreshIfExpired() {
        const saved = this.store.read();
        if (saved.expiresAt && saved.expiresAt <= Date.now() + 30_000) {
            if (!saved.tokens?.refresh_token) {
                throw safeMcpError('MCP sign-in expired. Run bahulam mcp login <name> again.');
            }
            await auth(this, { serverUrl: this.config.url, fetchFn: authFetch });
        }
    }
}

export async function openAuthBrowser(url) {
    const target = String(requireSecureUrl(url));
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', target] : [target];
    await new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'ignore', shell: false });
        child.once('error', () => reject(safeMcpError('Could not open the browser. Run login in a desktop terminal with a default browser.')));
        child.once('exit', code => code === 0 ? resolve() : reject(safeMcpError('Could not open the browser. Check your default browser and retry.')));
    });
}

export async function loginMcp(config, { openBrowser = openAuthBrowser, store = new McpCredentialStore(config.url), timeoutMs = 180_000, signal } = {}) {
    requireSecureUrl(config.url);
    const controller = new AbortController();
    const abort = () => controller.abort(safeMcpError('MCP login cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    process.once('SIGINT', abort);
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(safeMcpError('MCP login timed out. Run login again.')), timeoutMs);
    let provider;
    let finish;
    const callback = new Promise(resolve => { finish = resolve; });
    const server = http.createServer((req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        const url = new URL(req.url, 'http://127.0.0.1');
        const received = Buffer.from(url.searchParams.get('state') || '');
        const expected = Buffer.from(provider?.state() || '');
        if (req.method !== 'GET' || url.pathname !== '/callback' || !received.length || received.length !== expected.length || !timingSafeEqual(received, expected)) {
            res.writeHead(400).end('Invalid login callback.'); return;
        }
        if (url.searchParams.has('error')) {
            res.end('Sign-in declined. Return to Bahulam.');
            controller.abort(safeMcpError('MCP sign-in was declined.')); return;
        }
        const code = url.searchParams.get('code');
        if (!code || code.length > 8192) { res.writeHead(400).end('Missing authorization code.'); return; }
        res.end('Sign-in received. Return to Bahulam to finish connecting.');
        finish(code);
    });
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(config.auth?.callbackPort || 0, '127.0.0.1', resolve);
        });
        const redirectUrl = `http://127.0.0.1:${server.address().port}/callback`;
        // Keep tokens/registration off disk until the entire login succeeds.
        // A fresh dynamic registration uses this attempt's ephemeral callback.
        let state = {};
        const staged = { read: () => state, update: patch => { state = { ...state, ...patch }; }, clear: () => { state = {}; } };
        provider = new McpOAuthProvider(config, { store: staged, redirectUrl, openBrowser });
        const fetchFn = (input, init = {}) => authFetch(input, { ...init, signal: controller.signal });
        if (controller.signal.aborted) throw controller.signal.reason;
        // Read the actual challenge: some servers publish resource metadata at
        // a custom URL rather than the default well-known path.
        const probe = await fetchFn(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bahulam-code', version: '1.0.0' } } }) });
        const challenge = extractWWWAuthenticateParams(probe);
        await probe.body?.cancel();
        const result = await auth(provider, { serverUrl: config.url, fetchFn, resourceMetadataUrl: challenge.resourceMetadataUrl, scope: config.auth?.scope || challenge.scope });
        if (result === 'REDIRECT') {
            const code = await new Promise((resolve, reject) => {
                const onAbort = () => reject(controller.signal.reason);
                if (controller.signal.aborted) return onAbort();
                controller.signal.addEventListener('abort', onAbort, { once: true });
                callback.then(value => { controller.signal.removeEventListener('abort', onAbort); resolve(value); });
            });
            await auth(provider, { serverUrl: config.url, authorizationCode: code, fetchFn });
        }
        if (!state.tokens?.access_token) throw safeMcpError('MCP login did not return an access token.');
        store.write(state);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        process.removeListener('SIGINT', abort);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        if (provider) provider.verifier = undefined;
    }
}
