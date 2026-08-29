/**
 * User-facing helpers for PRD-065 rolling message windows.
 */

export function normalizeRateLimit(rateLimit) {
    if (!rateLimit || typeof rateLimit !== 'object') return null;

    const used = numberOrNull(rateLimit.msgs_used_in_window);
    const limit = numberOrNull(rateLimit.msgs_per_window);
    const configured = numberOrNull(rateLimit.configured_msgs_per_window);
    const retryAfter = numberOrNull(rateLimit.retry_after ?? rateLimit.retry_after_seconds);

    return {
        ...rateLimit,
        msgs_used_in_window: used,
        msgs_per_window: limit,
        configured_msgs_per_window: configured,
        retry_after: retryAfter,
        unlimited: Boolean(rateLimit.unlimited),
        byok: Boolean(rateLimit.byok),
    };
}

export function messagesRemaining(rateLimit) {
    const rl = normalizeRateLimit(rateLimit);
    if (!rl) return null;
    if (rl.unlimited || rl.msgs_per_window === -1) return Infinity;
    if (typeof rl.msgs_used_in_window !== 'number' || typeof rl.msgs_per_window !== 'number') return null;
    return Math.max(0, rl.msgs_per_window - rl.msgs_used_in_window);
}

export function formatRetryAfter(seconds) {
    const secs = Math.max(0, Math.ceil(Number(seconds) || 0));
    if (secs <= 0) return 'soon';
    const hours = Math.floor(secs / 3600);
    const minutes = Math.ceil((secs % 3600) / 60);
    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${secs}s`;
}

export function resetLabel(rateLimit, now = Date.now()) {
    const rl = normalizeRateLimit(rateLimit);
    if (!rl?.window_reset_at) return null;
    const resetMs = Date.parse(rl.window_reset_at);
    if (!Number.isFinite(resetMs)) return null;
    return formatRetryAfter(Math.max(0, (resetMs - now) / 1000));
}

export function formatMessageWindow(rateLimit, { includeReset = true } = {}) {
    const rl = normalizeRateLimit(rateLimit);
    if (!rl) return null;

    const tier = rl.tier ? String(rl.tier).toUpperCase() : null;
    if (rl.byok || rl.unlimited || rl.msgs_per_window === -1) {
        return [tier, 'unlimited messages'].filter(Boolean).join(' · ');
    }

    if (typeof rl.msgs_used_in_window !== 'number' || typeof rl.msgs_per_window !== 'number') {
        return tier || null;
    }

    const remaining = Math.max(0, rl.msgs_per_window - rl.msgs_used_in_window);
    const parts = [
        tier,
        `${remaining} / ${rl.msgs_per_window} messages this window`,
    ].filter(Boolean);

    const reset = includeReset ? resetLabel(rl) : null;
    if (reset) parts.push(`resets in ${reset}`);
    return parts.join(' · ');
}

export function lowWindowStatus(rateLimit) {
    const rl = normalizeRateLimit(rateLimit);
    if (!rl || rl.byok || rl.unlimited || rl.msgs_per_window === -1) return 'ok';
    const remaining = messagesRemaining(rl);
    if (typeof remaining !== 'number' || typeof rl.msgs_per_window !== 'number') return 'ok';
    if (remaining <= 0) return 'exhausted';
    if (remaining <= Math.max(5, Math.floor(rl.msgs_per_window * 0.2))) return 'low';
    return 'ok';
}

export function rateLimitErrorMessage(payload, fallback = 'Message limit reached.') {
    const detail = quotaErrorDetail(payload);
    const retryAfter = detail?.retry_after ?? detail?.rate_limit?.retry_after ?? detail?.rate_limit?.retry_after_seconds;
    const detailMessage = normalizeBillingBrandCopy(detail?.message);
    if (detail?.code === 'credit_balance_exhausted') {
        return detailMessage || 'Credit balance exhausted — add credits, upgrade your plan, or switch to BYOK in Settings.';
    }
    if (detail?.code === 'message_limit_reached') {
        if (detailMessage) return detailMessage;
        if (retryAfter != null) return `Message window exhausted — try again in ${formatRetryAfter(retryAfter)}, or upgrade your plan.`;
        return 'Message window exhausted — wait for the window to reset or upgrade your plan.';
    }
    if (detailMessage) return detailMessage;
    if (retryAfter != null) return `Message window exhausted — try again in ${formatRetryAfter(retryAfter)}, or upgrade your plan.`;
    return fallback;
}

export function normalizeBillingBrandCopy(value) {
    if (typeof value !== 'string') return value;
    return value
        .replace(/codekepler\.ai\/pricing/gi, 'bahulam.ai/pricing')
        .replace(/Kepler credit charges/g, 'Bahulam credit charges')
        .replace(/Kepler credits/g, 'Bahulam credits');
}

export function quotaErrorDetail(payload) {
    if (!payload || typeof payload !== 'object') return {};
    if (typeof payload.detail === 'string') return { message: payload.detail };
    if (payload.detail && typeof payload.detail === 'object') return payload.detail;
    return payload;
}

function numberOrNull(value) {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}
