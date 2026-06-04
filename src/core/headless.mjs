/**
 * Headless Runner — non-interactive mode for benchmarks and automation.
 *
 * No REPL, no spinners, no approval prompts. Auto-approves all tools.
 * Outputs structured JSONL to stdout for machine consumption.
 * stderr gets minimal progress (optional with --verbose).
 *
 * Usage:
 *   orca --headless "Fix the bug in auth.py"
 *   orca --headless --timeout 300 --max-cost 2.00 "Refactor the login flow"
 *   orca --headless --model deepseek/deepseek-chat-v3-0324 "Add tests"
 */

import { TarangStreamClient } from './stream-client.mjs';
import { createToolExecutor } from './tool-executor.mjs';
import { TarangAuth } from '../auth/tarang-auth.mjs';
import { ApprovalManager } from './approval.mjs';
import { ContextRetriever } from '../context/retriever.mjs';
import { buildProjectSkeleton } from '../context/skeleton.mjs';

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
        emit({ type: 'error', error: 'Not logged in. Run: orca login' });
        process.exit(1);
    }

    // ── Index project ──
    log('Indexing project...');
    const retriever = new ContextRetriever(process.cwd());
    try {
        await retriever.buildIndex();
    } catch {
        log('Index failed, continuing without BM25');
    }

    const skeleton = buildProjectSkeleton(process.cwd());
    const toolExecutor = createToolExecutor({ retriever });

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

    const execContext = { cwd: process.cwd(), dangerously_skip_permissions: true };
    if (skeleton) execContext.project_skeleton = skeleton;
    if (model) execContext.model_override = model;

    let toolCount = 0;
    let finalContent = '';
    let totalCost = 0;

    try {
        for await (const event of client.execute(instruction, execContext)) {
            const { type, data } = event;

            if (type === 'tool_call' || type === 'tool_request') {
                toolCount++;
                const toolName = data?.tool || 'unknown';
                const args = data?.args || {};
                emit({ type: 'tool_call', tool: toolName, args, approved: true });
                log(`Tool: ${toolName}`);
            }

            if (type === 'tool_result' || type === 'tool_done') {
                const success = data?.success !== false;
                const duration = data?.duration_s || 0;
                emit({ type: 'tool_result', tool: data?.tool || '', success, duration_ms: Math.round(duration * 1000) });
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

                // Extract cost from usage breakdown if available
                if (data?.usage?.total_cost) {
                    totalCost = data.usage.total_cost;
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

    emit({
        type: 'complete',
        tools: toolCount,
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
