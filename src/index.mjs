#!/usr/bin/env node
/**
 * @bahulamai/code — Bahulam Code CLI (Bahulam's coding agent).
 *
 * Phase 3: Hybrid local/remote/auto + advanced features.
 */

// Load .env file from cwd or ~/.bahulam/.env
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

for (const envPath of [join(process.cwd(), '.env'), join(homedir(), '.bahulam', '.env')]) {
    if (existsSync(envPath)) {
        for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
            const match = line.match(/^\s*([\w]+)\s*=\s*(.+?)\s*$/);
            if (match && !process.env[match[1]]) {
                process.env[match[1]] = match[2];
            }
        }
        break;
    }
}

import { TarangStreamClient, EVENT_TYPES } from './core/stream-client.mjs';
import { LocalAgent } from './core/local-agent.mjs';
import { createToolExecutor } from './core/tool-executor.mjs';
import { TarangAuth } from './auth/tarang-auth.mjs';
import { ApprovalManager } from './core/approval.mjs';
import { SessionManager } from './core/session-manager.mjs';
import { EventFormatter } from './ui/formatter.mjs';
import { COMMANDS } from './ui/slash-commands.mjs';
import { selectMode } from './core/mode-selector.mjs';
import { printBanner, printProjectInfo, printHints, printAuthStatus, printStyledConfig, printGoodbye } from './ui/banner.mjs';
import { ContextRetriever } from './context/retriever.mjs';
import { loadSettings } from './config/settings.mjs';

const VERSION = '2.6.16';

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
        model: null, route: null,
        // Extended flags (from cli-args.mjs)
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
            case 'configure': args.command = 'configure'; break;
            case 'sync':
                if (args.command === 'workflow' && !args.workflowSubcommand) args.workflowSubcommand = 'sync';
                else if (args.command === 'agent' && !args.agentSubcommand) args.agentSubcommand = 'sync';
                else if (!args.command) args.command = 'sync';
                break;
            case 'workflow': args.command = 'workflow'; break;
            case 'agent': args.command = 'agent'; break;
            // Config flags
            case '--show': args.showConfig = true; break;
            case '--openrouter-key': case '-k': args.openRouterKey = argv[++i]; break;
            case '--anthropic-key': args.anthropicKey = argv[++i]; break;
            case '--openai-key': args.openaiKey = argv[++i]; break;
            case '--google-key': args.googleKey = argv[++i]; break;
            case '--gateway': args.gateway = argv[++i]; break;
            // --backend-url removed: use TARANG_ENV
            case '--model': case '-m': args.model = argv[++i]; break;
            case '--route': args.route = argv[++i]; break;
            // Extended flags
            case '--permission-mode': args.permissionMode = argv[++i]; break;
            case '--print': case '-p': case '--instruction': case '--input': args.instruction = argv[++i]; break;
            case '--output-format': args.outputFormat = argv[++i]; break;
            case '--system-prompt': args.systemPrompt = argv[++i]; break;
            case '--add-dir': args.addDirs.push(argv[++i]); break;
            case '--max-turns': args.maxTurns = parseInt(argv[++i], 10); break;
            case '--allowedTools': args.allowedTools = argv[++i]?.split(',').map(s => s.trim()); break;
            case '--disallowedTools': args.disallowedTools = argv[++i]?.split(',').map(s => s.trim()); break;
            // Workflow flags
            case '--file': case '-f': args.workflowFile = argv[++i]; break;
            case '--dir': args.workflowDir = argv[++i]; break;
            case '--agent-dir': args.agentDir = argv[++i]; break;
            case '--pattern': args.pattern = argv[++i]; break;
            default:
                if (!arg.startsWith('-')) {
                    if (args.command === 'workflow' && !args.workflowSubcommand) {
                        // First positional after 'workflow' is the subcommand
                        const subcommands = new Set(['create', 'create-multi', 'run', 'run-multi', 'list', 'get', 'delete', 'sync']);
                        if (subcommands.has(arg)) {
                            args.workflowSubcommand = arg;
                        } else {
                            // Second positional is the workflow name/slug
                            args.workflowSlug = arg;
                        }
                    } else if (args.command === 'workflow' && args.workflowSubcommand && !args.workflowSlug) {
                        args.workflowSlug = arg;
                    } else if (args.command === 'agent' && !args.agentSubcommand) {
                        const agentSubs = new Set(['list', 'get', 'sync']);
                        if (agentSubs.has(arg)) {
                            args.agentSubcommand = arg;
                        } else {
                            args.agentSlug = arg;
                        }
                    } else if (args.command === 'agent' && args.agentSubcommand && !args.agentSlug) {
                        args.agentSlug = arg;
                    } else if (!args.command && !args.instruction) {
                        args.instruction = arg;
                    }
                }
                break;
        }
        i++;
    }
    if (!args.verbose && process.env.TARANG_VERBOSE === '1') args.verbose = true;
    if (!args.yes && process.env.TARANG_YES === '1') args.yes = true;
    return args;
}

function printUsage() {
    printBanner(VERSION);

    const B = '\x1b[1m', C = '\x1b[36m', D = '\x1b[2m', G = '\x1b[32m', R = '\x1b[0m';

    process.stderr.write(`${B}USAGE${R}\n`);
    process.stderr.write(`  ${C}bahulam "instruction"${R}         Execute instruction\n`);
    process.stderr.write(`  ${C}bahulam${R}                       Interactive mode (REPL)\n`);
    process.stderr.write(`  ${C}bahulam login${R}                 Authenticate via GitHub OAuth\n`);
    process.stderr.write(`  ${C}bahulam configure${R}             Open settings in browser\n`);
    process.stderr.write(`  ${C}bahulam config --show${R}         Display local configuration\n`);
    process.stderr.write(`  ${C}bahulam resume${R}                Resume a paused session\n`);
    process.stderr.write(`  ${C}bahulam workflow create --file <path>${R}  Create workflow from YAML\n`);
    process.stderr.write(`  ${C}bahulam workflow run <name>${R}           Run a workflow\n`);
    process.stderr.write(`  ${C}bahulam workflow list${R}                 List workflows\n`);
    process.stderr.write(`  ${C}bahulam workflow get <name>${R}           Show workflow details\n`);
    process.stderr.write(`  ${C}bahulam workflow delete <name>${R}        Delete a workflow\n`);
    process.stderr.write(`  ${C}bahulam workflow sync${R}                 Sync workflow YAML files\n`);
    process.stderr.write(`  ${C}bahulam agent list${R}                    List user-defined agents\n`);
    process.stderr.write(`  ${C}bahulam agent get <slug>${R}              Show agent details\n`);
    process.stderr.write(`  ${C}bahulam agent sync${R}                    Sync agent YAML files\n`);
    process.stderr.write('\n');
    process.stderr.write(`${B}MODE FLAGS${R}\n`);
    process.stderr.write(`  ${G}--local${R}                      Direct LLM API ${D}(<100ms, offline)${R}\n`);
    process.stderr.write(`  ${G}--remote${R}                     SSE backend ${D}(multi-agent orchestration)${R}\n`);
    process.stderr.write(`  ${G}--mode <auto|local|remote>${R}   Set mode explicitly\n`);
    process.stderr.write(`  ${D}(default: auto-select based on task complexity)${R}\n`);
    process.stderr.write('\n');
    process.stderr.write(`${B}MODEL FLAGS${R}\n`);
    process.stderr.write(`  ${G}--model, -m <id|role=id>${R}     Session model override ${D}(also: fast|thinking|extra|max)${R}\n`);
    process.stderr.write(`  ${G}--route <platform|byok>${R}      Model route ${D}(platform validates against curated catalog)${R}\n`);
    process.stderr.write(`  ${G}--system-prompt <text>${R}       Override system prompt\n`);
    process.stderr.write(`  ${G}--max-turns <n>${R}              Maximum conversation turns\n`);
    process.stderr.write(`  ${D}Persistent defaults are configured via: bahulam configure${R}\n`);
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
        process.stderr.write(`  ${C}${k.padEnd(14)}${R} ${v}\n`);
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

// Inline REPL removed — now delegates to startTerminalRepl() from terminal/repl.mjs
// which has full markdown rendering, turn summaries, cost display, and ANSI UI.

import { startTerminalRepl } from './terminal/repl.mjs';

// ── Main ────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.version) { console.log(`@bahulam/code ${VERSION}`); process.exit(0); }
    if (args.help) { printUsage(); process.exit(0); }

    const auth = new TarangAuth();

    if (args.command === 'login') {
        printBanner(VERSION);
        process.stderr.write('\x1b[1mAuthentication\x1b[0m\n\n');
        await auth.login();
        process.stderr.write('\n\x1b[32m✓ Login successful!\x1b[0m\n');
        // Sync settings from web after login
        try {
            process.stderr.write('\x1b[2mSyncing settings from server...\x1b[0m\n');
            const remote = await auth.syncSettings();
            process.stderr.write(`\x1b[32m✓ Settings synced\x1b[0m ${remote.gateway_type ? `(gateway: ${remote.gateway_type})` : ''}\n`);
        } catch {
            process.stderr.write('\x1b[2mSettings sync skipped — configure at bahulam.ai/dashboard/settings\x1b[0m\n');
        }
        process.stderr.write('\n');
        // Fall through to REPL — user starts working right away
    }

    if (args.command === 'sync') {
        printBanner(VERSION);
        process.stderr.write('\x1b[1mSyncing settings...\x1b[0m\n\n');
        try {
            const remote = await auth.syncSettings();
            process.stderr.write(`\x1b[32m✓ Gateway:\x1b[0m     ${remote.gateway_type}\n`);
            if (remote.models?.orchestrator) process.stderr.write(`\x1b[32m✓ Orchestrator:\x1b[0m ${remote.models.orchestrator}\n`);
            if (remote.models?.reasoning)    process.stderr.write(`\x1b[32m✓ Coding:\x1b[0m       ${remote.models.reasoning}\n`);
            if (remote.models?.local)        process.stderr.write(`\x1b[32m✓ Local:\x1b[0m        ${remote.models.local}\n`);
            if (remote.configured_providers?.length) process.stderr.write(`\x1b[32m✓ Providers:\x1b[0m   ${remote.configured_providers.join(', ')}\n`);
            process.stderr.write('\n\x1b[32m✓ Settings saved to ~/.bahulam/config.json\x1b[0m\n');
        } catch (err) {
            process.stderr.write(`\x1b[31m✗ ${err.message}\x1b[0m\n`);
        }
        process.exit(0);
    }

    if (args.command === 'configure') {
        printBanner(VERSION);
        const { resolveWebUrl } = await import('./core/backend-url.mjs');
        const webUrl = resolveWebUrl();
        const settingsUrl = `${webUrl}/dashboard/settings?tab=providers&source=cli`;
        process.stderr.write('\x1b[36mOpening settings in browser...\x1b[0m\n');
        process.stderr.write(`\x1b[2m${settingsUrl}\x1b[0m\n`);
        const openCmd = process.platform === 'darwin' ? 'open' :
                        process.platform === 'win32' ? 'start' : 'xdg-open';
        const { exec } = await import('node:child_process');
        exec(`${openCmd} "${settingsUrl}"`, () => {});
        process.stderr.write('\n\x1b[2mConfigure your provider, models, and CLI preferences in the browser.\x1b[0m\n');
        process.stderr.write('\x1b[2mChanges sync automatically to the backend.\x1b[0m\n');
        process.exit(0);
    }

    if (args.command === 'config') {
        let changed = false;
        if (args.openRouterKey) { auth.saveOpenRouterKey(args.openRouterKey); process.stderr.write('\x1b[32m✓ OpenRouter key saved.\x1b[0m\n'); changed = true; }
        if (args.anthropicKey) { auth.saveAnthropicKey(args.anthropicKey); process.stderr.write('\x1b[32m✓ Anthropic key saved.\x1b[0m\n'); changed = true; }
        if (args.openaiKey) { auth.saveOpenAIKey(args.openaiKey); process.stderr.write('\x1b[32m✓ OpenAI key saved.\x1b[0m\n'); changed = true; }
        if (args.googleKey) { auth.saveGoogleKey(args.googleKey); process.stderr.write('\x1b[32m✓ Google AI key saved.\x1b[0m\n'); changed = true; }
        if (args.gateway) { auth.saveCredentials({ gateway_type: args.gateway }); process.stderr.write(`\x1b[32m✓ Gateway set to ${args.gateway}\x1b[0m\n`); changed = true; }
        if (args.mode) { auth.setMode(args.mode); process.stderr.write(`\x1b[32m✓ Mode set to ${args.mode}\x1b[0m\n`); changed = true; }
        if (args.showConfig || !changed) {
            auth.printConfig();
        }
        process.exit(0);
    }

    if (args.command === 'workflow') {
        const { handleWorkflowCommand } = await import('./commands/workflow.mjs');
        await handleWorkflowCommand(args);
        process.exit(0);
    }

    if (args.command === 'agent') {
        const { handleAgentCommand } = await import('./commands/agent.mjs');
        await handleAgentCommand(args);
        process.exit(0);
    }

    // Load settings (user ~/.claude/settings.json + project .claude/settings.json + local)
    const settings = await loadSettings();

    /** Re-read credentials from disk (so /login updates take effect). */
    function freshCreds() {
        const c = auth.loadCredentials();
        return {
            token: process.env.TARANG_TOKEN || c.token,
            openRouterKey: process.env.OPENROUTER_API_KEY || c.openRouterKey,
            anthropicKey: process.env.ANTHROPIC_API_KEY || c.anthropicKey,
            openaiKey: process.env.OPENAI_API_KEY || c.openaiKey,
            googleKey: process.env.GOOGLE_API_KEY || c.googleKey,
            backendUrl: c.backendUrl,
            gatewayType: c.gatewayType,
            models: c.models,
        };
    }

    // Initial load — used for settings and startup checks
    const initCreds = freshCreds();

    // Apply settings as defaults (CLI flags override settings)
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
    async function createExecutor(instruction, messages = null) {
        // Always re-read credentials so /login changes are picked up
        const creds = freshCreds();
        const mode = await selectMode(instruction, args, { ...creds, backendUrl: creds.backendUrl });

        if (mode === 'local') {
            // Model priority: CLI flag > synced web setting > settings.json > default
            const localModel = creds.models?.local || settings.model || 'anthropic/claude-sonnet-4-6';
            if (args.verbose) process.stderr.write(`\x1b[2m[mode] local (${localModel})\x1b[0m\n`);

            // Pick the right API key based on the model/gateway
            let apiKey = creds.anthropicKey;
            let orKey = creds.openRouterKey;
            if (creds.gatewayType === 'openai') apiKey = creds.openaiKey;
            if (creds.gatewayType === 'googleai') apiKey = creds.googleKey;

            return new LocalAgent({
                apiKey,
                openRouterKey: orKey,
                model: localModel,
                toolExecutor,
                verbose: args.verbose,
                cwd: process.cwd(),
                systemPromptOverride: args.systemPrompt,
                maxTurns: args.maxTurns,
                stagnationDetection: settings.stagnationDetection,
                stagnationThreshold: settings.stagnationThreshold,
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
                baseUrl: creds.backendUrl, token: creds.token, toolExecutor,
                verbose: args.verbose, approvalManager: approval,
            });
            // Cancel on SIGINT but don't exit (REPL handles exit)
            const sigHandler = async () => { await client.cancel().catch(() => {}); };
            process.once('SIGINT', sigHandler);
            return client.execute(instruction, { cwd: process.cwd(), ...indexedContext }, messages);
        }
    }

    if (args.command === 'resume') {
        const state = sessionMgr.loadState();
        if (!state || state.status === 'completed') { process.stderr.write('No resumable session.\n'); process.exit(1); }
        const resumeCreds = freshCreds();
        const client = new TarangStreamClient({ baseUrl: resumeCreds.backendUrl, token: resumeCreds.token, toolExecutor, verbose: args.verbose, approvalManager: approval });
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

    await startTerminalRepl();
}

main().catch(err => { process.stderr.write(`\x1b[31mFatal: ${err.message}\x1b[0m\n`); process.exit(1); });
