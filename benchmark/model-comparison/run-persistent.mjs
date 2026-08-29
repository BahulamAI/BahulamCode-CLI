#!/usr/bin/env node
/**
 * Model Comparison Harness — Persistent CLI Mode
 * ==============================================
 *
 * Same 7-question set as run.mjs, but runs ALL turns in ONE Node.js process
 * with ONE TarangStreamClient instance. Matches manual (interactive) mode
 * behavior — warm caches, one session_id, no per-turn cold-start overhead.
 *
 * Why this exists:
 *   The spawn-per-turn harness (run.mjs) systematically over-invoked sub-agents
 *   vs manual mode (12 delegations headless vs 0 manual on the same 7 Qs).
 *   The overhead came from re-instantiating the stream-client each turn.
 *   Persistent mode closes that gap so headless benchmarks reflect real-user
 *   cost/behavior.
 *
 * Usage identical to run.mjs:
 *   TARANG_ENV=local node benchmark/model-comparison/run-persistent.mjs \
 *     --label "baseline-deepseek-subagents-on" \
 *     --model deepseek/deepseek-v4-flash \
 *     --route platform
 *
 * Notes:
 *   - Requires `kepler login` completed for the target backend
 *   - Session_id chaining is automatic (client instance carries it)
 *   - No child processes, no --resume, no TARANG_SESSION_ID env var
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reuse CLI's core primitives — same building blocks as `kepler --headless`,
// but composed into a single-process loop so state persists across turns.
import { TarangAuth } from '../../src/auth/tarang-auth.mjs';
import { TarangStreamClient } from '../../src/core/stream-client.mjs';
import { createToolExecutor } from '../../src/core/tool-executor.mjs';
import { ApprovalManager } from '../../src/core/approval.mjs';
import { buildWorkScope, promptProjectRoots } from '../../src/core/work-scope.mjs';
import { AgentHistoryTurnBuilder } from '../../src/core/agent-history.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_BENCH_MODEL = process.env.KEPLER_BENCH_MODEL
    || process.env.BENCHMARK_MODEL
    || 'deepseek/deepseek-v4-flash';
const DEFAULT_BENCH_ROUTE = process.env.KEPLER_BENCH_ROUTE
    || process.env.BENCHMARK_ROUTE
    || 'platform';

function parseOptionalJsonEnv(name) {
    const raw = process.env[name];
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new Error(`${name} must be valid JSON: ${err.message}`);
    }
}

// ── CLI args ──
function parseArgs(argv) {
    const out = {
        label: 'unnamed',
        model: DEFAULT_BENCH_MODEL,
        route: DEFAULT_BENCH_ROUTE,
        tag: null,
        outDir: null,
        questions: path.join(__dirname, 'questions.json'),
        timeoutS: 480,
        verbose: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--label') out.label = argv[++i];
        else if (a === '--model') out.model = argv[++i];
        else if (a === '--route') out.route = argv[++i];
        else if (a === '--tag') out.tag = argv[++i];
        else if (a === '--out-dir') out.outDir = argv[++i];
        else if (a === '--questions') out.questions = argv[++i];
        else if (a === '--timeout') out.timeoutS = parseInt(argv[++i], 10);
        else if (a === '--verbose') out.verbose = true;
        else if (a === '--help' || a === '-h') {
            usage();
            process.exit(0);
        }
    }
    return out;
}

function usage() {
    process.stderr.write(`
Model Comparison Harness (persistent CLI mode)

Options:
  --label <name>          Short identifier for this run (used in output paths)
  --model <id>            e.g. deepseek/deepseek-v4-flash, z-ai/glm-5.2 (default: ${DEFAULT_BENCH_MODEL})
  --route <route>         platform or byok (default: ${DEFAULT_BENCH_ROUTE})
  --tag <notes>           Free-form annotation stored in the report
  --out-dir <dir>         Where to write results (default: results/<label>-<timestamp>)
  --questions <path>      Question set JSON (default: ./questions.json)
  --timeout <seconds>     Per-question timeout (default: 480)
  --verbose               Show CLI stderr output live
`);
}

// ── Build ONE stream-client for the whole benchmark ──
async function createPersistentClient() {
    const auth = new TarangAuth();
    const creds = auth.loadCredentials();
    if (!creds.token) {
        throw new Error('Not logged in. Run: kepler login');
    }
    const toolExecutor = createToolExecutor();
    const approval = new ApprovalManager({ autoApprove: true });
    const client = new TarangStreamClient({
        baseUrl: creds.backendUrl,
        token: creds.token,
        toolExecutor,
        approvalManager: approval,
    });
    return { client, toolExecutor, creds };
}

// ── Run one turn against the persistent client. Matches the event shape
// ── that run.mjs's summarizeTurn expects (compatible with existing analysis).
async function runTurnPersistent({
    client,
    toolExecutor,
    question,
    model,
    modelOverrides,
    agentSpec,
    timeoutS,
    jsonlPath,
    verbose,
    agentHistory,
}) {
    const events = [];
    const rawJsonl = fs.createWriteStream(jsonlPath, { flags: 'w' });
    const history = Array.isArray(agentHistory) ? agentHistory : [];
    const userMessage = { role: 'user', content: question };
    history.push(userMessage);
    const turnHistory = new AgentHistoryTurnBuilder();
    let assistantContent = '';

    // Per-turn counters populated from the SSE event stream. Backend's
    // `complete` event is authoritative for billing/usage totals; these local
    // counters keep primary calls separate from forwarded sub-agent internals.
    let primaryToolCount = 0;
    let subAgentForwardedToolCount = 0;
    const toolCalls = [];
    const emittedToolResults = new Set();
    const subAgents = [];

    const emit = (obj) => {
        rawJsonl.write(JSON.stringify(obj) + '\n');
        events.push(obj);
    };

    emit({
        type: 'start',
        timestamp: Date.now(),
        instruction: question,
        model: model || 'default',
        model_overrides: modelOverrides || null,
        agent_spec: agentSpec || null,
        cwd: process.cwd(),
        prior_agent_history_messages: Math.max(0, history.length - 1),
    });

    // Register any project roots referenced by the prompt (same as headless.mjs)
    let projectResources = toolExecutor.getProjectResources();
    const promptRoots = promptProjectRoots(question);
    if (promptRoots.length > 0) {
        await toolExecutor.registerProjectRoots(promptRoots);
        projectResources = toolExecutor.getProjectResources();
    }
    const execContext = {
        cwd: process.cwd(),
        skip_permissions: true,
        freeswim: true, // legacy wire alias — drop after cloud backend 2.7 rollout
        project_resources: projectResources,
        work_scope: buildWorkScope({
            instruction: question,
            cwd: process.cwd(),
            projectResources,
        }),
        agent_context: toolExecutor.getAgentContext(),
    };
    if (model) execContext.model_override = model;
    if (modelOverrides && Object.keys(modelOverrides).length > 0) {
        execContext.model_overrides = modelOverrides;
    }
    if (agentSpec && Object.keys(agentSpec).length > 0) {
        execContext.agent_spec = agentSpec;
    }

    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
        timedOut = true;
        emit({ type: 'timeout', duration_s: timeoutS });
        // Best-effort cancel — TarangStreamClient will notice and stop yielding.
        try { client._cancelled = true; } catch (_) { /* ignore */ }
    }, timeoutS * 1000);

    try {
        for await (const event of client.execute(question, execContext, history)) {
            if (timedOut) break;
            const { type, data } = event;

            if (type === 'content_partial') {
                const text = data?.text || '';
                assistantContent += text;
                turnHistory.addAssistantText(text);
            } else if (type === 'content') {
                const text = data?.text || '';
                const newText = assistantContent && text.startsWith(assistantContent)
                    ? text.slice(assistantContent.length)
                    : text === assistantContent ? '' : text;
                if (text) {
                    assistantContent = assistantContent && !text.startsWith(assistantContent)
                        ? assistantContent + text
                        : text;
                }
                if (newText) turnHistory.addAssistantText(newText);
            }

            // Surface session_info so run.mjs's session_id capture logic still works.
            if (type === 'session_info' && data?.session_id) {
                emit({ type: 'session_info', session_id: data.session_id });
            }

            // Tool lifecycle events — same shape as headless.mjs emits.
            if (type === 'tool_call' || type === 'tool_request') {
                const isInternal = Boolean(data?.internal || data?.sub_agent);
                const toolName = data?.tool || 'unknown';
                const callId = data?.call_id || data?.request_id || '';
                turnHistory.addToolUse(data || {});
                if (isInternal) subAgentForwardedToolCount++;
                else primaryToolCount++;
                toolCalls.push({
                    tool: toolName,
                    call_id: callId,
                    success: null,
                    duration_ms: 0,
                    internal: isInternal,
                    sub_agent: data?.sub_agent || null,
                });
                emit({
                    type: 'tool_call',
                    tool: toolName,
                    args: data?.args || {},
                    call_id: callId,
                    approved: true,
                    internal: isInternal,
                    sub_agent: data?.sub_agent || null,
                });
                if (verbose) process.stderr.write(`  ↳ ${data?.tool}\n`);
            }
            if (type === 'tool_result' || type === 'tool_done') {
                const isInternal = Boolean(data?.internal || data?.sub_agent);
                const callId = data?.call_id || data?._callId || data?.request_id || '';
                const durationMs = data?.duration_ms ?? Math.round((data?.duration_s || 0) * 1000);
                const last = toolCalls.findLast(t => (callId && t.call_id === callId) || t.tool === (data?.tool || ''));
                if (last) {
                    last.success = data?.success !== false;
                    last.duration_ms = durationMs;
                    if (isInternal) {
                        last.internal = true;
                        last.sub_agent = data?.sub_agent || last.sub_agent || null;
                    }
                } else if (data?.tool) {
                    toolCalls.push({
                        tool: data.tool,
                        call_id: callId,
                        success: data?.success !== false,
                        duration_ms: durationMs,
                        internal: isInternal,
                        sub_agent: data?.sub_agent || null,
                    });
                    if (isInternal) subAgentForwardedToolCount++;
                    else primaryToolCount++;
                }
                turnHistory.addToolResult(data || {});
                if (callId && emittedToolResults.has(callId)) continue;
                if (callId) emittedToolResults.add(callId);
                emit({
                    type: 'tool_result',
                    tool: data?.tool || '',
                    call_id: callId,
                    success: data?.success !== false,
                    duration_ms: durationMs,
                    internal: isInternal,
                    sub_agent: data?.sub_agent || null,
                });
            }

            // Sub-agent lifecycle events — used by summarizeTurn to count delegations.
            if (type === 'sub_agent_start' || type === 'sub_agent' || type === 'sub_agent_complete') {
                if (type === 'sub_agent_complete') {
                    subAgents.push({
                        type: data?.type,
                        model: data?.model,
                        duration_s: data?.duration_s || 0,
                        tool_calls: data?.tool_calls || 0,
                        success: data?.success !== false,
                    });
                }
                emit({
                    type: 'sub_agent',
                    type_name: data?.type,
                    model: data?.model,
                    duration_s: data?.duration_s,
                    tool_calls: data?.tool_calls,
                    success: data?.success !== false,
                });
            }

            if (type === 'complete') {
                const completionSubAgents = subAgents.length ? subAgents : (data?.sub_agents || []);
                const subAgentReportedToolCount = completionSubAgents.reduce((s, sa) => s + (sa.tool_calls || 0), 0);
                const backendTotal = Number.isFinite(data?.tool_calls) ? data.tool_calls : null;
                const backendPrimary = Number.isFinite(data?.primary_tool_calls) ? data.primary_tool_calls : null;
                const backendSubAgent = Number.isFinite(data?.sub_agent_tool_calls) ? data.sub_agent_tool_calls : null;
                const subAgentToolCount = backendSubAgent ?? Math.max(subAgentReportedToolCount, subAgentForwardedToolCount);
                const totalTools = backendTotal ?? (primaryToolCount + subAgentToolCount);
                const primaryTools = backendPrimary ?? (
                    backendTotal != null
                        ? Math.max(0, totalTools - subAgentToolCount)
                        : primaryToolCount
                );
                const countBreakdown = (items) => {
                    const out = {};
                    for (const t of items) out[t.tool] = (out[t.tool] || 0) + 1;
                    return out;
                };
                emit({
                    type: 'complete',
                    duration_s: data?.duration_s || 0,
                    cost_usd: data?.cost || data?.total_cost || (data?.usage?.total_cost) || 0,
                    tools: totalTools,
                    tools_primary: primaryTools,
                    tools_sub_agent: subAgentToolCount,
                    tools_forwarded_sub_agent_events: subAgentForwardedToolCount,
                    sub_agents: completionSubAgents,
                    tool_breakdown: data?.tool_breakdown || countBreakdown(toolCalls),
                    tool_breakdown_primary: data?.tool_breakdown_primary || countBreakdown(toolCalls.filter(t => !t.internal)),
                    tool_breakdown_sub_agent: data?.tool_breakdown_sub_agent || countBreakdown(toolCalls.filter(t => t.internal)),
                    usage: {
                        input_tokens: data?.usage?.total_input_tokens || data?.usage?.input_tokens || 0,
                        output_tokens: data?.usage?.total_output_tokens || data?.usage?.output_tokens || 0,
                        cache_read: data?.usage?.cache_read_input_tokens || data?.usage?.cache_read || 0,
                        cache_write: data?.usage?.cache_creation_input_tokens || data?.usage?.cache_write || 0,
                    },
                    stagnation_triggers: data?.stagnation_triggers || 0,
                    content_length: (data?.content_length || 0),
                    rate_limit: data?.rate_limit || null,
                    model: data?.model,
                    agent_history_messages_sent: history.length,
                });
            }

            if (type === 'error') {
                emit({
                    type: 'error',
                    error: data?.error || data?.message || data?.code || 'unknown',
                    code: data?.code || null,
                    fatal: data?.fatal !== false,
                });
            }
        }
    } catch (e) {
        emit({ type: 'error', error: String(e?.message || e) });
    } finally {
        clearTimeout(timeoutTimer);
        const structuredTurn = turnHistory.finish();
        if (structuredTurn.length) {
            history.push(...structuredTurn);
        }
        rawJsonl.end();
    }

    return { exitCode: timedOut ? 2 : 0, events, agentHistoryMessages: history.length };
}

// ── Aggregate a single turn's JSONL events (same schema as run.mjs) ──
function summarizeTurn(events) {
    const completion = events.findLast(e => e.type === 'complete') || {};
    const errors = events.filter(e => e.type === 'error');
    const timeout = events.find(e => e.type === 'timeout');
    const subAgents = events.filter(e => e.type === 'sub_agent').map(e => ({
        type: e.type_name || e.data?.type || e.type,
        model: e.model || e.data?.model,
        duration_s: e.duration_s || e.data?.duration_s || 0,
        tool_calls: e.tool_calls || e.data?.tool_calls || 0,
        success: e.success !== false,
    }));
    const completionSubAgents = completion.sub_agents || subAgents;
    const subAgentToolTotal = Number.isFinite(completion.tools_sub_agent)
        ? completion.tools_sub_agent
        : completionSubAgents.reduce((s, sa) => s + (sa.tool_calls || 0), 0);
    const totalTools = Number.isFinite(completion.tools)
        ? completion.tools
        : ((completion.tools_primary || 0) + subAgentToolTotal);
    const primaryTools = Number.isFinite(completion.tools_primary)
        ? completion.tools_primary
        : Math.max(0, totalTools - subAgentToolTotal);

    return {
        exit_ok: !errors.length && !timeout && completion,
        duration_s: completion.duration_s || 0,
        cost_usd: completion.cost_usd || 0,
        tools_total: totalTools,
        tools_primary: primaryTools,
        tools_sub_agent: subAgentToolTotal,
        sub_agents: completionSubAgents,
        tool_breakdown: completion.tool_breakdown || {},
        usage: completion.usage || {},
        stagnation_triggers: completion.stagnation_triggers || 0,
        content_length: completion.content_length || 0,
        errors: errors.map(e => e.error || 'unknown'),
        timed_out: !!timeout,
        rate_limit: completion.rate_limit || null,
    };
}

function summarizeSession(turnSummaries) {
    const sum = (key) => turnSummaries.reduce((s, t) => s + (t[key] || 0), 0);
    const usageSum = (key) => turnSummaries.reduce((s, t) => s + (t.usage?.[key] || 0), 0);
    const inputT = usageSum('input_tokens');
    const cacheR = usageSum('cache_read');
    const cacheW = usageSum('cache_write');
    // Provider convention: total_input_tokens INCLUDES cache_read. So the correct
    // denominator is just inputT (no double-count). Matches the CLI's fixed /cache formula.
    const rate = inputT > 0 ? Math.round((cacheR / inputT) * 100) : 0;

    return {
        turns: turnSummaries.length,
        total_duration_s: sum('duration_s'),
        total_cost_usd: sum('cost_usd'),
        total_tools: sum('tools_total'),
        total_tools_primary: sum('tools_primary'),
        total_tools_sub_agent: sum('tools_sub_agent'),
        total_input_tokens: inputT,
        total_output_tokens: usageSum('output_tokens'),
        total_cache_read: cacheR,
        total_cache_write: cacheW,
        cache_hit_rate_pct: rate,
        errors: turnSummaries.filter(t => t.errors.length).length,
        timed_out: turnSummaries.filter(t => t.timed_out).length,
    };
}

// ── Main ──
async function main() {
    const opts = parseArgs(process.argv);
    const modelOverrides = parseOptionalJsonEnv('KEPLER_BENCH_MODEL_OVERRIDES_JSON');
    const agentSpec = parseOptionalJsonEnv('KEPLER_BENCH_AGENT_SPEC_JSON');
    const qFile = JSON.parse(fs.readFileSync(opts.questions, 'utf8'));
    const questions = qFile.questions;

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = opts.outDir || path.join(__dirname, 'results', `${opts.label}-${ts}`);
    fs.mkdirSync(outDir, { recursive: true });

    const runManifest = {
        schema: 'kepler.model-comparison-run/1',
        label: opts.label,
        harness_mode: 'persistent',
        started_at: new Date().toISOString(),
        env: {
            TARANG_ENV: process.env.TARANG_ENV || null,
            NODE_VERSION: process.version,
        },
        config: {
            model: opts.model,
            route: opts.route,
            tag: opts.tag,
            questions_source: opts.questions,
            model_overrides: modelOverrides,
            agent_spec: agentSpec,
        },
        turns: [],
    };

    process.stderr.write(`\n═══════════════════════════════════════════════════════\n`);
    process.stderr.write(`Model Comparison Harness (PERSISTENT) — label="${opts.label}"\n`);
    process.stderr.write(`  Backend env: ${process.env.TARANG_ENV || '(default)'}\n`);
    process.stderr.write(`  Model:       ${opts.model || '(backend default)'}\n`);
    process.stderr.write(`  Route:       ${opts.route || '(unset)'}\n`);
    process.stderr.write(`  Questions:   ${questions.length} from ${opts.questions}\n`);
    process.stderr.write(`  Output dir:  ${outDir}\n`);
    process.stderr.write(`  Mode:        one Node.js process, one stream-client, one session\n`);
    process.stderr.write(`═══════════════════════════════════════════════════════\n`);

    let client, toolExecutor;
    try {
        ({ client, toolExecutor } = await createPersistentClient());
    } catch (e) {
        process.stderr.write(`\nFATAL: ${e.message}\n`);
        process.exit(1);
    }

    const perTurn = [];
    const agentHistory = [];
    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const jsonlPath = path.join(outDir, `q${q.q}-raw.jsonl`);
        process.stderr.write(`\n[Q${q.q}] ${q.text.slice(0, 90)}${q.text.length > 90 ? '…' : ''}\n`);

        const startMs = Date.now();
        const { exitCode, events } = await runTurnPersistent({
            client,
            toolExecutor,
            question: q.text,
            model: opts.model,
            modelOverrides,
            agentSpec,
            timeoutS: opts.timeoutS,
            verbose: opts.verbose,
            jsonlPath,
            agentHistory,
        });

        // First-turn session_id is captured naturally by the client instance;
        // subsequent turns reuse it via body.session_id. No env var passthrough needed.
        if (i === 0 && client.sessionId) {
            process.stderr.write(`  ↳ session_id: ${client.sessionId.slice(0, 8)}…\n`);
        }

        const wallSec = ((Date.now() - startMs) / 1000).toFixed(1);
        const summary = summarizeTurn(events);
        summary.wall_duration_s = parseFloat(wallSec);
        perTurn.push(summary);

        runManifest.turns.push({
            q: q.q,
            question: q.text,
            tests: q.tests,
            exit_code: exitCode,
            summary,
            agent_history_messages: agentHistory.length,
            jsonl_path: path.relative(outDir, jsonlPath),
        });

        process.stderr.write(
            `  → ${summary.duration_s.toFixed(1)}s | ` +
            `${summary.tools_total} tools (${summary.tools_primary}P + ${summary.tools_sub_agent}S) | ` +
            `$${summary.cost_usd.toFixed(4)}` +
            (summary.errors.length ? ` | ERRORS: ${summary.errors.join(', ')}` : '') +
            (summary.timed_out ? ` | TIMED OUT` : '') + '\n'
        );
    }

    runManifest.aggregate = summarizeSession(perTurn);
    runManifest.completed_at = new Date().toISOString();

    const summaryPath = path.join(outDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(runManifest, null, 2));

    process.stderr.write(`\n═══════════════════════════════════════════════════════\n`);
    process.stderr.write(`Aggregate: ${JSON.stringify(runManifest.aggregate, null, 2)}\n`);
    process.stderr.write(`Summary written: ${summaryPath}\n`);
    process.stderr.write(`═══════════════════════════════════════════════════════\n`);

    process.stdout.write(JSON.stringify(runManifest, null, 2) + '\n');
}

main().catch(e => {
    process.stderr.write(`\nFATAL: ${e.stack || e.message}\n`);
    process.exit(1);
});
