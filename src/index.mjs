#!/usr/bin/env node
/**
 * @tarang/cli — Tarang AI Coding Agent CLI
 *
 * Phase 2: Full UI/UX parity with Python CLI.
 * - All 22 SSE events (T9)
 * - 14 slash commands (T10)
 * - Approval flow Y/n/v/a/t (T11)
 * - Keyboard: ESC=cancel, SPACE=pause (T12)
 * - Session management (T13)
 * - Control endpoints (T14)
 * - Config management with env fallbacks (T15)
 * - Error handling & output filtering (T16)
 */

import { TarangStreamClient, EVENT_TYPES } from './core/stream-client.mjs';
import { createToolExecutor } from './core/tool-executor.mjs';
import { TarangAuth } from './auth/tarang-auth.mjs';
import { ApprovalManager } from './core/approval.mjs';
import { SessionManager } from './core/session-manager.mjs';
import { EventFormatter } from './ui/formatter.mjs';
import { handleSlashCommand, COMMANDS } from './ui/slash-commands.mjs';

const VERSION = '5.0.0-beta.1';

// ── Arg Parsing (T15) ──────────────────────────────────────

function parseArgs(argv) {
    const args = {
        command: null,
        instruction: null,
        verbose: false,
        yes: false,
        plan: false,
        version: false,
        help: false,
        showConfig: false,
        openRouterKey: null,
        anthropicKey: null,
        backendUrl: null,
        mode: null,
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
            case 'login': args.command = 'login'; break;
            case 'resume': args.command = 'resume'; break;
            case 'config': args.command = 'config'; break;
            case '--show': args.showConfig = true; break;
            case '--openrouter-key': case '-k': args.openRouterKey = argv[++i]; break;
            case '--anthropic-key': args.anthropicKey = argv[++i]; break;
            case '--backend-url': args.backendUrl = argv[++i]; break;
            case '--mode': args.mode = argv[++i]; break;
            default:
                if (!arg.startsWith('-') && !args.command && !args.instruction) {
                    args.instruction = arg;
                }
                break;
        }
        i++;
    }

    // T15: env var fallbacks
    if (!args.verbose && process.env.TARANG_VERBOSE === '1') args.verbose = true;
    if (!args.yes && process.env.TARANG_YES === '1') args.yes = true;

    return args;
}

function printUsage() {
    console.log(`
\x1b[1m@tarang/cli v${VERSION}\x1b[0m — AI Coding Agent CLI

\x1b[1mUSAGE\x1b[0m
  tarang "instruction"         Execute instruction (one-shot)
  tarang                       Interactive mode (REPL)
  tarang login                 Authenticate via GitHub OAuth
  tarang config --show         Display configuration
  tarang resume                Resume a paused session

\x1b[1mFLAGS\x1b[0m
  --verbose, -v                Show tool details and thinking
  --yes, -y                    Auto-approve all operations
  --plan                       Read-only mode (block all writes)
  --version, -V                Show version
  --help, -h                   Show this help

\x1b[1mCONFIG\x1b[0m
  --openrouter-key KEY         Set OpenRouter API key
  --anthropic-key KEY          Set Anthropic API key
  --backend-url URL            Set custom backend URL
  --mode local|remote|auto     Set default execution mode

\x1b[1mSLASH COMMANDS\x1b[0m (interactive mode)
${Object.entries(COMMANDS).map(([k, v]) => `  ${k.padEnd(14)} ${v.description}`).join('\n')}

\x1b[1mKEYBOARD\x1b[0m
  ESC                          Cancel current execution
  SPACE                        Pause + inject instruction
  Ctrl+C                       Exit

\x1b[1mEXAMPLES\x1b[0m
  tarang "add user authentication"
  tarang -v "explain the project structure"
  tarang --yes "fix the login bug"
  tarang --plan "analyze the codebase"
`);
}

// ── Execute & Render ────────────────────────────────────────

async function executeInstruction(client, instruction, formatter, sessionMgr) {
    sessionMgr.start(instruction);

    for await (const event of client.execute(instruction)) {
        formatter.render(event);

        // Track session state
        if (event.type === 'session_info') sessionMgr.setSessionInfo(event.data);
        if (event.type === 'tool_call' || event.type === 'tool_request') sessionMgr.recordToolCall(event.data?.tool);
        if (event.type === 'complete') sessionMgr.complete(event.data?.summary);
        if (event.type === 'error' && event.data?.fatal) sessionMgr.fail(event.data?.message);
        if (event.type === 'cancelled') sessionMgr.cancel();
        if (event.type === 'paused') sessionMgr.pause();
    }
}

// ── Interactive REPL (T10, T12, T14) ────────────────────────

async function startRepl(client, formatter, sessionMgr, auth, args) {
    const readline = await import('node:readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
        prompt: '\x1b[36mtarang>\x1b[0m ',
    });

    const ctx = { formatter, auth, model: null, sessionMgr };

    process.stderr.write(`\x1b[1m@tarang/cli v${VERSION}\x1b[0m — Type an instruction or /help\n\n`);

    // T12: keyboard controls (ESC, SPACE) in raw mode during execution
    let executing = false;

    if (process.stdin.isTTY) {
        process.stdin.on('keypress', async (str, key) => {
            if (!executing) return;
            if (key && key.name === 'escape') {
                process.stderr.write('\n\x1b[33mCancelling...\x1b[0m\n');
                await client.cancel();
                sessionMgr.cancel();
            }
        });
    }

    rl.prompt();

    rl.on('line', async (line) => {
        const input = line.trim();
        if (!input) { rl.prompt(); return; }

        // T10: slash commands
        if (input.startsWith('/')) {
            handleSlashCommand(input, ctx);
            rl.prompt();
            return;
        }

        // Execute instruction
        executing = true;
        try {
            await executeInstruction(client, input, formatter, sessionMgr);
        } catch (err) {
            process.stderr.write(`\x1b[31mError: ${err.message}\x1b[0m\n`);
        }
        executing = false;
        process.stdout.write('\n');
        rl.prompt();
    });

    rl.on('close', () => process.exit(0));
}

// ── Resume (T14) ────────────────────────────────────────────

async function handleResume(client, sessionMgr, formatter) {
    const state = sessionMgr.loadState();
    if (!state) {
        process.stderr.write('No saved session to resume.\n');
        process.exit(1);
    }
    if (state.status === 'completed') {
        process.stderr.write(`Session already completed: ${state.summary || ''}\n`);
        process.exit(0);
    }
    if (state.status === 'failed') {
        process.stderr.write(`Session failed: ${state.error || ''}\n`);
        process.exit(1);
    }
    if (state.status !== 'paused' && state.status !== 'running') {
        process.stderr.write(`Session status: ${state.status}. Cannot resume.\n`);
        process.exit(1);
    }

    process.stderr.write(`Resuming session: ${state.instruction || ''}\n`);
    client.currentTaskId = state.task_id;
    await client.resume();

    // Re-consume the stream
    for await (const event of client.execute(state.instruction)) {
        formatter.render(event);
    }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.version) {
        console.log(`@tarang/cli ${VERSION}`);
        process.exit(0);
    }
    if (args.help) {
        printUsage();
        process.exit(0);
    }

    const auth = new TarangAuth();

    // ── Subcommands ──

    if (args.command === 'login') {
        const creds = auth.loadCredentials();
        await auth.login(args.backendUrl || creds.backendUrl);
        console.log('\x1b[32m✓ Login successful!\x1b[0m');
        process.exit(0);
    }

    if (args.command === 'config') {
        if (args.openRouterKey) { auth.saveOpenRouterKey(args.openRouterKey); console.log('✓ OpenRouter key saved.'); }
        if (args.anthropicKey) { auth.saveAnthropicKey(args.anthropicKey); console.log('✓ Anthropic key saved.'); }
        if (args.backendUrl) { auth.setBackendUrl(args.backendUrl); console.log(`✓ Backend URL set to ${args.backendUrl}`); }
        if (args.mode) { auth.setMode(args.mode); console.log(`✓ Mode set to ${args.mode}`); }
        if (args.showConfig || (!args.openRouterKey && !args.anthropicKey && !args.backendUrl && !args.mode)) {
            auth.printConfig();
        }
        process.exit(0);
    }

    // ── Load credentials (T15: env var fallbacks) ──
    const creds = auth.loadCredentials();
    const token = process.env.TARANG_TOKEN || creds.token;
    const openRouterKey = process.env.TARANG_OPENROUTER_KEY || creds.openRouterKey;
    const backendUrl = process.env.TARANG_BACKEND_URL || creds.backendUrl;

    // ── Create components ──
    const toolExecutor = createToolExecutor();
    const approval = new ApprovalManager({ autoApprove: args.yes, planMode: args.plan });
    const formatter = new EventFormatter({ verbose: args.verbose });
    const sessionMgr = new SessionManager();

    const client = new TarangStreamClient({
        baseUrl: backendUrl,
        token,
        openRouterKey,
        toolExecutor,
        verbose: args.verbose,
        approvalManager: approval,
    });

    // ── Graceful shutdown (T16) ──
    const shutdown = async () => {
        await client.cancel().catch(() => {});
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // ── Resume command (T14) ──
    if (args.command === 'resume') {
        await handleResume(client, sessionMgr, formatter);
        process.exit(0);
    }

    // ── One-shot mode ──
    if (args.instruction) {
        await executeInstruction(client, args.instruction, formatter, sessionMgr);
        process.stdout.write('\n');
        process.exit(0);
    }

    // ── Interactive REPL ──
    await startRepl(client, formatter, sessionMgr, auth, args);
}

main().catch(err => {
    process.stderr.write(`\x1b[31mFatal: ${err.message}\x1b[0m\n`);
    process.exit(1);
});
