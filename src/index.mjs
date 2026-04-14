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
import { printBanner, printProjectInfo, printHints, printAuthStatus, printStyledConfig, printGoodbye } from './ui/banner.mjs';
import { ContextRetriever } from './context/retriever.mjs';
import { loadSettings } from './config/settings.mjs';

const VERSION = '5.0.0';

// ── Arg Parsing (consolidated from index.mjs + cli-args.mjs) ──

function parseArgs(argv) {
    const args = {
        // Commands
        command: null, instruction: null,
        // Tarang mode flags
        verbose: false, yes: false, plan: false, strict: false,
        local: false, remote: false, debug: false,
        version: false, help: false,
        // Config subcommand flags
        showConfig: false, openRouterKey: null, anthropicKey: null,
        backendUrl: null, mode: null,
        // Extended flags (from cli-args.mjs)
        model: null,
        permissionMode: null,
        outputFormat: null,
        systemPrompt: null,
        addDirs: [],
        maxTurns: null,
        allowedTools: null,
        disallowedTools: null,
    };
    let i = 0;
    while (i < argv.length) {
        const arg = argv[i];
        switch (arg) {
            // Version / help
            case '--version': case '-V': args.version = true; break;
            case '--help': case '-h': args.help = true; break;
            // Behavior flags
            case '--verbose': case '-v': args.verbose = true; break;
            case '--debug': case '-d': args.debug = true; args.verbose = true; break;
            case '--yes': case '-y': args.yes = true; break;
            case '--plan': args.plan = true; break;
            case '--strict': args.strict = true; break;
            // Mode flags
            case '--local': args.local = true; break;
            case '--remote': args.remote = true; break;
            case '--mode': args.mode = argv[++i]; break;
            // Commands
            case 'login': args.command = 'login'; break;
            case 'resume': args.command = 'resume'; break;
            case 'config': args.command = 'config'; break;
            // Config flags
            case '--show': args.showConfig = true; break;
            case '--openrouter-key': case '-k': args.openRouterKey = argv[++i]; break;
            case '--anthropic-key': args.anthropicKey = argv[++i]; break;
            case '--backend-url': args.backendUrl = argv[++i]; break;
            // Extended flags
            case '--model': case '-m': args.model = argv[++i]; break;
            case '--permission-mode': args.permissionMode = argv[++i]; break;
            case '--print': case '-p': args.instruction = argv[++i]; break;
            case '--output-format': args.outputFormat = argv[++i]; break;
            case '--system-prompt': args.systemPrompt = argv[++i]; break;
            case '--add-dir': args.addDirs.push(argv[++i]); break;
            case '--max-turns': args.maxTurns = parseInt(argv[++i], 10); break;
            case '--allowedTools': args.allowedTools = argv[++i]?.split(',').map(s => s.trim()); break;
            case '--disallowedTools': args.disallowedTools = argv[++i]?.split(',').map(s => s.trim()); break;
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
    printBanner();

    const B = '\x1b[1m', C = '\x1b[36m', D = '\x1b[2m', G = '\x1b[32m', R = '\x1b[0m';

    process.stderr.write(`${B}USAGE${R}\n`);
    process.stderr.write(`  ${C}tarang "instruction"${R}         Execute instruction\n`);
    process.stderr.write(`  ${C}tarang${R}                       Interactive mode (REPL)\n`);
    process.stderr.write(`  ${C}tarang login${R}                 Authenticate via GitHub OAuth\n`);
    process.stderr.write(`  ${C}tarang config --show${R}         Display configuration\n`);
    process.stderr.write(`  ${C}tarang resume${R}                Resume a paused session\n`);
    process.stderr.write('\n');
    process.stderr.write(`${B}MODE FLAGS${R}\n`);
    process.stderr.write(`  ${G}--local${R}                      Direct LLM API ${D}(<100ms, offline)${R}\n`);
    process.stderr.write(`  ${G}--remote${R}                     SSE backend ${D}(multi-agent orchestration)${R}\n`);
    process.stderr.write(`  ${G}--mode <auto|local|remote>${R}   Set mode explicitly\n`);
    process.stderr.write(`  ${D}(default: auto-select based on task complexity)${R}\n`);
    process.stderr.write('\n');
    process.stderr.write(`${B}MODEL FLAGS${R}\n`);
    process.stderr.write(`  ${G}--model, -m <model>${R}          Model to use ${D}(e.g., claude-sonnet-4-6)${R}\n`);
    process.stderr.write(`  ${G}--system-prompt <text>${R}       Override system prompt\n`);
    process.stderr.write(`  ${G}--max-turns <n>${R}              Maximum conversation turns\n`);
    process.stderr.write('\n');
    process.stderr.write(`${B}PERMISSION FLAGS${R}\n`);
    process.stderr.write(`  ${G}--yes, -y${R}                    Auto-approve all operations\n`);
    process.stderr.write(`  ${G}--plan${R}                       Read-only mode (block all writes)\n`);
    process.stderr.write(`  ${G}--strict${R}                     Deny tools not in allowed list\n`);
    process.stderr.write(`  ${G}--permission-mode <mode>${R}     Permission mode ${D}(auto, plan, strict)${R}\n`);
    process.stderr.write(`  ${G}--allowedTools <tools>${R}       Comma-separated allowed tools\n`);
    process.stderr.write(`  ${G}--disallowedTools <tools>${R}    Comma-separated denied tools\n`);
    process.stderr.write('\n');
    process.stderr.write(`${B}OUTPUT FLAGS${R}\n`);
    process.stderr.write(`  ${G}--print, -p <prompt>${R}         Non-interactive: run prompt and exit\n`);
    process.stderr.write(`  ${G}--output-format <fmt>${R}        Output format: text, json, stream-json\n`);
    process.stderr.write(`  ${G}--verbose, -v${R}                Show tool details and thinking\n`);
    process.stderr.write(`  ${G}--debug, -d${R}                  Debug mode ${D}(implies verbose)${R}\n`);
    process.stderr.write('\n');
    process.stderr.write(`${B}OTHER FLAGS${R}\n`);
    process.stderr.write(`  ${G}--version, -V${R}                Show version\n`);
    process.stderr.write(`  ${G}--help, -h${R}                   Show this help\n`);
    process.stderr.write(`  ${G}--add-dir <dir>${R}              Additional CLAUDE.md directory\n`);
    process.stderr.write('\n');
    process.stderr.write(`${B}SLASH COMMANDS${R} ${D}(interactive mode)${R}\n`);
    for (const [k, v] of Object.entries(COMMANDS)) {
        process.stderr.write(`  ${C}${k.padEnd(14)}${R} ${v.description}\n`);
    }
    process.stderr.write('\n');
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

    // Branded startup
    printBanner();
    printProjectInfo(VERSION);
    process.stderr.write('\n');

    // Show auth status on startup
    const creds = auth.loadCredentials();
    printAuthStatus(creds);

    // Guided first-run: prompt login if not authenticated
    if (!creds.token && !creds.openRouterKey && !creds.anthropicKey) {
        process.stderr.write('\x1b[33mFirst time? Get started:\x1b[0m\n');
        process.stderr.write('  1. \x1b[36mtarang login\x1b[0m              Authenticate via GitHub\n');
        process.stderr.write('  2. \x1b[36mtarang config -k KEY\x1b[0m     Set your OpenRouter API key\n');
        process.stderr.write('  3. \x1b[36mtarang "your instruction"\x1b[0m Start coding!\n');
        process.stderr.write('\n');
    }

    printHints();
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

    rl.on('close', () => {
        printGoodbye();
        process.exit(0);
    });
}

// ── Main ────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.version) { console.log(`@tarang/cli ${VERSION}`); process.exit(0); }
    if (args.help) { printUsage(); process.exit(0); }

    const auth = new TarangAuth();

    if (args.command === 'login') {
        printBanner();
        process.stderr.write('\x1b[1mAuthentication\x1b[0m\n\n');
        const creds = auth.loadCredentials();
        await auth.login(args.backendUrl || creds.backendUrl);
        process.stderr.write('\n\x1b[32m✓ Login successful!\x1b[0m\n');

        if (!auth.hasOpenRouterKey()) {
            process.stderr.write('\n\x1b[33mNext step:\x1b[0m Set your OpenRouter API key:\n');
            process.stderr.write('  \x1b[36mtarang config --openrouter-key YOUR_KEY\x1b[0m\n\n');
        }
        process.exit(0);
    }

    if (args.command === 'config') {
        if (args.openRouterKey) { auth.saveOpenRouterKey(args.openRouterKey); process.stderr.write('\x1b[32m✓ OpenRouter key saved.\x1b[0m\n'); }
        if (args.anthropicKey) { auth.saveAnthropicKey(args.anthropicKey); process.stderr.write('\x1b[32m✓ Anthropic key saved.\x1b[0m\n'); }
        if (args.backendUrl) { auth.setBackendUrl(args.backendUrl); process.stderr.write(`\x1b[32m✓ Backend URL set.\x1b[0m\n`); }
        if (args.mode) { auth.setMode(args.mode); process.stderr.write(`\x1b[32m✓ Mode set to ${args.mode}\x1b[0m\n`); }
        if (args.showConfig || (!args.openRouterKey && !args.anthropicKey && !args.backendUrl && !args.mode)) {
            printStyledConfig(auth.loadCredentials());
        }
        process.exit(0);
    }

    // Load settings (user ~/.claude/settings.json + project .claude/settings.json + local)
    const settings = await loadSettings();

    const creds = auth.loadCredentials();
    const token = process.env.TARANG_TOKEN || creds.token;
    const openRouterKey = process.env.TARANG_OPENROUTER_KEY || creds.openRouterKey;
    const anthropicKey = process.env.ANTHROPIC_API_KEY || creds.anthropicKey;
    const backendUrl = process.env.TARANG_BACKEND_URL || creds.backendUrl;

    // Apply settings as defaults (CLI flags override settings)
    if (!args.model && settings.model) args.model = settings.model;
    if (!args.verbose && settings.debugMode) args.verbose = true;
    if (!args.permissionMode && settings.permissions?.defaultMode !== 'default') {
        args.permissionMode = settings.permissions.defaultMode;
    }

    const toolExecutor = createToolExecutor();
    const approval = new ApprovalManager({ autoApprove: args.yes, planMode: args.plan });
    const formatter = new EventFormatter({ verbose: args.verbose });
    const sessionMgr = new SessionManager();
    const contextRetriever = new ContextRetriever(process.cwd());

    /** Create an executor (local or remote) for a given instruction. */
    async function createExecutor(instruction) {
        const mode = await selectMode(instruction, args, { ...creds, backendUrl });

        if (mode === 'local') {
            if (args.verbose) process.stderr.write('\x1b[2m[mode] local\x1b[0m\n');
            return new LocalAgent({
                apiKey: anthropicKey,
                openRouterKey,
                model: args.model || 'claude-sonnet-4-20250514',
                toolExecutor,
                verbose: args.verbose,
                cwd: process.cwd(),
                systemPromptOverride: args.systemPrompt,
                maxTurns: args.maxTurns,
            }).execute(instruction, { cwd: process.cwd() });
        } else {
            if (args.verbose) process.stderr.write('\x1b[2m[mode] remote\x1b[0m\n');

            // Retrieve BM25 context to send to backend
            let indexedContext = {};
            try {
                const chunks = contextRetriever.retrieve(instruction, 8);
                if (chunks.length > 0) {
                    indexedContext = {
                        indexed: chunks.map(c => ({ id: c.id, score: c.score, text: c.text })),
                    };
                    if (args.verbose) process.stderr.write(`\x1b[2m[context] ${chunks.length} chunks from BM25 index\x1b[0m\n`);
                }
            } catch {
                // No index available — send without context
            }

            const client = new TarangStreamClient({
                baseUrl: backendUrl, token, openRouterKey, toolExecutor,
                verbose: args.verbose, approvalManager: approval,
            });
            process.on('SIGINT', async () => { await client.cancel().catch(() => {}); process.exit(0); });
            return client.execute(instruction, { cwd: process.cwd(), ...indexedContext });
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
