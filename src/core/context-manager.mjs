/**
 * Context Manager — tracks token usage and compacts conversation history.
 *
 * Features:
 * - Proper token estimation (4 chars ~ 1 token for English)
 * - Micro-compaction (remove stale tool results older than 5 turns)
 * - Keep system prompt and recent 3 turns intact during compaction
 * - Track pre/post compaction token counts
 */

const DEFAULT_MAX_TOKENS = 180000; // ~200k model limit with buffer
const COMPACT_THRESHOLD = 0.80;
const CHARS_PER_TOKEN = 4; // rough estimate for English text
const STALE_TOOL_RESULT_TURNS = 5; // tool results older than this are micro-compacted

export class ContextManager {
    /**
     * @param {number} maxTokens - Maximum tokens for context window
     */
    constructor(maxTokens = DEFAULT_MAX_TOKENS) {
        this.maxTokens = maxTokens;
        this.threshold = COMPACT_THRESHOLD;
        this.compactionCount = 0;
        this.lastPreCompactTokens = 0;
        this.lastPostCompactTokens = 0;
    }

    /**
     * Estimate token count for a message array.
     * Uses character-based heuristic (no external tokenizer dependency).
     * @param {Array} messages - conversation messages
     * @returns {number} estimated token count
     */
    getTokenCount(messages) {
        let chars = 0;
        for (const msg of messages) {
            // Role overhead (~4 tokens)
            chars += 16;

            if (typeof msg.content === 'string') {
                chars += msg.content.length;
            } else if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    if (block.type === 'text') chars += (block.text || '').length;
                    else if (block.type === 'tool_result') chars += (block.content || '').length;
                    else if (block.type === 'tool_use') chars += JSON.stringify(block.input || {}).length + 20;
                    else if (block.type === 'thinking') chars += (block.thinking || '').length;
                    else chars += JSON.stringify(block).length;
                }
            }
        }
        return Math.ceil(chars / CHARS_PER_TOKEN);
    }

    /**
     * Check if compaction is needed.
     * @param {Array} messages - current conversation messages
     * @returns {boolean}
     */
    shouldCompact(messages) {
        const tokenCount = this.getTokenCount(messages);
        return tokenCount >= this.maxTokens * this.threshold;
    }

    /**
     * Micro-compact: remove verbose tool results from messages older than N turns.
     * Keeps the tool call reference but truncates result content.
     * @param {Array} messages
     * @param {number} recentTurns - number of recent user/assistant pairs to preserve
     * @returns {Array}
     */
    microCompact(messages, recentTurns = STALE_TOOL_RESULT_TURNS) {
        // Count turns (each user message is roughly one turn)
        let turnCount = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') turnCount++;
        }

        if (turnCount <= recentTurns) return messages;

        // Mark the boundary: keep last recentTurns user messages intact
        let usersSeen = 0;
        let boundary = messages.length;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                usersSeen++;
                if (usersSeen >= recentTurns) {
                    boundary = i;
                    break;
                }
            }
        }

        // Truncate tool results before the boundary
        const result = messages.map((msg, idx) => {
            if (idx >= boundary) return msg;
            if (!Array.isArray(msg.content)) return msg;

            const newContent = msg.content.map(block => {
                if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 200) {
                    return {
                        ...block,
                        content: block.content.slice(0, 100) + '...[truncated]',
                    };
                }
                return block;
            });

            return { ...msg, content: newContent };
        });

        return result;
    }

    /**
     * Compact messages by summarizing older history.
     * Keeps the most recent N messages intact and replaces older ones
     * with a summary message.
     *
     * @param {Array} messages - current conversation messages
     * @param {number} keepRecent - number of recent messages to preserve (default 6 = ~3 turns)
     * @returns {Array} compacted message array
     */
    compact(messages, keepRecent = 6) {
        if (messages.length <= keepRecent) return messages;

        this.lastPreCompactTokens = this.getTokenCount(messages);
        this.compactionCount++;

        // First try micro-compaction
        let working = this.microCompact(messages);
        if (!this.shouldCompact(working)) {
            this.lastPostCompactTokens = this.getTokenCount(working);
            return working;
        }

        // Full compaction
        const oldMessages = messages.slice(0, -keepRecent);
        const recentMessages = messages.slice(-keepRecent);

        // Build a summary of old messages
        const summaryParts = [];
        for (const msg of oldMessages) {
            const role = msg.role;
            let text = '';
            if (typeof msg.content === 'string') {
                text = msg.content.slice(0, 200);
            } else if (Array.isArray(msg.content)) {
                text = msg.content
                    .map(b => {
                        if (b.type === 'text') return b.text?.slice(0, 100);
                        if (b.type === 'tool_use') return `[tool:${b.name}]`;
                        if (b.type === 'tool_result') return `[result:${String(b.content).slice(0, 80)}]`;
                        return `[${b.type}]`;
                    })
                    .filter(Boolean)
                    .join(' ');
            }
            if (text) summaryParts.push(`${role}: ${text}`);
        }

        const summary = {
            role: 'user',
            content: `[Context compacted — summary of ${oldMessages.length} earlier messages]\n` +
                summaryParts.join('\n').slice(0, 2000),
        };

        const compacted = [summary, ...recentMessages];
        this.lastPostCompactTokens = this.getTokenCount(compacted);
        return compacted;
    }

    /**
     * Add a message and auto-compact if needed.
     * @param {Array} messages - mutable message array
     * @param {object} msg - new message to add
     * @returns {Array} possibly compacted array with new message
     */
    addMessage(messages, msg) {
        messages.push(msg);
        if (this.shouldCompact(messages)) {
            return this.compact(messages);
        }
        return messages;
    }

    /**
     * Get compaction statistics.
     * @returns {object}
     */
    getStats() {
        return {
            compactionCount: this.compactionCount,
            lastPreCompactTokens: this.lastPreCompactTokens,
            lastPostCompactTokens: this.lastPostCompactTokens,
        };
    }
}
