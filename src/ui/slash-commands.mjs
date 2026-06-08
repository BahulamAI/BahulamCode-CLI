/**
 * Slash Commands — T10: 14 commands for interactive REPL.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { printGoodbye } from './banner.mjs';
import { ContextRetriever } from '../context/retriever.mjs';

export const COMMANDS = {
    '/help':     { description: 'Show available commands', handler: cmdHelp },
    '/git':      { description: 'Show git status', handler: cmdGit },
    '/status':   { description: 'Alias for /git', handler: cmdGit },
    '/commit':   { description: 'Interactive git commit', handler: cmdCommit },
    '/diff':     { description: 'Show git diff', handler: cmdDiff },
    '/clear':    { description: 'Clear conversation history', handler: cmdClear },
    '/sessions': { description: 'List previous sessions', handler: cmdSessions },
    '/exit':     { description: 'Exit CLI', handler: cmdExit },
    '/quit':     { description: 'Alias for /exit', handler: cmdExit },
    '/index':    { description: 'Build/rebuild BM25 context index', handler: cmdIndex },
    '/model':    { description: 'Show current model', handler: cmdModel },
    '/tokens':   { description: 'Show token usage', handler: cmdTokens },
    '/cost':     { description: 'Show session cost', handler: cmdCost },
    '/config':   { description: 'Open settings in browser', handler: cmdConfig },
    '/login':    { description: 'Re-authenticate via browser', handler: cmdLogin },
    '/refresh':  { description: 'Reload credentials from disk', handler: cmdRefresh },
    '/sync':     { description: 'Sync settings from web', handler: cmdSync },
    '/whoami':   { description: 'Show logged-in user', handler: cmdWhoami },
};

function run(cmd) {
    try {
        return execSync(cmd, { encoding: 'utf-8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
        return err.stderr || err.stdout || err.message;
    }
}

function cmdHelp(ctx) {
    const BOLD = '\x1b[1m', CYAN = '\x1b[36m', DIM = '\x1b[2m', GREEN = '\x1b[32m', BLUE = '\x1b[34m', RESET = '\x1b[0m';

    process.stderr.write(`\n${BLUE}┌──────────────────────────────────────────────┐${RESET}\n`);
    process.stderr.write(`${BLUE}│${RESET}  ${BOLD}Kepler Help${RESET}                                   ${BLUE}│${RESET}\n`);
    process.stderr.write(`${BLUE}├──────────────────────────────────────────────┤${RESET}\n`);
    process.stderr.write(`${BLUE}│${RESET}                                              ${BLUE}│${RESET}\n`);
    process.stderr.write(`${BLUE}│${RESET}  ${BOLD}Commands:${RESET}                                   ${BLUE}│${RESET}\n`);
    for (const [name, { description }] of Object.entries(COMMANDS)) {
        const line = `  ${CYAN}${name.padEnd(12)}${RESET} ${description}`;
        process.stderr.write(`${BLUE}│${RESET}${line}${' '.repeat(Math.max(0, 44 - name.length - description.length))}${BLUE}│${RESET}\n`);
    }
    process.stderr.write(`${BLUE}│${RESET}                                              ${BLUE}│${RESET}\n`);
    process.stderr.write(`${BLUE}│${RESET}  ${BOLD}Keyboard:${RESET}                                   ${BLUE}│${RESET}\n`);
    process.stderr.write(`${BLUE}│${RESET}  ${BOLD}ESC${RESET}${DIM}=${RESET}cancel  ${BOLD}SPACE${RESET}${DIM}=${RESET}pause  ${BOLD}Ctrl+C${RESET}${DIM}=${RESET}exit       ${BLUE}│${RESET}\n`);
    process.stderr.write(`${BLUE}│${RESET}                                              ${BLUE}│${RESET}\n`);
    process.stderr.write(`${BLUE}│${RESET}  ${BOLD}Tips:${RESET}                                       ${BLUE}│${RESET}\n`);
    process.stderr.write(`${BLUE}│${RESET}  ${DIM}Type naturally: "add a login button"${RESET}        ${BLUE}│${RESET}\n`);
    process.stderr.write(`${BLUE}│${RESET}  ${DIM}Reference files: "fix bug in src/main.py"${RESET}   ${BLUE}│${RESET}\n`);
    process.stderr.write(`${BLUE}│${RESET}  ${DIM}Ask questions: "explain how auth works"${RESET}     ${BLUE}│${RESET}\n`);
    process.stderr.write(`${BLUE}│${RESET}                                              ${BLUE}│${RESET}\n`);
    process.stderr.write(`${BLUE}└──────────────────────────────────────────────┘${RESET}\n\n`);
}

function cmdGit() {
    process.stdout.write(run('git status --short --branch') + '\n');
}

function cmdCommit(ctx) {
    const status = run('git status --short');
    if (!status.trim()) {
        process.stderr.write('Nothing to commit.\n');
        return;
    }
    process.stdout.write('\x1b[1mStaged changes:\x1b[0m\n');
    process.stdout.write(run('git diff --cached --stat') || '(no staged changes)\n');
    process.stdout.write('\n\x1b[1mUnstaged changes:\x1b[0m\n');
    process.stdout.write(status + '\n');
    process.stderr.write('\x1b[2mUse git add + git commit from shell to commit.\x1b[0m\n');
}

function cmdDiff() {
    const diff = run('git diff --stat');
    process.stdout.write(diff || '(no changes)\n');
}

function cmdClear(ctx) {
    if (ctx.formatter) {
        ctx.formatter.toolCalls = [];
        ctx.formatter.toolCount = 0;
        ctx.formatter.phases.clear();
        ctx.formatter.changes = [];
    }
    process.stderr.write('Conversation cleared.\n');
}

function cmdSessions() {
    const sessDir = path.join(process.cwd(), '.kepler', 'sessions');
    if (!fs.existsSync(sessDir)) {
        process.stderr.write('No sessions found.\n');
        return;
    }
    const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 20);
    if (files.length === 0) {
        process.stderr.write('No sessions found.\n');
        return;
    }
    process.stderr.write('\n\x1b[1mRecent Sessions:\x1b[0m\n');
    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(sessDir, file), 'utf-8'));
            const date = file.replace('.json', '').replace(/T/g, ' ').replace(/-/g, ':').slice(0, 19);
            const instr = (data.instruction || '').slice(0, 40);
            const status = data.status || 'unknown';
            process.stderr.write(`  ${date}  ${status.padEnd(10)}  ${instr}\n`);
        } catch {
            process.stderr.write(`  ${file}  (unreadable)\n`);
        }
    }
    process.stderr.write('\n');
}

function cmdExit() {
    printGoodbye();
    process.exit(0);
}

async function cmdIndex() {
    const cwd = process.cwd();
    process.stderr.write('\x1b[2mBuilding BM25 index...\x1b[0m\n');
    try {
        const retriever = new ContextRetriever(cwd);
        const result = await retriever.buildIndex();
        process.stderr.write(`\x1b[32m✓ Index built: ${result.fileCount} files, ${result.chunkCount} chunks\x1b[0m\n`);
        process.stderr.write(`\x1b[2m  Stored at: ${path.join(cwd, '.kepler', 'index')}\x1b[0m\n`);
    } catch (err) {
        process.stderr.write(`\x1b[31mIndex build failed: ${err.message}\x1b[0m\n`);
    }
}

function cmdModel(ctx) {
    process.stderr.write(`Model: ${ctx.model || 'default (set by backend)'}\n`);
}

function cmdTokens(ctx) {
    const t = ctx.formatter?.tokenCount || { input: 0, output: 0 };
    process.stderr.write(`Tokens: ${t.input} input, ${t.output} output, ${t.input + t.output} total\n`);
}

function cmdCost(ctx) {
    const t = ctx.formatter?.tokenCount || { input: 0, output: 0 };
    // Rough estimate: Sonnet ~$3/$15 per MTok
    const cost = (t.input * 3 + t.output * 15) / 1_000_000;
    process.stderr.write(`Estimated cost: $${cost.toFixed(4)}\n`);
}

function cmdConfig(ctx) {
    // Show local config summary
    if (ctx.auth) ctx.auth.printConfig();

    // Open settings in browser
    import('../core/backend-url.mjs').then(({ resolveWebUrl }) => {
        const webUrl = resolveWebUrl();
        const settingsUrl = `${webUrl}/dashboard/settings?tab=providers&source=cli`;
        process.stderr.write(`\x1b[36mOpening settings...\x1b[0m \x1b[2m${settingsUrl}\x1b[0m\n`);
        const openCmd = process.platform === 'darwin' ? 'open' :
                        process.platform === 'win32' ? 'start' : 'xdg-open';
        import('node:child_process').then(({ exec }) => {
            exec(`${openCmd} "${settingsUrl}"`, () => {});
        });
    });
}

function cmdLogin(ctx) {
    if (ctx.auth) {
        process.stderr.write('\x1b[36mStarting login flow...\x1b[0m\n');
        ctx.auth.login().then(() => {
            process.stderr.write('\x1b[32m✓ Login successful!\x1b[0m\n');
        }).catch((err) => {
            process.stderr.write(`\x1b[31m✗ Login failed: ${err.message}\x1b[0m\n`);
        });
    }
}

function cmdRefresh(ctx) {
    if (!ctx.auth) {
        process.stderr.write('\x1b[31mNo auth module available.\x1b[0m\n');
        return;
    }
    // Force re-read from ~/.kepler/config.json
    ctx.auth._config = null;
    const creds = ctx.auth.loadCredentials();
    const GREEN = '\x1b[32m', DIM = '\x1b[2m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
    process.stderr.write(`\n${GREEN}✓ Credentials reloaded${RESET}\n`);
    process.stderr.write(`  ${DIM}Auth:${RESET}     ${creds.token ? 'logged in' : 'not logged in'}\n`);
    process.stderr.write(`  ${DIM}Gateway:${RESET}  ${creds.gatewayType}\n`);
    process.stderr.write(`  ${DIM}Backend:${RESET}  ${creds.backendUrl}\n`);
    if (creds.models?.orchestrator) process.stderr.write(`  ${DIM}Model:${RESET}    ${creds.models.orchestrator}\n`);
    process.stderr.write(`\n  ${DIM}Next prompt will use updated credentials.${RESET}\n\n`);
}

function cmdSync(ctx) {
    if (ctx.auth) {
        process.stderr.write('\x1b[36mSyncing settings from web...\x1b[0m\n');
        ctx.auth.syncSettings().then((remote) => {
            process.stderr.write(`\x1b[32m✓ Synced:\x1b[0m gateway=${remote.gateway_type}`);
            if (remote.models?.orchestrator) process.stderr.write(`, orchestrator=${remote.models.orchestrator}`);
            if (remote.models?.reasoning) process.stderr.write(`, coding=${remote.models.reasoning}`);
            process.stderr.write('\n');
        }).catch((err) => {
            process.stderr.write(`\x1b[31m✗ Sync failed: ${err.message}\x1b[0m\n`);
        });
    }
}

function cmdWhoami(ctx) {
    if (!ctx.auth) {
        process.stderr.write('\x1b[31mNot logged in.\x1b[0m\n');
        return;
    }
    const creds = ctx.auth.loadCredentials();
    if (!creds.token) {
        process.stderr.write('\x1b[31mNot logged in. Run /login first.\x1b[0m\n');
        return;
    }
    const backendUrl = creds.backendUrl;
    process.stderr.write('\x1b[2mFetching user info...\x1b[0m\n');
    fetch(`${backendUrl}/api/user/me`, {
        headers: { 'Authorization': `Bearer ${creds.token}` },
    }).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
    }).then(data => {
        const GREEN = '\x1b[32m', CYAN = '\x1b[36m', DIM = '\x1b[2m', RESET = '\x1b[0m';
        process.stderr.write(`\n  ${GREEN}✓${RESET} ${data.github_username || 'unknown'}\n`);
        process.stderr.write(`  ${DIM}Email:${RESET}    ${data.email || 'n/a'}\n`);
        process.stderr.write(`  ${DIM}User ID:${RESET}  ${data.id}\n`);
        process.stderr.write(`  ${DIM}Step:${RESET}     ${data.onboarding_step || 'signed_up'}\n`);
        process.stderr.write(`  ${DIM}Role:${RESET}     ${data.role || 'user'}\n\n`);
    }).catch(err => {
        process.stderr.write(`\x1b[31m✗ Failed: ${err.message}\x1b[0m\n`);
    });
}

/**
 * Execute a slash command if input starts with /.
 * @returns {boolean} true if handled
 */
export function handleSlashCommand(input, ctx) {
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const entry = COMMANDS[cmd];
    if (!entry) {
        process.stderr.write(`Unknown command: ${cmd}. Type /help for available commands.\n`);
        return true;
    }
    entry.handler(ctx, parts.slice(1));
    return true;
}
