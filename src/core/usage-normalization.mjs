/**
 * Normalize provider/gateway usage into the npm agent's canonical shape.
 *
 * Providers use prompt_tokens/completion_tokens, Anthropic-style callers use
 * input_tokens/output_tokens, and remote complete events use total_* fields.
 * Keeping this conversion here prevents each runtime mode from drifting.
 */
export function normalizeUsage(usage) {
    if (!usage) return null;

    const input = usage.input_tokens
        ?? usage.total_input_tokens
        ?? usage.prompt_tokens
        ?? 0;
    const output = usage.output_tokens
        ?? usage.total_output_tokens
        ?? usage.completion_tokens
        ?? 0;
    const promptDetails = usage.prompt_tokens_details || {};

    return {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: usage.cache_read_input_tokens
            ?? usage.cache_read_tokens
            ?? promptDetails.cached_tokens
            ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens
            ?? usage.cache_creation_tokens
            ?? 0,
    };
}
