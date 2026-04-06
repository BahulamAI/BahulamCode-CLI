/**
 * Prompt Caching — implements cache_control for Anthropic API.
 *
 * Adds cache_control: { type: "ephemeral" } to system prompt blocks
 * that are static (like CLAUDE.md content), allowing the API to
 * cache them and reduce input token costs.
 *
 * Tracks cache_read_tokens and cache_creation_tokens.
 */

export class PromptCache {
    constructor() {
        this.stats = {
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalRequests: 0,
            cacheHits: 0,
            cacheMisses: 0,
        };
    }

    /**
     * Apply cache control to system prompt blocks.
     * Static content (CLAUDE.md, tool definitions) gets ephemeral cache markers.
     *
     * @param {string|Array} systemPrompt - system prompt content
     * @returns {Array} system prompt blocks with cache_control
     */
    applyCacheControl(systemPrompt) {
        if (typeof systemPrompt === 'string') {
            return [
                {
                    type: 'text',
                    text: systemPrompt,
                    cache_control: { type: 'ephemeral' },
                },
            ];
        }

        if (Array.isArray(systemPrompt)) {
            return systemPrompt.map((block, i) => {
                if (typeof block === 'string') {
                    return {
                        type: 'text',
                        text: block,
                        cache_control: { type: 'ephemeral' },
                    };
                }
                // Only cache the first block (usually CLAUDE.md) and tool defs
                if (i === 0 || block.cacheable) {
                    return { ...block, cache_control: { type: 'ephemeral' } };
                }
                return block;
            });
        }

        return systemPrompt;
    }

    /**
     * Update cache stats from API response usage data.
     * @param {object} usage - API response usage object
     */
    updateStats(usage) {
        this.stats.totalRequests++;
        if (usage) {
            if (usage.cache_creation_input_tokens) {
                this.stats.cacheCreationTokens += usage.cache_creation_input_tokens;
                this.stats.cacheMisses++;
            }
            if (usage.cache_read_input_tokens) {
                this.stats.cacheReadTokens += usage.cache_read_input_tokens;
                this.stats.cacheHits++;
            }
        }
    }

    /**
     * Get cache efficiency stats.
     */
    getStats() {
        const hitRate = this.stats.totalRequests > 0
            ? ((this.stats.cacheHits / this.stats.totalRequests) * 100).toFixed(1)
            : '0.0';

        return {
            ...this.stats,
            hitRate: `${hitRate}%`,
            tokensSaved: this.stats.cacheReadTokens,
        };
    }

    /**
     * Reset stats.
     */
    reset() {
        this.stats = {
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalRequests: 0,
            cacheHits: 0,
            cacheMisses: 0,
        };
    }
}
