import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpCredentialStore, mcpError, safeMcpError } from './credentials.mjs';
import { McpOAuthProvider, authFetch, requireSecureUrl } from './oauth.mjs';

// Adapter keeps Node, Rust and plugin integrations on the same auth/transport.
export async function connectRemoteMcp(config, kind) {
    const store = new McpCredentialStore(config.url);
    const saved = store.read();
    const headers = { ...config.headers };
    if (config.auth?.type === 'api-key') {
        requireSecureUrl(config.url);
        if (!saved.apiKey) throw safeMcpError('MCP API key missing. Run bahulam mcp login <name> --api-key.');
        headers[config.auth.header || 'Authorization'] = (config.auth.prefix ?? 'Bearer ') + saved.apiKey;
    }
    const oauth = config.auth?.type === 'oauth' || (!config.auth && saved.tokens);
    if (oauth && Object.keys(headers).some(key => key.toLowerCase() === 'authorization')) {
        throw safeMcpError('Choose either OAuth or an Authorization header for this MCP server.');
    }
    const provider = oauth ? new McpOAuthProvider(config, { store }) : undefined;
    if (provider && !saved.tokens) throw safeMcpError('MCP sign-in required. Run bahulam mcp login <name>, then reconnect the server.');
    // Block credential-bearing plaintext connections. Public HTTP servers retain
    // compatibility; OAuth and header-authenticated servers require TLS.
    if (provider || Object.keys(headers).length) requireSecureUrl(config.url);
    const client = new Client({ name: 'bahulam-code', version: '1.0.0' }, { capabilities: {} });
    const Transport = kind === 'sse' ? SSEClientTransport : StreamableHTTPClientTransport;
    const transport = new Transport(new URL(config.url), {
        authProvider: provider, requestInit: { headers, redirect: 'error' },
        ...(provider || Object.keys(headers).length ? { fetch: authFetch } : {}),
    });
    let connectTimeout;
    try {
        await provider?.refreshIfExpired();
        await Promise.race([
            client.connect(transport, { timeout: 30_000 }),
            new Promise((_, reject) => {
                connectTimeout = setTimeout(() => reject(safeMcpError('MCP connection timed out. Check the server and authentication.')), 30_000);
            }),
        ]);
    } catch (error) {
        await client.close().catch(() => {});
        throw safeMcpError(mcpError(error));
    } finally { clearTimeout(connectTimeout); }
    return {
        serverInfo: { serverInfo: client.getServerVersion(), capabilities: client.getServerCapabilities() },
        async request(method, params) {
            try {
                await provider?.refreshIfExpired();
                return await client.request({ method, params }, ResultSchema, { timeout: 60_000 });
            } catch (error) { throw safeMcpError(mcpError(error)); }
        },
        async disconnect() { await client.close(); },
    };
}
