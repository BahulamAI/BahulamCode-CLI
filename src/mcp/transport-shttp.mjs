/**
 * Streamable HTTP Transport — new MCP transport.
 *
 * Uses POST with SSE response body for bidirectional communication.
 * Each request is a POST that returns a streaming SSE response.
 */

export class StreamableHttpTransport {
    /**
     * @param {string} url - HTTP endpoint URL
     * @param {object} [options] - { headers, timeout, sessionId }
     */
    constructor(url, options = {}) {
        this.url = url;
        this.headers = options.headers || {};
        this.timeout = options.timeout || 30000;
        this.sessionId = options.sessionId || null;
        this.connected = false;
    }

    async connect() {
        // Test connectivity with an empty request
        const res = await fetch(this.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
                ...this.headers,
            },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: {} }),
        });

        if (res.ok) {
            this.sessionId = res.headers.get('x-session-id') || this.sessionId;
            this.connected = true;
        }
        return this;
    }

    /**
     * Send a JSON-RPC request and receive a streaming SSE response.
     * Collects all events and returns the final result.
     */
    async request(method, params) {
        const id = Date.now();
        const body = { jsonrpc: '2.0', id, method, params };

        const headers = {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...this.headers,
        };

        if (this.sessionId) {
            headers['x-session-id'] = this.sessionId;
        }

        const res = await fetch(this.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            throw new Error(`sHTTP error: ${res.status} ${res.statusText}`);
        }

        const contentType = res.headers.get('content-type') || '';

        // If SSE response, stream it
        if (contentType.includes('text/event-stream')) {
            return this._readSSEResponse(res);
        }

        // Otherwise, plain JSON
        return res.json();
    }

    async _readSSEResponse(res) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let result = null;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const events = buffer.split('\n\n');
                buffer = events.pop() || '';

                for (const raw of events) {
                    const parsed = this._parseEvent(raw);
                    if (parsed?.data?.result !== undefined) {
                        result = parsed.data.result;
                    } else if (parsed?.data?.error) {
                        throw new Error(parsed.data.error.message || 'Unknown error');
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        return result;
    }

    _parseEvent(raw) {
        const dataLines = [];
        for (const line of raw.split('\n')) {
            if (line.startsWith('data: ')) dataLines.push(line.slice(6));
        }
        if (dataLines.length === 0) return null;
        try {
            return { data: JSON.parse(dataLines.join('\n')) };
        } catch {
            return null;
        }
    }

    async send(message) {
        return this.request(message.method, message.params);
    }

    async disconnect() {
        this.connected = false;
    }
}
