/**
 * Model Pricing — per-model cost calculation.
 *
 * Two sources of truth:
 * 1. OpenRouter /api/v1/models endpoint (live pricing, fetched at startup)
 * 2. Static fallback table (for non-OpenRouter providers: Anthropic, OpenAI, Google)
 *
 * All prices in USD per million tokens (MTok).
 *
 * PRD-028: Phase 1 — CLI-side pricing with live OpenRouter fetch.
 */

// ── Static Fallback Table (non-OpenRouter providers) ─────────

const STATIC_PRICING = {
    // ── Anthropic (direct API, not via OpenRouter) ──
    'claude-opus-4':              { input: 15,    output: 75,   cache_read: 1.50,  cache_write: 18.75 },
    'claude-sonnet-4':            { input: 3,     output: 15,   cache_read: 0.30,  cache_write: 3.75  },
    'claude-haiku-3-5':           { input: 0.80,  output: 4,    cache_read: 0.08,  cache_write: 1.0   },

    // ── OpenAI (direct API) ──
    'gpt-4o':                     { input: 2.50,  output: 10   },
    'gpt-4.1':                    { input: 2,     output: 8    },
    'gpt-4.1-mini':               { input: 0.40,  output: 1.60 },
    'gpt-4.1-nano':               { input: 0.10,  output: 0.40 },
    'o3':                         { input: 2,     output: 8    },
    'o3-mini':                    { input: 1.10,  output: 4.40 },
    'o4-mini':                    { input: 1.10,  output: 4.40 },

    // ── Google (direct API) ──
    'gemini-2.5-pro':             { input: 1.25,  output: 10   },
    'gemini-2.5-flash':           { input: 0.30,  output: 2.50 },
    'gemini-2.0-flash':           { input: 0.10,  output: 0.40 },

    // ── Bedrock (Anthropic models via AWS) ──
    'us.anthropic.claude-sonnet-4-6-20260401-v1:0': { input: 3, output: 15, cache_read: 0.30, cache_write: 3.75 },
    'us.anthropic.claude-haiku-4-5-20251001-v1:0':  { input: 0.80, output: 4, cache_read: 0.08, cache_write: 1.0 },
};

const DEFAULT_PRICING = { input: 3, output: 15 };

// ── Live OpenRouter Pricing Cache ────────────────────────────

let _openRouterPricing = null;  // Map<model_id, { input, output }>
let _fetchPromise = null;

/**
 * Fetch live pricing from OpenRouter's /api/v1/models endpoint.
 * Called once at startup, cached for the session.
 * Non-blocking — returns immediately, populates cache in background.
 */
export async function fetchOpenRouterPricing() {
    if (_openRouterPricing) return _openRouterPricing;
    if (_fetchPromise) return _fetchPromise;

    _fetchPromise = (async () => {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);

            const res = await fetch('https://openrouter.ai/api/v1/models', {
                signal: controller.signal,
                headers: { 'Accept': 'application/json' },
            });
            clearTimeout(timeout);

            if (!res.ok) return null;

            const data = await res.json();
            const models = data.data || [];
            const pricing = new Map();

            for (const m of models) {
                const id = m.id;
                const p = m.pricing;
                if (!id || !p) continue;

                // OpenRouter returns per-token prices as strings
                const input = parseFloat(p.prompt || '0') * 1_000_000;   // convert to per-MTok
                const output = parseFloat(p.completion || '0') * 1_000_000;

                pricing.set(id, { input, output });
            }

            _openRouterPricing = pricing;
            return pricing;
        } catch {
            // Network error, timeout, or parse error — fall back to static
            return null;
        } finally {
            _fetchPromise = null;
        }
    })();

    return _fetchPromise;
}

/**
 * Start fetching OpenRouter pricing in the background.
 * Call this at CLI startup — non-blocking.
 */
export function prefetchPricing() {
    fetchOpenRouterPricing().catch(() => {});
}

// ── Model ID Normalization ───────────────────────────────────

/**
 * Normalize a model ID for pricing lookup.
 * Strips version suffixes, date stamps, provider prefixes (openrouter/).
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
 *
 * Search order:
 * 1. OpenRouter live pricing (exact match)
 * 2. Static table (exact → normalized → provider-stripped)
 * 3. Default fallback ($3/$15 Sonnet)
 *
 * @param {string} model
 * @returns {{ input: number, output: number, cache_read?: number, cache_write?: number }}
 */
export function lookupPricing(model) {
    if (!model) return DEFAULT_PRICING;

    // 1. OpenRouter live cache (exact match — OpenRouter IDs are canonical)
    if (_openRouterPricing) {
        const orPrice = _openRouterPricing.get(model);
        if (orPrice) return orPrice;

        // Try normalized
        const normalized = normalizeModelId(model);
        const orNorm = _openRouterPricing.get(normalized);
        if (orNorm) return orNorm;
    }

    // 2. Static table — exact match
    if (STATIC_PRICING[model]) return STATIC_PRICING[model];

    // Normalized match
    const normalized = normalizeModelId(model);
    if (STATIC_PRICING[normalized]) return STATIC_PRICING[normalized];

    // Try without provider prefix (e.g. 'google/gemini-2.5-pro' → 'gemini-2.5-pro')
    const withoutProvider = normalized.replace(/^[^/]+\//, '');
    if (STATIC_PRICING[withoutProvider]) return STATIC_PRICING[withoutProvider];

    // Try with common provider prefixes
    for (const prefix of ['deepseek/', 'xiaomi/', 'google/', 'meta/', 'qwen/', 'moonshotai/']) {
        if (STATIC_PRICING[prefix + withoutProvider]) return STATIC_PRICING[prefix + withoutProvider];
    }

    // 3. OpenRouter fuzzy match (without provider prefix)
    if (_openRouterPricing) {
        for (const [id, price] of _openRouterPricing) {
            if (id.endsWith('/' + withoutProvider)) return price;
        }
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
 * @returns {{ total: number, breakdown: Array, accurate: boolean }}
 */
export function calculateCost(usage) {
    if (!usage) return { total: 0, breakdown: [], accurate: false };

    // Best case: backend computed cost from live OpenRouter pricing
    if (typeof usage.total_cost === 'number' && usage.models && usage.models.length > 0) {
        const breakdown = usage.models.map(m => ({
            model: m.model,
            role: m.role || 'unknown',
            input_tokens: m.input_tokens || 0,
            output_tokens: m.output_tokens || 0,
            cache_read_tokens: m.cache_read_tokens || 0,
            cache_creation_tokens: m.cache_creation_tokens || 0,
            cost: m.cost || 0,
            free: (m.cost || 0) === 0 && (m.input_tokens || 0) > 0,
            pricingSource: 'backend',
        }));

        return {
            total: usage.total_cost,
            breakdown,
            accurate: true,
        };
    }

    // Fallback: per-model breakdown without backend cost — CLI computes
    if (usage.models && usage.models.length > 0) {
        const breakdown = usage.models.map(m => {
            const pricing = lookupPricing(m.model);
            const inputCost = (m.input_tokens || 0) * pricing.input / 1_000_000;
            const outputCost = (m.output_tokens || 0) * pricing.output / 1_000_000;
            const cacheReadCost = (m.cache_read_tokens || 0) * (pricing.cache_read || pricing.input) / 1_000_000;
            const cacheWriteCost = (m.cache_creation_tokens || 0) * (pricing.cache_write || pricing.input) / 1_000_000;
            const cost = inputCost + outputCost + cacheReadCost + cacheWriteCost;

            const usedLivePricing = _openRouterPricing?.has(m.model) || false;
            const usedStaticPricing = STATIC_PRICING[m.model] || STATIC_PRICING[normalizeModelId(m.model)];

            return {
                model: m.model,
                role: m.role || 'unknown',
                input_tokens: m.input_tokens || 0,
                output_tokens: m.output_tokens || 0,
                cache_read_tokens: m.cache_read_tokens || 0,
                cache_creation_tokens: m.cache_creation_tokens || 0,
                cost,
                free: pricing.input === 0 && pricing.output === 0,
                pricingSource: usedLivePricing ? 'openrouter' : usedStaticPricing ? 'static' : 'default',
            };
        });

        const allAccurate = breakdown.every(b => b.pricingSource !== 'default');

        return {
            total: breakdown.reduce((sum, b) => sum + b.cost, 0),
            breakdown,
            accurate: allAccurate,
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
            pricingSource: 'default',
        }],
        accurate: false,
    };
}

// ── Formatting ───────────────────────────────────────────────

/**
 * Format a cost value as a dollar string (diagnostic/telemetry only).
 * @param {number} cost
 * @returns {string}
 */
export function formatCostValue(cost) {
    if (cost === 0) return '$0.00';
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
}

/**
 * Convert provider cost to Bahulam credits.
 * 100 credits = $1 of retail model usage, 2x multiplier.
 * @param {number} costUsd
 * @returns {number}
 */
export function costToCredits(costUsd) {
    if (costUsd <= 0) return 0;
    return Math.max(1, Math.ceil(costUsd * 2.0 * 100));
}

/**
 * Format credits for display (e.g. "5 cr", "1.2k cr").
 * @param {number} credits
 * @returns {string}
 */
export function formatCredits(credits) {
    if (credits === 0) return '0 cr';
    if (credits >= 1000) return `${(credits / 1000).toFixed(1)}k cr`;
    return `${credits} cr`;
}

/**
 * Format a token count for display.
 *   42          → '42'
 *   42100       → '42.1k'
 *   1_500_000   → '1.5M'
 * Session-cumulative counts easily cross millions on tool-heavy runs;
 * without the M suffix they render as multi-thousand-'k' strings like
 * '53148.2k' that read as broken.
 * @param {number} tokens
 * @returns {string}
 */
export function formatTokens(tokens) {
    if (tokens === 0) return '0';
    if (tokens < 1000) return String(tokens);
    if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
    return `${(tokens / 1_000_000).toFixed(1)}M`;
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
 * Get pricing status (for /status display).
 * @returns {{ source: string, modelCount: number }}
 */
export function getPricingStatus() {
    if (_openRouterPricing) {
        return { source: 'openrouter-live', modelCount: _openRouterPricing.size };
    }
    return { source: 'static-fallback', modelCount: Object.keys(STATIC_PRICING).length };
}
