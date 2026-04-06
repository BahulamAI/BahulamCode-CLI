/**
 * WebSocket Transport — bidirectional MCP transport over WebSocket.
 *
 * Uses the ws protocol for full-duplex communication with MCP servers.
 * Falls back to a stub if WebSocket is not available in the runtime.
 */

export class WebSocketTransport {
    /**
     * @param {string} url - WebSocket URL (ws:// or wss://)
     * @param {object} [options] - { headers, timeout, protocols }
     */
    constructor(url, options = {}) {
        this.url = url;
        this.options = options;
        this.timeout = options.timeout || 30000;
        this.ws = null;
        this.connected = false;
        this.requestId = 0;
        this.pending = new Map();
        this.messageHandlers = [];
    }

    async connect() {
        return new Promise((resolve, reject) => {
            try {
                // Use global WebSocket if available (Node 22+)
                const WS = globalThis.WebSocket;
                if (!WS) {
                    throw new Error('WebSocket not available in this runtime');
                }

                this.ws = new WS(this.url, this.options.protocols);

                const timeout = setTimeout(() => {
                    reject(new Error('WebSocket connection timeout'));
                }, this.timeout);

                this.ws.onopen = () => {
                    clearTimeout(timeout);
                    this.connected = true;
                    resolve(this);
                };

                this.ws.onmessage = (event) => {
                    this._handleMessage(event.data);
                };

                this.ws.onerror = (err) => {
                    clearTimeout(timeout);
                    reject(new Error(`WebSocket error: ${err.message || 'unknown'}`));
                };

                this.ws.onclose = () => {
                    this.connected = false;
                    for (const [, { reject: rej }] of this.pending) {
                        rej(new Error('WebSocket closed'));
                    }
                    this.pending.clear();
                };
            } catch (err) {
                reject(err);
            }
        });
    }

    _handleMessage(data) {
        try {
            const msg = JSON.parse(typeof data === 'string' ? data : data.toString());

            // Handle response to pending request
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) {
                    reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                } else {
                    resolve(msg.result);
                }
                return;
            }

            // Handle notifications
            for (const handler of this.messageHandlers) {
                handler(msg);
            }
        } catch {
            // Malformed message
        }
    }

    async request(method, params) {
        if (!this.connected) throw new Error('WebSocket not connected');

        return new Promise((resolve, reject) => {
            const id = ++this.requestId;
            this.pending.set(id, { resolve, reject });

            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`WebSocket request timeout: ${method}`));
            }, this.timeout);

            const origResolve = resolve;
            this.pending.set(id, {
                resolve: (val) => { clearTimeout(timeout); origResolve(val); },
                reject: (err) => { clearTimeout(timeout); reject(err); },
            });

            this.ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id,
                method,
                params: params || {},
            }));
        });
    }

    async send(message) {
        return this.request(message.method, message.params);
    }

    onMessage(handler) {
        this.messageHandlers.push(handler);
    }

    async disconnect() {
        this.connected = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}
