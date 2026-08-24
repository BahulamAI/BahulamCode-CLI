/**
 * Headless Runner — non-interactive mode for benchmarks and automation.
 *
 * No REPL, no spinners, no approval prompts. Auto-approves all tools.
 * Outputs structured JSONL to stdout for machine consumption.
 * stderr gets minimal progress (optional with --verbose).
 *
 * Usage:
 *   bahulam-code --headless "Fix the bug in auth.py"
 *   bahulam-code --headless --timeout 300 --max-cost 2.00 "Refactor the login flow"
 *   bahulam-code --headless --model deepseek/deepseek-chat-v3-0324 "Add tests"
 */

import { TarangStreamClient } from './stream-client.mjs';
import { createToolExecutor } from './tool-executor.mjs';
import { buildWorkScope, promptProjectRoots } from './work-scope.mjs';
import { persistProjectArtifacts } from './project-artifacts.mjs';
import { TarangAuth } from '../auth/tarang-auth.mjs';
import { ApprovalManager } from './approval.mjs';
// PRD-092 wiring — headless (and `bahulam daemonize`) also starts the socket
// server + relay bridge when eventlog is enabled. Without this the daemon
// is invisible to attach clients and to paired mobile devices.
import { tapSseEvent, registerBroadcaster } from '../daemon/event-tap.mjs';
import { startSocketServer } from '../daemon/socket-server.mjs';
import { resolvePending } from '../daemon/approval-store.mjs';
import { startRelayBridge } from '../daemon/relay-client.mjs';
import { loadRemoteConfig } from '../commands/remote.mjs';
import { writeSessionMeta } from './event-log.mjs';
import { daemonSessionDir } from './paths.mjs';
import * as fsSync from 'node:fs';
import * as pathSync from 'node:path';
import {
    appendVisionAnalysisToInstruction,
    prepareImageAttachments,
    publicAttachmentMetadata,
} from './attachments.mjs';

/**
 * Run a single instruction in headless mode.
 * @param {object} opts
 * @param {string} opts.instruction - the prompt to send
 * @param {string} [opts.model] - model override
 * @param {number} [opts.timeout] - max seconds (default: 300)
 * @param {number} [opts.maxCost] - abort if cost exceeds this USD amount
 * @param {boolean} [opts.verbose] - show progress on stderr
 */
export async function runHeadless({ instruction, model, timeout = 300, maxCost, verbose = false, cacheReport = null, local = false, vision = [] }) {
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
        emit({ type: 'error', error: 'Not logged in. Run: bahulam login' });
        process.exit(1);
    }

    // Projects are registered and indexed only when the agent requests an overview.
    const toolExecutor = createToolExecutor();

    // Auto-approve everything — no prompts
    const approval = new ApprovalManager({ autoApprove: true });

    // ── Client selection ──
    // PRD-071 Phase 2 measurement — --local forces the CLI-side LocalAgent path,
    // bypassing the backend so we can exercise the cache_control wiring we
    // just added to _callClaude / _callOpenRouter. Model comes from the
    // --model flag (which overrides settings dynamically for benchmarking).
    let client;
    if (local) {
        const { LocalAgent } = await import('./local-agent.mjs');
        const localModel = model || creds.models?.local || 'anthropic/claude-sonnet-4';
        const orKey = process.env.OPENROUTER_API_KEY || creds.openRouterKey;
        const anthKey = process.env.ANTHROPIC_API_KEY || creds.anthropicKey;
        if (!orKey && !anthKey) {
            emit({ type: 'error', error: '--local requires OPENROUTER_API_KEY or ANTHROPIC_API_KEY' });
            process.exit(1);
        }
        client = {
            execute: (instr, ctx) => new LocalAgent({
                apiKey: anthKey,
                openRouterKey: orKey,
                model: localModel,
                toolExecutor,
                verbose,
                cwd: process.cwd(),
                maxTurns: 50,
            }).execute(instr, ctx),
        };
        log(`Local mode: ${localModel}`);
    } else {
        client = new TarangStreamClient({
            baseUrl: creds.backendUrl,
            token: creds.token,
            toolExecutor,
            approvalManager: approval,
        });
    }

    // ── Timeout ──
    const timeoutMs = timeout * 1000;
    const timeoutTimer = setTimeout(() => {
        emit({ type: 'timeout', duration_s: timeout });
        log(`Timeout after ${timeout}s`);
        process.exit(2);
    }, timeoutMs);

    // ── Vision analysis preflight ──
    if (!local) {
        try {
            const prepared = prepareImageAttachments(instruction, {
                cwd: process.cwd(),
                extraPaths: Array.isArray(vision) ? vision : [],
            });
            if (prepared.attachments.length) {
                emit({
                    type: 'attachments',
                    attachments: prepared.attachments.map(publicAttachmentMetadata),
                });
                const analysis = await client.analyzeVision({
                    instruction: prepared.instruction,
                    attachments: prepared.attachments,
                });
                instruction = appendVisionAnalysisToInstruction(prepared.instruction, analysis);
                emit({
                    type: 'vision_analysis',
                    model: analysis.model,
                    attachments: analysis.attachments || prepared.metadata,
                    summary_chars: String(analysis.summary || '').length,
                });
            } else {
                instruction = prepared.instruction || instruction;
            }
        } catch (err) {
            emit({ type: 'error', error: err.message || String(err), code: 'vision_analysis_failed' });
            process.exit(1);
        }
    } else if (Array.isArray(vision) && vision.length) {
        emit({ type: 'error', error: '--vision is not supported with --local yet', code: 'vision_local_unsupported' });
        process.exit(1);
    }

    // ── Execute ──
    emit({ type: 'start', timestamp: Date.now(), instruction, model: model || 'default', cwd: process.cwd() });

    let projectResources = toolExecutor.getProjectResources();
    const promptRoots = promptProjectRoots(instruction);
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
            instruction,
            cwd: process.cwd(),
            projectResources,
        }),
        agent_context: toolExecutor.getAgentContext(),
    };
    if (model) execContext.model_override = model;

    let primaryToolCount = 0;
    let subAgentForwardedToolCount = 0;
    let backendToolCount = null;
    let backendPrimaryToolCount = null;
    let backendSubAgentToolCount = null;
    let finalContent = '';
    let totalCost = 0;
    let rateLimit = null;

    // ── Telemetry collectors ──
    const toolCalls = [];       // { tool, call_id, duration_ms, success, internal, sub_agent }
    const emittedToolResults = new Set();
    const subAgents = [];       // { type, model, duration_s, tool_calls, success }
    let stagnationCount = 0;
    let usage = {};             // { input_tokens, output_tokens, cache_read, cache_write }
    // PRD-092 daemon wiring — one-shot per headless invocation.
    let prd092Started = false;
    let currentSessionId = null;

    try {
        for await (const event of client.execute(instruction, execContext)) {
            const { type, data } = event;

            if (type === 'tool_call' || type === 'tool_request') {
                const isInternal = Boolean(data?.internal || data?.sub_agent);
                const toolName = data?.tool || 'unknown';
                const args = data?.args || {};
                if (isInternal) subAgentForwardedToolCount++;
                else primaryToolCount++;
                toolCalls.push({
                    tool: toolName,
                    call_id: data?.call_id || data?.request_id || '',
                    success: null,
                    duration_ms: 0,
                    internal: isInternal,
                    sub_agent: data?.sub_agent || null,
                });
                emit({
                    type: 'tool_call',
                    tool: toolName,
                    args,
                    call_id: data?.call_id || data?.request_id || '',
                    approved: true,
                    internal: isInternal,
                    sub_agent: data?.sub_agent || null,
                });
                log(`Tool: ${toolName}`);
            }

            if (type === 'tool_result' || type === 'tool_done') {
                const success = data?.success !== false;
                const durationMs = data?.duration_ms ?? Math.round((data?.duration_s || 0) * 1000);
                const callId = data?.call_id || data?._callId || data?.request_id || '';
                const isInternal = Boolean(data?.internal || data?.sub_agent);
                // Update last tool call with result
                const last = toolCalls.findLast(t => (callId && t.call_id === callId) || t.tool === (data?.tool || ''));
                if (last) {
                    last.success = success;
                    last.duration_ms = durationMs;
                    if (isInternal) {
                        last.internal = true;
                        last.sub_agent = data?.sub_agent || last.sub_agent || null;
                    }
                } else if (data?.tool) {
                    // Some backend-owned meta-tools (for example explore) emit a
                    // result/complete event without a preceding client-visible
                    // tool_call. Keep the breakdown honest without relying on a
                    // duplicate rendered call line.
                    toolCalls.push({
                        tool: data.tool,
                        call_id: callId,
                        success,
                        duration_ms: durationMs,
                        internal: isInternal,
                        sub_agent: data?.sub_agent || null,
                    });
                    if (isInternal) subAgentForwardedToolCount++;
                    else primaryToolCount++;
                }
                if (callId && emittedToolResults.has(callId)) continue;
                if (callId) emittedToolResults.add(callId);
                emit({
                    type: 'tool_result',
                    tool: data?.tool || '',
                    call_id: callId,
                    success,
                    duration_ms: durationMs,
                    internal: isInternal,
                    sub_agent: data?.sub_agent || null,
                });
            }

            if (type === 'file_diff') {
                emit({
                    type: 'file_diff',
                    tool: data?.tool || '',
                    path: data?.path || '',
                    relative_path: data?.relative_path || '',
                    lines_added: data?.lines_added || 0,
                    lines_removed: data?.lines_removed || 0,
                    truncated: !!data?.truncated,
                    hunks: data?.hunks || [],
                });
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
                emit({ ...data, type: 'sub_agent', agent_type: data?.type || '' });
                log(`SubAgent done: ${data?.type} (${data?.tool_calls} tools, ${data?.duration_s}s)`);
            }

            if (type === 'plan_created' || type === 'goal_created') {
                persistProjectArtifacts(
                    data,
                    toolExecutor.getProjectResources(),
                    log,
                );
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

            if (type === 'session_info') {
                if (data?.rate_limit) rateLimit = data.rate_limit;
                // Surface session_id in the JSONL so multi-turn harnesses can
                // capture it from turn N and forward on turn N+1 (via TARANG_SESSION_ID).
                if (data?.session_id) emit({ type: 'session_info', session_id: data.session_id });

                // PRD-092 — same daemon wiring the interactive REPL does on
                // session_info: start the socket server so attach clients can
                // connect, tap events, and (if remote is enabled) dial the
                // relay so mobile can see the session. Gated by env var, one-
                // shot per process, fire-and-forget so a wire failure never
                // interrupts the turn.
                const _sid = data?.session_id;
                if (
                    _sid &&
                    process.env.BAHULAM_DAEMON_EVENTLOG === '1' &&
                    !prd092Started
                ) {
                    prd092Started = true;
                    (async () => {
                        try {
                            const server = await startSocketServer({
                                sessionId: _sid,
                                onCommand: {
                                    approve: async (payload, attachId) => resolvePending('approve', payload?.apr_id, attachId, payload?.note),
                                    deny: async (payload, attachId) => resolvePending('deny', payload?.apr_id, attachId, payload?.note),
                                    interrupt: async () => { try { if (typeof client?.cancel === 'function') client.cancel(); } catch {} },
                                    send_message: async () => { /* Slice C follow-up */ },
                                },
                            });
                            registerBroadcaster(evt => server.broadcastEvent(evt));

                            // Write meta.json + daemon.pid so `bahulam list` /
                            // `bahulam stop` and the mobile session directory
                            // can find this session.
                            try {
                                await writeSessionMeta({
                                    sessionId: _sid,
                                    meta: {
                                        cwd: process.cwd(),
                                        model: options.model || null,
                                        pid: process.pid,
                                        sock_path: server.sockPath,
                                        opened_at: new Date().toISOString(),
                                        headless: true,
                                    },
                                });
                                fsSync.writeFileSync(
                                    pathSync.join(daemonSessionDir(_sid), 'daemon.pid'),
                                    String(process.pid),
                                    { mode: 0o600 },
                                );
                            } catch (err) {
                                try { process.stderr.write(`[prd-092] meta/pid write: ${err.message}\n`); } catch {}
                            }

                            // Optional relay dial (Slice H) — only when the
                            // user opted in via `bahulam remote enable`.
                            try {
                                const remoteCfg = loadRemoteConfig();
                                if (remoteCfg?.enabled) {
                                    startRelayBridge({
                                        sessionId: _sid,
                                        remoteConfig: remoteCfg,
                                        registerBroadcaster,
                                        onCommand: {
                                            approve: async (payload, attachId) => resolvePending('approve', payload?.apr_id, attachId, payload?.note),
                                            deny: async (payload, attachId) => resolvePending('deny', payload?.apr_id, attachId, payload?.note),
                                            interrupt: async () => { try { if (typeof client?.cancel === 'function') client.cancel(); } catch {} },
                                            send_message: async () => { /* Slice C follow-up */ },
                                        },
                                    });
                                }
                            } catch (err) {
                                try { process.stderr.write(`[prd-092] relay bridge: ${err.message}\n`); } catch {}
                            }
                        } catch (err) {
                            try { process.stderr.write(`[prd-092] socket server: ${err.message}\n`); } catch {}
                        }
                    })();
                }
                // Tap this event too, so the very first frame lands in the
                // event log (before broadcasters are registered).
                if (_sid && process.env.BAHULAM_DAEMON_EVENTLOG === '1') {
                    tapSseEvent({ type: 'session_info', data }, { sessionId: _sid });
                }
            } else if (process.env.BAHULAM_DAEMON_EVENTLOG === '1') {
                // Tap every other event too, matching the REPL's for-await tap.
                // sessionId is populated once session_info has landed.
                if (currentSessionId) {
                    tapSseEvent(event, { sessionId: currentSessionId });
                }
            }
            // Track current session id for the tap.
            if (type === 'session_info' && data?.session_id) currentSessionId = data.session_id;

            if (type === 'complete') {
                if (data?.rate_limit) rateLimit = data.rate_limit;
                totalCost = data?.cost || data?.total_cost || 0;
                if (data?.usage?.total_cost) totalCost = data.usage.total_cost;
                if (Number.isFinite(data?.tool_calls)) backendToolCount = data.tool_calls;
                if (Number.isFinite(data?.primary_tool_calls)) backendPrimaryToolCount = data.primary_tool_calls;
                if (Number.isFinite(data?.sub_agent_tool_calls)) backendSubAgentToolCount = data.sub_agent_tool_calls;
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
                emit({
                    type: 'error',
                    error: data?.message || 'Unknown error',
                    code: data?.code,
                    retry_after: data?.retry_after,
                    rate_limit: data?.rate_limit || null,
                });
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
    const countBreakdown = (items) => {
        const out = {};
        for (const t of items) out[t.tool] = (out[t.tool] || 0) + 1;
        return out;
    };
    const toolBreakdown = countBreakdown(toolCalls);
    const primaryToolBreakdown = countBreakdown(toolCalls.filter(t => !t.internal));
    const subAgentToolBreakdown = countBreakdown(toolCalls.filter(t => t.internal));

    const subAgentReportedToolCount = subAgents.reduce((sum, sa) => sum + (sa.tool_calls || 0), 0);
    const observedSubAgentToolCount = Math.max(
        subAgentReportedToolCount,
        subAgentForwardedToolCount,
    );
    const subAgentToolCount = (
        backendSubAgentToolCount && backendSubAgentToolCount > 0
    )
        ? backendSubAgentToolCount
        : observedSubAgentToolCount;
    const computedToolCount = primaryToolCount + subAgentToolCount;
    const totalToolCount = backendToolCount != null
        ? Math.max(backendToolCount, computedToolCount)
        : computedToolCount;
    const primaryToolTotal = backendPrimaryToolCount ?? (
        backendToolCount != null
            ? Math.max(0, totalToolCount - subAgentToolCount)
            : primaryToolCount
    );
    if (subAgentToolCount > subAgentReportedToolCount && !backendSubAgentToolCount) {
        subAgents.push({
            type: 'forwarded',
            model: '',
            duration_s: 0,
            tool_calls: subAgentToolCount - subAgentReportedToolCount,
            success: true,
        });
    }

    emit({
        type: 'complete',
        tools: totalToolCount,
        tools_primary: primaryToolTotal,
        tools_sub_agent: subAgentToolCount,
        tools_forwarded_sub_agent_events: subAgentForwardedToolCount,
        tool_breakdown: toolBreakdown,
        tool_breakdown_primary: primaryToolBreakdown,
        tool_breakdown_sub_agent: subAgentToolBreakdown,
        sub_agents: subAgents,
        stagnation_triggers: stagnationCount,
        usage,
        duration_s: Math.round(durationS * 10) / 10,
        cost_usd: totalCost,
        rate_limit: rateLimit,
        model: model || 'default',
        content_length: finalContent.length,
    });

    // PRD-071 §1.5 — cache summary for benchmark harness. Machine-readable,
    // one file per run. Fields match what benchmark/cache-check.sh already
    // computes (input, cache_read, cache_write, rate) so the shell script
    // becomes a thin reader instead of re-doing the arithmetic.
    if (cacheReport && usage) {
        const cacheRead = usage.cache_read || 0;
        const cacheWrite = usage.cache_write || 0;
        const inputT = usage.input_tokens || 0;
        // Two conventions in the wild:
        //   OpenAI/DeepSeek: input_tokens INCLUDES cached tokens
        //                    → hit_rate = cache_read / input_tokens
        //   Anthropic:       input_tokens EXCLUDES cache reads AND writes
        //                    → hit_rate = cache_read / (input + cache_read + cache_write)
        // Report both. Also expose `cache_hit_rate_pct` as the "sane" number
        // — auto-detects convention by whether cache_read > input_tokens.
        const rateOpenAI = inputT > 0 ? Math.round((cacheRead / inputT) * 100) : 0;
        const anthropicDenom = inputT + cacheRead + cacheWrite;
        const rateAnthropic = anthropicDenom > 0 ? Math.round((cacheRead / anthropicDenom) * 100) : 0;
        const rateAuto = cacheRead > inputT ? rateAnthropic : rateOpenAI;
        const report = {
            schema: 'kepler.cache-report/1',
            model: model || 'default',
            input_tokens: inputT,
            output_tokens: usage.output_tokens || 0,
            cache_read_tokens: cacheRead,
            cache_write_tokens: cacheWrite,
            cache_hit_rate_pct: rateAuto,
            cache_hit_rate_openai_pct: rateOpenAI,
            cache_hit_rate_anthropic_pct: rateAnthropic,
            duration_s: Math.round(durationS * 10) / 10,
            cost_usd: totalCost,
        };
        try {
            const fs = await import('node:fs');
            fs.writeFileSync(cacheReport, JSON.stringify(report, null, 2) + '\n');
            log(`Cache report written: ${cacheReport}`);
        } catch (err) {
            log(`Cache report write failed: ${err.message}`);
        }
    }

    log(`Done: ${totalToolCount} tools (${primaryToolTotal} primary, ${subAgentToolCount} sub-agent), ${durationS.toFixed(1)}s, $${totalCost.toFixed(3)}`);

    // Write final content to stderr so it's human-readable (stdout is JSONL)
    if (verbose && finalContent) {
        process.stderr.write(`\n--- Response ---\n${finalContent.slice(0, 2000)}\n`);
    }

    process.exit(0);
}
