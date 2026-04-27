/**
 * Approval Flow — select-and-confirm permission prompts with risk assessment.
 *
 * Write tools (shell, write_file, edit_file, delete_file) require approval.
 * Read tools (read_file, list_files, search_code, etc.) auto-approve.
 *
 * UX: Arrow-key selector with Enter to confirm, Esc to cancel.
 * Dangerous options (approve all) require a second confirmation.
 *
 * Risk levels:
 *   LOW    — file writes to non-critical paths
 *   MEDIUM — shell commands, file edits
 *   HIGH   — delete, force push, destructive shell commands
 */

import * as path from 'node:path';

// ── Tool Classification ──

const WRITE_TOOLS = new Set([
    'shell', 'write_file', 'write_project', 'edit_file', 'delete_file',
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
    write_file: 'low', write_project: 'low', edit_file: 'low',
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

// ── ANSI helpers ──

const ESC = '\x1b[';
const RST = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';
const WHITE = '\x1b[37m';

const write = (s) => process.stderr.write(s);
const cursorUp = (n = 1) => write(`${ESC}${n}A`);
const cursorDown = (n = 1) => write(`${ESC}${n}B`);
const clearLine = () => write(`${ESC}2K\r`);
const cursorHide = () => write(`${ESC}?25l`);
const cursorShow = () => write(`${ESC}?25h`);

// ── Shell Command Risk Assessment ──

function assessShellRisk(command) {
    if (!command) return 'medium';
    const cmd = command.toLowerCase();
    if (/rm\s+-r/i.test(cmd)) return 'high';
    if (/git\s+(push|reset|clean|checkout\s+\.)/i.test(cmd)) return 'high';
    if (/drop\s+(table|database)/i.test(cmd)) return 'high';
    if (/sudo\s/i.test(cmd)) return 'high';
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
                action: 'Create/overwrite file',
                detail: shortP(args.path || args.file_path),
                why: args.content
                    ? `Will write ${args.content.split('\n').length} lines to ${shortP(args.path || args.file_path)}`
                    : 'Will create or replace a file',
            };
        case 'edit_file':
            return {
                action: 'Edit file',
                detail: shortP(args.path || args.file_path),
                why: args.search
                    ? `Replace "${args.search.slice(0, 40)}${args.search.length > 40 ? '...' : ''}"`
                    : 'Modify file contents',
            };
        case 'delete_file':
            return {
                action: 'Delete file',
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

// ── Menu Option Definitions ──

function getMenuOptions(toolName) {
    return [
        { key: 'yes',      label: 'Yes, allow this once',            icon: `${GREEN}✓${RST}` },
        { key: 'all',      label: 'Yes, approve all remaining',      icon: `${GREEN}✓✓${RST}`, dangerous: true },
        { key: 'type',     label: `Yes, auto-approve all ${toolName}`, icon: `${GREEN}✓${RST}${DIM}t${RST}` },
        { key: 'no',       label: 'No, deny this',                   icon: `${RED}✗${RST}` },
        { key: 'view',     label: 'View full arguments',             icon: `${CYAN}▸${RST}` },
    ];
}

// ── Interactive Selector ──

/**
 * Render the menu with the current selection highlighted.
 * Returns the number of lines rendered (for cleanup).
 */
function renderMenu(options, selectedIdx, firstRender) {
    // Move cursor up to overwrite previous render (except on first render)
    if (!firstRender) {
        cursorUp(options.length + 1); // +1 for the hint line
    }

    for (let i = 0; i < options.length; i++) {
        clearLine();
        const opt = options[i];
        const selected = i === selectedIdx;
        const pointer = selected ? `${CYAN}›${RST}` : ' ';
        const labelStyle = selected ? `${BOLD}${WHITE}` : DIM;
        const dangerTag = opt.dangerous ? `  ${RED}${DIM}(confirm required)${RST}` : '';
        write(`  ${pointer} ${opt.icon} ${labelStyle}${opt.label}${RST}${dangerTag}\n`);
    }

    // Hint line
    clearLine();
    write(`  ${GRAY}↑↓ select · Enter confirm · Esc deny${RST}\n`);
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

    /** Attach the readline interface so we can pause/resume around prompts. */
    setReadline(rl) {
        this._rl = rl;
    }

    /**
     * Set callbacks to pause/resume the execution keypress listener.
     * Called before/after the approval menu takes over stdin.
     */
    setExecutionHooks({ onPause, onResume } = {}) {
        this._execPause = onPause || null;
        this._execResume = onResume || null;
    }

    /** Revoke approve-all and all type approvals. */
    revoke() {
        const wasActive = this.approveAll || this.approvedToolTypes.size > 0;
        this.approveAll = false;
        this.approvedToolTypes.clear();
        return wasActive;
    }

    /** Get current approval mode label for display. */
    getModeLabel() {
        if (this.approveAll) return `${GREEN}approve-all${RST}`;
        if (this.approvedToolTypes.size > 0) {
            return `${CYAN}auto: ${[...this.approvedToolTypes].join(', ')}${RST}`;
        }
        return `${DIM}ask${RST}`;
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

        // Auto-approve read-only shell commands
        if (toolName === 'shell') {
            const risk = assessShellRisk(args.command);
            if (risk === 'low') {
                this.history.push({ tool: toolName, decision: 'auto-safe', time: Date.now() });
                return { approved: true };
            }

            // NEVER auto-approve destructive shell commands
            const forcePrompt = FORCE_APPROVAL_SHELL.some(p => p.test(args.command || ''));
            if (forcePrompt) {
                return this._prompt(toolName, args);
            }
        }

        // NEVER auto-approve destructive tool types
        if (NEVER_AUTO_APPROVE.has(toolName)) {
            return this._prompt(toolName, args);
        }

        // --yes flag or 'a' was confirmed
        if (this.autoApprove || this.approveAll) {
            this.history.push({ tool: toolName, decision: 'auto', time: Date.now() });
            return { approved: true };
        }

        // Type was approved earlier
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

        write('\n');

        // What it will do
        if (toolName === 'shell') {
            write(`  ${CYAN}$ ${args.command || ''}${RST}\n`);
        } else {
            write(`  ${desc.action}  ${CYAN}${desc.detail}${RST}\n`);
        }

        // Risk badge + why
        write(`  ${riskColor}${riskLabel}${RST}  ${DIM}${desc.why}${RST}\n`);
        write('\n');

        // Show current approval mode if active
        if (this.approveAll || this.approvedToolTypes.size > 0) {
            write(`  ${GRAY}mode: ${this.getModeLabel()}${GRAY} (overridden for this prompt)${RST}\n`);
        }

        const options = getMenuOptions(toolName);
        const result = await this._selectMenu(options);

        switch (result) {
            case 'yes':
                write(`  ${GREEN}✓ Approved${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'yes', time: Date.now() });
                return { approved: true };

            case 'no':
            case 'escape':
                write(`  ${RED}✗ Denied${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'no', time: Date.now() });
                return { approved: false, reason: 'User denied' };

            case 'view':
                write(`\n${DIM}${JSON.stringify(args, null, 2)}${RST}\n`);
                return this._prompt(toolName, args);

            case 'all': {
                // Second confirmation for dangerous option
                const confirmed = await this._confirmDangerous(
                    'Approve ALL remaining tool calls this session?',
                    'Only destructive ops (delete, rm) will still prompt.'
                );
                if (confirmed) {
                    this.approveAll = true;
                    write(`  ${GREEN}✓✓ Approve-all activated${RST}\n\n`);
                    this.history.push({ tool: toolName, decision: 'approve-all', time: Date.now() });
                    return { approved: true };
                }
                // User backed out — re-show menu
                return this._prompt(toolName, args);
            }

            case 'type': {
                write(`  ${GREEN}✓ Auto-approving ${toolName}${RST}\n\n`);
                this.approvedToolTypes.add(toolName);
                this.history.push({ tool: toolName, decision: 'type-approve', time: Date.now() });
                return { approved: true };
            }

            default:
                return this._prompt(toolName, args);
        }
    }

    /**
     * Second confirmation for dangerous options.
     * Simple Y/N with Enter to confirm, any other key to cancel.
     */
    async _confirmDangerous(question, detail) {
        write('\n');
        write(`  ${YELLOW}⚠${RST}  ${BOLD}${question}${RST}\n`);
        if (detail) write(`     ${DIM}${detail}${RST}\n`);
        write(`\n  ${GRAY}Enter${RST} to confirm, ${GRAY}any other key${RST} to cancel  `);

        const key = await this._readKey();

        if (key === 'return') {
            write(`${GREEN}confirmed${RST}\n`);
            return true;
        }
        write(`${DIM}cancelled${RST}\n`);
        return false;
    }

    /**
     * Interactive arrow-key menu selector.
     * Returns the key of the selected option.
     */
    async _selectMenu(options) {
        let selectedIdx = 0;

        // Pause execution keypress listener so it doesn't interfere
        if (this._execPause) this._execPause();

        // Pause readline
        if (this._rl) this._rl.pause();

        cursorHide();
        renderMenu(options, selectedIdx, true);

        return new Promise((resolve) => {
            if (!process.stdin.isTTY) {
                cursorShow();
                if (this._rl) this._rl.resume();
                resolve('yes');
                return;
            }

            const wasRaw = process.stdin.isRaw;
            process.stdin.setRawMode(true);
            process.stdin.resume();

            const onData = (data) => {
                const bytes = [...data];
                const str = data.toString();

                // Escape key
                if (bytes[0] === 0x1b && bytes.length === 1) {
                    cleanup();
                    resolve('escape');
                    return;
                }

                // Arrow keys: ESC [ A/B
                if (bytes[0] === 0x1b && bytes[1] === 0x5b) {
                    if (bytes[2] === 0x41) { // Up
                        selectedIdx = Math.max(0, selectedIdx - 1);
                        renderMenu(options, selectedIdx, false);
                        return;
                    }
                    if (bytes[2] === 0x42) { // Down
                        selectedIdx = Math.min(options.length - 1, selectedIdx + 1);
                        renderMenu(options, selectedIdx, false);
                        return;
                    }
                    return; // ignore other escape sequences
                }

                // Enter
                if (str === '\r' || str === '\n') {
                    cleanup();
                    resolve(options[selectedIdx].key);
                    return;
                }

                // Ctrl+C
                if (bytes[0] === 0x03) {
                    cleanup();
                    process.exit(0);
                }

                // Quick keys (still supported as shortcuts, but require Enter-like immediacy)
                // Only 'y' and 'n' as quick shortcuts for speed
                if (str === 'y' || str === 'Y') {
                    cleanup();
                    resolve('yes');
                    return;
                }
                if (str === 'n' || str === 'N') {
                    cleanup();
                    resolve('no');
                    return;
                }
            };

            const cleanup = () => {
                process.stdin.removeListener('data', onData);
                process.stdin.setRawMode(wasRaw || false);
                cursorShow();
                // Clear the menu lines
                cursorUp(options.length + 1);
                for (let i = 0; i < options.length + 1; i++) {
                    clearLine();
                    if (i < options.length) cursorDown();
                }
                cursorUp(options.length);
                if (this._rl) this._rl.resume();
                // Resume execution keypress listener
                if (this._execResume) this._execResume();
            };

            process.stdin.on('data', onData);
        });
    }

    /**
     * Read a single key event (for confirmations).
     * Returns key name: 'return', 'escape', or the character.
     */
    _readKey() {
        return new Promise((resolve) => {
            if (!process.stdin.isTTY) {
                resolve('return');
                return;
            }

            if (this._rl) this._rl.pause();

            const wasRaw = process.stdin.isRaw;
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.once('data', (data) => {
                process.stdin.setRawMode(wasRaw || false);
                if (this._rl) this._rl.resume();

                const bytes = [...data];
                const str = data.toString();

                if (bytes[0] === 0x03) process.exit(0);
                if (bytes[0] === 0x1b) { resolve('escape'); return; }
                if (str === '\r' || str === '\n') { resolve('return'); return; }
                resolve(str);
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
