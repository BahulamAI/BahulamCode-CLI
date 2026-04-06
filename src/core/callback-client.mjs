/**
 * Callback Client — POST tool results back to Tarang backend.
 * Implements retry with backoff: 2 retries, 500ms delay.
 * 4xx: no retry. 5xx/network: retry.
 */

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;
const TIMEOUT_MS = 10_000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send a tool execution result to the backend.
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} taskId
 * @param {string} callId
 * @param {Object} result - { success, output, ... }
 * @returns {Promise<boolean>}
 */
export async function sendCallback(baseUrl, token, taskId, callId, result) {
    const url = `${baseUrl}/api/callback`;
    const body = JSON.stringify({
        task_id: taskId,
        call_id: callId,
        result: {
            ...result,
            _output_meta: {
                tool: result._tool || 'unknown',
                success: result.success !== false,
                output_type: result._output_type || 'generic',
                priority: 'normal',
            },
        },
    });

    const headers = {
        'Content-Type': 'application/json',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

            const resp = await fetch(url, {
                method: 'POST',
                headers,
                body,
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (resp.ok) return true;

            // 4xx: client error, don't retry
            if (resp.status >= 400 && resp.status < 500) {
                return false;
            }

            // 5xx: server error, retry
            if (attempt < MAX_RETRIES) {
                await sleep(RETRY_DELAY_MS * (attempt + 1));
            }
        } catch (err) {
            // Network error or timeout, retry
            if (attempt < MAX_RETRIES) {
                await sleep(RETRY_DELAY_MS * (attempt + 1));
            }
        }
    }

    return false;
}

/**
 * Send a "skipped" callback for rejected operations.
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} taskId
 * @param {string} callId
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export async function sendSkippedCallback(baseUrl, token, taskId, callId, message) {
    return sendCallback(baseUrl, token, taskId, callId, {
        skipped: true,
        message: message || 'User rejected operation',
        success: false,
    });
}
