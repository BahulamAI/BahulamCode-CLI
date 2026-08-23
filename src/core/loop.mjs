/**
 * Thin Agent Loop — iterates turns against /v1/agent/* gateway endpoints.
 *
 * PRD-091 §6.2-6.3: CLI owns iteration. Gateway owns LLM calls,
 * prompt assembly, memory management, and sub-agent orchestration.
 *
 * This loop replaces local-agent.mjs's direct LLM calls with a
 * POST /v1/agent/turn to the gateway. Everything else — tool dispatch,
 * message accumulation, event shapes — matches the existing patterns
 * the REPL already consumes.
 *
 * Usage (replacing client.execute()):
 *   const { createAgentLoop } = await import('../core/loop.mjs');
 *   for await (const event of createAgentLoop({
 *     sessionId: 'sess_...',
 *     messages: session.agentHistory,
 *     toolExecutor: executor,
 *     gatewayFetch: (body) => fetch(`${GATEWAY_URL}/v1/agent/turn`, { ... }),
 *   })) {
 *     // same event types as client.execute() / LocalAgent.execute()
 *   }
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

const MAX_TURNS = 999;

// ── Auth / URL discovery ────────────────────────────────────────────────
// Same precedence as bundled-runtime.mjs::_readCliToken so gateway calls
// use the SAME credential the user's login saved. Kept inline here so
// loop.mjs stays importable without pulling the bundled-runtime module.
function _readCliToken() {
    if (process.env.BAHULAM_API_KEY) return process.env.BAHULAM_API_KEY;
    if (process.env.BAHULAM_CLI_TOKEN) return process.env.BAHULAM_CLI_TOKEN;
    if (process.env.B0_TOKEN) return process.env.B0_TOKEN;
    try {
        const raw = fs.readFileSync(path.join(os.homedir(), '.bahulam', 'config.json'), 'utf8');
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed.token === 'string' && parsed.token.trim()) || null;
    } catch {
        return null;
    }
}

function _gatewayUrl() {
    return (process.env.BAHULAM_GATEWAY_URL || 'https://gateway.bahulam.ai/v1').replace(/\/+$/, '');
}

/**
 * Create a session on the gateway. Returns the session config the loop
 * uses on every subsequent /v1/agent/turn (server-owned prompt +
 * tool_schemas + model). Called ONCE per REPL session before iterating.
 */
export async function createGatewaySession({
    workspace = 'kepler-code',
    model = process.env.BAHULAM_MODEL || undefined,
    token = _readCliToken(),
    gateway = _gatewayUrl(),
} = {}) {
    if (!token) {
        throw new Error(
            'Not logged in — set BAHULAM_API_KEY or run `bahulam login` first.',
        );
    }
    const base = gateway.endsWith('/v1') ? gateway.slice(0, -3) : gateway;
    const res = await fetch(`${base}/v1/agent/session`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'X-Bahulam-User-Id': process.env.BAHULAM_USER_ID || 'cli-user',
            'X-Bahulam-Tier': process.env.BAHULAM_TIER || 'free',
        },
        body: JSON.stringify({ workspace, ...(model ? { model } : {}) }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`session create failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    return res.json();  // { session_id, workspace, prompt, tool_schemas, model, expires_at, ... }
}

/**
 * Execute one turn against /v1/agent/turn. Real implementation of the
 * gateway call — sends session_id + messages, gets back Bahulam-shape
 * response (assistant with content blocks + optional tool_calls + usage).
 */
async function _callGateway({ sessionId, messages, model }) {
    const token = _readCliToken();
    if (!token) throw new Error('Missing gateway token (BAHULAM_API_KEY / bahulam login).');
    const base = _gatewayUrl();
    const url = base.endsWith('/v1') ? base.slice(0, -3) + '/v1/agent/turn' : `${base}/v1/agent/turn`;

    const body = {
        session_id: sessionId,
        messages,
        ...(model ? { model } : {}),
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'X-Bahulam-User-Id': process.env.BAHULAM_USER_ID || 'cli-user',
            'X-Bahulam-Tier': process.env.BAHULAM_TIER || 'free',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`turn failed (HTTP ${res.status}): ${text.slice(0, 400)}`);
    }
    return res.json();  // { messages, tool_calls?, done, usage, timing_ms }
}

/**
 * Create an async generator that iterates turns against the gateway.
 *
 * @param {Object} opts
 * @param {string} opts.sessionId        - Gateway session ID
 * @param {Array}  opts.messages          - Conversation history (role/content)
 * @param {Object} opts.toolExecutor      - From createToolExecutor()
 * @param {Function} [opts.gatewayFetch]  - Override for testing
 * @param {number}  [opts.maxTurns]       - Max iterations (default 50)
 * @yields {Object} Events matching the REPL event protocol
 */
export async function* createAgentLoop({
    sessionId,
    messages,
    toolExecutor,
    gatewayFetch = _callGateway,
    maxTurns = MAX_TURNS,
} = {}) {
    let toolCount = 0;
    const startTime = Date.now();

    for (let i = 0; i < maxTurns; i++) {
        // ── Call gateway ────────────────────────────────────────────
        const turn = await gatewayFetch({
            sessionId,
            messages,
            toolExecutor,
        });

        // ── Push assistant response into message history ────────────
        const assistantContent = turn.messages?.[0]?.content || [];
        messages.push({
            role: 'assistant',
            content: assistantContent,
        });

        // ── Yield text content blocks ───────────────────────────────
        for (const block of assistantContent) {
            if (block.type === 'text' && block.text) {
                yield { type: 'content', data: { text: block.text } };
            }
        }

        // ── Handle tool calls ───────────────────────────────────────
        const toolCalls = turn.tool_calls;
        if (toolCalls && toolCalls.length > 0) {
            let hasToolUse = false;

            for (const tc of toolCalls) {
                const { id, name, input } = tc;
                hasToolUse = true;

                yield { type: 'tool_call', data: { call_id: id, tool: name, args: input } };

                // Execute locally via the existing tool executor
                let result;
                try {
                    result = await toolExecutor.execute(name, input || {});
                } catch (err) {
                    result = { success: false, output: `Error: ${err.message}` };
                }

                yield { type: 'tool_done', data: { tool: name, duration_ms: 0 } };
                toolCount++;

                // Push tool result as a user message
                messages.push({
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: id,
                            content: result.output || JSON.stringify(result),
                        },
                    ],
                });
            }

            if (!hasToolUse) {
                // No actual tool calls in the tool_calls array — weird edge case
                break;
            }
            // Loop continues to next iteration with tool results in messages
        } else {
            // ── No tool calls → turn is done ────────────────────────
            const duration = (Date.now() - startTime) / 1000;
            yield {
                type: 'complete',
                data: {
                    summary: 'Done',
                    changes: toolCount,
                    duration_s: duration,
                    usage: turn.usage || { input_tokens: 0, output_tokens: 0 },
                },
            };
            return;
        }
    }

    // Max turns reached
    yield { type: 'error', data: { message: `Max turns (${maxTurns}) reached.`, fatal: false } };
    yield {
        type: 'complete',
        data: {
            summary: 'Aborted (max turns)',
            changes: toolCount,
            duration_s: (Date.now() - startTime) / 1000,
            usage: { input_tokens: 0, output_tokens: 0 },
        },
    };
}