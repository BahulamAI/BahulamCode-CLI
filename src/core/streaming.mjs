/**
 * Streaming Handler — processes Anthropic SSE events from the Messages API.
 *
 * Handles ALL SSE event types:
 * - message_start, message_delta, message_stop
 * - content_block_start, content_block_delta, content_block_stop
 * - ping
 * - error
 *
 * Parses:
 * - thinking blocks (type: "thinking")
 * - tool_use input streaming (type: "input_json_delta")
 * - Usage tracking from message_delta.usage
 */

/**
 * Parse an SSE stream from an Anthropic streaming response.
 * @param {Response} response - fetch Response with streaming body
 * @yields {object} Parsed SSE event data
 */
export async function* streamResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // SSE events are separated by double newlines
            while (buffer.includes('\n\n')) {
                const idx = buffer.indexOf('\n\n');
                const chunk = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);

                const event = parseSSEChunk(chunk);
                if (event) yield event;
            }
        }

        // Handle remaining buffer
        if (buffer.trim()) {
            const event = parseSSEChunk(buffer.trim());
            if (event) yield event;
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * Parse a single SSE chunk into an event object.
 * @param {string} chunk - raw SSE text (may contain event: and data: lines)
 * @returns {object|null} Parsed event or null
 */
function parseSSEChunk(chunk) {
    let eventType = null;
    let dataLines = [];

    for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
            dataLines.push(line.slice(6));
        } else if (line.startsWith(':')) {
            // SSE comment, ignore
            continue;
        }
    }

    // Handle ping events (no data)
    if (eventType === 'ping') {
        return { type: 'ping' };
    }

    if (dataLines.length === 0) return null;

    const raw = dataLines.join('\n');
    if (raw === '[DONE]') return { type: 'done' };

    try {
        const data = JSON.parse(raw);
        return { type: eventType || data.type || 'unknown', ...data };
    } catch {
        return null;
    }
}

/**
 * Accumulate streaming events into a complete message response.
 * Collects content blocks, thinking blocks, and usage stats.
 *
 * @param {AsyncIterable} events - stream of SSE events
 * @returns {object} Complete message in the same shape as non-streaming API
 */
export async function accumulateStream(events) {
    const message = {
        id: null,
        role: 'assistant',
        content: [],
        model: null,
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };

    let currentBlock = null;
    let blockIndex = -1;

    for await (const event of events) {
        switch (event.type) {
            case 'message_start':
                if (event.message) {
                    message.id = event.message.id;
                    message.model = event.message.model;
                    if (event.message.usage) {
                        message.usage.input_tokens = event.message.usage.input_tokens || 0;
                        message.usage.cache_creation_input_tokens = event.message.usage.cache_creation_input_tokens || 0;
                        message.usage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens || 0;
                    }
                }
                break;

            case 'content_block_start':
                blockIndex = event.index ?? message.content.length;
                currentBlock = { ...event.content_block };
                if (currentBlock.type === 'text') currentBlock.text = '';
                if (currentBlock.type === 'thinking') currentBlock.thinking = '';
                if (currentBlock.type === 'tool_use') {
                    currentBlock.input = '';
                }
                message.content[blockIndex] = currentBlock;
                break;

            case 'content_block_delta':
                if (!currentBlock) break;
                if (event.delta?.type === 'text_delta') {
                    currentBlock.text += event.delta.text;
                } else if (event.delta?.type === 'thinking_delta') {
                    currentBlock.thinking += event.delta.thinking;
                } else if (event.delta?.type === 'input_json_delta') {
                    currentBlock.input += event.delta.partial_json;
                }
                break;

            case 'content_block_stop':
                // Parse tool_use input from accumulated JSON string
                if (currentBlock?.type === 'tool_use' && typeof currentBlock.input === 'string') {
                    try {
                        currentBlock.input = JSON.parse(currentBlock.input || '{}');
                    } catch {
                        currentBlock.input = {};
                    }
                }
                currentBlock = null;
                break;

            case 'message_delta':
                if (event.delta?.stop_reason) {
                    message.stop_reason = event.delta.stop_reason;
                }
                if (event.usage) {
                    message.usage.output_tokens = event.usage.output_tokens || 0;
                }
                break;

            case 'message_stop':
                break;

            case 'ping':
                // Keepalive, ignore
                break;

            case 'error':
                throw new Error(`Stream error: ${event.error?.message || JSON.stringify(event)}`);
        }
    }

    return message;
}
