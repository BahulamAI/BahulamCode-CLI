/**
 * Approval Flow — permission prompts for tool execution.
 *
 * Modeled after Claude Code's visual pattern:
 *   ⏺ Tool(args)          ← tool header
 *   ⎿ Allow? [y/n/a/t]    ← inline prompt
 *   ⎿ ✓ allowed            ← result
 *
 * Write tools require approval. Read tools auto-approve.
 * Shell commands are risk-assessed (safe/medium/high).
 */

import * as path from 'node:path';

// ── Tool Classification ──

const WRITE_TOOLS = new Set([
    'shell', 'write_file', 'write_project', 'edit_file', 'delete_file',
    'validate_build', 'lint_check',
]);

const NEVER_AUTO_APPROVE = new Set(['delete_file']);

const FORCE_APPROVAL_SHELL = [
    /\brm\s/,
    /\bunlink\s/,
    /\brmdir\s/,
    /\bgit\s+clean/,
    /\bgit\s+reset/,
    /\bgit\s+push.*--force/,
];

const RISK_LEVELS = {
    read_file: 'none', read_files: 'none', search_code: 'none',
    search_files: 'none', list_files: 'none', get_file_info: 'none',
    validate_file: 'none', validate_structure: 'none',
    write_file: 'low', write_project: 'low', edit_file: 'low',
    lint_check: 'low', validate_build: 'medium',
    shell: 'medium',
    delete_file: 'high',
};

function assessShellRisk(command) {
    if (!command) return 'medium';
    if (/rm\s+-r/i.test(command)) return 'high';
    if (/git\s+(push|reset|clean|checkout\s+\.)/i.test(command)) return 'high';
    if (/drop\s+(table|database)/i.test(command)) return 'high';
    if (/sudo\s/i.test(command)) return 'high';
    if (/^(ls|cat|head|tail|less|more|wc|file|stat|tree|find|grep|rg|ag|echo|printf|pwd|whoami|date|which|type|env|printenv|uname|hostname|id|df|du|uptime|free|top|ps|lsof)/i.test(command)) return 'low';
    if (/^git\s+(status|log|diff|show|branch|tag|remote|stash\s+list|blame|shortlog|describe|rev-parse|ls-files|ls-tree)/i.test(command)) return 'low';
    if (/^(npm\s+(test|run|list|ls|view|info|outdated|audit)|node\s+--check|python3?\s+-m\s+py_compile|cargo\s+(check|test|clippy))/i.test(command)) return 'low';
    return 'medium';
}

// ── ANSI helpers ──

const RST = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';
const WHITE = '\x1b[37m';

const write = (s) => process.stderr.write(s);

// ── Tool Description ──

function shortPath(p) {
    if (!p) return '';
    const cwd = process.cwd();
    return p.startsWith(cwd) ? p.slice(cwd.length + 1) : p;
}

function toolSummary(toolName, args) {
    switch (toolName) {
        case 'shell':
            return args.command || '(empty)';
        case 'write_file':
            return shortPath(args.path || args.file_path || '');
        case 'write_project': {
            const files = args.files || [];
            if (files.length === 0) return 'batch write';
            return files.map(f => shortPath(f.path || f.file_path || '')).join(', ');
        }
        case 'edit_file': {
            const fp = shortPath(args.path || args.file_path || '');
            const search = (args.search || '').slice(0, 30);
            return search ? `${fp} "${search}..."` : fp;
        }
        case 'delete_file':
            return shortPath(args.path || args.file_path || '');
        case 'read_file':
        case 'read_files':
            return shortPath(args.file_path || args.path || (args.file_paths || [])[0] || '');
        case 'search_code':
            return `"${args.query || args.pattern || ''}"`;
        case 'list_files':
            return args.pattern || args.path || '';
        default:
            return Object.values(args || {}).filter(v => typeof v === 'string').join(', ').slice(0, 50) || '';
    }
}

// ── Approval Manager ──

export class ApprovalManager {
    constructor({ autoApprove = false, planMode = false } = {}) {
        this.autoApprove = autoApprove;
        this.planMode = planMode;
        this.approveAll = false;
        this.approvedToolTypes = new Set();
        this.history = [];
        this._rl = null;
    }

    setReadline(rl) { this._rl = rl; }

    setExecutionHooks({ onPause, onResume } = {}) {
        this._execPause = onPause || null;
        this._execResume = onResume || null;
    }

    revoke() {
        const wasActive = this.approveAll || this.approvedToolTypes.size > 0;
        this.approveAll = false;
        this.approvedToolTypes.clear();
        return wasActive;
    }

    getModeLabel() {
        if (this.approveAll) return `${GREEN}allow-all${RST}`;
        if (this.approvedToolTypes.size > 0) {
            return `${CYAN}auto: ${[...this.approvedToolTypes].join(', ')}${RST}`;
        }
        return `${DIM}ask${RST}`;
    }

    async check(toolName, args, requireApproval = false) {
        if (this.planMode && WRITE_TOOLS.has(toolName)) {
            return { approved: false, reason: `Blocked by plan mode: ${toolName}` };
        }
        // Auto-approve everything in headless/autoApprove mode (no TTY prompts)
        if (this.autoApprove) {
            this.history.push({ tool: toolName, decision: 'auto', time: Date.now() });
            return { approved: true };
        }
        if (!WRITE_TOOLS.has(toolName) && !requireApproval) {
            return { approved: true };
        }
        if (toolName === 'shell') {
            const risk = assessShellRisk(args.command);
            if (risk === 'low') {
                this.history.push({ tool: toolName, decision: 'auto-safe', time: Date.now() });
                return { approved: true };
            }
            if (FORCE_APPROVAL_SHELL.some(p => p.test(args.command || ''))) {
                return this._prompt(toolName, args);
            }
        }
        if (NEVER_AUTO_APPROVE.has(toolName)) {
            return this._prompt(toolName, args);
        }
        if (this.approveAll) {
            this.history.push({ tool: toolName, decision: 'auto', time: Date.now() });
            return { approved: true };
        }
        if (this.approvedToolTypes.has(toolName)) {
            this.history.push({ tool: toolName, decision: 'type-auto', time: Date.now() });
            return { approved: true };
        }
        return this._prompt(toolName, args);
    }

    async _prompt(toolName, args) {
        const baseRisk = RISK_LEVELS[toolName] || 'medium';
        const risk = toolName === 'shell' ? assessShellRisk(args.command) : baseRisk;
        const summary = toolSummary(toolName, args);
        const isDestructive = risk === 'high';

        // ── Prompt line ──
        if (isDestructive) {
            write(`  ${YELLOW}⚠${RST}  ${DIM}Allow?${RST} ${WHITE}[y]${RST} yes  ${WHITE}[n]${RST} no  ${WHITE}[d]${RST} details\n`);
        } else {
            write(`  ${DIM}?${RST}  ${DIM}Allow?${RST} ${WHITE}[y]${RST} yes  ${WHITE}[n]${RST} no  ${WHITE}[a]${RST} always  ${WHITE}[t]${RST} type  ${WHITE}[d]${RST} details\n`);
        }

        const key = await this._readKey();

        switch (key) {
            case 'y':
            case 'Y':
            case 'return':
                write(`  ${GREEN}✓${RST}  ${DIM}${toolName}${RST} ${DIM}${summary.slice(0, 60)}${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'yes', time: Date.now() });
                return { approved: true };

            case 'n':
            case 'N':
            case 'escape':
                write(`  ${RED}✗${RST}  ${DIM}denied${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'no', time: Date.now() });
                return { approved: false, reason: 'User denied' };

            case 'a':
            case 'A':
                if (isDestructive) return this._prompt(toolName, args);
                this.approveAll = true;
                write(`  ${GREEN}✓✓${RST} ${DIM}allow-all activated${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'approve-all', time: Date.now() });
                return { approved: true };

            case 't':
            case 'T':
                if (isDestructive) return this._prompt(toolName, args);
                this.approvedToolTypes.add(toolName);
                write(`  ${GREEN}✓${RST}  ${DIM}always allow ${toolName}${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'type-approve', time: Date.now() });
                return { approved: true };

            case 'd':
            case 'D':
                write(`\n${DIM}${JSON.stringify(args, null, 2)}${RST}\n\n`);
                return this._prompt(toolName, args);

            default:
                return this._prompt(toolName, args);
        }
    }

    _readKey() {
        return new Promise((resolve) => {
            if (!process.stdin.isTTY) {
                resolve('return');
                return;
            }

            if (this._execPause) this._execPause();
            if (this._rl) this._rl.pause();

            const wasRaw = process.stdin.isRaw;
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.once('data', (data) => {
                process.stdin.setRawMode(wasRaw || false);
                if (this._rl) this._rl.resume();
                if (this._execResume) this._execResume();

                const bytes = [...data];
                const str = data.toString();

                if (bytes[0] === 0x03) process.exit(0);
                if (bytes[0] === 0x1b) { resolve('escape'); return; }
                if (str === '\r' || str === '\n') { resolve('return'); return; }
                resolve(str);
            });
        });
    }

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
