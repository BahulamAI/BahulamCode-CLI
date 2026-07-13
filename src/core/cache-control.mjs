/**
 * cache_control breakpoints for Anthropic prompt caching (PRD-071 Phase 2).
 *
 * Shared by every direct-API call site that talks to Anthropic — LocalAgent
 * (Anthropic direct + OpenRouter passthrough) and agent-loop's Task sub-agents.
 *
 * Anthropic allows 4 breakpoints per request; we spend 3:
 *   1) End of system prompt        (1h TTL — persistent across long-idle sessions)
 *   2) Last tool schema            (1h TTL — persistent)
 *   3) Second-to-last user message (5min TTL — rolls each turn, cheaper to write)
 *
 * The 4th slot stays reserved (attachments, future retrieval prefix).
 *
 * Extended 1-hour TTL is a beta — pass ANTHROPIC_BETA_HEADER on the request
 * whenever any block carries ttl:'1h'.
 */

export const ANTHROPIC_BETA_HEADER = 'extended-cache-ttl-2025-04-11';

const CACHE_1H = { type: 'ephemeral', ttl: '1h' };
const CACHE_5M = { type: 'ephemeral' };

/**
 * Turn a `system` string into a content-block array with a cache_control
 * breakpoint on the tail. If the caller already passed blocks, returns them
 * unchanged. Undefined / non-string inputs pass through as-is.
 */
export function cacheableSystem(systemPrompt) {
    if (Array.isArray(systemPrompt)) return systemPrompt;
    if (!systemPrompt || typeof systemPrompt !== 'string') return systemPrompt;
    return [{ type: 'text', text: systemPrompt, cache_control: CACHE_1H }];
}

/**
 * Return a copy of `tools` with cache_control on the LAST tool. Anthropic
 * caches system + tools as one prefix from that breakpoint, so this single
 * marker covers the whole tool schema regardless of length.
 */
export function cacheableTools(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return tools || [];
    const out = tools.slice();
    const last = out[out.length - 1];
    out[out.length - 1] = { ...last, cache_control: CACHE_1H };
    return out;
}

/**
 * Tag the SECOND-to-last user message with a 5-min cache_control breakpoint.
 * Leaves the last turn write-through so the next round extends the cache
 * instead of re-writing it. Returns messages unchanged when there aren't
 * enough user turns yet (< 2).
 *
 * Handles both content shapes: string (wrapped into blocks) and block array
 * (tagged on the last block).
 */
export function withMessageBreakpoint(messages) {
    if (!Array.isArray(messages) || messages.length < 2) return messages;
    const userIdx = [];
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'user') userIdx.push(i);
    }
    if (userIdx.length < 2) return messages;
    const targetIdx = userIdx[userIdx.length - 2];
    const msg = messages[targetIdx];

    if (typeof msg.content === 'string') {
        return messages.map((m, i) => i === targetIdx ? {
            ...m,
            content: [{ type: 'text', text: m.content, cache_control: CACHE_5M }],
        } : m);
    }

    if (Array.isArray(msg.content) && msg.content.length > 0) {
        const blocks = msg.content.slice();
        const last = blocks[blocks.length - 1];
        blocks[blocks.length - 1] = { ...last, cache_control: CACHE_5M };
        return messages.map((m, i) => i === targetIdx ? { ...m, content: blocks } : m);
    }

    return messages;
}

/**
 * True if the given model id needs Anthropic-style explicit cache_control
 * (vs OpenAI/DeepSeek which auto-cache). Handles bare Claude ids and
 * OpenRouter's `anthropic/*` prefix.
 */
export function needsExplicitCacheControl(model) {
    if (!model) return false;
    const m = model.toLowerCase();
    return m.startsWith('claude') || m.startsWith('anthropic/');
}
