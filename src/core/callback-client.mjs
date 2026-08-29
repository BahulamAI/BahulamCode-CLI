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

export function cleanCallbackResult(result = {}) {
    // Clean result for the backend — strip internal CLI metadata so the LLM
    // sees a clear, unambiguous tool result (not noisy JSON with _tool, _output_meta, etc.)
    const cleanResult = {};
    for (const [key, value] of Object.entries(result || {})) {
        if (!key.startsWith('_')) {
            cleanResult[key] = value;
        }
    }
    return cleanResult;
}

export function backendToolResultForLlm(toolName, cleanResult = {}) {
    const rawResult = cleanCallbackResult(cleanResult);
    if (toolName === 'get_project_overview' && !Object.hasOwn(rawResult, 'error')) {
        return {
            output: rawResult.output || '',
            project_resource: rawResult.project_resource,
            already_registered: rawResult.already_registered || false,
        };
    }
    if (!Object.hasOwn(rawResult, 'error')) {
        const outputText = rawResult.output || '';
        if (rawResult.success && outputText) {
            return { output: outputText };
        }
        return rawResult;
    }
    return rawResult;
}

export function llmToolResultContent(toolName, result = {}) {
    return JSON.stringify(backendToolResultForLlm(toolName, result));
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
    const cleanResult = cleanCallbackResult(result);

    const body = JSON.stringify({
        task_id: taskId,
        call_id: callId,
        result: cleanResult,
    });

    const headers = {
        'Content-Type': 'application/json',
        'Idempotency-Key': `${taskId}:${callId}`,
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

/**
 * Send an approval decision to the backend's HITL handler.
 * Called when the framework emits approval_required and the CLI
 * has collected the user's decision via the approval menu.
 *
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} taskId
 * @param {string} toolId  - tool_id from the approval_required event
 * @param {string} decision - "grant" or "deny"
 * @param {string} [scope]  - "once", "type", or "all" (for grant)
 * @param {string} [reason] - optional reason
 * @returns {Promise<boolean>}
 */
export async function sendApprovalDecision(baseUrl, token, taskId, toolId, decision, scope = 'once', reason = '') {
    const url = `${baseUrl}/api/approval_callback`;

    const body = JSON.stringify({
        task_id: taskId,
        tool_id: toolId,
        decision,
        scope,
        reason,
    });

    const headers = {
        'Content-Type': 'application/json',
        'Idempotency-Key': `${taskId}:${toolId}:${decision}`,
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
            if (resp.status >= 400 && resp.status < 500) return false;
            if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
        } catch {
            if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
        }
    }
    return false;
}
