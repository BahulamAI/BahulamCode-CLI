/**
 * Model Pricing — per-model cost calculation.
 *
 * All prices in USD per million tokens (MTok).
 * Cache pricing is Anthropic-specific; other providers fall back to input rate.
 *
 * PRD-028: Phase 1 — CLI-side pricing table with backend fallback.
 */

// ── Pricing Table (USD per MTok) ─────────────────────────────

const PRICING = {
    // ── Anthropic ──
    'claude-opus-4':              { input: 15,    output: 75,   cache_read: 1.50,  cache_write: 18.75 },
    'claude-sonnet-4':            { input: 3,     output: 15,   cache_read: 0.30,  cache_write: 3.75  },
    'claude-haiku-3-5':           { input: 0.80,  output: 4,    cache_read: 0.08,  cache_write: 1.0   },

    // ── OpenAI ──
    'gpt-4o':                     { input: 2.50,  output: 10   },
    'gpt-4.1':                    { input: 2,     output: 8    },
    'gpt-4.1-mini':               { input: 0.40,  output: 1.60 },
    'gpt-4.1-nano':               { input: 0.10,  output: 0.40 },
    'o3':                         { input: 2,     output: 8    },
    'o3-mini':                    { input: 1.10,  output: 4.40 },
    'o4-mini':                    { input: 1.10,  output: 4.40 },

    // ── Google ──
    'gemini-2.5-pro':             { input: 1.25,  output: 10   },
    'gemini-2.5-flash':           { input: 0.15,  output: 0.60 },
    'gemini-2.0-flash':           { input: 0.10,  output: 0.40 },

    // ── Open-source (via OpenRouter / self-hosted) ──
    'deepseek/deepseek-chat-v3':       { input: 0.27, output: 1.10 },
    'deepseek/deepseek-chat-v3-0324':  { input: 0.27, output: 1.10 },
    'deepseek/deepseek-reasoner':      { input: 0.55, output: 2.19 },
    'xiaomi/mimo-v2-flash':            { input: 0,    output: 0    },
    'xiaomi/mimo-v2-flash:free':       { input: 0,    output: 0    },
};

const DEFAULT_PRICING = { input: 3, output: 15 };

// ── Model ID Normalization ───────────────────────────────────

/**
 * Normalize a model ID for pricing lookup.
 * Strips version suffixes, date stamps, provider prefixes (openrouter/),
 * and tries progressively shorter matches.
 *
 * Examples:
 *   'claude-sonnet-4-20250514' → 'claude-sonnet-4'
 *   'openrouter/google/gemini-2.5-pro' → 'gemini-2.5-pro'
 *   'google/gemini-2.5-pro-preview-05-06' → 'gemini-2.5-pro'
 */
function normalizeModelId(model) {
    if (!model) return '';
    let id = model.trim().toLowerCase();

    // Strip 'openrouter/' prefix
    id = id.replace(/^openrouter\//, '');

    // Strip date suffixes like -20250514 or -preview-05-06
    id = id.replace(/-\d{8}$/, '');
    id = id.replace(/-preview[-\d]*$/, '');

    return id;
}

/**
 * Look up pricing for a model ID.
 * Tries exact match, then normalized, then progressively shorter prefixes.
 * @param {string} model
 * @returns {{ input: number, output: number, cache_read?: number, cache_write?: number }}
 */
export function lookupPricing(model) {
    if (!model) return DEFAULT_PRICING;

    // Exact match
    if (PRICING[model]) return PRICING[model];

    // Normalized match
    const normalized = normalizeModelId(model);
    if (PRICING[normalized]) return PRICING[normalized];

    // Try without provider prefix (e.g. 'google/gemini-2.5-pro' → 'gemini-2.5-pro')
    const withoutProvider = normalized.replace(/^[^/]+\//, '');
    if (PRICING[withoutProvider]) return PRICING[withoutProvider];

    // Try with common provider prefixes
    for (const prefix of ['deepseek/', 'xiaomi/', 'google/', 'meta/']) {
        if (PRICING[prefix + withoutProvider]) return PRICING[prefix + withoutProvider];
    }

    return DEFAULT_PRICING;
}

// ── Cost Calculation ─────────────────────────────────────────

/**
 * Calculate cost from a usage object.
 *
 * Supports two formats:
 * 1. New format (with per-model breakdown):
 *    { models: [{ model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens }] }
 *
 * 2. Legacy format (flat tokens, no model):
 *    { input_tokens, output_tokens }
 *
 * @param {Object} usage - Usage object from backend complete event
 * @returns {{ total: number, breakdown: Array<{ model: string, role: string, cost: number, input_tokens: number, output_tokens: number }>, accurate: boolean }}
 */
export function calculateCost(usage) {
    if (!usage) return { total: 0, breakdown: [], accurate: false };

    // New format: per-model breakdown
    if (usage.models && usage.models.length > 0) {
        const breakdown = usage.models.map(m => {
            const pricing = lookupPricing(m.model);
            const inputCost = (m.input_tokens || 0) * pricing.input / 1_000_000;
            const outputCost = (m.output_tokens || 0) * pricing.output / 1_000_000;
            const cacheReadCost = (m.cache_read_tokens || 0) * (pricing.cache_read || pricing.input) / 1_000_000;
            const cacheWriteCost = (m.cache_creation_tokens || 0) * (pricing.cache_write || pricing.input) / 1_000_000;
            const cost = inputCost + outputCost + cacheReadCost + cacheWriteCost;

            return {
                model: m.model,
                role: m.role || 'unknown',
                input_tokens: m.input_tokens || 0,
                output_tokens: m.output_tokens || 0,
                cache_read_tokens: m.cache_read_tokens || 0,
                cache_creation_tokens: m.cache_creation_tokens || 0,
                cost,
                free: pricing.input === 0 && pricing.output === 0,
            };
        });

        return {
            total: breakdown.reduce((sum, b) => sum + b.cost, 0),
            breakdown,
            accurate: true,
        };
    }

    // Legacy format: flat tokens, unknown model — use default pricing
    const inputTokens = usage.total_input_tokens || usage.input_tokens || 0;
    const outputTokens = usage.total_output_tokens || usage.output_tokens || 0;
    const total = (inputTokens * DEFAULT_PRICING.input + outputTokens * DEFAULT_PRICING.output) / 1_000_000;

    return {
        total,
        breakdown: [{
            model: 'unknown',
            role: 'unknown',
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cost: total,
            free: false,
        }],
        accurate: false,  // using fallback pricing
    };
}

// ── Formatting ───────────────────────────────────────────────

/**
 * Format a cost value as a dollar string.
 * @param {number} cost
 * @returns {string}
 */
export function formatCostValue(cost) {
    if (cost === 0) return '$0.00';
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
}

/**
 * Format a token count for display (e.g. 42100 → '42.1k').
 * @param {number} tokens
 * @returns {string}
 */
export function formatTokens(tokens) {
    if (tokens === 0) return '0';
    if (tokens < 1000) return String(tokens);
    return `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * Check if a model is free-tier.
 * @param {string} model
 * @returns {boolean}
 */
export function isFreeModel(model) {
    const pricing = lookupPricing(model);
    return pricing.input === 0 && pricing.output === 0;
}

/**
 * Get the full pricing table (for /cost display).
 * @returns {Object}
 */
export function getPricingTable() {
    return { ...PRICING, _default: DEFAULT_PRICING };
}
