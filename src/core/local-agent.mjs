/**
 * Local Agent — T18: Direct LLM API calls, <100ms startup, offline.
 * Replaces the SSE backend for --local mode.
 * Yields events matching the same format as TarangStreamClient.
 */

import { ContextRetriever } from '../context/retriever.mjs';

const MAX_ITERATIONS = 50;
const STAGNATION_THRESHOLD = 3;

/** Tool schemas for the LLM — proper parameter definitions. */
const TOOL_SCHEMAS = [
    {
        name: 'shell',
        description: 'Run a shell command and return stdout/stderr. Use for: installing packages, running tests, builds, git operations, or any terminal command.',
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The shell command to execute' },
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
        description: 'Search for a string in a file and replace it. The old_string must match exactly (including whitespace).',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file' },
                old_string: { type: 'string', description: 'Exact string to find in the file' },
                new_string: { type: 'string', description: 'Replacement string' },
            },
            required: ['file_path', 'old_string', 'new_string'],
        },
    },
    {
        name: 'list_files',
        description: 'List files matching a glob pattern. Returns file paths relative to project root.',
        input_schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Glob pattern (e.g., "src/**/*.ts", "*.json")' },
                path: { type: 'string', description: 'Directory to search in (default: project root)' },
            },
            required: ['pattern'],
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
        description: 'Run linter on a file. Uses ruff for Python, eslint for JS/TS.',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file to lint' },
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
    constructor({ apiKey, model, toolExecutor, verbose = false, openRouterKey = null, cwd = null, systemPromptOverride = null, maxTurns = null }) {
        this.apiKey = apiKey;
        this.openRouterKey = openRouterKey;
        this.model = model || 'claude-sonnet-4-20250514';
        this.toolExecutor = toolExecutor;
        this.verbose = verbose;
        this.cwd = cwd || process.cwd();
        this.retriever = new ContextRetriever(this.cwd);
        this.systemPromptOverride = systemPromptOverride;
        this.maxTurns = maxTurns || MAX_ITERATIONS;
        this._cancelled = false;
    }

    async *execute(instruction, context = {}) {
        this._cancelled = false;
        const startTime = Date.now();
        let toolCount = 0;

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

        const recentCalls = []; // for stagnation detection

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

        yield { type: 'error', data: { message: `Max turns (${this.maxTurns}) reached.` } };
        yield { type: 'complete', data: { summary: 'Aborted (max turns)', changes: toolCount, duration_s: (Date.now() - startTime) / 1000 } };
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
        return TOOL_SCHEMAS;
    }

    _buildSystemPrompt(context, retrievedContext = null) {
        if (this.systemPromptOverride) {
            return this.systemPromptOverride;
        }

        const parts = [
            'You are Tarang, an AI coding agent running in local mode.',
            'You have access to tools for reading, writing, and executing code.',
            'Use tools to accomplish the user\'s request. Be concise and direct.',
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
