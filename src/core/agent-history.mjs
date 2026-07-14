/**
 * Structured live history for backend continuity.
 *
 * The terminal display history is intentionally human-friendly. This builder
 * keeps the backend payload provider-shaped: assistant text/tool_use blocks,
 * followed by user tool_result blocks, appended in the order they happened.
 */

const DEFAULT_MAX_TOOL_RESULT_CHARS = 200_000;

function asString(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function maybeTruncate(text, maxChars) {
    const value = asString(text);
    if (!maxChars || value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}\n\n[Kepler truncated this tool result from ${value.length} to ${maxChars} characters for live session continuity.]`;
}

function mergeTextBlock(blocks, text) {
    if (!text) return;
    const last = blocks[blocks.length - 1];
    if (last?.type === 'text') {
        last.text += text;
    } else {
        blocks.push({ type: 'text', text });
    }
}

export class AgentHistoryTurnBuilder {
    constructor({ maxToolResultChars = DEFAULT_MAX_TOOL_RESULT_CHARS } = {}) {
        this.maxToolResultChars = maxToolResultChars;
        this.messages = [];
        this.assistantBlocks = [];
        this.toolUseIds = new Set();
        this.toolResultIds = new Set();
    }

    addAssistantText(text) {
        mergeTextBlock(this.assistantBlocks, asString(text));
    }

    addToolUse(data = {}) {
        const id = data.call_id || data.request_id || data.id;
        const name = data.tool || data.name;
        if (!id || !name) return false;
        this.assistantBlocks.push({
            type: 'tool_use',
            id,
            name,
            input: data.args || data.input || {},
        });
        this.toolUseIds.add(id);
        return true;
    }

    addToolResult(data = {}) {
        const id = data.call_id || data._callId || data.request_id || data.id || data.tool_use_id;
        if (!id || !this.toolUseIds.has(id)) return false;
        if (this.toolResultIds.has(id)) return false;

        this.flushAssistant();
        this.messages.push({
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: id,
                content: maybeTruncate(data.output ?? data.result ?? data.message ?? '', this.maxToolResultChars),
                ...(data.success === false || data.is_error ? { is_error: true } : {}),
            }],
        });
        this.toolResultIds.add(id);
        return true;
    }

    flushAssistant() {
        const blocks = this.assistantBlocks.filter(block => {
            if (block.type === 'text') return Boolean(block.text);
            return true;
        });
        if (!blocks.length) return false;
        this.messages.push({ role: 'assistant', content: blocks });
        this.assistantBlocks = [];
        return true;
    }

    finish() {
        this.flushAssistant();
        return this.messages;
    }
}
