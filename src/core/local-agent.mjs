/**
 * Local Agent — T18: Direct LLM API calls, <100ms startup, offline.
 * Replaces the SSE backend for --local mode.
 * Yields events matching the same format as TarangStreamClient.
 */

const MAX_ITERATIONS = 50;
const STAGNATION_THRESHOLD = 3;

export class LocalAgent {
    constructor({ apiKey, model, toolExecutor, verbose = false, openRouterKey = null }) {
        this.apiKey = apiKey;
        this.openRouterKey = openRouterKey;
        this.model = model || 'claude-sonnet-4-20250514';
        this.toolExecutor = toolExecutor;
        this.verbose = verbose;
        this._cancelled = false;
    }

    async *execute(instruction, context = {}) {
        this._cancelled = false;
        const startTime = Date.now();
        let toolCount = 0;

        yield { type: 'status', data: { message: `Local mode: ${this.model}` } };

        const tools = this._buildToolDefs();
        const systemPrompt = this._buildSystemPrompt(context);
        const messages = [{ role: 'user', content: instruction }];

        const recentCalls = []; // for stagnation detection

        for (let i = 0; i < MAX_ITERATIONS; i++) {
            if (this._cancelled) {
                yield { type: 'cancelled', data: { reason: 'User cancelled' } };
                return;
            }

            let response;
            try {
                response = await this._callLLM(systemPrompt, messages, tools);
            } catch (err) {
                yield { type: 'error', data: { message: `LLM API error: ${err.message}`, fatal: true } };
                return;
            }

            const { content, stopReason } = response;

            // Process content blocks
            let hasToolUse = false;
            const assistantContent = [];

            for (const block of content) {
                if (block.type === 'text') {
                    yield { type: 'content', data: { text: block.text } };
                    assistantContent.push(block);
                } else if (block.type === 'tool_use') {
                    hasToolUse = true;
                    toolCount++;
                    const { id, name, input } = block;

                    // Stagnation check
                    const callSig = `${name}:${JSON.stringify(input)}`;
                    recentCalls.push(callSig);
                    const repeats = recentCalls.filter(c => c === callSig).length;
                    if (repeats >= STAGNATION_THRESHOLD) {
                        yield { type: 'error', data: { message: `Stagnation detected: ${name} called ${repeats} times with same args. Aborting.` } };
                        yield { type: 'complete', data: { summary: 'Aborted (stagnation)', changes: 0, duration_s: (Date.now() - startTime) / 1000 } };
                        return;
                    }

                    yield { type: 'tool_call', data: { call_id: id, tool: name, args: input } };

                    // Execute locally
                    let result;
                    try {
                        result = await this.toolExecutor.execute(name, input || {});
                    } catch (err) {
                        result = { success: false, output: `Error: ${err.message}` };
                    }

                    yield { type: 'tool_done', data: { tool: name, duration_ms: 0 } };

                    assistantContent.push(block);
                    messages.push({ role: 'assistant', content: assistantContent.slice() });
                    messages.push({
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: id, content: result.output || JSON.stringify(result) }],
                    });
                }
            }

            if (!hasToolUse || stopReason === 'end_turn') {
                const duration = (Date.now() - startTime) / 1000;
                yield { type: 'complete', data: { summary: 'Done (local)', changes: toolCount, duration_s: duration } };
                return;
            }
        }

        yield { type: 'error', data: { message: `Max iterations (${MAX_ITERATIONS}) reached.` } };
        yield { type: 'complete', data: { summary: 'Aborted (max iterations)', changes: toolCount, duration_s: (Date.now() - startTime) / 1000 } };
    }

    async _callLLM(systemPrompt, messages, tools) {
        if (this.apiKey && (this.apiKey.startsWith('sk-ant-') || !this.openRouterKey)) {
            return this._callClaude(systemPrompt, messages, tools);
        }
        if (this.openRouterKey) {
            return this._callOpenRouter(systemPrompt, messages, tools);
        }
        throw new Error('No API key configured. Set ANTHROPIC_API_KEY or configure OpenRouter key.');
    }

    async _callClaude(systemPrompt, messages, tools) {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: this.model,
                system: systemPrompt,
                messages,
                tools: tools.length > 0 ? tools : undefined,
                max_tokens: 8192,
            }),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`Claude API ${resp.status}: ${text.slice(0, 200)}`);
        }
        const data = await resp.json();
        return { content: data.content || [], stopReason: data.stop_reason };
    }

    async _callOpenRouter(systemPrompt, messages, tools) {
        const orMessages = [{ role: 'system', content: systemPrompt }, ...messages];
        const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.openRouterKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: this.model,
                messages: orMessages,
                tools: tools.length > 0 ? tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) : undefined,
            }),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`OpenRouter API ${resp.status}: ${text.slice(0, 200)}`);
        }
        const data = await resp.json();
        const choice = data.choices?.[0];
        const content = [];
        if (choice?.message?.content) content.push({ type: 'text', text: choice.message.content });
        if (choice?.message?.tool_calls) {
            for (const tc of choice.message.tool_calls) {
                content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || '{}') });
            }
        }
        return { content, stopReason: choice?.finish_reason === 'stop' ? 'end_turn' : 'tool_use' };
    }

    _buildToolDefs() {
        const toolNames = this.toolExecutor.listTools();
        return toolNames.map(name => ({
            name,
            description: `Execute the ${name} tool`,
            input_schema: { type: 'object', properties: {}, additionalProperties: true },
        }));
    }

    _buildSystemPrompt(context) {
        const parts = [
            'You are Tarang, an AI coding agent running in local mode.',
            'You have access to tools for reading, writing, and executing code.',
            'Use tools to accomplish the user\'s request. Be concise and direct.',
        ];
        if (context.cwd) parts.push(`Working directory: ${context.cwd}`);
        if (context.gitBranch) parts.push(`Git branch: ${context.gitBranch}`);
        return parts.join('\n');
    }

    cancel() { this._cancelled = true; }
}
