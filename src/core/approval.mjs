/**
 * Approval Flow — contextual permission prompts with risk assessment.
 *
 * Write tools (shell, write_file, edit_file, delete_file) require approval.
 * Read tools (read_file, list_files, search_code, etc.) auto-approve.
 *
 * Risk levels:
 *   LOW    — file writes to non-critical paths
 *   MEDIUM — shell commands, file edits
 *   HIGH   — delete, force push, destructive shell commands
 *
 * The prompt shows WHY approval is needed + a human-readable description
 * of what the tool will do, not raw JSON.
 */

import * as readline from 'node:readline';
import * as path from 'node:path';

// ── Tool Classification ──

const WRITE_TOOLS = new Set([
    'shell', 'write_file', 'edit_file', 'delete_file',
    'validate_build', 'lint_check',
]);

/** Tools/commands that NEVER auto-approve, even with 'a' (approve all). */
const NEVER_AUTO_APPROVE = new Set(['delete_file']);

/** Shell patterns that always require explicit per-call approval. */
const FORCE_APPROVAL_SHELL = [
    /\brm\s/,          // any rm command
    /\bunlink\s/,      // unlink
    /\brmdir\s/,       // rmdir
    /\bgit\s+clean/,   // git clean
    /\bgit\s+reset/,   // git reset
    /\bgit\s+push.*--force/, // force push
];

const RISK_LEVELS = {
    read_file: 'none', read_files: 'none', search_code: 'none',
    search_files: 'none', list_files: 'none', get_file_info: 'none',
    validate_file: 'none', validate_structure: 'none',
    write_file: 'low', edit_file: 'low',
    lint_check: 'low', validate_build: 'medium',
    shell: 'medium',
    delete_file: 'high',
};

const RISK_COLORS = {
    none: '\x1b[90m',   // gray
    low: '\x1b[32m',    // green
    medium: '\x1b[33m', // yellow
    high: '\x1b[31m',   // red
};

const RISK_LABELS = {
    none: 'safe',
    low: 'low risk',
    medium: 'caution',
    high: 'destructive',
};

// ── Shell Command Risk Assessment ──

function assessShellRisk(command) {
    if (!command) return 'medium';
    const cmd = command.toLowerCase();
    // High risk
    if (/rm\s+-r/i.test(cmd)) return 'high';
    if (/git\s+(push|reset|clean|checkout\s+\.)/i.test(cmd)) return 'high';
    if (/drop\s+(table|database)/i.test(cmd)) return 'high';
    if (/sudo\s/i.test(cmd)) return 'high';
    // Low risk — read-only commands that don't modify state
    if (/^(ls|cat|head|tail|less|more|wc|file|stat|tree|find|grep|rg|ag|echo|printf|pwd|whoami|date|which|type|env|printenv|uname|hostname|id|df|du|uptime|free|top|ps|lsof)/i.test(cmd)) return 'low';
    if (/^git\s+(status|log|diff|show|branch|tag|remote|stash\s+list|blame|shortlog|describe|rev-parse|ls-files|ls-tree)/i.test(cmd)) return 'low';
    if (/^(npm\s+(test|run|list|ls|view|info|outdated|audit)|node\s+--check|python3?\s+-m\s+py_compile|cargo\s+(check|test|clippy))/i.test(cmd)) return 'low';
    return 'medium';
}

// ── Human-Readable Tool Descriptions ──

function describeToolCall(toolName, args) {
    const shortP = (p) => {
        if (!p) return 'file';
        const cwd = process.cwd();
        return p.startsWith(cwd) ? p.slice(cwd.length + 1) : path.basename(p);
    };

    switch (toolName) {
        case 'shell':
            return {
                action: 'Run command',
                detail: args.command || '(empty)',
                why: 'Shell commands can modify files, install packages, or change system state',
            };
        case 'write_file':
            return {
                action: `Create/overwrite file`,
                detail: shortP(args.path || args.file_path),
                why: args.content
                    ? `Will write ${args.content.split('\n').length} lines to ${shortP(args.path || args.file_path)}`
                    : 'Will create or replace a file',
            };
        case 'edit_file':
            return {
                action: `Edit file`,
                detail: shortP(args.path || args.file_path),
                why: args.search
                    ? `Replace "${args.search.slice(0, 40)}${args.search.length > 40 ? '...' : ''}"`
                    : 'Modify file contents',
            };
        case 'delete_file':
            return {
                action: `Delete file`,
                detail: shortP(args.path || args.file_path),
                why: 'This cannot be undone (unless tracked by git)',
            };
        case 'validate_build':
            return {
                action: 'Run build',
                detail: args.command || 'auto-detect',
                why: 'Build commands may have side effects (install deps, generate files)',
            };
        case 'lint_check':
            return {
                action: 'Lint file',
                detail: shortP(args.path),
                why: 'Runs an external linter process',
            };
        default:
            return {
                action: toolName,
                detail: JSON.stringify(args).slice(0, 60),
                why: 'This tool modifies state',
            };
    }
}

// ── Approval Manager ──

export class ApprovalManager {
    constructor({ autoApprove = false, planMode = false } = {}) {
        this.autoApprove = autoApprove;
        this.planMode = planMode;
        this.approveAll = false;
        this.approvedToolTypes = new Set();
        this.history = [];  // track what was approved/denied
        this._rl = null;    // readline interface — set via setReadline()
    }

    /** Attach the readline interface so we can pause/resume around prompts. */
    setReadline(rl) {
        this._rl = rl;
    }

    async check(toolName, args, requireApproval = false) {
        // Plan mode: reject all writes
        if (this.planMode && WRITE_TOOLS.has(toolName)) {
            return { approved: false, reason: `Blocked by plan mode: ${toolName}` };
        }

        // Auto-approve reads
        if (!WRITE_TOOLS.has(toolName) && !requireApproval) {
            return { approved: true };
        }

        // Auto-approve read-only shell commands (ls, cat, git status, etc.)
        // Our own risk assessment overrides backend's requireApproval for safe commands
        if (toolName === 'shell') {
            const risk = assessShellRisk(args.command);
            if (risk === 'low') {
                this.history.push({ tool: toolName, decision: 'auto-safe', time: Date.now() });
                return { approved: true };
            }

            // NEVER auto-approve destructive shell commands (rm, unlink, git clean, etc.)
            const forcePrompt = FORCE_APPROVAL_SHELL.some(p => p.test(args.command || ''));
            if (forcePrompt) {
                return this._prompt(toolName, args);
            }
        }

        // NEVER auto-approve destructive tool types (delete_file, etc.)
        if (NEVER_AUTO_APPROVE.has(toolName)) {
            return this._prompt(toolName, args);
        }

        // --yes flag or 'a' was pressed
        if (this.autoApprove || this.approveAll) {
            this.history.push({ tool: toolName, decision: 'auto', time: Date.now() });
            return { approved: true };
        }

        // 't' was pressed for this tool type
        if (this.approvedToolTypes.has(toolName)) {
            this.history.push({ tool: toolName, decision: 'type-auto', time: Date.now() });
            return { approved: true };
        }

        // Interactive prompt
        return this._prompt(toolName, args);
    }

    async _prompt(toolName, args) {
        const desc = describeToolCall(toolName, args);
        const baseRisk = RISK_LEVELS[toolName] || 'medium';
        const risk = toolName === 'shell' ? assessShellRisk(args.command) : baseRisk;
        const riskColor = RISK_COLORS[risk];
        const riskLabel = RISK_LABELS[risk];
        const RST = '\x1b[0m';
        const DIM = '\x1b[2m';
        const BOLD = '\x1b[1m';
        const CYAN = '\x1b[36m';

        const YELLOW = '\x1b[33m';
        const GREEN = '\x1b[32m';
        const GRAY = '\x1b[90m';

        process.stderr.write('\n\n');

        // What it will do — the key detail, prominent
        if (toolName === 'shell') {
            const cmd = args.command || '';
            process.stderr.write(`  ${CYAN}$ ${cmd}${RST}\n`);
        } else {
            process.stderr.write(`  ${desc.action}  ${CYAN}${desc.detail}${RST}\n`);
        }

        // Risk badge + why — compact
        process.stderr.write(`  ${riskColor}${riskLabel}${RST}  ${DIM}${desc.why}${RST}\n`);

        // Prompt — visually distinct, easy to find
        process.stderr.write('\n');
        process.stderr.write(`  ${YELLOW}?${RST} ${BOLD}Allow${RST}  ${GREEN}Y${RST}${DIM}es${RST}  ${DIM}[n]o  [v]iew  [a]ll  [t]ype${RST}  `);

        const answer = await this._readChar();

        switch (answer.toLowerCase()) {
            case 'y': case '': case '\r': case '\n':
                process.stderr.write(`${CYAN}yes${RST}\n`);
                this.history.push({ tool: toolName, decision: 'yes', time: Date.now() });
                return { approved: true };
            case 'n':
                process.stderr.write(`denied\n`);
                this.history.push({ tool: toolName, decision: 'no', time: Date.now() });
                return { approved: false, reason: 'User denied' };
            case 'v':
                process.stderr.write(`view\n`);
                process.stderr.write(`\n${DIM}${JSON.stringify(args, null, 2)}${RST}\n`);
                return this._prompt(toolName, args);
            case 'a':
                process.stderr.write(`${CYAN}approve all remaining${RST}\n`);
                this.approveAll = true;
                this.history.push({ tool: toolName, decision: 'approve-all', time: Date.now() });
                return { approved: true };
            case 't':
                process.stderr.write(`${CYAN}auto-approve ${toolName}${RST}\n`);
                this.approvedToolTypes.add(toolName);
                this.history.push({ tool: toolName, decision: 'type-approve', time: Date.now() });
                return { approved: true };
            default:
                process.stderr.write('\n');
                return this._prompt(toolName, args);
        }
    }

    _readChar() {
        return new Promise((resolve) => {
            if (!process.stdin.isTTY) {
                resolve('y');
                return;
            }

            // Pause readline so it doesn't steal our keypress
            if (this._rl) this._rl.pause();

            const wasRaw = process.stdin.isRaw;
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.once('data', (data) => {
                process.stdin.setRawMode(wasRaw || false);

                // Resume readline after we've captured the char
                if (this._rl) this._rl.resume();

                const char = data.toString();
                if (char === '\x03') process.exit(0);
                resolve(char);
            });
        });
    }

    /** Get approval history summary for /status display */
    getSummary() {
        const approved = this.history.filter(h => h.decision !== 'no').length;
        const denied = this.history.filter(h => h.decision === 'no').length;
        return {
            total: this.history.length,
            approved,
            denied,
            autoApproveAll: this.approveAll,
            autoApprovedTypes: [...this.approvedToolTypes],
        };
    }
}
