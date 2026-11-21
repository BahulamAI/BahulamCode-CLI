const messages = new Map([
    [400, 'The provider rejected the model request. Try another model.'],
    [401, 'The provider could not authenticate the model request. Check the provider configuration.'],
    [402, 'The provider budget cannot cover this request. Reduce the output limit or choose a lower-cost model.'],
    [403, 'The provider denied access to this model. Choose another model or check model access.'],
    [404, 'The selected model is unavailable. Choose another model.'],
    [408, 'The model request timed out. Please try again.'],
    [413, "The request exceeds the provider's size limit. Shorten the input and try again."],
    [429, 'The provider rate limit was reached. Wait before retrying.'],
]);

const budget = /requested up to ([\d,]{1,16}) (?:output )?tokens,? but (?:can only afford|the provider budget covers) ([\d,]{1,16})/i;
const legacyStatus = /(?:error code:|(?:gateway|openrouter|claude)(?: api)?(?: http)?)[ :]+([45]\d\d)\b/i;
const accountUrl = /openrouter\.ai\/[^\s]*\/keys\//i;

export function isProviderDiagnostic(message) {
    return legacyStatus.test(message) || accountUrl.test(message);
}

export function providerErrorMessage(status, body = '') {
    const text = String(body).slice(0, 16000);
    if (status === 402) {
        const match = text.match(budget);
        if (match) {
            return `Requested up to ${match[1]} output tokens, but the provider budget covers ${match[2]}. Reduce the output limit or choose a lower-cost model.`;
        }
    }
    if (status === 400 && /tool names must be unique|duplicate tool names/i.test(text)) {
        return 'The request contains duplicate tool names. Check the registered tools.';
    }
    return messages.get(status) || 'The model request failed at the provider. Please try again.';
}

// Older servers and saved sessions can contain the SDK exception and its raw body.
export function safeProviderEvent(data = {}) {
    if (typeof data === 'string') data = { message: data };
    if (!data || typeof data !== 'object') return data;
    const message = String(data.message || data.error || '');
    const legacy = message.match(legacyStatus);
    const statusHint = data.http_status || data.status || data.details?.status_code;
    const gatewayCode = /^gateway_/.test(data.code || '');
    const providerFailure = gatewayCode || ((data.provider || data.phase === 'gateway') && (statusHint || data.details));
    if (!legacy && !providerFailure && !accountUrl.test(message)) return data;
    const parsed = Number(statusHint || legacy?.[1]);
    const status = Number.isInteger(parsed) && parsed >= 400 && parsed <= 599 ? parsed : 502;
    const safe = { message: providerErrorMessage(status, message), http_status: status };
    if (data.route === 'byok' || data.route === 'platform') safe.route = data.route;
    for (const key of ['code', 'phase', 'operation', 'provider', 'model', 'task_id', 'request_id', 'exception_type']) {
        if (typeof data[key] === 'string' && /^[\w./:-]{1,160}$/.test(data[key]) && !data[key].includes('://') && !/sk-[\w-]{12,}/i.test(data[key])) safe[key] = data[key];
    }
    for (const key of ['fatal', 'retryable', 'retry_after', 'iteration', 'timeout_seconds']) {
        if (typeof data[key] === 'boolean' || Number.isFinite(data[key])) safe[key] = data[key];
    }
    if (['credit_balance_exhausted', 'credits_exhausted'].includes(safe.code)) safe.message = 'No Bahulam credits remaining. Check your balance in billing.';
    if (safe.code === 'paid_subscription_required') safe.message = 'This model requires a paid Bahulam subscription.';
    return safe;
}

// Gateway-owned account errors have different recovery steps from upstream failures.
export function gatewayFailure(status, body) {
    let code;
    try { code = JSON.parse(body)?.detail?.code; } catch { /* Non-JSON upstream failure. */ }
    if (code === 'credits_exhausted') return { code, message: 'No Bahulam credits remaining. Check your balance in billing.' };
    if (code === 'paid_subscription_required') return { code, message: 'This model requires a paid Bahulam subscription.' };
    return {
        code: status === 401 || status === 403 ? 'gateway_authentication_error' : `gateway_http_${status}`,
        message: providerErrorMessage(status, body),
    };
}


// Some providers return HTTP 200 and signal a failed completion inside the envelope.
export function completionFailure(payload) {
    const error = payload?.error || payload?.choices?.find(choice => choice?.error)?.error;
    if (!error) return null;
    const rawStatus = Number(error.status || error.code);
    const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 502;
    return { status, message: providerErrorMessage(status, error.message || error) };
}
