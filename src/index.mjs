#!/usr/bin/env node
/**
 * @tarang/cli v5.0.0 — Tarang AI Coding Agent CLI
 *
 * Phase 3: Hybrid local/remote/auto + advanced features.
 */

import { TarangStreamClient, EVENT_TYPES } from './core/stream-client.mjs';
import { LocalAgent } from './core/local-agent.mjs';
import { createToolExecutor } from './core/tool-executor.mjs';
import { TarangAuth } from './auth/tarang-auth.mjs';
import { ApprovalManager } from './core/approval.mjs';
import { SessionManager } from './core/session-manager.mjs';
import { EventFormatter } from './ui/formatter.mjs';
import { handleSlashCommand, COMMANDS } from './ui/slash-commands.mjs';
import { selectMode } from './core/mode-selector.mjs';

const VERSION = '5.0.0';

// ── Arg Parsing ─────────────────────────────────────────────

function parseArgs(argv) {
    const args = {
        command: null, instruction: null,
        verbose: false, yes: false, plan: false, strict: false,
        local: false, remote: false,
        version: false, help: false,
        showConfig: false, openRouterKey: null, anthropicKey: null,
        backendUrl: null, mode: null,
    };
    let i = 0;
    while (i < argv.length) {
        const arg = argv[i];
        switch (arg) {
            case '--version': case '-V': args.version = true; break;
            case '--help': case '-h': args.help = true; break;
            case '--verbose': case '-v': args.verbose = true; break;
            case '--yes': case '-y': args.yes = true; break;
            case '--plan': args.plan = true; break;
            case '--strict': args.strict = true; break;
            case '--local': args.local = true; break;
            case '--remote': args.remote = true; break;
            case 'login': args.command = 'login'; break;
            case 'resume': args.command = 'resume'; break;
            case 'config': args.command = 'config'; break;
            case '--show': args.showConfig = true; break;
            case '--openrouter-key': case '-k': args.openRouterKey = argv[++i]; break;
            case '--anthropic-key': args.anthropicKey = argv[++i]; break;
            case '--backend-url': args.backendUrl = argv[++i]; break;
            case '--mode': args.mode = argv[++i]; break;
            default:
                if (!arg.startsWith('-') && !args.command && !args.instruction) args.instruction = arg;
                break;
        }
        i++;
    }
    if (!args.verbose && process.env.TARANG_VERBOSE === '1') args.verbose = true;
    if (!args.yes && process.env.TARANG_YES === '1') args.yes = true;
    return args;
}

function printUsage() {
    console.log(`
\x1b[1m@tarang/cli v${VERSION}\x1b[0m — AI Coding Agent CLI (Hybrid)

\x1b[1mUSAGE\x1b[0m
  tarang "instruction"         Execute instruction
  tarang                       Interactive mode (REPL)
  tarang login                 Authenticate via GitHub OAuth
  tarang config --show         Display configuration
  tarang resume                Resume a paused session

\x1b[1mMODE FLAGS\x1b[0m
  --local                      Direct LLM API (<100ms, offline)
  --remote                     SSE backend (multi-agent orchestration)
  (default: auto-select based on task complexity)

\x1b[1mPERMISSION FLAGS\x1b[0m
  --yes, -y                    Auto-approve all operations
  --plan                       Read-only mode (block all writes)
  --strict                     Deny tools not in allowed list

\x1b[1mOTHER FLAGS\x1b[0m
  --verbose, -v                Show tool details and thinking
  --version, -V                Show version
  --help, -h                   Show this help

\x1b[1mSLASH COMMANDS\x1b[0m (interactive mode)
${Object.entries(COMMANDS).map(([k, v]) => `  ${k.padEnd(14)} ${v.description}`).join('\n')}
`);
}

// ── Execute ─────────────────────────────────────────────────

async function executeInstruction(executor, instruction, formatter, sessionMgr) {
    sessionMgr.start(instruction);
    for await (const event of executor) {
        formatter.render(event);
        if (event.type === 'session_info') sessionMgr.setSessionInfo(event.data);
        if (event.type === 'tool_call' || event.type === 'tool_request') sessionMgr.recordToolCall(event.data?.tool);
        if (event.type === 'complete') sessionMgr.complete(event.data?.summary);
        if (event.type === 'error' && event.data?.fatal) sessionMgr.fail(event.data?.message);
        if (event.type === 'cancelled') sessionMgr.cancel();
        if (event.type === 'paused') sessionMgr.pause();
    }
}

// ── REPL ────────────────────────────────────────────────────

async function startRepl(createExecutor, formatter, sessionMgr, auth, args) {
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, prompt: '\x1b[36mtarang>\x1b[0m ' });
    const ctx = { formatter, auth, model: null, sessionMgr };

    process.stderr.write(`\x1b[1m@tarang/cli v${VERSION}\x1b[0m — Type an instruction or /help\n\n`);
    rl.prompt();

    rl.on('line', async (line) => {
        const input = line.trim();
        if (!input) { rl.prompt(); return; }
        if (input.startsWith('/')) { handleSlashCommand(input, ctx); rl.prompt(); return; }

        try {
            const exec = await createExecutor(input);
            await executeInstruction(exec, input, formatter, sessionMgr);
        } catch (err) {
            process.stderr.write(`\x1b[31mError: ${err.message}\x1b[0m\n`);
        }
        process.stdout.write('\n');
        rl.prompt();
    });

    rl.on('close', () => process.exit(0));
}

// ── Main ────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.version) { console.log(`@tarang/cli ${VERSION}`); process.exit(0); }
    if (args.help) { printUsage(); process.exit(0); }

    const auth = new TarangAuth();

    if (args.command === 'login') {
        const creds = auth.loadCredentials();
        await auth.login(args.backendUrl || creds.backendUrl);
        console.log('\x1b[32m✓ Login successful!\x1b[0m');
        process.exit(0);
    }

    if (args.command === 'config') {
        if (args.openRouterKey) { auth.saveOpenRouterKey(args.openRouterKey); console.log('✓ OpenRouter key saved.'); }
        if (args.anthropicKey) { auth.saveAnthropicKey(args.anthropicKey); console.log('✓ Anthropic key saved.'); }
        if (args.backendUrl) { auth.setBackendUrl(args.backendUrl); console.log(`✓ Backend URL set.`); }
        if (args.mode) { auth.setMode(args.mode); console.log(`✓ Mode set to ${args.mode}`); }
        if (args.showConfig || (!args.openRouterKey && !args.anthropicKey && !args.backendUrl && !args.mode)) auth.printConfig();
        process.exit(0);
    }

    const creds = auth.loadCredentials();
    const token = process.env.TARANG_TOKEN || creds.token;
    const openRouterKey = process.env.TARANG_OPENROUTER_KEY || creds.openRouterKey;
    const anthropicKey = process.env.ANTHROPIC_API_KEY || creds.anthropicKey;
    const backendUrl = process.env.TARANG_BACKEND_URL || creds.backendUrl;

    const toolExecutor = createToolExecutor();
    const approval = new ApprovalManager({ autoApprove: args.yes, planMode: args.plan });
    const formatter = new EventFormatter({ verbose: args.verbose });
    const sessionMgr = new SessionManager();

    /** Create an executor (local or remote) for a given instruction. */
    async function createExecutor(instruction) {
        const mode = await selectMode(instruction, args, { ...creds, backendUrl });

        if (mode === 'local') {
            if (args.verbose) process.stderr.write('\x1b[2m[mode] local\x1b[0m\n');
            return new LocalAgent({
                apiKey: anthropicKey,
                openRouterKey,
                model: 'claude-sonnet-4-20250514',
                toolExecutor,
                verbose: args.verbose,
            }).execute(instruction, { cwd: process.cwd() });
        } else {
            if (args.verbose) process.stderr.write('\x1b[2m[mode] remote\x1b[0m\n');
            const client = new TarangStreamClient({
                baseUrl: backendUrl, token, openRouterKey, toolExecutor,
                verbose: args.verbose, approvalManager: approval,
            });
            process.on('SIGINT', async () => { await client.cancel().catch(() => {}); process.exit(0); });
            return client.execute(instruction);
        }
    }

    if (args.command === 'resume') {
        const state = sessionMgr.loadState();
        if (!state || state.status === 'completed') { process.stderr.write('No resumable session.\n'); process.exit(1); }
        const client = new TarangStreamClient({ baseUrl: backendUrl, token, openRouterKey, toolExecutor, verbose: args.verbose, approvalManager: approval });
        client.currentTaskId = state.task_id;
        await client.resume();
        for await (const event of client.execute(state.instruction)) formatter.render(event);
        process.exit(0);
    }

    if (args.instruction) {
        const exec = await createExecutor(args.instruction);
        await executeInstruction(exec, args.instruction, formatter, sessionMgr);
        process.stdout.write('\n');
        process.exit(0);
    }

    await startRepl(createExecutor, formatter, sessionMgr, auth, args);
}

main().catch(err => { process.stderr.write(`\x1b[31mFatal: ${err.message}\x1b[0m\n`); process.exit(1); });
