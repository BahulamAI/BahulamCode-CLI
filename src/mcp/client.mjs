/**
 * MCP Client — multi-transport Model Context Protocol client.
 *
 * Supports four transports:
 * - stdio: spawn child process, communicate via stdin/stdout
 * - sse: Server-Sent Events over HTTP
 * - websocket: bidirectional WebSocket
 * - streamable-http: POST with SSE response (new MCP transport)
 *
 * Auto-detects transport from server config.
 */

import { spawn } from 'child_process';
import { resolveMcpConfig, mcpError, safeMcpError } from './credentials.mjs';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class McpClient {
    /**
     * @param {object} serverConfig - { command, args, env, url, transport }
     */
    constructor(serverConfig) {
        this.config = resolveMcpConfig(serverConfig);
        this.process = null;
        this.transport = null;
        this.requestId = 0;
        this.pending = new Map();
        this.buffer = '';
        this.tools = [];
        this.resources = [];
        this.serverInfo = null;
        this.connected = false;
    }

    _detectTransport() {
        if (this.config.transport) return this.config.transport === 'http' ? 'streamable-http' : this.config.transport;
        if (this.config.command) return 'stdio';
        if (this.config.url) {
            if (this.config.url.startsWith('ws://') || this.config.url.startsWith('wss://')) return 'websocket';
            if (this.config.url.includes('/sse')) return 'sse';
            return 'streamable-http';
        }
        return 'stdio';
    }

    async connect() {
        const transportType = this._detectTransport();
        try {
            switch (transportType) {
                case 'stdio': return await this._connectStdio();
                case 'sse': return await this._connectSSE();
                case 'websocket': return await this._connectWebSocket();
                case 'streamable-http': return await this._connectStreamableHttp();
                default: throw safeMcpError('Unknown MCP transport.');
            }
        } catch (error) {
            await this.disconnect().catch(() => {});
            throw safeMcpError(mcpError(error));
        }
    }

    async _connectStdio() {
        this.process = spawn(this.config.command, this.config.args || [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...this.config.env },
        });

        this.process.stdout.on('data', (data) => this._onData(data));
        this.process.on('error', () => {
            for (const { reject } of this.pending.values()) reject(safeMcpError('Could not start the MCP server process. Check its command and environment.'));
            this.pending.clear();
        });
        this.process.stderr.on('data', (data) => {
            if (process.env.MCP_DEBUG) {
                process.stderr.write('[mcp] Server wrote diagnostic output (hidden to protect credentials).\n');
            }
        });

        this.process.on('exit', (code) => {
            this.connected = false;
            for (const [, { reject }] of this.pending) {
                reject(new Error(`MCP server exited with code ${code}`));
            }
            this.pending.clear();
        });

        const initResult = await this._request('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'bahulam-code', version: '2.0.0' },
        });

        this.serverInfo = initResult;
        this.connected = true;
        this._notify('notifications/initialized', {});
        return this.serverInfo;
    }

    async _connectSSE() { return this._connectHttp('sse'); }

    async _connectHttp(kind) {
        const { connectRemoteMcp } = await import('./remote-client.mjs');
        this.transport = await connectRemoteMcp(this.config, kind);
        this.connected = true;
        this.serverInfo = this.transport.serverInfo;
        return this.serverInfo;
    }

    async _connectWebSocket() {
        if (this.config.auth) throw safeMcpError('Stored MCP authentication requires HTTP or SSE; use headers for WebSocket servers.');
        if (Object.keys(this.config.headers || {}).length) {
            const { requireSecureUrl } = await import('./oauth.mjs');
            requireSecureUrl(this.config.url.replace(/^ws/, 'http'));
        }
        const { WebSocketTransport } = await import('./transport-ws.mjs');
        this.transport = new WebSocketTransport(this.config.url, {
            headers: this.config.headers || {},
        });
        const request = this.transport.request.bind(this.transport);
        this.transport.request = async (...args) => {
            try { return await request(...args); }
            catch (error) { throw safeMcpError(mcpError(error)); }
        };
        await this.transport.connect();
        this.connected = true;
        this.serverInfo = await this.transport.request('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'bahulam-code', version: '2.0.0' },
        });
        this._notifyRemote('notifications/initialized', {});
        return this.serverInfo;
    }

    async _connectStreamableHttp() { return this._connectHttp('streamable-http'); }

    async _initRemote() {
        const result = await this._transportRequest('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'bahulam-code', version: '2.0.0' },
        });
        this.serverInfo = result;
        return result;
    }

    _notifyRemote(method, params) {
        if (this.transport?.request) {
            // WebSocket / sHTTP transports have native request() — use send()
            // for notifications (no id, no response expected).
            if (this.transport.send) {
                this.transport.send({ jsonrpc: '2.0', method, params }).catch(() => {});
            }
        } else if (this.transport) {
            // SSE transport — fire-and-forget via send()
            this.transport.send({ jsonrpc: '2.0', method, params }).catch(() => {});
        }
    }

    async _transportRequest(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++this.requestId;
            const timeout = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`MCP request timeout: ${method} (${DEFAULT_REQUEST_TIMEOUT_MS}ms)`));
                }
            }, DEFAULT_REQUEST_TIMEOUT_MS);
            this.pending.set(id, {
                resolve: (val) => { clearTimeout(timeout); resolve(val); },
                reject: (err) => { clearTimeout(timeout); reject(err); },
            });
            this.transport.send({ jsonrpc: '2.0', id, method, params }).catch(err => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    clearTimeout(timeout);
                    reject(err);
                }
            });
        });
    }

    async listTools() {
        let result;
        if (this.transport?.request) {
            result = await this.transport.request('tools/list', {});
        } else if (this.transport) {
            result = await this._transportRequest('tools/list', {});
        } else {
            result = await this._request('tools/list', {});
        }
        this.tools = result?.tools || [];
        return this.tools;
    }

    async callTool(name, args) {
        const params = { name, arguments: args };
        let result;
        if (this.transport?.request) {
            result = await this.transport.request('tools/call', params);
        } else if (this.transport) {
            result = await this._transportRequest('tools/call', params);
        } else {
            result = await this._request('tools/call', params);
        }
        if (result?.isError) throw safeMcpError('MCP tool reported an error. Provider details are hidden because they may contain credentials.');
        if (result?.content && Array.isArray(result.content)) {
            const textParts = result.content.filter(c => c.type === 'text').map(c => c.text);
            const imageParts = result.content.filter(c => c.type === 'image');
            if (imageParts.length > 0 && textParts.length === 0) {
                return result;
            }
            if (textParts.length > 0) {
                return textParts.join('\n');
            }
        }
        return result;
    }

    async readResource(uri) {
        const params = { uri };
        if (this.transport?.request) return this.transport.request('resources/read', params);
        if (this.transport) return this._transportRequest('resources/read', params);
        return this._request('resources/read', params);
    }

    async listResources() {
        let result;
        if (this.transport?.request) result = await this.transport.request('resources/list', {});
        else if (this.transport) result = await this._transportRequest('resources/list', {});
        else result = await this._request('resources/list', {});
        this.resources = result?.resources || [];
        return this.resources;
    }

    async disconnect() {
        const wasConnected = this.connected;
        this.connected = false;
        if (this.transport) {
            await this.transport.disconnect();
            this.transport = null;
            return;
        }
        if (!this.process) return;
        if (this.process.exitCode !== null || this.process.signalCode !== null || !this.process.pid) { this.process = null; return; }
        try {
            if (wasConnected) {
                await this._request('shutdown', {}, 2000);
                this._notify('exit', {});
            }
        } catch { /* best effort */ }

        await new Promise(resolve => {
            const timeout = setTimeout(() => { this.process?.kill('SIGKILL'); resolve(); }, 2000);
            this.process.on('exit', () => { clearTimeout(timeout); resolve(); });
            this.process.kill('SIGTERM');
        });
        this.process = null;
    }

    _request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            const id = ++this.requestId;
            const timeout = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(safeMcpError(`MCP request timeout: ${method} (${timeoutMs}ms)`));
                }
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (val) => { clearTimeout(timeout); resolve(val); },
                reject: (err) => { clearTimeout(timeout); reject(err); },
            });
            const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
            this.process.stdin.write(msg + '\n');
        });
    }

    _notify(method, params) {
        const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
        this.process?.stdin.write(msg + '\n');
    }

    _onData(data) {
        this.buffer += data.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop();
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line);
                if (msg.id && this.pending.has(msg.id)) {
                    const { resolve, reject } = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    if (msg.error) reject(safeMcpError(mcpError(msg.error)));
                    else resolve(msg.result);
                }
            } catch { /* malformed */ }
        }
    }
}
