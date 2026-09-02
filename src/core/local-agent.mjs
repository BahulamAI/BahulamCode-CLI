/**
 * Local Agent — T18: Direct LLM API calls, <100ms startup, offline.
 * Replaces the SSE backend for --local mode.
 * Yields events matching the same format as BahulamStreamClient.
 */

import { ContextRetriever } from '../context/retriever.mjs';
import { createStagnationTracker, stagnationMessage } from './stagnation.mjs';
import { PromptCache } from './cache.mjs';
import {
    ANTHROPIC_BETA_HEADER,
    cacheableSystem,
    cacheableTools,
    withMessageBreakpoint,
    needsExplicitCacheControl,
} from './cache-control.mjs';

const MAX_ITERATIONS = 50;

/** Tool schemas for the LLM — proper parameter definitions. */
const TOOL_SCHEMAS = [
    {
        name: 'shell',
        description: 'Run one non-interactive shell command and return stdout/stderr. Command substitution (backticks, $()) is allowed but triggers a user-approval prompt; prefer plain commands when equivalent.',
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The command to execute. Backticks/$() are allowed (user approval required); use them when splitting would be awkward.' },
                timeout: { type: 'number', description: 'Timeout in milliseconds (default: 120000)' },
            },
            required: ['command'],
        },
    },
    {
        name: 'read_file',
        description: 'Read a file and return its contents. Supports line ranges for large files.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file (relative to project root)' },
                offset: { type: 'number', description: 'Start line number (1-based, optional)' },
                limit: { type: 'number', description: 'Number of lines to read (optional)' },
            },
            required: ['file_path'],
        },
    },
    {
        name: 'write_file',
        description: 'Create or overwrite a file with the given content. Parent directories are created automatically.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file (relative to project root)' },
                content: { type: 'string', description: 'The full file content to write' },
            },
            required: ['file_path', 'content'],
        },
    },
    {
        name: 'edit_file',
        description: 'Search for a string in a file and replace it. The search string must match exactly, including whitespace.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file' },
                search: { type: 'string', description: 'Exact string to find in the file' },
                replace: { type: 'string', description: 'Replacement string' },
                replace_all: { type: 'boolean', description: 'Replace every occurrence instead of only the first match' },
            },
            required: ['file_path', 'search', 'replace'],
        },
    },
    {
        name: 'list_files',
        description: 'List files matching a glob pattern, or return a bounded directory tree with format="tree".',
        input_schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Glob pattern (e.g., "src/**/*.ts", "*.json")' },
                path: { type: 'string', description: 'Directory to search in (default: project root)' },
                format: { type: 'string', enum: ['files', 'tree'], description: 'Output format. "files" returns file paths; "tree" returns folders and files.' },
                max_depth: { type: 'number', description: 'Maximum tree depth when format="tree" (default 2, max 6)' },
            },
        },
    },
    {
        name: 'search_code',
        description: 'Search file contents using a regex pattern. Returns matching lines with file paths and line numbers.',
        input_schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Regex pattern to search for' },
                path: { type: 'string', description: 'Directory or file to search in (default: project root)' },
                include: { type: 'string', description: 'File glob filter (e.g., "*.ts")' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'search_files',
        description: 'Search for files by name pattern. Returns matching file paths.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Filename pattern to search for' },
                path: { type: 'string', description: 'Directory to search in (default: project root)' },
            },
            required: ['query'],
        },
    },
    {
        name: 'read_files',
        description: 'Read multiple files at once (batch). More efficient than multiple read_file calls.',
        input_schema: {
            type: 'object',
            properties: {
                file_paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Array of file paths to read',
                },
            },
            required: ['file_paths'],
        },
    },
    {
        name: 'delete_file',
        description: 'Delete a file from the project.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file to delete' },
            },
            required: ['file_path'],
        },
    },
    {
        name: 'get_file_info',
        description: 'Get file metadata: size, modification time, type, permissions.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file' },
            },
            required: ['file_path'],
        },
    },
    {
        name: 'validate_file',
        description: 'Check file syntax. Runs language-specific checks (node --check for JS, py_compile for Python).',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file to validate' },
            },
            required: ['file_path'],
        },
    },
    {
        name: 'validate_build',
        description: 'Run the project build command. Auto-detects: npm run build, make, cargo build, etc.',
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Build command override (optional — auto-detected if omitted)' },
            },
        },
    },
    {
        name: 'lint_check',
        description: 'Run the project-aware linter or syntax checker for a file or directory.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file or directory to lint' },
            },
            required: ['file_path'],
        },
    },
    {
        name: 'validate_structure',
        description: 'Check that a list of expected files exist in the project.',
        input_schema: {
            type: 'object',
            properties: {
                files: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Array of file paths that should exist',
                },
            },
            required: ['files'],
        },
    },
];

export class LocalAgent {
    constructor({
        apiKey,
        model,
        toolExecutor,
        verbose = false,
        openRouterKey = null,
        cwd = null,
        systemPromptOverride = null,
        maxTurns = null,
        stagnationDetection = false,
        stagnationThreshold = 3,
        // Additional tool schemas beyond the built-in set — e.g. plugin
        // tools a sub-agent node declares. Execution still routes through
        // the (scoped) toolExecutor; this only makes the schemas visible
        // to the model.
        extraToolSchemas = [],
    }) {
        this.apiKey = apiKey;
        this.openRouterKey = openRouterKey;
        this.model = model || 'claude-sonnet-4-20250514';
        this.toolExecutor = toolExecutor;
        this.verbose = verbose;
        this.cwd = cwd || process.cwd();
        this.retriever = new ContextRetriever(this.cwd);
        this.systemPromptOverride = systemPromptOverride;
        this.maxTurns = maxTurns || MAX_ITERATIONS;
        this.stagnationDetection = stagnationDetection;
        this.stagnationThreshold = stagnationThreshold;
        this.extraToolSchemas = Array.isArray(extraToolSchemas) ? extraToolSchemas : [];
        this._cancelled = false;
        this.promptCache = new PromptCache();
    }

    async *execute(instruction, context = {}) {
        this._cancelled = false;
        const startTime = Date.now();
        let toolCount = 0;
        const usageTotals = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };

        yield { type: 'status', data: { message: `Local mode: ${this.model}` } };

        // Retrieve relevant code context via BM25 index
        let retrievedContext = [];
        try {
            retrievedContext = this.retriever.retrieve(instruction, 8);
            if (retrievedContext.length > 0) {
                yield { type: 'status', data: { message: `Context: ${retrievedContext.length} relevant chunks from index` } };
            }
        } catch {
            // Index may not exist yet — that's fine, continue without context
        }

        const tools = this._buildToolDefs();
        const systemPrompt = this._buildSystemPrompt(context, retrievedContext);
        const messages = [{ role: 'user', content: instruction }];

        const stagnation = createStagnationTracker({
            enabled: this.stagnationDetection,
            threshold: this.stagnationThreshold,
        });

        for (let i = 0; i < this.maxTurns; i++) {
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

            const { content, stopReason, usage } = response;

            if (usage) {
                this.promptCache.updateStats(usage);
                usageTotals.input_tokens += usage.input_tokens || 0;
                usageTotals.output_tokens += usage.output_tokens || 0;
                usageTotals.cache_read_tokens += usage.cache_read_input_tokens || 0;
                usageTotals.cache_creation_tokens += usage.cache_creation_input_tokens || 0;
            }

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

                    const stagnationResult = stagnation.record(name, input);
                    if (stagnationResult.detected) {
                        const message = stagnationMessage(name, stagnationResult.count);
                        yield { type: 'stagnation', data: { tool: name, count: stagnationResult.count, message } };
                        assistantContent.push(block);
                        messages.push({ role: 'assistant', content: assistantContent.slice() });
                        messages.push({
                            role: 'user',
                            content: [{ type: 'tool_result', tool_use_id: id, content: message }],
                        });
                        continue;
                    }

                    yield { type: 'tool_call', data: { call_id: id, tool: name, args: input } };

                    // Execute locally
                    let result;
                    const toolStart = Date.now();
                    try {
                        result = await this.toolExecutor.execute(name, input || {});
                    } catch (err) {
                        result = { success: false, output: `Error: ${err.message}` };
                    }
                    const durationMs = Date.now() - toolStart;
                    const resultStagnation = stagnation.recordResult(name, input || {}, result);
                    if (resultStagnation.detected) {
                        const message = stagnationMessage(name, resultStagnation.count, resultStagnation);
                        result = {
                            ...result,
                            success: false,
                            output: message,
                            _stagnation: true,
                        };
                        yield {
                            type: 'stagnation',
                            data: {
                                tool: name,
                                count: resultStagnation.count,
                                message,
                                kind: resultStagnation.kind,
                                target: resultStagnation.target,
                            },
                        };
                    }

                    yield {
                        type: 'tool_done',
                        data: {
                            ...result,
                            call_id: id,
                            tool: name,
                            args: input || {},
                            duration_ms: durationMs,
                        },
                    };

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
                yield {
                    type: 'complete',
                    data: {
                        summary: 'Done (local)',
                        changes: toolCount,
                        duration_s: duration,
                        usage: _buildLocalUsageEnvelope(this.model, usageTotals),
                    },
                };
                return;
            }
        }

        yield { type: 'error', data: { message: `Max turns (${this.maxTurns}) reached.` } };
        yield {
            type: 'complete',
            data: {
                summary: 'Aborted (max turns)',
                changes: toolCount,
                duration_s: (Date.now() - startTime) / 1000,
                usage: _buildLocalUsageEnvelope(this.model, usageTotals),
            },
        };
    }

    async _callLLM(systemPrompt, messages, tools) {
        const isClaude = this.model.startsWith('claude') || this.model.startsWith('anthropic/claude');

        // Use Anthropic direct API only for Claude models when we have an Anthropic key
        if (isClaude && this.apiKey && this.apiKey.startsWith('sk-ant-')) {
            return this._callClaude(systemPrompt, messages, tools);
        }

        // Everything else goes through OpenRouter (DeepSeek, GPT, Gemini, or Claude via OR)
        if (this.openRouterKey) {
            return this._callOpenRouter(systemPrompt, messages, tools);
        }

        if (this.apiKey) {
            return this._callClaude(systemPrompt, messages, tools);
        }

        throw new Error('No API key configured. Set ANTHROPIC_API_KEY or configure OpenRouter key.');
    }

    async _callClaude(systemPrompt, messages, tools) {
        // PRD-071 Phase 2 — cache_control breakpoints for Anthropic direct.
        // Extended 1-hour TTL beta on the persistent prefix (system + tools).
        // Message history breakpoint stays at default 5-min TTL.
        const cachedSystem = cacheableSystem(systemPrompt);
        const cachedTools = cacheableTools(tools);
        const cachedMessages = withMessageBreakpoint(messages);

        const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': ANTHROPIC_BETA_HEADER,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: this.model,
                system: cachedSystem,
                messages: cachedMessages,
                tools: cachedTools.length > 0 ? cachedTools : undefined,
                max_tokens: 8192,
            }),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`Claude API ${resp.status}: ${text.slice(0, 200)}`);
        }
        const data = await resp.json();
        return { content: data.content || [], stopReason: data.stop_reason, usage: data.usage || null };
    }

    async _callOpenRouter(systemPrompt, messages, tools) {
        // OpenRouter requires provider prefix (e.g. anthropic/claude-sonnet-4-20250514)
        let model = this.model;
        if (model.startsWith('claude') && !model.includes('/')) {
            model = `anthropic/${model}`;
        }

        // PRD-071 Phase 2 — for anthropic/* models we need explicit cache_control
        // breakpoints (OpenRouter relays them through to Anthropic). OpenAI +
        // DeepSeek auto-cache, so the string system prompt path is fine there.
        const isAnthropic = needsExplicitCacheControl(model);
        const systemForOR = isAnthropic
            ? { role: 'system', content: cacheableSystem(systemPrompt) }
            : { role: 'system', content: systemPrompt };
        const messagesForOR = isAnthropic ? withMessageBreakpoint(messages) : messages;
        const orMessages = [systemForOR, ...messagesForOR];

        // Same tool-schema shape as before, but tag the last tool for Anthropic
        // (OpenRouter passes cache_control on function tools through).
        const orTools = tools.length > 0
            ? tools.map(t => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.input_schema },
            }))
            : [];
        const finalTools = isAnthropic ? cacheableTools(orTools) : orTools;

        const headers = {
            'Authorization': `Bearer ${this.openRouterKey}`,
            'Content-Type': 'application/json',
        };
        // OpenRouter forwards `anthropic-beta` to Anthropic upstreams.
        if (isAnthropic) headers['anthropic-beta'] = ANTHROPIC_BETA_HEADER;

        const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                messages: orMessages,
                tools: finalTools.length > 0 ? finalTools : undefined,
                // Ask OpenRouter to include upstream cache accounting in the
                // usage payload so PromptCache.updateStats() sees real numbers.
                usage: { include: true },
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
        return {
            content,
            stopReason: choice?.finish_reason === 'stop' ? 'end_turn' : 'tool_use',
            usage: _normalizeOpenRouterUsage(data.usage),
        };
    }

    _buildToolDefs() {
        if (!this.extraToolSchemas.length) return TOOL_SCHEMAS;
        const names = new Set(TOOL_SCHEMAS.map(t => t.name));
        const extras = this.extraToolSchemas.filter(t => t?.name && !names.has(t.name));
        return extras.length ? [...TOOL_SCHEMAS, ...extras] : TOOL_SCHEMAS;
    }

    _buildSystemPrompt(context, retrievedContext = null) {
        if (this.systemPromptOverride) {
            return this.systemPromptOverride;
        }

        const parts = [
            'You are Bahulam Code, Bahulam\'s AI coding agent running in local mode.',
            'You have access to tools for reading, writing, and executing code.',
            'Use tools to accomplish the user\'s request. Be concise and direct.',
            'Shell command substitution (backticks, $()) is allowed but requires user approval — use it when it is the natural expression; otherwise prefer plain commands.',
        ];
        if (context.cwd) parts.push(`Working directory: ${context.cwd}`);
        if (context.gitBranch) parts.push(`Git branch: ${context.gitBranch}`);

        if (retrievedContext && retrievedContext.length > 0) {
            parts.push('');
            parts.push('== RELEVANT CODE CONTEXT (from project index) ==');
            for (const chunk of retrievedContext) {
                parts.push(`--- ${chunk.id} (score: ${chunk.score.toFixed(2)}) ---`);
                parts.push(chunk.text);
                parts.push('');
            }
            parts.push('== END CONTEXT ==');
            parts.push('');
            parts.push('Use the above context to understand the codebase. Read full files with read_file when you need more detail.');
        }

        return parts.join('\n');
    }

    cancel() { this._cancelled = true; }
}

// Shape the accumulated per-turn totals into the same envelope the remote
// SSE `complete` event uses, so repl.mjs:837 can consume both modes with the
// same code path. `models[0].role = 'local'` distinguishes single-agent
// local mode from remote's Coder/Explorer/Planner breakdown.
function _buildLocalUsageEnvelope(model, totals) {
    return {
        total_input_tokens: totals.input_tokens,
        total_output_tokens: totals.output_tokens,
        models: [{
            model,
            role: 'local',
            input_tokens: totals.input_tokens,
            output_tokens: totals.output_tokens,
            cache_read_tokens: totals.cache_read_tokens,
            cache_creation_tokens: totals.cache_creation_tokens,
        }],
    };
}

// Normalize OpenRouter usage into Anthropic's field names so downstream
// consumers (PromptCache, pricing.calculateCost) don't branch on shape.
// OpenRouter returns OpenAI-style: prompt_tokens, completion_tokens,
// prompt_tokens_details.cached_tokens. When the underlying model is
// Anthropic, OpenRouter also relays cache_read_input_tokens verbatim.
function _normalizeOpenRouterUsage(usage) {
    if (!usage) return null;
    const cachedFromOpenAI = usage.prompt_tokens_details?.cached_tokens || 0;
    return {
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || cachedFromOpenAI || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    };
}
