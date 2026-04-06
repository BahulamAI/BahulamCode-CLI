#!/usr/bin/env node
/**
 * @tarang/cli — Tarang AI Coding Agent CLI
 *
 * Hybrid local/remote multi-agent orchestration.
 * Built on open-claude-code v2 scaffold.
 *
 * Phase 1: SSE consumer + tool executor + callback client.
 */

import { TarangStreamClient, EVENT_TYPES } from './core/stream-client.mjs';
import { createToolExecutor } from './core/tool-executor.mjs';
import { TarangAuth } from './auth/tarang-auth.mjs';

const VERSION = '5.0.0-alpha.1';

// ── Arg Parsing ─────────────────────────────────────────────

function parseArgs(argv) {
    const args = {
        command: null,       // login, config, resume
        instruction: null,   // positional instruction
        verbose: false,
        yes: false,
        version: false,
        help: false,
        // config subcommand opts
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
            case 'login': args.command = 'login'; break;
            case 'resume': args.command = 'resume'; break;
            case 'config':
                args.command = 'config';
                break;
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
  tarang config -k KEY         Set OpenRouter API key
  tarang resume                Resume a paused session

\x1b[1mFLAGS\x1b[0m
  --verbose, -v                Show tool details and thinking
  --yes, -y                    Auto-approve all operations
  --version, -V                Show version
  --help, -h                   Show this help

\x1b[1mCONFIG\x1b[0m
  --openrouter-key KEY         Set OpenRouter API key
  --anthropic-key KEY          Set Anthropic API key
  --backend-url URL            Set custom backend URL
  --mode local|remote|auto     Set default execution mode

\x1b[1mEXAMPLES\x1b[0m
  tarang "add user authentication"
  tarang -v "explain the project structure"
  tarang --yes "fix the login bug"
  npx @tarang/cli "add auth"
`);
}

// ── Event Rendering ─────────────────────────────────────────

function renderEvent(event, verbose = false) {
    const { type, data } = event;
    switch (type) {
        case EVENT_TYPES.STATUS:
            process.stderr.write(`\x1b[2m${data.message || ''}\x1b[0m\n`);
            break;
        case EVENT_TYPES.PLAN:
            if (data.milestones) {
                process.stderr.write('\n\x1b[1mPlan:\x1b[0m\n');
                for (const m of data.milestones) {
                    const icon = m.status === 'completed' ? '✓' : m.status === 'failed' ? '✗' : '○';
                    process.stderr.write(`  ${icon} ${m.name}${m.description ? ': ' + m.description : ''}\n`);
                }
                process.stderr.write('\n');
            }
            break;
        case EVENT_TYPES.CONTENT:
            process.stdout.write(data.text || data.message || '');
            break;
        case EVENT_TYPES.ERROR:
            process.stderr.write(`\x1b[31m✗ ${data.message || 'Unknown error'}\x1b[0m\n`);
            break;
        case EVENT_TYPES.COMPLETE:
            process.stderr.write(`\n\x1b[32m✓ ${data.summary || 'Done'}`);
            if (data.changes) process.stderr.write(` (${data.changes} changes)`);
            if (data.duration_s) process.stderr.write(` in ${data.duration_s.toFixed(1)}s`);
            process.stderr.write('\x1b[0m\n');
            break;
        // Phase 2: remaining events
        case EVENT_TYPES.THINKING:
            if (verbose) process.stderr.write(`\x1b[2m${(data.text || '').slice(0, 200)}\x1b[0m\n`);
            break;
        case EVENT_TYPES.PHASE_UPDATE:
        case EVENT_TYPES.PHASE_SUMMARY:
        case EVENT_TYPES.WORKER_UPDATE:
        case EVENT_TYPES.DELEGATION:
            if (verbose) process.stderr.write(`\x1b[2m[${type}] ${JSON.stringify(data).slice(0, 120)}\x1b[0m\n`);
            break;
        default:
            if (verbose) process.stderr.write(`\x1b[2m[${type}] ${JSON.stringify(data).slice(0, 100)}\x1b[0m\n`);
            break;
    }
}

// ── Interactive REPL ────────────────────────────────────────

async function startRepl(client, verbose) {
    const readline = await import('node:readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
        prompt: '\x1b[36mtarang>\x1b[0m ',
    });

    console.error(`\x1b[1m@tarang/cli v${VERSION}\x1b[0m — Type an instruction or /help\n`);
    rl.prompt();

    rl.on('line', async (line) => {
        const input = line.trim();
        if (!input) { rl.prompt(); return; }

        if (input === '/exit' || input === '/quit') {
            rl.close();
            process.exit(0);
        }
        if (input === '/help') {
            console.error('  /help    Show this help');
            console.error('  /exit    Exit CLI');
            console.error('  /config  Show configuration');
            console.error('  Or type any instruction to execute.\n');
            rl.prompt();
            return;
        }
        if (input === '/config') {
            const auth = new TarangAuth();
            auth.printConfig();
            rl.prompt();
            return;
        }

        try {
            for await (const event of client.execute(input)) {
                renderEvent(event, verbose);
            }
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
        if (args.openRouterKey) {
            auth.saveOpenRouterKey(args.openRouterKey);
            console.log('✓ OpenRouter key saved.');
        }
        if (args.anthropicKey) {
            auth.saveAnthropicKey(args.anthropicKey);
            console.log('✓ Anthropic key saved.');
        }
        if (args.backendUrl) {
            auth.setBackendUrl(args.backendUrl);
            console.log(`✓ Backend URL set to ${args.backendUrl}`);
        }
        if (args.mode) {
            auth.setMode(args.mode);
            console.log(`✓ Mode set to ${args.mode}`);
        }
        if (args.showConfig || (!args.openRouterKey && !args.anthropicKey && !args.backendUrl && !args.mode)) {
            auth.printConfig();
        }
        process.exit(0);
    }

    // ── Load credentials ──
    const creds = auth.loadCredentials();

    // ── Create tool executor + stream client ──
    const toolExecutor = createToolExecutor();
    const client = new TarangStreamClient({
        baseUrl: creds.backendUrl,
        token: creds.token,
        openRouterKey: creds.openRouterKey,
        toolExecutor,
        verbose: args.verbose,
    });

    // ── Graceful shutdown ──
    process.on('SIGINT', async () => {
        await client.cancel();
        process.exit(0);
    });
    process.on('SIGTERM', async () => {
        await client.cancel();
        process.exit(0);
    });

    // ── One-shot mode ──
    if (args.instruction) {
        for await (const event of client.execute(args.instruction)) {
            renderEvent(event, args.verbose);
        }
        process.stdout.write('\n');
        process.exit(0);
    }

    // ── Interactive REPL ──
    await startRepl(client, args.verbose);
}

main().catch(err => {
    console.error(`\x1b[31mFatal: ${err.message}\x1b[0m`);
    process.exit(1);
});
