#!/usr/bin/env node
/**
 * Model Comparison Harness — 7-Question Automated Runner
 * ======================================================
 *
 * Runs the 7-question set from `docs/strategy/model-comparison.md` against
 * a specific Kepler build + model configuration using the CLI's headless
 * mode. Chains turns with `--resume` so cross-turn context accumulates the
 * same way an interactive session would.
 *
 * Outputs:
 *   - Per-turn JSONL (raw)
 *   - Aggregated summary matching the model-comparison.md matrix schema
 *   - Human-readable comparison table on stdout
 *
 * Usage:
 *   TARANG_ENV=local node benchmark/model-comparison/run.mjs \
 *     --label "deepseek-layer3" \
 *     --model deepseek/deepseek-v4-flash \
 *     --route platform
 *
 *   TARANG_ENV=local node benchmark/model-comparison/run.mjs \
 *     --label "glm52-primary" \
 *     --model z-ai/glm-5.2 \
 *     --route platform \
 *     --tag "sub-agents=deepseek, backend=commit 6248e93"
 *
 * Env:
 *   TARANG_ENV                       — backend selector (local, treetop, production)
 *   KEPLER_MAIN                      — path to CLI main.mjs (default derives from this file)
 *
 * Notes:
 *   - Requires `kepler login` completed for the target backend
 *   - Backend model resolution: the --model flag overrides ONLY if backend
 *     has model_route wired for the CLI. Otherwise env vars on backend win.
 *   - Each question is a separate `runHeadless` invocation; conversation
 *     continuity is preserved via --resume (built-in JSONL replay).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── CLI args ──
function parseArgs(argv) {
    const out = {
        label: null,
        model: null,
        route: null,
        tag: '',
        outDir: null,
        questions: path.join(__dirname, 'questions.json'),
        timeoutS: 600,
        verbose: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const next = argv[i + 1];
        if (a === '--label') { out.label = next; i++; }
        else if (a === '--model' || a === '-m') { out.model = next; i++; }
        else if (a === '--route') { out.route = next; i++; }
        else if (a === '--tag') { out.tag = next; i++; }
        else if (a === '--out-dir') { out.outDir = next; i++; }
        else if (a === '--questions') { out.questions = next; i++; }
        else if (a === '--timeout') { out.timeoutS = parseInt(next, 10); i++; }
        else if (a === '--verbose' || a === '-v') { out.verbose = true; }
        else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    }
    if (!out.label) { usage('missing --label'); process.exit(1); }
    return out;
}

function usage(msg) {
    if (msg) process.stderr.write(`ERR: ${msg}\n`);
    process.stderr.write(`
Usage: node run.mjs --label <name> [--model <id>] [--route <platform|byok>] [--tag <notes>]

Required:
  --label <name>          Short identifier for this run (used in output paths)

Model config (optional; passed to CLI --model / --route):
  --model <id>            e.g. deepseek/deepseek-v4-flash, z-ai/glm-5.2
  --route <route>         platform or byok (required if --model set)

Other:
  --tag <notes>           Free-form annotation stored in the report
  --out-dir <dir>         Where to write results (default: results/<label>-<timestamp>)
  --questions <path>      Question set JSON (default: ./questions.json)
  --timeout <seconds>     Per-question timeout (default: 600)
  --verbose               Show CLI stderr output live
`.trim() + '\n');
}

// ── Locate the CLI main entrypoint ──
function resolveKeplerMain() {
    if (process.env.KEPLER_MAIN) return process.env.KEPLER_MAIN;
    // walk up from this file to codekepler-npm/src/terminal/main.mjs
    return path.resolve(__dirname, '..', '..', 'src', 'terminal', 'main.mjs');
}

// ── Run one turn via CLI headless ──
async function runTurn({ keplerMain, question, model, route, resume, timeoutS, verbose, jsonlPath }) {
    return new Promise((resolve) => {
        const args = [keplerMain];
        if (route) args.push(route);      // 'platform' or 'byok' — must come BEFORE --headless
        args.push('--headless');
        if (model) { args.push('--model', model); }
        args.push('--timeout', String(timeoutS));
        args.push('-p', question);
        if (resume) args.push('--resume');
        if (verbose) args.push('--verbose');

        if (verbose) process.stderr.write(`\n  $ node ${args.join(' ')}\n`);

        const child = spawn('node', args, {
            env: { ...process.env },
            stdio: ['ignore', 'pipe', verbose ? 'inherit' : 'pipe'],
        });

        const events = [];
        const rawJsonl = fs.createWriteStream(jsonlPath, { flags: 'w' });
        let buf = '';
        child.stdout.on('data', (chunk) => {
            rawJsonl.write(chunk);
            buf += chunk.toString('utf8');
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                try { events.push(JSON.parse(line)); }
                catch (e) { /* skip malformed line */ }
            }
        });

        if (!verbose) child.stderr.on('data', () => { /* suppress */ });

        child.on('close', (code) => {
            rawJsonl.end();
            if (buf.trim()) {
                try { events.push(JSON.parse(buf)); }
                catch (e) { /* skip */ }
            }
            resolve({ exitCode: code, events });
        });
    });
}

// ── Aggregate a single turn's JSONL events ──
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
    // Sub-agent tools from the CLI's own count in the completion event
    const subAgentToolTotal = (completion.sub_agents || []).reduce((s, sa) => s + (sa.tool_calls || 0), 0);
    // Primary tools = total tools - sub-agent tools (headless includes both in `tools`)
    const totalTools = completion.tools || 0;
    const primaryTools = Math.max(0, totalTools - subAgentToolTotal);

    return {
        exit_ok: !errors.length && !timeout && completion,
        duration_s: completion.duration_s || 0,
        cost_usd: completion.cost_usd || 0,
        tools_total: totalTools,
        tools_primary: primaryTools,
        tools_sub_agent: subAgentToolTotal,
        sub_agents: completion.sub_agents || subAgents,
        tool_breakdown: completion.tool_breakdown || {},
        usage: completion.usage || {},
        stagnation_triggers: completion.stagnation_triggers || 0,
        content_length: completion.content_length || 0,
        errors: errors.map(e => e.error || 'unknown'),
        timed_out: !!timeout,
        rate_limit: completion.rate_limit || null,
    };
}

// ── Aggregate a session ──
function summarizeSession(turnSummaries) {
    const sum = (key) => turnSummaries.reduce((s, t) => s + (t[key] || 0), 0);
    const usageSum = (key) => turnSummaries.reduce((s, t) => s + (t.usage?.[key] || 0), 0);
    const inputT = usageSum('input_tokens');
    const cacheR = usageSum('cache_read');
    // Cache hit rate — same auto-detect logic as headless.mjs's cache-report
    const cacheW = usageSum('cache_write');
    const rateAnthropic = (inputT + cacheR + cacheW) > 0
        ? Math.round((cacheR / (inputT + cacheR + cacheW)) * 100) : 0;
    const rateOpenAI = inputT > 0 ? Math.round((cacheR / inputT) * 100) : 0;
    const rateAgg = cacheR > inputT ? rateAnthropic : rateOpenAI;

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
        cache_hit_rate_pct: rateAgg,
        errors: turnSummaries.filter(t => t.errors.length).length,
        timed_out: turnSummaries.filter(t => t.timed_out).length,
    };
}

// ── Human-readable table ──
function renderTable(perTurn, questions) {
    const w = (s, n) => String(s).padEnd(n).slice(0, n);
    const r = (s, n) => String(s).padStart(n).slice(0, n);

    let out = '\nPer-turn results:\n\n';
    out += `${w('Q', 3)} ${w('Test', 42)} ${r('Runtime', 8)} ${r('Prim', 5)} ${r('Sub', 5)} ${r('Iter', 5)} ${r('Cost', 8)} ${r('Cache%', 7)}\n`;
    out += '─'.repeat(90) + '\n';
    for (let i = 0; i < perTurn.length; i++) {
        const t = perTurn[i];
        const q = questions[i];
        const cache = t.usage?.input_tokens
            ? Math.round(((t.usage.cache_read || 0) / t.usage.input_tokens) * 100) : 0;
        out += `${w(q?.q ?? i + 1, 3)} `;
        out += `${w(q?.tests || '', 42)} `;
        out += `${r(t.duration_s.toFixed(1) + 's', 8)} `;
        out += `${r(t.tools_primary, 5)} `;
        out += `${r(t.tools_sub_agent, 5)} `;
        out += `${r(t.sub_agents?.length || 0, 5)} `;
        out += `${r('$' + t.cost_usd.toFixed(4), 8)} `;
        out += `${r(cache + '%', 7)}\n`;
    }
    return out;
}

// ── Main ──
async function main() {
    const opts = parseArgs(process.argv);
    const keplerMain = resolveKeplerMain();
    if (!fs.existsSync(keplerMain)) {
        process.stderr.write(`ERR: kepler main not found at ${keplerMain}\n`);
        process.exit(1);
    }

    const qFile = JSON.parse(fs.readFileSync(opts.questions, 'utf8'));
    const questions = qFile.questions;

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = opts.outDir || path.join(__dirname, 'results', `${opts.label}-${ts}`);
    fs.mkdirSync(outDir, { recursive: true });

    const runManifest = {
        schema: 'kepler.model-comparison-run/1',
        label: opts.label,
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
        },
        turns: [],
    };

    process.stderr.write(`\n═══════════════════════════════════════════════════════\n`);
    process.stderr.write(`Model Comparison Harness — label="${opts.label}"\n`);
    process.stderr.write(`  Backend env: ${process.env.TARANG_ENV || '(default)'}\n`);
    process.stderr.write(`  Model:       ${opts.model || '(backend default)'}\n`);
    process.stderr.write(`  Route:       ${opts.route || '(unset)'}\n`);
    process.stderr.write(`  Questions:   ${questions.length} from ${opts.questions}\n`);
    process.stderr.write(`  Output dir:  ${outDir}\n`);
    process.stderr.write(`═══════════════════════════════════════════════════════\n`);

    const perTurn = [];
    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const jsonlPath = path.join(outDir, `q${q.q}-raw.jsonl`);
        process.stderr.write(`\n[Q${q.q}] ${q.text.slice(0, 90)}${q.text.length > 90 ? '…' : ''}\n`);
        const startMs = Date.now();
        const { exitCode, events } = await runTurn({
            keplerMain,
            question: q.text,
            model: opts.model,
            route: opts.route,
            resume: i > 0,
            timeoutS: opts.timeoutS,
            verbose: opts.verbose,
            jsonlPath,
        });
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
            jsonl_path: path.relative(outDir, jsonlPath),
        });
        process.stderr.write(
            `  → ${summary.duration_s.toFixed(1)}s | ` +
            `${summary.tools_total} tools (${summary.tools_primary}P + ${summary.tools_sub_agent}S) | ` +
            `$${summary.cost_usd.toFixed(4)}` +
            (summary.errors.length ? ` | ERRORS: ${summary.errors.join(', ')}` : '') +
            (summary.timed_out ? ` | TIMED OUT` : '') + '\n'
        );
        if (exitCode !== 0 && !summary.timed_out) {
            process.stderr.write(`  ! CLI exited ${exitCode}; continuing to next question\n`);
        }
    }

    runManifest.aggregate = summarizeSession(perTurn);
    runManifest.completed_at = new Date().toISOString();

    // Write summary
    const summaryPath = path.join(outDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(runManifest, null, 2) + '\n');

    // Human-readable comparison table
    const table = renderTable(perTurn, questions);
    process.stderr.write(table);
    process.stderr.write(`\nSession totals:\n`);
    const agg = runManifest.aggregate;
    process.stderr.write(`  Runtime:          ${agg.total_duration_s.toFixed(1)}s\n`);
    process.stderr.write(`  Tools:            ${agg.total_tools} (primary=${agg.total_tools_primary}, sub=${agg.total_tools_sub_agent}, split=${agg.total_tools > 0 ? Math.round(agg.total_tools_primary / agg.total_tools * 100) : 0}/${agg.total_tools > 0 ? Math.round(agg.total_tools_sub_agent / agg.total_tools * 100) : 0})\n`);
    process.stderr.write(`  Input tokens:     ${agg.total_input_tokens.toLocaleString()}\n`);
    process.stderr.write(`  Output tokens:    ${agg.total_output_tokens.toLocaleString()}\n`);
    process.stderr.write(`  Cache read:       ${agg.total_cache_read.toLocaleString()}\n`);
    process.stderr.write(`  Cache hit rate:   ${agg.cache_hit_rate_pct}%\n`);
    process.stderr.write(`  Total COGS:       $${agg.total_cost_usd.toFixed(4)}\n`);
    process.stderr.write(`  Errors:           ${agg.errors} turn(s)\n`);
    process.stderr.write(`  Timeouts:         ${agg.timed_out} turn(s)\n`);
    process.stderr.write(`\nDetails: ${summaryPath}\n`);

    // Emit final aggregate on stdout as one JSON object for easy consumption
    // by downstream scripts (curl into a spreadsheet, etc.)
    process.stdout.write(JSON.stringify(runManifest, null, 2) + '\n');
}

main().catch((err) => {
    process.stderr.write(`FATAL: ${err.stack || err.message}\n`);
    process.exit(2);
});
