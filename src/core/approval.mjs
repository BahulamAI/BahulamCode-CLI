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

import { toolDisplayLabel, toolDisplaySummary } from '../terminal/tool-display.mjs';
import {
  classify as classifyTier,
  TIERS,
  requiresExplicitApproval,
  requiresCheckpoint,
  label as tierLabel,
} from './risk-tier.mjs';
import {
  renderApprovalPrompt,
  renderInlinePrompt,
  defaultOptions as approvalOptions,
} from '../ui/approval.mjs';

// ── Tool Classification ──
//
// Risk tiering moved to src/core/risk-tier.mjs (PRD-055 §8.1). WRITE_TOOLS
// stays here only because `planMode` blocks anything that writes.

const WRITE_TOOLS = new Set([
    'shell', 'write_file', 'write_project', 'edit_file', 'delete_file',
    'validate_build', 'lint_check',
]);

function defaultWhy(tier, tool, args) {
    switch (tier) {
        case TIERS.SHELL_DANGEROUS:
            return `Shell command matches a high-risk pattern (rm -rf, sudo, force push, etc.). Confirm before running.`;
        case TIERS.DESTRUCTIVE:
            return `${tool} permanently mutates project state. Confirm before running.`;
        case TIERS.SHELL_MEDIUM:
            return `Mutates the workspace or environment (install, build, commit, push).`;
        case TIERS.NETWORK:
            return `Reaches an external network endpoint.`;
        default:
            return '';
    }
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

    async check(toolName, args, requireApproval = false, context = {}) {
        if (this.planMode && WRITE_TOOLS.has(toolName)) {
            return { approved: false, reason: `Blocked by plan mode: ${toolName}` };
        }
        // Auto-approve everything in headless/autoApprove mode (no TTY prompts)
        if (this.autoApprove) {
            this.history.push({ tool: toolName, decision: 'auto', time: Date.now() });
            return { approved: true, tier: classifyTier(toolName, args) };
        }

        const tier = classifyTier(toolName, args);

        // 'auto' tiers: read, shell-safe.
        if (tier === TIERS.READ || tier === TIERS.SHELL_SAFE) {
            this.history.push({ tool: toolName, decision: 'auto-tier', tier, time: Date.now() });
            return { approved: true, tier };
        }

        // 'auto-with-undo' tier: local-edit. Checkpoint is taken by the tool
        // executor before the edit; here we just approve.
        if (tier === TIERS.LOCAL_EDIT) {
            this.history.push({ tool: toolName, decision: 'auto-with-undo', tier, time: Date.now() });
            return { approved: true, tier, requireCheckpoint: true };
        }

        // Honor approve-all / type-allow shortcuts for non-explicit tiers only.
        if (!requiresExplicitApproval(tier)) {
            if (this.approveAll) {
                this.history.push({ tool: toolName, decision: 'auto-all', tier, time: Date.now() });
                return { approved: true, tier };
            }
            if (this.approvedToolTypes.has(toolName)) {
                this.history.push({ tool: toolName, decision: 'type-auto', tier, time: Date.now() });
                return { approved: true, tier };
            }
        }

        return this._prompt(toolName, args, { ...context, tier });
    }

    async _prompt(toolName, args, context = {}) {
        const tier = context.tier || classifyTier(toolName, args);
        const explicit = requiresExplicitApproval(tier);
        const why = context.reason || context.why || defaultWhy(tier, toolName, args);
        const summary = toolDisplaySummary(toolName, args);
        const options = approvalOptions(tier);

        let selected = 0; // arrow-driven cursor
        let printedHeight = 0;

        // For TTYs we redraw in place on every arrow key so the prompt feels
        // live. For non-TTYs / pipes we just print once and read a line.
        const isInteractive = process.stdin.isTTY;
        if (!isInteractive) {
            write(explicit
                ? renderApprovalPrompt({ tool: toolName, args, tier, why, selected, options }) + '\n'
                : renderInlinePrompt({ tool: toolName, args, tier, why }) + '\n');
        }

        const drawExplicit = () => {
            // Move up over the previous render before re-printing.
            if (printedHeight > 0) {
                write(`\x1b[${printedHeight}F`); // cursor to start of N lines above
                write('\x1b[J');                   // clear from cursor to end of screen
            }
            const block = renderApprovalPrompt({ tool: toolName, args, tier, why, selected, options });
            write(block + '\n');
            printedHeight = block.split('\n').length;
        };

        if (isInteractive && explicit) drawExplicit();
        if (isInteractive && !explicit) write(renderInlinePrompt({ tool: toolName, args, tier, why }) + '\n');

        // ── Input loop ─────────────────────────────────────────────────
        const choose = async () => {
            for (;;) {
                const k = await this._readKey();

                if (k === 'up' || k === 'left') {
                    if (!explicit || !isInteractive) continue;
                    selected = (selected - 1 + options.length) % options.length;
                    drawExplicit();
                    continue;
                }
                if (k === 'down' || k === 'right' || k === 'tab') {
                    if (!explicit || !isInteractive) continue;
                    selected = (selected + 1) % options.length;
                    drawExplicit();
                    continue;
                }
                if (k === 'return') {
                    return options[selected].value;
                }
                if (k === 'escape') return 'reject';

                // Letter shortcut: match against option.key
                if (typeof k === 'string' && k.length === 1) {
                    const lower = k.toLowerCase();
                    const idx = options.findIndex(o => o.key === lower);
                    if (idx >= 0) {
                        selected = idx;
                        if (isInteractive && explicit) drawExplicit();
                        return options[idx].value;
                    }
                }
                // Anything else: ignore and re-read.
            }
        };

        const value = await choose();

        switch (value) {
            case 'approve':
                write(`  ${GREEN}✓${RST}  ${DIM}${toolName}${RST} ${DIM}${summary.slice(0, 60)}${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'yes', tier, time: Date.now() });
                return { approved: true, tier };

            case 'reject':
                write(`  ${RED}✗${RST}  ${DIM}denied${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'no', tier, time: Date.now() });
                return { approved: false, tier, reason: 'User denied' };

            case 'allow-all':
                if (explicit) return this._prompt(toolName, args, context);
                this.approveAll = true;
                write(`  ${GREEN}✓✓${RST} ${DIM}allow-all activated${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'approve-all', tier, time: Date.now() });
                return { approved: true, tier };

            case 'allow-type':
                if (explicit) return this._prompt(toolName, args, context);
                this.approvedToolTypes.add(toolName);
                write(`  ${GREEN}✓${RST}  ${DIM}always allow ${toolName}${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'type-approve', tier, time: Date.now() });
                return { approved: true, tier };

            case 'why':
                write(`\n  ${DIM}${(context.reason || why).slice(0, 400)}${RST}\n\n`);
                printedHeight = 0;
                return this._prompt(toolName, args, context);

            case 'edit':
            case 'replan':
                write(`  ${YELLOW}↩${RST}  ${DIM}reject with hint — rework the plan${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'replan', tier, time: Date.now() });
                return { approved: false, tier, reason: 'User asked to re-plan' };

            default:
                return this._prompt(toolName, args, context);
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
                // Arrow keys: ESC [ A/B/C/D (3-byte CSI sequences)
                if (bytes.length === 3 && bytes[0] === 0x1b && bytes[1] === 0x5b) {
                    if (bytes[2] === 0x41) { resolve('up');    return; }
                    if (bytes[2] === 0x42) { resolve('down');  return; }
                    if (bytes[2] === 0x43) { resolve('right'); return; }
                    if (bytes[2] === 0x44) { resolve('left');  return; }
                }
                // Bare Esc (single byte) — explicit reject signal
                if (bytes.length === 1 && bytes[0] === 0x1b) { resolve('escape'); return; }
                if (bytes[0] === 0x09) { resolve('tab'); return; }
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
