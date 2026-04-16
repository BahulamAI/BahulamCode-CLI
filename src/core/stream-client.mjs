/**
 * TarangStreamClient — SSE consumer for Tarang backend.
 *
 * Replaces OCC's agent-loop.mjs. Instead of calling the LLM API directly,
 * this client POSTs to the Tarang backend, parses the SSE stream, intercepts
 * tool_request/tool_call events (executes locally, POSTs callback), and
 * yields all other events to the caller for rendering.
 *
 * Phase 2: handles all 22 event types. Approval flow integrated.
 */

import { sendCallback, sendSkippedCallback } from './callback-client.mjs';
import { ApprovalManager } from './approval.mjs';

export const EVENT_TYPES = Object.freeze({
    // Phase 1 — handled
    STATUS: 'status',
    TOOL_REQUEST: 'tool_request',
    TOOL_CALL: 'tool_call',
    PLAN: 'plan',
    ERROR: 'error',
    COMPLETE: 'complete',
    // Phase 2 — stubbed
    SESSION_INFO: 'session_info',
    TOOL_DONE: 'tool_done',
    THINKING: 'thinking',
    PHASE_UPDATE: 'phase_update',
    PHASE_SUMMARY: 'phase_summary',
    PHASE_START: 'phase_start',
    WORKER_UPDATE: 'worker_update',
    WORKER_START: 'worker_start',
    WORKER_DONE: 'worker_done',
    DELEGATION: 'delegation',
    CHANGE: 'change',
    CONTENT: 'content',
    CANCELLED: 'cancelled',
    PAUSED: 'paused',
    RESUMED: 'resumed',
    PAUSE_INSTRUCTION: 'pause_instruction',
});

export class TarangStreamClient {
    /**
     * @param {Object} opts
     * @param {string} opts.baseUrl - Tarang backend URL
     * @param {string} opts.token - CLI auth token
     * @param {Object} opts.toolExecutor - { execute(name, args) }
     * @param {boolean} [opts.verbose=false]
     */
    constructor({ baseUrl, token, toolExecutor, verbose = false, approvalManager = null }) {
        this.baseUrl = (baseUrl || '').replace(/\/$/, '');
        this.token = token;
        this.toolExecutor = toolExecutor;
        this.verbose = verbose;
        this.approval = approvalManager || new ApprovalManager();
        this.currentTaskId = null;
        this._cancelled = false;
        this._paused = false;
    }

    /**
     * Execute an instruction via SSE stream.
     * Yields parsed events. Tool requests are handled internally
     * (executed locally, callback POSTed) and NOT yielded.
     *
     * @param {string} instruction
     * @param {Object} [context={}]
     * @param {string} [model]
     * @yields {{ type: string, data: Object }}
     */
    async *execute(instruction, context = {}, model = null) {
        this._cancelled = false;

        const url = `${this.baseUrl}/api/execute`;
        const body = { instruction, context };
        if (model) body.model = model;

        const headers = {
            'Accept': 'text/event-stream',
            'Content-Type': 'application/json',
        };
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });
        } catch (err) {
            yield { type: EVENT_TYPES.ERROR, data: { message: `Network error: ${err.message}. Check your connection or use --local mode.`, fatal: true } };
            return;
        }

        if (response.status === 401) {
            yield { type: EVENT_TYPES.ERROR, data: { message: 'Authentication failed. Run `tarang login` to re-authenticate.', fatal: true } };
            return;
        }
        if (!response.ok) {
            const text = await response.text().catch(() => 'Unknown error');
            yield { type: EVENT_TYPES.ERROR, data: { message: `Backend error ${response.status}: ${text}`, fatal: true } };
            return;
        }

        // Grab task ID from response header
        this.currentTaskId = response.headers.get('X-Task-ID') || null;

        // Parse SSE stream
        for await (const { event, data } of this._parseSSE(response)) {
            if (this._cancelled) {
                yield { type: EVENT_TYPES.STATUS, data: { message: 'Cancelled by user.' } };
                return;
            }

            // Tool requests — show to user, then execute locally and POST callback
            if (event === EVENT_TYPES.TOOL_REQUEST || event === EVENT_TYPES.TOOL_CALL) {
                yield { type: event, data }; // Show tool call to user first
                const toolEvent = await this._handleToolRequest(data);
                if (toolEvent) yield toolEvent;
                continue;
            }

            // All other events yielded to caller
            yield { type: event, data };
        }
    }

    /**
     * Parse SSE from a fetch Response using ReadableStream.
     * @param {Response} response
     * @yields {{ event: string, data: Object }}
     */
    async *_parseSSE(response) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = 'message';
        let currentData = [];

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete last line

                for (const line of lines) {
                    const trimmed = line.trim();

                    if (!trimmed) {
                        // Empty line = event boundary
                        if (currentData.length > 0) {
                            const rawData = currentData.join('\n');
                            let parsed;
                            try {
                                parsed = JSON.parse(rawData);
                            } catch {
                                parsed = { message: rawData };
                            }
                            yield { event: currentEvent, data: parsed };
                        }
                        currentEvent = 'message';
                        currentData = [];
                    } else if (trimmed.startsWith('event:')) {
                        currentEvent = trimmed.slice(6).trim();
                    } else if (trimmed.startsWith('data:')) {
                        currentData.push(trimmed.slice(5).trim());
                    }
                    // ignore other fields (id:, retry:, comments)
                }
            }

            // Flush remaining
            if (currentData.length > 0) {
                const rawData = currentData.join('\n');
                let parsed;
                try {
                    parsed = JSON.parse(rawData);
                } catch {
                    parsed = { message: rawData };
                }
                yield { event: currentEvent, data: parsed };
            }
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Handle a tool_request or tool_call event:
     * execute tool locally, POST result via callback.
     * @param {Object} data - { call_id, tool, args, require_approval, description }
     * @returns {Object|null} optional status event to yield
     */
    async _handleToolRequest(data) {
        const { call_id, request_id, tool, args, require_approval } = data;
        const callId = call_id || request_id;
        const toolName = tool;

        if (this.verbose) {
            process.stderr.write(`\x1b[2m[tool] ${toolName}(${JSON.stringify(args).slice(0, 80)}...)\x1b[0m\n`);
        }

        // Phase 2: approval flow
        const { approved, reason } = await this.approval.check(toolName, args || {}, require_approval);
        if (!approved) {
            if (this.currentTaskId && callId) {
                await sendSkippedCallback(this.baseUrl, this.token, this.currentTaskId, callId, reason);
            }
            return { type: EVENT_TYPES.STATUS, data: { message: `Skipped ${toolName}: ${reason || 'rejected'}` } };
        }

        // Execute tool locally via the tool executor bridge
        const startTime = Date.now();
        let result;
        try {
            result = await this.toolExecutor.execute(toolName, args || {});
        } catch (err) {
            result = { success: false, output: `Tool execution error: ${err.message}` };
        }
        const durationMs = Date.now() - startTime;

        if (this.verbose) {
            const status = result.success ? 'OK' : 'FAIL';
            process.stderr.write(`\x1b[2m[tool] ${toolName} → ${status} (${durationMs}ms)\x1b[0m\n`);
        }

        // POST callback to backend
        if (this.currentTaskId && callId) {
            await sendCallback(this.baseUrl, this.token, this.currentTaskId, callId, result);
        }

        return null;
    }

    /** Cancel the current stream. */
    async cancel() {
        this._cancelled = true;
        if (this.currentTaskId) {
            try {
                await fetch(`${this.baseUrl}/api/cancel/${this.currentTaskId}`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${this.token}` },
                });
            } catch { /* best effort */ }
        }
    }

    /** Pause the current stream. */
    async pause() {
        if (this.currentTaskId) {
            await fetch(`${this.baseUrl}/api/pause/${this.currentTaskId}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.token}` },
            });
        }
    }

    /** Resume a paused stream. */
    async resume(instruction = null) {
        if (this.currentTaskId) {
            const body = instruction ? JSON.stringify({ instruction }) : undefined;
            await fetch(`${this.baseUrl}/api/resume/${this.currentTaskId}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json',
                },
                body,
            });
        }
    }
}
