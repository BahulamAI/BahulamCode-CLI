/**
 * Rate Limiter — handle 429 and 529 API responses.
 *
 * Implements exponential backoff with jitter for rate-limited
 * and overloaded API responses. Tracks retry state per-instance.
 */

export class RateLimiter {
    /**
     * @param {object} [options]
     * @param {number} [options.maxRetries] - max number of retries (default: 5)
     * @param {number} [options.baseDelay] - base delay in ms (default: 1000)
     * @param {number} [options.maxDelay] - max delay in ms (default: 60000)
     */
    constructor(options = {}) {
        this.maxRetries = options.maxRetries ?? 5;
        this.baseDelay = options.baseDelay ?? 1000;
        this.maxDelay = options.maxDelay ?? 60000;
        this.retryAfter = 0;
        this.retryCount = 0;
        this.lastRetryAt = null;
    }

    /**
     * Handle an API response and determine whether to retry.
     * @param {{ status: number, headers: { get: (name: string) => string|null } }} response
     * @returns {Promise<'ok'|'retry'|'fail'>}
     */
    async handleResponse(response) {
        if (response.status === 429) {
            // Rate limited
            if (this.retryCount >= this.maxRetries) return 'fail';

            const retryAfter = parseInt(response.headers?.get?.('retry-after') || '10', 10);
            const delayMs = Math.min(retryAfter * 1000, this.maxDelay);
            this.retryAfter = Date.now() + delayMs;
            this.retryCount++;
            this.lastRetryAt = new Date().toISOString();

            await this.wait(delayMs);
            return 'retry';
        }

        if (response.status === 529) {
            // API overloaded
            if (this.retryCount >= this.maxRetries) return 'fail';

            const delay = this.calculateBackoff();
            this.retryAfter = Date.now() + delay;
            this.retryCount++;
            this.lastRetryAt = new Date().toISOString();

            await this.wait(delay);
            return 'retry';
        }

        // Success — reset retry count
        this.retryCount = 0;
        return 'ok';
    }

    /**
     * Calculate exponential backoff with jitter.
     * @returns {number} delay in milliseconds
     */
    calculateBackoff() {
        const exponential = this.baseDelay * Math.pow(2, this.retryCount);
        const jitter = Math.random() * this.baseDelay;
        return Math.min(exponential + jitter, this.maxDelay);
    }

    /**
     * Check if we should wait before making a request.
     * @returns {boolean}
     */
    shouldWait() {
        return Date.now() < this.retryAfter;
    }

    /**
     * Get remaining wait time in ms.
     * @returns {number}
     */
    remainingWait() {
        return Math.max(0, this.retryAfter - Date.now());
    }

    /**
     * Reset all retry state.
     */
    reset() {
        this.retryAfter = 0;
        this.retryCount = 0;
        this.lastRetryAt = null;
    }

    /**
     * Get current limiter status.
     */
    status() {
        return {
            retryCount: this.retryCount,
            maxRetries: this.maxRetries,
            retryAfter: this.retryAfter,
            lastRetryAt: this.lastRetryAt,
            isWaiting: this.shouldWait(),
            remainingMs: this.remainingWait(),
        };
    }

    /**
     * Wait for the specified duration.
     * @param {number} ms
     * @returns {Promise<void>}
     */
    wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
