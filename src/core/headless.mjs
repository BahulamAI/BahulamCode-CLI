/**
 * Headless Runner — non-interactive mode for benchmarks and automation.
 *
 * No REPL, no spinners, no approval prompts. Auto-approves all tools.
 * Outputs structured JSONL to stdout for machine consumption.
 * stderr gets minimal progress (optional with --verbose).
 *
 * Usage:
 *   kepler --headless "Fix the bug in auth.py"
 *   kepler --headless --timeout 300 --max-cost 2.00 "Refactor the login flow"
 *   kepler --headless --model deepseek/deepseek-chat-v3-0324 "Add tests"
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TarangStreamClient } from './stream-client.mjs';
import { createToolExecutor } from './tool-executor.mjs';
import { TarangAuth } from '../auth/tarang-auth.mjs';
import { ApprovalManager } from './approval.mjs';

/**
 * Run a single instruction in headless mode.
 * @param {object} opts
 * @param {string} opts.instruction - the prompt to send
 * @param {string} [opts.model] - model override
 * @param {number} [opts.timeout] - max seconds (default: 300)
 * @param {number} [opts.maxCost] - abort if cost exceeds this USD amount
 * @param {boolean} [opts.verbose] - show progress on stderr
 */
export async function runHeadless({ instruction, model, timeout = 300, maxCost, verbose = false }) {
    const startTime = Date.now();

    const log = (msg) => {
        if (verbose) process.stderr.write(`[headless] ${msg}\n`);
    };

    const emit = (obj) => {
        process.stdout.write(JSON.stringify(obj) + '\n');
    };

    // ── Auth ──
    const auth = new TarangAuth();
    const creds = auth.loadCredentials();
    if (!creds.token) {
        emit({ type: 'error', error: 'Not logged in. Run: kepler login' });
        process.exit(1);
    }

    // Projects are registered and indexed only when the agent requests an overview.
    const toolExecutor = createToolExecutor();

    // Auto-approve everything — no prompts
    const approval = new ApprovalManager({ autoApprove: true });

    // ── Stream client ──
    const client = new TarangStreamClient({
        baseUrl: creds.backendUrl,
        token: creds.token,
        toolExecutor,
        approvalManager: approval,
    });

    // ── Timeout ──
    const timeoutMs = timeout * 1000;
    const timeoutTimer = setTimeout(() => {
        emit({ type: 'timeout', duration_s: timeout });
        log(`Timeout after ${timeout}s`);
        process.exit(2);
    }, timeoutMs);

    // ── Execute ──
    emit({ type: 'start', timestamp: Date.now(), instruction, model: model || 'default', cwd: process.cwd() });

    // Load global agent context (~/.kepler/identity.md, preferences.md, skills/)
    const { ProjectRegistry } = await import('../tools/project-overview.mjs');
    const globalCtx = new ProjectRegistry().getGlobalContext();

    const execContext = {
        cwd: process.cwd(),
        freeswim: true,
        project_resources: toolExecutor.getProjectResources(),
        agent_context: {
            identity: globalCtx.identity,
            preferences: globalCtx.preferences,
            global_skills: globalCtx.skills,
            source: 'cli',
        },
    };
    if (model) execContext.model_override = model;

    let toolCount = 0;
    let finalContent = '';
    let totalCost = 0;

    // ── Telemetry collectors ──
    const toolCalls = [];       // { tool, duration_ms, success }
    const subAgents = [];       // { type, model, duration_s, tool_calls, success }
    let stagnationCount = 0;
    let usage = {};             // { input_tokens, output_tokens, cache_read, cache_write }

    try {
        for await (const event of client.execute(instruction, execContext)) {
            const { type, data } = event;

            if (type === 'tool_call' || type === 'tool_request') {
                toolCount++;
                const toolName = data?.tool || 'unknown';
                const args = data?.args || {};
                toolCalls.push({ tool: toolName, success: null, duration_ms: 0 });
                emit({ type: 'tool_call', tool: toolName, args, approved: true });
                log(`Tool: ${toolName}`);
            }

            if (type === 'tool_result' || type === 'tool_done') {
                const success = data?.success !== false;
                const duration = data?.duration_s || 0;
                // Update last tool call with result
                const last = toolCalls.findLast(t => t.tool === (data?.tool || ''));
                if (last) { last.success = success; last.duration_ms = Math.round(duration * 1000); }
                emit({ type: 'tool_result', tool: data?.tool || '', success, duration_ms: Math.round(duration * 1000) });
            }

            if (type === 'sub_agent_start') {
                log(`SubAgent: ${data?.type} (${data?.model})`);
            }

            if (type === 'sub_agent_complete') {
                subAgents.push({
                    type: data?.type || '',
                    model: data?.model || '',
                    duration_s: data?.duration_s || 0,
                    tool_calls: data?.tool_calls || 0,
                    success: data?.success !== false,
                });
                emit({ type: 'sub_agent', ...data });
                log(`SubAgent done: ${data?.type} (${data?.tool_calls} tools, ${data?.duration_s}s)`);
            }

            if (type === 'plan_created') {
                // Plan pinning (PRD-053): persist plan to .kepler/plan.md (auto-approved in headless)
                const planText = data?.plan || '';
                if (planText) {
                    try {
                        const keplerDir = path.join(process.cwd(), '.kepler');
                        fs.mkdirSync(keplerDir, { recursive: true });
                        fs.writeFileSync(path.join(keplerDir, 'plan.md'), planText, 'utf-8');
                        log('Plan saved → .kepler/plan.md');
                    } catch { /* non-fatal */ }
                }
            }

            if (type === 'stagnation' || type === 'stagnation_detected') {
                stagnationCount++;
                emit({ type: 'stagnation', reason: data?.reason || '', strategy: data?.recovery_strategy || '' });
                log(`Stagnation: ${data?.reason || ''}`);
            }

            if (type === 'content') {
                finalContent = data?.text || '';
            }

            if (type === 'content_partial') {
                const text = data?.text || '';
                if (text) finalContent = text;
            }

            if (type === 'complete') {
                totalCost = data?.cost || data?.total_cost || 0;
                if (data?.usage?.total_cost) totalCost = data.usage.total_cost;
                // Capture token usage
                if (data?.usage) {
                    usage = {
                        input_tokens: data.usage.total_input_tokens || data.usage.input_tokens || 0,
                        output_tokens: data.usage.total_output_tokens || data.usage.output_tokens || 0,
                        cache_read: data.usage.cache_read_input_tokens || data.usage.cache_read || 0,
                        cache_write: data.usage.cache_creation_input_tokens || data.usage.cache_write || 0,
                    };
                }
            }

            if (type === 'error') {
                emit({ type: 'error', error: data?.message || 'Unknown error' });
            }

            // ── Cost guard ──
            if (maxCost && totalCost > maxCost) {
                emit({ type: 'cost_exceeded', cost_usd: totalCost, max_cost: maxCost });
                log(`Cost exceeded: $${totalCost.toFixed(3)} > $${maxCost}`);
                break;
            }
        }
    } catch (err) {
        emit({ type: 'error', error: err.message });
    }

    clearTimeout(timeoutTimer);

    const durationS = (Date.now() - startTime) / 1000;

    // ── Tool breakdown ──
    const toolBreakdown = {};
    for (const t of toolCalls) {
        toolBreakdown[t.tool] = (toolBreakdown[t.tool] || 0) + 1;
    }

    emit({
        type: 'complete',
        tools: toolCount,
        tool_breakdown: toolBreakdown,
        sub_agents: subAgents,
        stagnation_triggers: stagnationCount,
        usage,
        duration_s: Math.round(durationS * 10) / 10,
        cost_usd: totalCost,
        model: model || 'default',
        content_length: finalContent.length,
    });

    log(`Done: ${toolCount} tools, ${durationS.toFixed(1)}s, $${totalCost.toFixed(3)}`);

    // Write final content to stderr so it's human-readable (stdout is JSONL)
    if (verbose && finalContent) {
        process.stderr.write(`\n--- Response ---\n${finalContent.slice(0, 2000)}\n`);
    }

    process.exit(0);
}
