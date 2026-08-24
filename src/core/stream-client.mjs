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

import { llmToolResultContent, sendCallback, sendSkippedCallback, sendApprovalDecision } from './callback-client.mjs';
import { ApprovalManager } from './approval.mjs';
import { normalizeBillingBrandCopy, quotaErrorDetail, rateLimitErrorMessage } from './rate-limit-display.mjs';
import * as telemetry from '../telemetry/index.mjs';

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
    CONTENT_PARTIAL: 'content_partial',
    TOOL_RESULT: 'tool_result',
    FILE_DIFF: 'file_diff',
    SUB_AGENT_START: 'sub_agent_start',
    SUB_AGENT_TOOL: 'sub_agent_tool',
    SUB_AGENT_COMPLETE: 'sub_agent_complete',
    STAGNATION: 'stagnation',
    CANCELLED: 'cancelled',
    PAUSED: 'paused',
    RESUMED: 'resumed',
    PAUSE_INSTRUCTION: 'pause_instruction',
    RECONNECTING: 'reconnecting',
    RECONNECTED: 'reconnected',
    RECONNECT_FAILED: 'reconnect_failed',
    // HITL approval events (from framework)
    APPROVAL_REQUIRED: 'approval_required',
    APPROVAL_GRANTED: 'approval_granted',
    APPROVAL_DENIED: 'approval_denied',
    // Live steering (PRD-081 §5.2)
    USER_INTERVENTION_ACCEPTED: 'user_intervention_accepted',
    USER_INTERVENTION_DELIVERED: 'user_intervention_delivered',
    USER_INTERVENTION_QUEUED: 'user_intervention_queued',
});

// Lightweight UUID-ish generator for intervention ids. Node ≥18 has
// crypto.randomUUID but the fallback avoids importing node:crypto here.
function _uuidLike() {
  try {
    // eslint-disable-next-line no-undef
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {}
  const rand = () => Math.random().toString(16).slice(2, 10);
  return `iv-${Date.now().toString(36)}-${rand()}${rand()}`;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Full jitter around the scheduled delay: pick a value in [delay*0.5, delay*1.5].
// Spreads out reconnect storms so N clients dropping simultaneously don't
// synchronize their retries. Clamped to the same 30s ceiling as the base delay.
function jitteredDelay(delayMs) {
    const min = Math.floor(delayMs * 0.5);
    const max = Math.floor(delayMs * 1.5);
    const jittered = min + Math.floor(Math.random() * (max - min + 1));
    return Math.max(200, Math.min(30_000, jittered));
}

// Categorize a fetch error. "offline-class" means DNS/routing failures that
// almost never recover within a few seconds — we bail after 2 in a row rather
// than burn the full 5-min budget when the user's network is truly down.
function isOfflineLikelyError(err) {
    const code = err?.cause?.code || err?.code || '';
    return (
        code === 'ENOTFOUND' ||        // DNS lookup failed
        code === 'EAI_AGAIN' ||        // DNS temporary failure
        code === 'ENETUNREACH' ||      // no route to host
        code === 'EHOSTUNREACH' ||     // host unreachable
        code === 'UND_ERR_CONNECT_TIMEOUT' // undici connect timeout
    );
}

export class TarangStreamClient {
    /**
     * @param {Object} opts
     * @param {string} opts.baseUrl - Tarang backend URL (ignored when mode='bundled')
     * @param {string} opts.token - CLI auth token
     * @param {Object} opts.toolExecutor - { execute(name, args) }
     * @param {boolean} [opts.verbose=false]
     * @param {'remote'|'bundled'} [opts.mode='remote'] - 'bundled' routes all
     *   requests through the local bahulam-agent runtime subprocess (PRD-091 §6).
     *   'remote' uses baseUrl and standard fetch (default; matches cloud/dev/prod backend).
     */
    constructor({
        baseUrl,
        token,
        toolExecutor,
        verbose = false,
        approvalManager = null,
        reconnectMaxElapsedMs = null,
        mode = null,
    }) {
        this.baseUrl = (baseUrl || '').replace(/\/$/, '');
        this.token = token;
        this.toolExecutor = toolExecutor;
        this.verbose = verbose;
        this.approval = approvalManager || new ApprovalManager();
        this.product = 'bahulam';
        this.currentTaskId = null;
        this.lastEventId = null;
        this.retryDelayMs = null;
        this.pendingToolCallbacks = new Map();
        this.reconnectMaxElapsedMs = reconnectMaxElapsedMs
            ?? Number(process.env.KEPLER_RECONNECT_MAX_ELAPSED_MS || 300_000);
        // Set by backend on first turn, reused on subsequent turns. Headless mode
        // (which starts fresh per invocation) can pre-seed via TARANG_SESSION_ID
        // so multi-turn benchmarks share one backend session across `node` runs.
        this.sessionId = process.env.TARANG_SESSION_ID || null;
        this._cancelled = false;
        this._paused = false;
        this._pauseWaiters = new Set();
        this._abort = null;
        this._toolAbort = null;

        // Transport mode:
        //   'remote' → cloud backend runs the agent loop server-side.
        //     Backend calls Bahulam Gateway with service-token attribution;
        //     metering runs at the gateway boundary.
        //   'bundled' → legacy: local Python runtime (PRD-091 §6, deprecated).
        //     Only used when BAHULAM_RUNTIME_MODE=bundled is explicitly set.
        //
        // Explicit opt precedence: constructor arg > env vars > default 'remote'.
        this.mode = mode
            || (process.env.BAHULAM_RUNTIME_MODE === 'remote' ? 'remote' : null)
            || (process.env.BAHULAM_RUNTIME_MODE === 'bundled' ? 'bundled' : null)
            || (process.env.TARANG_ENV === 'remote' ? 'remote' : null)
            || (process.env.TARANG_ENV === 'bundled' ? 'bundled' : null)
            || 'remote';
        this._bundledReady = false;
    }

    /**
     * Ensure the bundled runtime is spawned and this.baseUrl points at it.
     * No-op in remote mode. Callers that hit the backend should invoke this
     * at the top of their method (idempotent, cheap after the first call).
     */
    async _ensureBundledRuntime() {
        if (this.mode !== 'bundled' || this._bundledReady) return;
        const { ensureRuntimeReady } = await import('./bundled-runtime.mjs');
        const info = await ensureRuntimeReady();
        // Runtime speaks the same HTTP shape as the cloud backend, just on a
        // random localhost port. Overriding baseUrl means every existing
        // ${this.baseUrl}/api/* fetch call keeps working unchanged.
        this.baseUrl = info.baseUrl;
        this._bundledReady = true;
    }

    _headers(extra = {}) {
        const headers = { ...extra };
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
        if (this.product) headers['X-Product'] = this.product;
        return headers;
    }

    async analyzeVision({ instruction, attachments }) {
        const url = `${this.baseUrl}/api/vision/analyze`;
        const body = { instruction, attachments: attachments || [] };
        const response = await fetch(url, {
            method: 'POST',
            headers: this._headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body),
        });
        const text = await response.text().catch(() => '');
        let payload = null;
        try {
            payload = text ? JSON.parse(text) : null;
        } catch {
            payload = { detail: text };
        }
        if (!response.ok) {
            const detail = payload?.detail || payload || {};
            const message = typeof detail === 'string'
                ? detail
                : detail.message || detail.error || `Vision analysis failed (${response.status})`;
            const err = new Error(message);
            err.status = response.status;
            err.detail = detail;
            throw err;
        }
        return payload || {};
    }

    /**
     * Execute an instruction via SSE stream.
     * Yields parsed events. Client-side tool requests are shown, executed
     * locally, callback-posted, then followed by a local tool_result event.
     *
     * @param {string} instruction
     * @param {Object} [context={}]
     * @param {string} [model]
     * @yields {{ type: string, data: Object }}
     */
    async *execute(instruction, context = {}, messages = null) {
        this._cancelled = false;
        this.currentTaskId = null;

        // Bundled mode: spawn the local Python runtime on first turn.
        // After this, this.baseUrl points at http://127.0.0.1:<random-port>
        // and every existing fetch call in this class works unchanged.
        await this._ensureBundledRuntime();

        const url = `${this.baseUrl}/api/execute`;
        const body = { instruction, context };
        if (messages && messages.length > 0) body.messages = messages;
        if (this.sessionId) body.session_id = this.sessionId;

        // daemon cache-guard hook. If BAHULAM_CAPTURE_REQUEST is set to a file
        // path, serialize the exact body that would go to /api/execute, write
        // it there, and exit(0) before making the network call. Zero credits
        // spent, zero backend state changed. Used to capture a byte-exact
        // baseline before the Slice B refactor so we can assert byte identity
        // after the daemon extraction. See the security model note
        // about no daemon-added fields leaking into the payload).
        if (process.env.BAHULAM_CAPTURE_REQUEST) {
            const fs = await import('node:fs');
            const target = process.env.BAHULAM_CAPTURE_REQUEST;
            const serialized = JSON.stringify(body, null, 2);
            try {
                fs.writeFileSync(target, serialized, { mode: 0o600 });
                process.stderr.write(
                    `[BAHULAM_CAPTURE_REQUEST] wrote ${target} (${Buffer.byteLength(serialized, 'utf-8')} bytes, ${Object.keys(body).length} top-level keys)\n`
                );
            } catch (err) {
                process.stderr.write(`[BAHULAM_CAPTURE_REQUEST] write failed: ${err.message}\n`);
                process.exit(1);
            }
            process.exit(0);
        }

        const headers = this._headers({
            'Accept': 'text/event-stream',
            'Content-Type': 'application/json',
        });

        // Abort controller so cancel() can break out of a stalled reader
        // instead of waiting for the next SSE event to notice _cancelled.
        this._abort = new AbortController();
        this._toolAbort = new AbortController();

        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: this._abort.signal,
            });
        } catch (err) {
            if (err.name === 'AbortError') {
                return;
            }
            yield { type: EVENT_TYPES.ERROR, data: { message: `Network error: ${err.message}. Check your connection or use --local mode.`, fatal: true } };
            return;
        }

        if (response.status === 401) {
            yield { type: EVENT_TYPES.ERROR, data: { message: 'Authentication failed. Run `bahulam login` to re-authenticate.', fatal: true } };
            return;
        }
        if (response.status === 429) {
            const text = await response.text().catch(() => '');
            let payload = null;
            try {
                payload = text ? JSON.parse(text) : null;
            } catch {
                payload = { detail: { message: text } };
            }
            const detail = quotaErrorDetail(payload);
            yield {
                type: EVENT_TYPES.ERROR,
                data: {
                    message: rateLimitErrorMessage(payload),
                    code: detail?.code || 'rate_limited',
                    retry_after: detail?.retry_after ?? detail?.rate_limit?.retry_after,
                    rate_limit: detail?.rate_limit || null,
                    action: detail?.action || null,
                    pricing_url: normalizeBillingBrandCopy(detail?.pricing_url || null),
                    fatal: true,
                },
            };
            return;
        }
        if (!response.ok) {
            const text = await response.text().catch(() => 'Unknown error');
            yield { type: EVENT_TYPES.ERROR, data: { message: `Backend error ${response.status}: ${text}`, fatal: true } };
            return;
        }

        try {
            yield* this._consumeResponse(response);
        } catch (err) {
            if (this._cancelled) {
                return;
            }
            yield* this._reconnectAfterDrop(err);
        }
    }

    async *_consumeResponse(response) {
        const taskId = response.headers.get('X-Task-ID');
        if (taskId) this.currentTaskId = taskId;

        for await (const parsed of this._parseSSE(response)) {
            if (this._cancelled) return;
            await this._waitIfPaused();
            if (this._cancelled) return;

            if (parsed.id != null) this.lastEventId = parsed.id;
            if (parsed.retry != null) this.retryDelayMs = parsed.retry;
            if (parsed.data?.task_id) this.currentTaskId = parsed.data.task_id;

            for await (const event of this._handleStreamEvent(parsed)) {
                yield event;
            }
        }
    }

    async *consumeEventStream(response) {
        yield* this._consumeResponse(response);
    }

    async *_handleStreamEvent({ event, data, id = null, retry = null }) {
        const rendered = { type: event, data, event_id: id, retry };

        // Capture session_id from backend (first turn creates it, subsequent turns reuse)
        if (event === EVENT_TYPES.SESSION_INFO && data?.session_id) {
            this.sessionId = data.session_id;
        }

        // Framework HITL: approval_required — show menu, POST decision
        if (event === EVENT_TYPES.APPROVAL_REQUIRED) {
            yield rendered;
            const approvalEvent = await this._handleApprovalRequired(data);
            if (approvalEvent) yield approvalEvent;
            return;
        }

        if (event === EVENT_TYPES.APPROVAL_GRANTED || event === EVENT_TYPES.APPROVAL_DENIED) {
            yield rendered;
            return;
        }

        // Tool requests — show to user, then execute locally and POST callback.
        if (event === EVENT_TYPES.TOOL_REQUEST || event === EVENT_TYPES.TOOL_CALL) {
            yield rendered;
            await this._waitIfPaused();
            if (this._cancelled || data?.server_side) return;
            const toolEvent = await this._handleToolRequest(data);
            if (toolEvent) {
                await this._waitIfPaused();
                if (this._cancelled) return;
                yield toolEvent;
                for (const diffEvent of fileDiffEventsForToolResult(toolEvent)) {
                    yield diffEvent;
                }
            }
            return;
        }

        yield rendered;
        if (event === EVENT_TYPES.TOOL_RESULT || event === EVENT_TYPES.TOOL_DONE) {
            for (const diffEvent of fileDiffEventsForToolResult(rendered)) {
                yield diffEvent;
            }
        }
    }

    async *_reconnectAfterDrop(err) {
        const taskId = this.currentTaskId;
        if (!taskId || this.lastEventId == null) {
            yield {
                type: EVENT_TYPES.ERROR,
                data: {
                    message: `Stream interrupted: ${err?.message || 'connection lost'}. Use /resume to continue from saved history.`,
                    fatal: true,
                },
            };
            return;
        }

        const started = Date.now();
        let attempt = 0;
        // Slow-start baseline: 500ms for the first retry catches most
        // transient blips before the user notices; the ramp doubles from
        // there. Server-hinted `retry:` from the last SSE frame overrides
        // if present. Capped at 30s.
        let delayMs = Math.max(200, Math.min(this.retryDelayMs || 500, 30_000));
        let offlineStreak = 0;

        while (!this._cancelled && Date.now() - started < this.reconnectMaxElapsedMs) {
            attempt++;
            const after = this.lastEventId;
            // Apply jitter to the scheduled delay so N clients dropping at
            // the same time don't lockstep-retry against the server. The
            // event surfaces the ACTUAL wait so the CLI can show it.
            const waitMs = jitteredDelay(delayMs);
            telemetry.track('stream.reconnect.attempt', {
                task_id: taskId,
                after,
                attempt,
                base_delay_ms: delayMs,
                delay_ms: waitMs,
            });
            yield {
                type: EVENT_TYPES.RECONNECTING,
                data: { task_id: taskId, after, attempt, delay_ms: waitMs },
            };
            await sleep(waitMs);
            try {
                const url = `${this.baseUrl}/api/execute/${encodeURIComponent(taskId)}/events?after=${encodeURIComponent(after)}`;
                const response = await fetch(url, {
                    method: 'GET',
                    headers: this._headers({ Accept: 'text/event-stream' }),
                    signal: AbortSignal.timeout(30_000),
                });
                if (response.status === 404 || response.status === 410) {
                    telemetry.track('stream.reconnect.failed', {
                        task_id: taskId,
                        after,
                        attempt,
                        status: response.status,
                        code: response.status === 410 ? 'reconnect_buffer_expired' : 'task_not_found',
                        retryable: false,
                    });
                    yield {
                        type: EVENT_TYPES.RECONNECT_FAILED,
                        data: {
                            task_id: taskId,
                            code: response.status === 410 ? 'reconnect_buffer_expired' : 'task_not_found',
                            retryable: false,
                        },
                    };
                    return;
                }
                if (!response.ok) throw new Error(`reconnect failed (${response.status})`);
                let replayed = 0;
                for await (const event of this._consumeResponse(response)) {
                    if (event.type !== EVENT_TYPES.RECONNECTED) replayed++;
                    if (event.type === EVENT_TYPES.RECONNECTED) {
                        replayed = Number(event.data?.replayed ?? replayed);
                    }
                    yield event;
                }
                telemetry.track('stream.reconnect.succeeded', {
                    task_id: taskId,
                    after,
                    attempt,
                    replayed,
                    elapsed_ms: Date.now() - started,
                });
                return;
            } catch (nextErr) {
                if (this._cancelled) return;
                // Offline-class errors (DNS failure, no route) rarely recover
                // in seconds. Bail after 2 in a row so we don't burn the full
                // 5-min budget spinning against a dead network — the user
                // gets an actionable "network unreachable" message instead.
                if (isOfflineLikelyError(nextErr)) {
                    offlineStreak++;
                    if (offlineStreak >= 2) {
                        telemetry.track('stream.reconnect.failed', {
                            task_id: taskId,
                            after,
                            attempt,
                            code: 'network_unreachable',
                            error_code: nextErr?.cause?.code || nextErr?.code || '',
                            retryable: true,
                        });
                        yield {
                            type: EVENT_TYPES.RECONNECT_FAILED,
                            data: {
                                task_id: taskId,
                                after,
                                code: 'network_unreachable',
                                message: 'Network appears unreachable — DNS lookup failed twice. Check your connection, then /resume to continue.',
                                retryable: true,
                            },
                        };
                        return;
                    }
                } else {
                    offlineStreak = 0;
                }
                telemetry.track('stream.reconnect.retry', {
                    task_id: taskId,
                    after,
                    attempt,
                    message: nextErr?.message || 'reconnect failed',
                    error_code: nextErr?.cause?.code || nextErr?.code || '',
                });
                err = nextErr;
                delayMs = Math.min(delayMs * 2, 30_000);
            }
        }

        telemetry.track('stream.reconnect.failed', {
            task_id: taskId,
            after: this.lastEventId,
            code: 'reconnect_timeout',
            retryable: false,
            elapsed_ms: Date.now() - started,
        });
        yield {
            type: EVENT_TYPES.RECONNECT_FAILED,
            data: {
                task_id: taskId,
                after: this.lastEventId,
                code: 'reconnect_timeout',
                message: err?.message || 'connection lost',
                retryable: false,
            },
        };
    }

    /**
     * Parse SSE from a fetch Response using ReadableStream.
     * @param {Response} response
     * @yields {{ event: string, data: Object, id: string|null, retry: number|null }}
     */
    async *_parseSSE(response) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = 'message';
        let currentData = [];
        let currentId = null;
        let currentRetry = null;

        try {
            while (true) {
                let read;
                try {
                    read = await reader.read();
                } catch (err) {
                    // Aborted via cancel() — treat as a clean end-of-stream.
                    if (err && (err.name === 'AbortError' || this._cancelled)) break;
                    throw err;
                }
                const { done, value } = read;
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete last line

                for (const line of lines) {
                    const rawLine = line.endsWith('\r') ? line.slice(0, -1) : line;
                    const trimmed = rawLine.trim();

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
                            yield { event: currentEvent, data: parsed, id: currentId, retry: currentRetry };
                        }
                        currentEvent = 'message';
                        currentData = [];
                        currentId = null;
                        currentRetry = null;
                    } else if (trimmed.startsWith('event:')) {
                        currentEvent = trimmed.slice(6).trim();
                    } else if (trimmed.startsWith('data:')) {
                        currentData.push(trimmed.slice(5).trim());
                    } else if (trimmed.startsWith('id:')) {
                        currentId = trimmed.slice(3).trim();
                    } else if (trimmed.startsWith('retry:')) {
                        const parsedRetry = Number(trimmed.slice(6).trim());
                        if (Number.isFinite(parsedRetry) && parsedRetry >= 0) currentRetry = parsedRetry;
                    }
                    // comments and unknown SSE fields are ignored.
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
                yield { event: currentEvent, data: parsed, id: currentId, retry: currentRetry };
            }
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Handle a tool_call event: execute tool locally, POST result via callback.
     *
     * Approval is handled by the framework (HITL) BEFORE this is called.
     * By the time a tool_call arrives here, it's already approved.
     *
     * @param {Object} data - { call_id, tool, args }
     * @returns {Object} local tool result event to yield
     */
    async _handleToolRequest(data) {
        const { call_id, request_id, tool, args } = data;
        const callId = call_id || request_id;
        const toolName = tool;
        const isInternal = Boolean(data?.internal || data?.sub_agent);

        if (this.verbose) {
            process.stderr.write(`\x1b[2m[tool] ${toolName}(${JSON.stringify(args).slice(0, 80)}...)\x1b[0m\n`);
        }

        if (this._cancelled) {
            return {
                type: EVENT_TYPES.TOOL_RESULT,
                data: {
                    success: false,
                    output: 'Cancelled by user',
                    call_id: callId,
                    tool: toolName,
                    args: args || {},
                    _cancelled: true,
                    internal: isInternal,
                    sub_agent: data?.sub_agent || null,
                    local_callback: false,
                },
            };
        }

        // Execute tool locally — framework already approved this
        const startTime = Date.now();
        let result;
        try {
            result = await this.toolExecutor.execute(toolName, args || {}, {
                signal: this._toolAbort?.signal,
            });
        } catch (err) {
            if (err?.name === 'AbortError' || this._cancelled) {
                result = { success: false, output: 'Cancelled by user', _cancelled: true };
            } else {
                result = { success: false, output: `Tool execution error: ${err.message}` };
            }
        }
        const durationMs = Date.now() - startTime;

        if (this.verbose) {
            const status = result.success ? 'OK' : 'FAIL';
            process.stderr.write(`\x1b[2m[tool] ${toolName} → ${status} (${durationMs}ms)\x1b[0m\n`);
        }

        // POST callback to backend
        let callbackPosted = false;
        if (!this._cancelled && !result?._cancelled && this.currentTaskId && callId) {
            callbackPosted = await sendCallback(this.baseUrl, this.token, this.currentTaskId, callId, result);
            telemetry.track(callbackPosted ? 'tool.callback.posted' : 'tool.callback.failed', {
                task_id: this.currentTaskId,
                call_id: callId,
                tool: toolName,
                success: Boolean(result?.success !== false),
                duration_ms: durationMs,
            });
        }

        return {
            type: EVENT_TYPES.TOOL_RESULT,
            data: {
                ...result,
                call_id: callId,
                tool: toolName,
                args: args || {},
                llm_content: llmToolResultContent(toolName, result),
                duration_ms: durationMs,
                internal: isInternal,
                sub_agent: data?.sub_agent || null,
                local_callback: true,
            },
        };
    }

    /**
     * Handle framework HITL approval_required event.
     * Shows the same approval menu as tool_call, but POSTs the decision
     * to /api/approval_callback instead of skipping the tool.
     *
     * @param {Object} data - { tool_id, tool, args, risk, reason }
     * @returns {Object|null} optional status event to yield
     */
    async _handleApprovalRequired(data) {
        const { tool_id, tool, args, risk, reason } = data;

        if (this.verbose) {
            process.stderr.write(`\x1b[2m[hitl] Approval needed: ${tool} (${risk})\x1b[0m\n`);
        }

        // Use the same ApprovalManager for consistent UX
        const { approved, reason: denyReason, scope: approvedScope } = await this.approval.check(
            tool,
            args || {},
            true,
            { risk, reason },
        );

        // Map ApprovalManager decision to framework scope
        let decision, scope;
        if (approved) {
            decision = 'grant';
            // Determine scope from ApprovalManager state
            if (this.approval.approveAll) {
                scope = 'all';
            } else if (this.approval.approvedToolTypes.has(tool)) {
                scope = 'type';
            } else if (approvedScope) {
                scope = String(approvedScope).toLowerCase();
            } else {
                scope = 'once';
            }
        } else {
            decision = 'deny';
            scope = 'once';
        }

        // POST decision to backend
        if (this.currentTaskId && tool_id) {
            const posted = await sendApprovalDecision(
                this.baseUrl, this.token, this.currentTaskId,
                tool_id, decision, scope, denyReason || '',
            );
            telemetry.track(posted ? 'approval.callback.posted' : 'approval.callback.failed', {
                task_id: this.currentTaskId,
                tool_id,
                tool,
                decision,
            });
            if (!posted) {
                return {
                    type: EVENT_TYPES.ERROR,
                    data: {
                        message: `Approval for ${tool} could not be applied. The request may have timed out or the stream may be stale; retry the command if it did not continue.`,
                        code: 'approval_callback_failed',
                        fatal: false,
                    },
                };
            }
        }

        if (!approved) {
            return {
                type: EVENT_TYPES.STATUS,
                data: { message: `Denied ${tool}: ${denyReason || 'rejected'}` },
            };
        }

        return null; // Approved — framework continues with tool execution
    }

    /** Cancel the current stream. */
    async cancel() {
        this._cancelled = true;
        this._paused = false;
        this._releasePauseWaiters();
        // Stop local work first. The backend POST below is best-effort and
        // must not delay returning control to the terminal.
        if (this._toolAbort) {
            try { this._toolAbort.abort(); } catch {}
        }
        if (this._abort) {
            try { this._abort.abort(); } catch {}
        }
        // Best-effort backend POST — the stream may already be torn down.
        if (this.currentTaskId) {
            fetch(`${this.baseUrl}/api/cancel/${this.currentTaskId}`, {
                    method: 'POST',
                    headers: this._headers(),
            }).catch(() => {});
        }
    }

    /** Pause the current stream. */
    async pause() {
        this._paused = true;
        if (this.currentTaskId) {
            try {
                await fetch(`${this.baseUrl}/api/pause/${this.currentTaskId}`, {
                    method: 'POST',
                    headers: this._headers(),
                });
            } catch { /* best effort */ }
        }
    }

    /** Resume a paused stream. */
    async resume(instruction = null) {
        this._paused = false;
        this._releasePauseWaiters();
        if (this.currentTaskId) {
            const body = instruction ? JSON.stringify({ instruction }) : undefined;
            try {
                await fetch(`${this.baseUrl}/api/resume/${this.currentTaskId}`, {
                    method: 'POST',
                    headers: this._headers({
                        'Content-Type': 'application/json',
                    }),
                    body,
                });
            } catch { /* best effort */ }
        }
    }

    /**
     * Submit a live-steering follow-up on the current running task (PRD-081 §5.2).
     * Unlike resume(), this does NOT pause/unpause — the text is queued and
     * delivered at the next tool boundary.
     *
     * Returns a status object; callers should NOT swallow errors:
     *   { status: 'accepted', interventionId }        — queued on backend, SSE ack forthcoming
     *   { status: 'queued_next_turn', interventionId } — task already ended; hand back as next turn
     *   { status: 'duplicate', interventionId }       — same intervention_id previously submitted
     *   { status: 'no_task' }                          — no currentTaskId (nothing to steer)
     *   { status: 'error', error, httpStatus? }        — network or non-2xx response
     *
     * @param {string} instruction  Follow-up text (non-empty, trimmed by caller).
     * @param {object} [opts]
     * @param {string} [opts.idempotencyKey]  Optional client-generated id.
     *                                        Auto-generated when omitted; pass the same key
     *                                        for retries to stay idempotent.
     */
    async sendIntervention(instruction, opts = {}) {
        if (!this.currentTaskId) {
            return { status: 'no_task' };
        }
        const text = String(instruction || '').trim();
        if (!text) {
            return { status: 'error', error: 'instruction is empty' };
        }
        const interventionId = opts.idempotencyKey || _uuidLike();
        try {
            const response = await fetch(
                `${this.baseUrl}/api/intervention/${this.currentTaskId}`,
                {
                    method: 'POST',
                    headers: this._headers({
                        'Content-Type': 'application/json',
                    }),
                    body: JSON.stringify({
                        instruction: text,
                        intervention_id: interventionId,
                    }),
                },
            );
            if (!response.ok) {
                let errText = '';
                try { errText = (await response.text()).slice(0, 400); } catch {}
                return {
                    status: 'error',
                    httpStatus: response.status,
                    error: errText || `HTTP ${response.status}`,
                    interventionId,
                };
            }
            const body = await response.json().catch(() => ({}));
            const backendStatus = body.status || 'accepted';
            const status = body.duplicate ? 'duplicate' : backendStatus;
            return {
                status,
                interventionId: body.intervention_id || interventionId,
            };
        } catch (e) {
            return {
                status: 'error',
                error: (e && e.message) || String(e),
                interventionId,
            };
        }
    }

    async _waitIfPaused() {
        while (this._paused && !this._cancelled) {
            await new Promise(resolve => this._pauseWaiters.add(resolve));
        }
    }

    _releasePauseWaiters() {
        const waiters = [...this._pauseWaiters];
        this._pauseWaiters.clear();
        for (const resolve of waiters) {
            try { resolve(); } catch { /* ignore */ }
        }
    }

    /**
     * Summarize a prior transcript for resume continuity.
     *
     * @param {Array<{role:string,content:string}>} messages
     * @param {Object} [opts]
     * @returns {Promise<{summary:string,source:string,model:string}>}
     */
    async summarizeSession(messages, opts = {}) {
        const response = await fetch(`${this.baseUrl}/api/summarize/session`, {
            method: 'POST',
            headers: this._headers({
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            }),
            body: JSON.stringify({
                messages,
                session_id: opts.sessionId || null,
                project_path: opts.projectPath || null,
                max_tokens: opts.maxTokens || 800,
            }),
            signal: AbortSignal.timeout(opts.timeoutMs || 15000),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`summary request failed (${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
        }
        return await response.json();
    }
}

function fileDiffEventsForToolResult(toolEvent) {
    const data = toolEvent?.data || {};
    const diffs = Array.isArray(data.file_diffs)
        ? data.file_diffs
        : data.file_diff ? [data.file_diff] : [];
    if (!diffs.length) return [];

    return diffs.map((diff, index) => ({
        type: EVENT_TYPES.FILE_DIFF,
        data: {
            call_id: data.call_id || data._callId || null,
            tool: data.tool || data._tool || '',
            index,
            count: diffs.length,
            path: diff.path || '',
            relative_path: diff.relative_path || '',
            lines_added: diff.lines_added || 0,
            lines_removed: diff.lines_removed || 0,
            truncated: !!diff.truncated,
            truncated_line_count: diff.truncated_line_count || 0,
            hunks: diff.hunks || [],
            unified: diff.unified || '',
        },
    }));
}
