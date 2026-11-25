import { CLI_INFO_SCHEMA, CLI_INFO_PROMPT } from './cli-info.mjs';
/**
 * Local Agent — CLI-side orchestration for --local mode.
 * Model calls use the shared Bahulam Gateway; tools and the ReAct loop stay local.
 * Yields events matching the same format as BahulamStreamClient.
 */

import { attachHandoff, codingHandoff } from './coding-handoff.mjs';
import { QueryCodeGraphTool } from '../tools/query-code-graph.mjs';
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
import { DEFAULT_REASONING_MODEL } from '../config/model-defaults.mjs';
import {
    SUMMARY_MARKER,
    DISTILLATION_MARKER,
    distillMessages,
    contextProduct,
    contextReductionConfig,
    collapseMessages,
    reductionBoundary,
    estimateMessagesTokens,
    resolveContextBudget,
} from './context-reduction.mjs';
import { providerErrorMessage, gatewayFailure, completionFailure } from './provider-error.mjs';
import { normalizeUsage } from './usage-normalization.mjs';
import { fetchWithRetry, RequestError, requestErrorData } from './request-retry.mjs';

// Single source of truth for the agent-loop turn cap. Previously duplicated
// as a hardcoded 50 in headless.mjs (x2) and repl.mjs, independently of this
// constant and of each other — a config drift hazard, and a hard ceiling
// autonomous/headless callers had no way to raise for problems that need
// more exploration than 50 turns. BAHULAM_MAX_TURNS overrides it for every
// caller (headless, REPL, orchestration) since LocalAgent.maxTurns falls
// back to this constant whenever a caller doesn't pass its own value.
//
// Default raised 50 -> 999 (2026-11-20): on a hard SWE-bench Verified
// instance (pydata__xarray-6992, >4h difficulty, unresolved by every model
// in our Aug 2026 baseline including the 67.8%-overall champion), three
// different candidate models each produced a genuinely correct fix once
// given room to finish — one had been cut off mid-fix with a wrong patch
// at exactly turn 50. 999 is "effectively no cap" while still bounding a
// runaway loop; --timeout / BAHULAM_MAX_TURNS remain the real backstops.
const MAX_ITERATIONS = (() => {
    const envValue = Number(process.env.BAHULAM_MAX_TURNS);
    return Number.isFinite(envValue) && envValue > 0 ? envValue : 999;
})();

function toOpenAITool(tool) {
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || { type: 'object', properties: {} },
        },
    };
}

export function toOpenAIMessage(message) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
        const text = message.content
            .filter(block => block.type === 'text')
            .map(block => block.text || '')
            .join('');
        const toolCalls = message.content
            .filter(block => block.type === 'tool_use')
            .map(block => ({
                id: block.id,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input || {}),
                },
            }));
        return {
            role: 'assistant',
            content: text || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        };
    }

    if (message.role === 'user' && Array.isArray(message.content)) {
        const results = message.content.filter(block => block.type === 'tool_result');
        if (results.length > 0) {
            // OpenAI-compatible APIs require one role=tool message per result.
            // The caller expands this marker in _callGateway below.
            return results.map(block => ({
                role: 'tool',
                tool_call_id: block.tool_use_id,
                content: String(block.content || ''),
            }));
        }
    }

    if (message.role === 'tool' && message.tool_call_id) return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content };
    if (message.role === 'assistant' && message.tool_calls) return { role: 'assistant', tool_calls: message.tool_calls, content: message.content };
    return { role: message.role, content: message.content };
}

// Used only for older history submitted to the summarizer. Live results stay intact.
function summaryExcerpt(text) {
    if (text.length <= 8000) return text;
    const middle = text.slice(3000, -3000);
    const signals = [];
    for (const match of middle.matchAll(/^.*\b(?:error|failed|exception|panic|assertionerror|warning)\b.*$/gim)) {
        signals.push(match[0].slice(0, 300));
        if (signals.length === 6) break;
    }
    return [text.slice(0, 3000), '[… excerpt of older history …]', ...signals, text.slice(-3000)].join('\n');
}

/** Tool schemas for the LLM — proper parameter definitions. */
const TOOL_SCHEMAS = [
    CLI_INFO_SCHEMA,
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
                project_id: { type: 'string', description: 'Registered project for relative paths' },
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
                project_id: { type: 'string', description: 'Registered project for relative paths' },
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
                project_id: { type: 'string', description: 'Registered project for relative paths' },
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
                project_id: { type: 'string', description: 'Registered project for relative paths' },
                pattern: { type: 'string', description: 'Glob pattern (e.g., "src/**/*.ts", "*.json")' },
                path: { type: 'string', description: 'Directory to search in (default: project root)' },
                format: { type: 'string', enum: ['files', 'tree'], description: 'Output format. "files" returns file paths; "tree" returns folders and files.' },
                max_depth: { type: 'number', description: 'Maximum tree depth when format="tree" (default 2, max 6)' },
            },
        },
    },
    {
        name: QueryCodeGraphTool.name,
        description: QueryCodeGraphTool.description,
        input_schema: QueryCodeGraphTool.inputSchema,
    },
    {
        name: 'get_project_overview',
        description: 'Register a project root and obtain its project_id for indexed queries.',
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    {
        name: 'search_code',
        description: 'Discover relevant code using text, symbols and BM25-ranked snippets.',
        input_schema: {
            type: 'object',
            properties: {
                project_id: { type: 'string', description: 'Registered project for relative paths' },
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
                project_id: { type: 'string', description: 'Registered project for relative paths' },
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
                project_id: { type: 'string', description: 'Registered project for relative paths' },
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
                project_id: { type: 'string', description: 'Registered project for relative paths' },
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
    {
        name: 'skill_view',
        description: 'Read a discovered skill or one of its bundled resources.',
        input_schema: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' } }, required: ['name'] },
    },
];

export class LocalAgent {
    constructor({
        apiKey,
        model,
        toolExecutor,
        verbose = false,
        openRouterKey = null,
        gatewayUrl = null,
        gatewayToken = null,
        product = 'bahulam',
        sessionId = null,
        executionId = null,
        approvalManager = null,
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
        summarizerModel = null,
    }) {
        this.apiKey = apiKey;
        this.openRouterKey = openRouterKey;
        this.gatewayUrl = (gatewayUrl || '').replace(/\/+$/, '');
        this.gatewayToken = gatewayToken;
        this.product = product;
        this.sessionId = sessionId;
        this.executionId = executionId;
        this.approvalManager = approvalManager;
        this.model = model || DEFAULT_REASONING_MODEL;
        this.toolExecutor = toolExecutor;
        this.verbose = verbose;
        this.cwd = cwd || process.cwd();
        this.retriever = new ContextRetriever(this.cwd);
        this.systemPromptOverride = systemPromptOverride;
        this.maxTurns = maxTurns || MAX_ITERATIONS;
        this.stagnationDetection = stagnationDetection;
        this.stagnationThreshold = stagnationThreshold;
        this.extraToolSchemas = Array.isArray(extraToolSchemas) ? extraToolSchemas : [];
        this.summarizerModel = summarizerModel || process.env.BAHULAM_SUMMARIZE_MODEL || process.env.BAHULAM_CHAT_SUMMARIZER_MODEL || this.model;
        this._cancelled = false;
        this._requestSequence = 0;
        this._pendingInterventions = [];
        this._deliveredInterventionIds = new Set();
        this._executing = false;
        this.promptCache = new PromptCache();
    }

    async *execute(instruction, context = {}, priorHistory = []) {
        this._executing = true;
        try { yield* this._executeTurn(instruction, context, priorHistory); }
        finally { this._executing = false; }
    }

    async *_executeTurn(instruction, context, priorHistory) {
        this._cancelled = false;
        const startTime = Date.now();
        let toolCount = 0;
        const usageTotals = { input_tokens: 0, output_tokens: 0, byModel: new Map() };
        const addUsage = (model, usage) => {
            this.promptCache.updateStats(usage);
            const row = usageTotals.byModel.get(model) || {
                model, role: model === this.model ? 'local' : 'summarizer',
                input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost: 0,
            };
            row.input_tokens += usage.input_tokens || 0;
            row.output_tokens += usage.output_tokens || 0;
            row.cache_read_tokens += usage.cache_read_input_tokens || 0;
            row.cache_creation_tokens += usage.cache_creation_input_tokens || 0;
            if (Number.isFinite(usage.cost) && Number.isFinite(row.cost)) row.cost += usage.cost;
            else delete row.cost;
            usageTotals.byModel.set(model, row);
            usageTotals.input_tokens += usage.input_tokens || 0;
            usageTotals.output_tokens += usage.output_tokens || 0;
        };

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
        // Keep the same turn contract as BahulamStreamClient. The REPL owns
        // the canonical agent history and passes it here when the npm-owned
        // local/direct transports are selected.
        const messages = Array.isArray(priorHistory)
            ? priorHistory.map(message => ({ ...message }))
            : [];
        const lastMessage = messages[messages.length - 1];
        if (lastMessage?.role !== 'user' || lastMessage.content !== instruction) {
            messages.push({ role: 'user', content: instruction });
        }

        const applyReduction = (reduction) => {
            messages.splice(0, messages.length, ...reduction.messages);
            if (Array.isArray(priorHistory)) {
                priorHistory.splice(0, priorHistory.length, ...reduction.messages);
            }
            if (reduction.usage) {
                addUsage(this.summarizerModel || this.model, reduction.usage);
            }
        };

        const stagnation = createStagnationTracker({
            enabled: this.stagnationDetection,
            threshold: this.stagnationThreshold,
        });

        for (let i = 0; i < this.maxTurns; i++) {
            if (this._cancelled) {
                yield { type: 'cancelled', data: { reason: 'User cancelled' } };
                return;
            }

            // Match the remote live-steering contract. The REPL may submit a
            // follow-up while a local model/tool call is in flight; apply it
            // at the next safe model boundary and retain it in canonical
            // agent history for the following turn.
            const interventions = this._pendingInterventions.splice(0);
            for (const intervention of interventions) {
                const message = { role: 'user', content: intervention.instruction };
                messages.push(message);
                this._deliveredInterventionIds.add(intervention.interventionId);
                yield {
                    type: 'user_intervention_delivered',
                    data: {
                        intervention_id: intervention.interventionId,
                        delivered_at_tool: null,
                    },
                };
            }

            const phase = i === 0 ? 'pre_turn' : 'mid_turn';
            const reduction = yield* this._reduceContext(messages, { systemPrompt, tools, phase });
            if (reduction?.error) {
                yield { type: 'error', data: { message: reduction.error } };
                return;
            }
            if (reduction) {
                applyReduction(reduction);
                yield { type: 'summarize', data: reduction.event };
            }
            if (this._cancelled) {
                yield { type: 'cancelled', data: { reason: 'User cancelled' } };
                return;
            }

            let response;
            try {
                response = await this._callLLM(systemPrompt, messages, tools);
            } catch (err) {
                const errorData = requestErrorData(err, {
                    phase: this.gatewayUrl ? 'gateway' : 'provider',
                    provider: this.gatewayUrl ? 'bahulam-gateway' : 'direct-provider',
                });
                yield {
                    type: 'error',
                    data: {
                        ...errorData,
                        message: errorData.message,
                        fatal: true,
                    },
                };
                return;
            }

            const { content, stopReason, usage } = response;

            if (usage) {
                usageTotals.lastRequestInput = usage.input_tokens;
                addUsage(this.model, usage);
            }

            // Process content blocks
            let hasToolUse = false;
            const assistantContent = [];
            const toolResults = [];

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
                        toolResults.push({ tool_use_id: id, content: message });
                        continue;
                    }

                    yield { type: 'tool_call', data: { call_id: id, tool: name, args: input } };

                    // Execute locally
                    let result;
                    const toolStart = Date.now();
                    try {
                        const approval = this.approvalManager
                            ? await this.approvalManager.check(name, input || {}, false, { source: 'local-agent' })
                            : { approved: true };
                        result = approval?.approved
                            ? await this.toolExecutor.execute(name, input || {})
                            : { success: false, output: `Tool call not approved: ${approval?.reason || name}` };
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
                    toolResults.push({
                        tool_use_id: id,
                        content: result.output || JSON.stringify(result),
                        ...(result.success === false ? { is_error: true } : {}),
                    });
                }
            }

            // Keep one provider-shaped assistant turn for the complete tool batch.
            // Appending the cumulative assistant content once per tool duplicates
            // earlier tool calls and makes the next request grow quadratically.
            if (assistantContent.length) {
                messages.push({ role: 'assistant', content: assistantContent.slice() });
            }
            if (hasToolUse) {
                for (const result of toolResults) {
                    messages.push({
                        role: 'user',
                        content: [{ type: 'tool_result', ...result }],
                    });
                }
            }

            if ((!hasToolUse || stopReason === 'end_turn') && this._pendingInterventions.length === 0) {
                this._executing = false; // A submission during the complete yield belongs to the next turn.
                const duration = (Date.now() - startTime) / 1000;
                yield {
                    type: 'complete',
                    data: {
                        summary: 'Done (local)',
                        changes: toolCount,
                        turns: i + 1,
                        duration_s: duration,
                        usage: _buildLocalUsageEnvelope(usageTotals),
                    },
                };
                return;
            }
        }

        this._executing = false;
        yield { type: 'error', data: { message: `Max turns (${this.maxTurns}) reached.` } };
        yield {
            type: 'complete',
            data: {
                summary: 'Aborted (max turns)',
                changes: toolCount,
                turns: this.maxTurns,
                duration_s: (Date.now() - startTime) / 1000,
                usage: _buildLocalUsageEnvelope(usageTotals),
            },
        };
    }

    async _callLLM(systemPrompt, messages, tools, modelOverride = this.model) {
        // Local orchestration still uses the shared Bahulam Gateway for model
        // access. The gateway resolves identity, credits/BYOK, and provider
        // routing; this process owns the ReAct/tool loop.
        if (this.gatewayUrl && this.gatewayToken) {
            return this._callGateway(systemPrompt, messages, tools, modelOverride);
        }

        const isClaude = this.model.startsWith('claude') || this.model.startsWith('anthropic/claude');

        // Use Anthropic direct API only for Claude models when we have an Anthropic key
        if (isClaude && this.apiKey && this.apiKey.startsWith('sk-ant-')) {
            return this._callClaude(systemPrompt, messages, tools, modelOverride);
        }

        // Everything else goes through OpenRouter (DeepSeek, GPT, Gemini, or Claude via OR)
        if (this.openRouterKey) {
            return this._callOpenRouter(systemPrompt, messages, tools, modelOverride);
        }

        if (this.apiKey) {
            return this._callClaude(systemPrompt, messages, tools, modelOverride);
        }

        throw new Error('No API key configured. Set ANTHROPIC_API_KEY or configure OpenRouter key.');
    }

    async _callGateway(systemPrompt, messages, tools, modelOverride = this.model) {
        const base = this.gatewayUrl.endsWith('/v1')
            ? this.gatewayUrl
            : `${this.gatewayUrl}/v1`;
        const headers = {
            Authorization: `Bearer ${this.gatewayToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Product': this.product,
            'X-Bahulam-Request-ID': this._nextRequestId(),
            'X-Bahulam-Op-Class': 'coding',
        };
        if (this.sessionId) headers['X-Bahulam-Session-ID'] = this.sessionId;
        if (this.executionId) headers['X-Bahulam-Execution-ID'] = this.executionId;

        const body = {
            model: modelOverride,
            messages: [
                { role: 'system', content: systemPrompt },
                ...messages.flatMap(toOpenAIMessage),
            ],
            tools: tools.length > 0 ? tools.map(toOpenAITool) : undefined,
            stream: false,
        };
        const resp = await fetchWithRetry(`${base}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            const failure = gatewayFailure(resp.status, text);
            throw new RequestError(failure.message, {
                status: resp.status,
                code: failure.code,
                retryable: false,
            });
        }

        const data = await resp.json();
        const failure = completionFailure(data);
        if (failure) throw new RequestError(failure.message, { status: failure.status });
        const message = data.choices?.[0]?.message || {};
        const content = [];
        if (message.content) content.push({ type: 'text', text: message.content });
        for (const call of message.tool_calls || []) {
            const fn = call.function || {};
            let input = {};
            try { input = fn.arguments ? JSON.parse(fn.arguments) : {}; } catch {}
            content.push({
                type: 'tool_use',
                id: call.id,
                name: fn.name,
                input,
            });
        }
        return {
            content,
            stopReason: data.choices?.[0]?.finish_reason || null,
            usage: normalizeUsage(data.usage),
        };
    }

    async _callClaude(systemPrompt, messages, tools, modelOverride = this.model) {
        // PRD-071 Phase 2 — cache_control breakpoints for Anthropic direct.
        // Extended 1-hour TTL beta on the persistent prefix (system + tools).
        // Message history breakpoint stays at default 5-min TTL.
        const cachedSystem = cacheableSystem(systemPrompt);
        const cachedTools = cacheableTools(tools);
        const cachedMessages = withMessageBreakpoint(messages);

        const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': ANTHROPIC_BETA_HEADER,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: modelOverride,
                system: cachedSystem,
                messages: cachedMessages,
                tools: cachedTools.length > 0 ? cachedTools : undefined,
                max_tokens: 8192,
            }),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new RequestError(providerErrorMessage(resp.status, text), {
                status: resp.status,
                code: `anthropic_http_${resp.status}`,
                retryable: false,
            });
        }
        const data = await resp.json();
        return { content: data.content || [], stopReason: data.stop_reason, usage: data.usage || null };
    }

    async _callOpenRouter(systemPrompt, messages, tools, modelOverride = this.model) {
        // OpenRouter requires provider prefix (e.g. anthropic/claude-sonnet-4-20250514)
        let model = modelOverride;
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
            'X-Request-ID': this._nextRequestId(),
        };
        // OpenRouter forwards `anthropic-beta` to Anthropic upstreams.
        if (isAnthropic) headers['anthropic-beta'] = ANTHROPIC_BETA_HEADER;

        const resp = await fetchWithRetry('https://openrouter.ai/api/v1/chat/completions', {
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
            throw new RequestError(providerErrorMessage(resp.status, text), {
                status: resp.status,
                code: `openrouter_http_${resp.status}`,
                retryable: false,
            });
        }
        const data = await resp.json();
        const failure = completionFailure(data);
        if (failure) throw new RequestError(failure.message, { status: failure.status });
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
            usage: normalizeUsage(data.usage),
        };
    }

    _nextRequestId() {
        this._requestSequence += 1;
        return `npm-${this.sessionId || 'local'}-${Date.now()}-${this._requestSequence}`.slice(0, 256);
    }

    async *_reduceContext(messages, { systemPrompt = '', tools = [], phase = 'pre_turn' } = {}) {
        const config = contextReductionConfig(process.env, this.product);
        const fixedPromptTokens = estimateMessagesTokens([
            { role: 'system', content: systemPrompt },
            { role: 'system', content: tools },
        ]);
        const budget = resolveContextBudget({
            product: this.product,
            model: this.model,
            fixedPromptTokens,
            explicitThreshold: config.threshold,
        });
        const preserve = config.preserve || budget.preserve;
        const estimated = estimateMessagesTokens(messages);
        if (!config.enabled || !budget.threshold || estimated <= budget.threshold) {
            return null;
        }

        const split = reductionBoundary(messages, preserve, budget.threshold / 2);
        const capacity = contextProduct(this.product) === 'ide' ? budget.usableTokens : null;
        const capacityError = {error: 'The task and retained evidence exceed this model’s available context. Your transcript is preserved. Resume with a larger-context model or start a narrower task.'};
        if (!split) return capacity && estimated > capacity ? capacityError : null;
        const progress = { phase, before_tokens: estimated, threshold: budget.threshold, collapsed_messages: split };
        const handoff = contextProduct(this.product) === 'ide' ? codingHandoff(messages, split) : null;
        if (handoff && (!capacity || estimated <= capacity)) {
            const floor = collapseMessages(messages, attachHandoff('', handoff.state), messages.length - split);
            floor.splice(2, 0, ...handoff.protectedRows);
            const minimum = estimateMessagesTokens(floor);
            if (minimum >= budget.threshold && estimated - minimum <= 1200) return null;
        }
        yield { type: 'summarize_progress', data: { ...progress, state: 'started' } };
        const source = handoff?.older ?? messages.slice(0, split);
        let summary = null;
        let summaryUsage = null;
        let appliedStrategy = config.strategy;
        const prompt = config.strategy === 'distillation'
            ? 'You are the Bahulam coding-context distiller. Summarize the middle of the earlier conversation while preserving exact active ingredients: user intent, decisions, file paths, edits, commands, test results, errors, constraints, and unfinished work. Include the recorded rationale for decisions, alternatives ruled out, the action in progress and the next concrete step. Keep it concise. Do not invent facts.'
            : 'You are the Bahulam context summarizer. Summarize the earlier conversation for another coding-agent turn. Preserve user intent, decisions, files changed, commands/results, errors, constraints, and unfinished work. Do not invent facts. Return concise plain text only.';
        const transcript = source.map(message => {
            const content = Array.isArray(message.content) ? message.content.map(block => {
                if (block.type === 'tool_result') {
                    const body = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
                    return `[Tool result ${block.tool_use_id}]\n${summaryExcerpt(body)}`;
                }
                return block.type === 'text' ? block.text : JSON.stringify(block);
            }).join('\n') : String(message.content || '');
            return { role: message.role, content: summaryExcerpt(content) };
        });
        try {
            const response = await this._callLLM(
                prompt,
                [{ role: 'user', content: JSON.stringify(transcript) }],
                [],
                this.summarizerModel,
            );
            summaryUsage = response.usage || null;
            summary = response.content
                ?.filter(block => block.type === 'text')
                .map(block => block.text || '')
                .join('\n')
                .trim() || null;
        } catch (error) {
            // Match the backend's fail-open behavior: a failed reduction
            // must never prevent the actual user turn from running.
            appliedStrategy = 'summarization_failed';
            if (this.verbose) process.stderr.write(`[context] summarization skipped: ${error.message}\n`);
        }
        if (!summary && !this._cancelled && capacity && estimated > capacity) {
            summary = distillMessages(source);
            appliedStrategy = 'local_distillation';
        }
        if (!summary || this._cancelled) {
            yield { type: 'summarize_progress', data: { ...progress, state: this._cancelled ? 'cancelled' : 'skipped' } };
            return null;
        }
        if (!summary.startsWith(SUMMARY_MARKER) && !summary.startsWith(DISTILLATION_MARKER)) {
            summary = `${config.strategy === 'distillation' ? DISTILLATION_MARKER : SUMMARY_MARKER}\n${summary}`;
        }
        const checkpoint = handoff ? attachHandoff(summary, handoff.state) : summary;
        const reduced = collapseMessages(messages, checkpoint, messages.length - split);
        if (handoff) reduced.splice(2, 0, ...handoff.protectedRows);
        const after = estimateMessagesTokens(reduced);
        if (capacity && after > capacity) return capacityError;
        if (after >= estimated) {
            yield { type: 'summarize_progress', data: { ...progress, state: 'skipped' } };
            return null;
        }
        return {
            messages: reduced,
            event: {
                phase,
                strategy: appliedStrategy,
                collapsed_messages: source.length,
                kept_recent: messages.length - split,
                before_tokens: estimated,
                threshold: budget.threshold,
                budget_source: budget.source,
                context_length: budget.contextLength || null,
                target_tokens: budget.targetTokens || null,
                source: this.gatewayUrl ? 'gateway' : 'provider',
                summary_preview: summary.replace(/^\[[^\]]+\]\s*/, '').split('\n', 1)[0].slice(0, 120),
                summary_usage: summaryUsage,
            },
            usage: summaryUsage,
        };
    }

    _buildToolDefs() {
        if (!this.extraToolSchemas.length) return TOOL_SCHEMAS;
        // Dedupe extras against the core schemas AND against each other —
        // not just against the core 16. With enough plugins registered
        // (this isn't rare: research/azure/browser/render/document-authoring
        // plugins all ship their own tool sets), two different plugins can
        // easily register the same name (e.g. two document-authoring
        // plugins both defining create_document/get_document/ingest_pdf).
        // Providers mostly tolerate a duplicate name silently; Claude does
        // not — it rejects the whole request with "tools: Tool names must
        // be unique", which only ever showed up for Claude models and
        // looked like a provider-specific quirk until traced to this.
        const names = new Set(TOOL_SCHEMAS.map(t => t.name));
        const extras = [];
        for (const t of this.extraToolSchemas) {
            if (!t?.name || names.has(t.name)) continue;
            names.add(t.name);
            extras.push(t);
        }
        return extras.length ? [...TOOL_SCHEMAS, ...extras] : TOOL_SCHEMAS;
    }

    _buildSystemPrompt(context, retrievedContext = null) {
        if (this.systemPromptOverride) {
            return [this.systemPromptOverride, CLI_INFO_PROMPT, context.project_context?.prompt_block].filter(Boolean).join('\n\n');
        }

        const parts = [
            CLI_INFO_PROMPT,
            'You are Bahulam Code, Bahulam\'s AI coding agent running in local mode.',
            'You have access to tools for reading, writing, and executing code.',
            'Use search_code for discovery. For a known file, use query_code_graph with its registered project_id to inspect imports, find importers, resolve a module specifier or trace a dependency path. Cite the source file and line of resolved edges.',
            'Use project-relative paths for file and search tools. Pass project_id when multiple roots are registered.',
            'Use tools to accomplish the user\'s request. Be concise and direct.',
            'Shell command substitution (backticks, $()) is allowed but requires user approval — use it when it is the natural expression; otherwise prefer plain commands.',
        ];
        if (context.cwd) parts.push(`Working directory: ${context.cwd}`);
        if (context.project_context?.prompt_block) parts.push(context.project_context.prompt_block);
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
            parts.push('Use the above context to understand the codebase. Use read_file for exact source.');
        }

        return parts.join('\n');
    }

    cancel() { this._cancelled = true; }

    /** Queue a live follow-up for the next local model boundary. */
    sendIntervention(instruction, { idempotencyKey = null } = {}) {
        const text = String(instruction || '').trim();
        if (!text) return Promise.resolve({ status: 'error', error: 'instruction is empty' });
        const interventionId = idempotencyKey || this._nextRequestId();
        if (this._deliveredInterventionIds.has(interventionId)) return Promise.resolve({ status: 'delivered', interventionId });
        if (!this._executing || this._cancelled) return Promise.resolve({ status: 'queued_next_turn', interventionId });
        if (this._pendingInterventions.some(item => item.interventionId === interventionId)) {
            return Promise.resolve({ status: 'duplicate', interventionId });
        }
        this._pendingInterventions.push({ instruction: text, interventionId });
        return Promise.resolve({ status: 'accepted', interventionId });
    }
}

// Match the remote completion event and preserve separate model costs for summarization.
function _buildLocalUsageEnvelope(totals) {
    const models = [...totals.byModel.values()];
    return {
        total_input_tokens: totals.input_tokens,
        last_request_input_tokens: totals.lastRequestInput,
        total_output_tokens: totals.output_tokens,
        models,
        ...(models.length && models.every(row => Number.isFinite(row.cost))
            ? { total_cost: models.reduce((sum, row) => sum + row.cost, 0) } : {}),
    };
}
