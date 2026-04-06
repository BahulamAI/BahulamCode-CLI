/**
 * SSE Transport — Server-Sent Events transport for MCP.
 *
 * Connects to an MCP server over HTTP using SSE for server-to-client
 * messages and POST for client-to-server messages.
 */

export class SseTransport {
    /**
     * @param {string} url - SSE endpoint URL
     * @param {object} [options] - { headers, timeout }
     */
    constructor(url, options = {}) {
        this.url = url;
        this.headers = options.headers || {};
        this.timeout = options.timeout || 30000;
        this.connected = false;
        this.messageHandlers = [];
        this.reader = null;
        this.abortController = null;
    }

    async connect() {
        this.abortController = new AbortController();

        const res = await fetch(this.url, {
            headers: {
                Accept: 'text/event-stream',
                ...this.headers,
            },
            signal: this.abortController.signal,
        });

        if (!res.ok) {
            throw new Error(`SSE connect failed: HTTP ${res.status}`);
        }

        this.connected = true;
        this.reader = res.body.getReader();
        this._readLoop();
        return this;
    }

    async _readLoop() {
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (this.connected) {
                const { done, value } = await this.reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const events = buffer.split('\n\n');
                buffer = events.pop() || '';

                for (const raw of events) {
                    const parsed = this._parseSSE(raw);
                    if (parsed) {
                        for (const handler of this.messageHandlers) {
                            handler(parsed);
                        }
                    }
                }
            }
        } catch (err) {
            if (err.name !== 'AbortError') {
                this._handleError(err);
            }
        }
    }

    _parseSSE(raw) {
        let eventType = 'message';
        const dataLines = [];

        for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
        }

        if (dataLines.length === 0) return null;

        try {
            return {
                type: eventType,
                data: JSON.parse(dataLines.join('\n')),
            };
        } catch {
            return { type: eventType, data: dataLines.join('\n') };
        }
    }

    async send(message) {
        const res = await fetch(this.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...this.headers,
            },
            body: JSON.stringify(message),
        });

        if (!res.ok) {
            throw new Error(`SSE send failed: HTTP ${res.status}`);
        }

        const text = await res.text();
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }

    onMessage(handler) {
        this.messageHandlers.push(handler);
    }

    _handleError(err) {
        if (process.env.MCP_DEBUG) {
            console.error(`[SSE transport] Error: ${err.message}`);
        }
    }

    async disconnect() {
        this.connected = false;
        this.abortController?.abort();
        this.reader = null;
    }
}
