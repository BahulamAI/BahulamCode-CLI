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

const MCP_PROTOCOL_VERSION = '2024-11-05';

export class McpClient {
    /**
     * @param {object} serverConfig - { command, args, env, url, transport }
     */
    constructor(serverConfig) {
        this.config = serverConfig;
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
        if (this.config.transport) return this.config.transport;
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

        switch (transportType) {
            case 'stdio': return this._connectStdio();
            case 'sse': return this._connectSSE();
            case 'websocket': return this._connectWebSocket();
            case 'streamable-http': return this._connectStreamableHttp();
            default: throw new Error(`Unknown MCP transport: ${transportType}`);
        }
    }

    async _connectStdio() {
        this.process = spawn(this.config.command, this.config.args || [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...this.config.env },
        });

        this.process.stdout.on('data', (data) => this._onData(data));
        this.process.stderr.on('data', (data) => {
            if (process.env.MCP_DEBUG) {
                process.stderr.write(`[mcp:${this.config.command}] ${data}`);
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
            clientInfo: { name: 'open-claude-code', version: '2.0.0' },
        });

        this.serverInfo = initResult;
        this.connected = true;
        this._notify('notifications/initialized', {});
        return this.serverInfo;
    }

    async _connectSSE() {
        const { SseTransport } = await import('./transport-sse.mjs');
        this.transport = new SseTransport(this.config.url, {
            headers: this.config.headers || {},
        });
        await this.transport.connect();
        this.transport.onMessage((msg) => {
            if (msg.data?.id && this.pending.has(msg.data.id)) {
                const { resolve, reject } = this.pending.get(msg.data.id);
                this.pending.delete(msg.data.id);
                if (msg.data.error) reject(new Error(msg.data.error.message));
                else resolve(msg.data.result);
            }
        });
        this.connected = true;
        return this._initRemote();
    }

    async _connectWebSocket() {
        const { WebSocketTransport } = await import('./transport-ws.mjs');
        this.transport = new WebSocketTransport(this.config.url, {
            headers: this.config.headers || {},
        });
        await this.transport.connect();
        this.connected = true;
        this.serverInfo = await this.transport.request('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'open-claude-code', version: '2.0.0' },
        });
        return this.serverInfo;
    }

    async _connectStreamableHttp() {
        const { StreamableHttpTransport } = await import('./transport-shttp.mjs');
        this.transport = new StreamableHttpTransport(this.config.url, {
            headers: this.config.headers || {},
        });
        await this.transport.connect();
        this.connected = true;
        this.serverInfo = await this.transport.request('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'open-claude-code', version: '2.0.0' },
        });
        return this.serverInfo;
    }

    async _initRemote() {
        const result = await this._transportRequest('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'open-claude-code', version: '2.0.0' },
        });
        this.serverInfo = result;
        return result;
    }

    async _transportRequest(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++this.requestId;
            this.pending.set(id, { resolve, reject });
            this.transport.send({ jsonrpc: '2.0', id, method, params });
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
        if (result?.content && Array.isArray(result.content)) {
            return result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
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
        this.connected = false;
        if (this.transport) {
            await this.transport.disconnect();
            this.transport = null;
            return;
        }
        if (!this.process) return;
        try {
            await this._request('shutdown', {});
            this._notify('exit', {});
        } catch { /* best effort */ }

        await new Promise(resolve => {
            const timeout = setTimeout(() => { this.process?.kill('SIGKILL'); resolve(); }, 2000);
            this.process.on('exit', () => { clearTimeout(timeout); resolve(); });
            this.process.kill('SIGTERM');
        });
        this.process = null;
    }

    _request(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++this.requestId;
            this.pending.set(id, { resolve, reject });
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
                    if (msg.error) reject(new Error(`MCP error: ${msg.error.message || JSON.stringify(msg.error)}`));
                    else resolve(msg.result);
                }
            } catch { /* malformed */ }
        }
    }
}
