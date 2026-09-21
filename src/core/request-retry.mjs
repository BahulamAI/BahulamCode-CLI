/**
 * Shared retry policy for one-shot model HTTP requests.
 *
 * Streaming /api/execute has its own event-id resume protocol in
 * stream-client.mjs. This helper is for npm-owned local/direct model calls
 * where the request must finish before the agent loop can continue.
 */

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT',
  'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
]);

function numberEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function isNetworkError(error) {
  const code = error?.cause?.code || error?.code;
  return error?.name === 'AbortError'
    || NETWORK_CODES.has(String(code || '').toUpperCase())
    || /fetch failed|network|socket|timed out|timeout|connection reset|connection refused/i.test(String(error?.message || ''));
}

export function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(Number(status));
}

function retryDelay(attempt, base, max) {
  const exponential = Math.min(max, base * (2 ** Math.max(0, attempt - 1)));
  return Math.min(max, Math.round(exponential * (0.8 + Math.random() * 0.4)));
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class RequestError extends Error {
  constructor(message, { status = null, code = 'request_error', retryable = false, attempts = 1, cause = null } = {}) {
    super(message, { cause: cause || undefined });
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.attempts = attempts;
  }
}

/**
 * Fetch with bounded retry for transient transport/server failures.
 * 401/403 and all other non-retryable 4xx responses return immediately.
 */
export async function fetchWithRetry(url, options = {}, {
  fetchImpl = globalThis.fetch,
  maxRetries = numberEnv('BAHULAM_REQUEST_MAX_RETRIES', 2),
  baseDelayMs = numberEnv('BAHULAM_REQUEST_RETRY_BASE_MS', 500),
  maxDelayMs = numberEnv('BAHULAM_REQUEST_RETRY_MAX_MS', 8000),
  onRetry = null,
} = {}) {
  const retries = Math.max(0, Number(maxRetries) || 0);
  let attempt = 0;

  while (true) {
    attempt++;
    let response;
    try {
      response = await fetchImpl(url, options);
    } catch (error) {
      if (!isNetworkError(error) || attempt > retries + 1) {
        throw new RequestError(
          `Network request failed after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${error?.message || error}`,
          { code: 'network_error', retryable: true, attempts: attempt, cause: error },
        );
      }
      const delayMs = retryDelay(attempt, baseDelayMs, maxDelayMs);
      onRetry?.({ attempt, delayMs, reason: 'network', error });
      await wait(delayMs);
      continue;
    }

    if (!isRetryableStatus(response.status) || attempt > retries + 1) {
      return response;
    }

    // Release the failed response before retrying. The final response remains
    // available to the caller for its normal provider-specific error body.
    try { response.body?.cancel?.(); } catch {}
    const delayMs = retryDelay(attempt, baseDelayMs, maxDelayMs);
    onRetry?.({ attempt, delayMs, reason: `http_${response.status}`, status: response.status });
    await wait(delayMs);
  }
}

export function requestErrorData(error, { phase = 'model', provider = null } = {}) {
  return {
    message: error?.message || String(error),
    code: error?.code || (error?.status ? `http_${error.status}` : 'request_error'),
    phase,
    provider,
    status: error?.status ?? null,
    retryable: error?.retryable === true || isRetryableStatus(error?.status),
    attempts: error?.attempts || 1,
  };
}
