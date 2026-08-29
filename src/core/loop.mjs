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
 * Execute one turn against /v1/chat/completions (the standard OpenAI-shape
 * gateway endpoint). This reuses the existing metering, entitlement, and
 * provider translation the gateway already does for BYOK — we don't need
 * a new /v1/agent/turn endpoint. Session config (prompt + tools + model)
 * comes from createGatewaySession() once, then every turn just posts
 * standard OpenAI messages + tools + model.
 *
 * The `session` param carries { prompt, tool_schemas, model } from
 * createGatewaySession. We inject them into the request server prefers
 * client to send explicitly so per-tier gating on the gateway side
 * still works (gateway decides what a caller may use; client just
 * echoes what it received).
 */
async function _callGateway({ session, messages }) {
    const token = _readCliToken();
    if (!token) throw new Error('Missing gateway token (BAHULAM_API_KEY / bahulam login).');
    const base = _gatewayUrl();
    // Support both `<host>` and `<host>/v1` in BAHULAM_GATEWAY_URL.
    const url = base.endsWith('/v1')
        ? `${base}/chat/completions`
        : `${base}/v1/chat/completions`;

    // Strip Bahulam-specific metadata from tool schemas before sending
    // — server also strips defensively, but keep the wire clean.
    const tools = (session.tool_schemas || []).map(t => ({
        type: t.type || 'function',
        function: t.function,
    }));

    const body = {
        model: session.model,
        messages,   // OpenAI-shape end-to-end — {role, content} or
                    // assistant.tool_calls + tool.tool_call_id
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        temperature: 0.0,
        stream: false,
    };

    const t0 = performance.now();
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
    const roundTripMs = performance.now() - t0;

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`chat/completions failed (HTTP ${res.status}): ${text.slice(0, 400)}`);
    }
    const data = await res.json();
    const choice = (data.choices || [{}])[0];
    return {
        message: choice.message || {},   // OpenAI assistant message shape
        finish_reason: choice.finish_reason,
        usage: data.usage || {},
        timing_ms: { roundTrip: Math.round(roundTripMs * 10) / 10 },
    };
}

/**
 * Create an async generator that iterates turns against the gateway.
 *
 * Uses standard OpenAI /v1/chat/completions shape throughout — the same
 * shape the gateway already speaks to upstream providers. No custom
 * content-block conversion, no /v1/agent/turn endpoint needed.
 *
 * @param {Object} opts
 * @param {Object} opts.session           - From createGatewaySession()
 *                                          { session_id, prompt, tool_schemas, model, ... }
 * @param {Array}  opts.messages          - Conversation history (mutated across turns).
 *                                          Caller seeds with [{role:'user', content:input}].
 * @param {Object} opts.toolExecutor      - From createToolExecutor() — .execute(name, input)
 * @param {Function} [opts.gatewayFetch]  - Override for testing
 * @param {number}  [opts.maxTurns]       - Max iterations (default 999)
 * @yields {Object} Events matching the REPL event protocol
 */
export async function* createAgentLoop({
    session,
    messages,
    toolExecutor,
    gatewayFetch = _callGateway,
    maxTurns = MAX_TURNS,
} = {}) {
    let toolCount = 0;
    const startTime = Date.now();
    let usage = { input_tokens: 0, output_tokens: 0 };

    // Prepend the workspace system prompt if not already present. The
    // messages array (caller-owned) may accumulate across REPL turns,
    // so only inject once.
    if (session?.prompt && !messages.some(m => m.role === 'system')) {
        messages.unshift({ role: 'system', content: session.prompt });
    }

    for (let i = 0; i < maxTurns; i++) {
        // ── Call gateway (/v1/chat/completions) ─────────────────────
        const turn = await gatewayFetch({ session, messages });
        const asst = turn.message || {};
        usage = {
            input_tokens: (usage.input_tokens || 0) + (turn.usage?.prompt_tokens || 0),
            output_tokens: (usage.output_tokens || 0) + (turn.usage?.completion_tokens || 0),
        };

        // ── Push assistant response into message history (OpenAI shape)
        // content=null when tool_calls exist (OpenAI protocol requirement),
        // else the text string.
        const openAiAsst = { role: 'assistant' };
        if (asst.tool_calls && asst.tool_calls.length > 0) {
            openAiAsst.content = asst.content ?? null;
            openAiAsst.tool_calls = asst.tool_calls;
        } else {
            openAiAsst.content = asst.content ?? '';
        }
        messages.push(openAiAsst);

        // ── Yield text content ──────────────────────────────────────
        if (typeof asst.content === 'string' && asst.content) {
            yield { type: 'content', data: { text: asst.content } };
        }

        // ── Handle tool calls ───────────────────────────────────────
        const toolCalls = asst.tool_calls || [];
        if (toolCalls.length > 0) {
            for (const tc of toolCalls) {
                const id = tc.id;
                const name = tc.function?.name || '';
                let input = {};
                try { input = JSON.parse(tc.function?.arguments || '{}'); }
                catch { input = { _raw: tc.function?.arguments }; }

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

                // Push tool response as a role='tool' message (OpenAI shape).
                // tool_call_id links it to the assistant's tool_calls[i].id.
                // MUST push one message per tool_call in the SAME order as
                // the assistant's tool_calls, or OpenAI rejects the next
                // turn with "tool_call_ids did not have response messages".
                messages.push({
                    role: 'tool',
                    tool_call_id: id,
                    content: typeof result.output === 'string'
                        ? result.output
                        : JSON.stringify(result.output ?? result),
                });
            }
            // Loop continues to next iteration
        } else {
            // ── No tool calls → turn is done ────────────────────────
            const duration = (Date.now() - startTime) / 1000;
            yield {
                type: 'complete',
                data: {
                    summary: 'Done',
                    changes: toolCount,
                    duration_s: duration,
                    usage,
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
            usage,
        },
    };
}