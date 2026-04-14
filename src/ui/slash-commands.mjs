/**
 * Slash Commands — T10: 14 commands for interactive REPL.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { printGoodbye } from './banner.mjs';

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
    '/index':    { description: 'Build/rebuild context index (Phase 3)', handler: cmdIndex },
    '/model':    { description: 'Show current model', handler: cmdModel },
    '/tokens':   { description: 'Show token usage', handler: cmdTokens },
    '/cost':     { description: 'Show session cost', handler: cmdCost },
    '/config':   { description: 'Show configuration', handler: cmdConfig },
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
    process.stderr.write(`${BLUE}│${RESET}  ${BOLD}Tarang Help${RESET}                                 ${BLUE}│${RESET}\n`);
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
    const sessDir = path.join(process.cwd(), '.tarang', 'sessions');
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

function cmdIndex() {
    process.stderr.write('\x1b[2mContext indexing available in Phase 3 (--local mode).\x1b[0m\n');
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
    if (ctx.auth) ctx.auth.printConfig();
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
