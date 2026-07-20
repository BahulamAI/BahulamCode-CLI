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

import { shellCommandDisplay, toolDisplaySummary } from '../terminal/tool-display.mjs';
import {
  classify as classifyTier,
  TIERS,
  requiresExplicitApproval,
  requiresCheckpoint,
  label as tierLabel,
} from './risk-tier.mjs';
import {
  renderApprovalPrompt,
  renderTrustedApproval,
  defaultOptions as approvalOptions,
} from '../ui/approval.mjs';
import { validateShellCommand } from './safety.mjs';
import { classifyCommand } from '../permissions/command-classifier.mjs';
import { ApprovalLog } from './approval-log.mjs';
import { TrustStore } from './trust.mjs';
import { loadEffectivePolicy } from './policy-resolver.mjs';

// ── Tool Classification ──
//
// Risk tiering moved to src/core/risk-tier.mjs (PRD-055 §8.1). WRITE_TOOLS
// stays here only because `planMode` blocks anything that writes.

const WRITE_TOOLS = new Set([
    'shell', 'write_file', 'write_project', 'edit_file', 'delete_file',
    'validate_build', 'lint_check',
    'skill_install', 'skill_update', 'skill_remove',
]);

function defaultWhy(tier, tool, args) {
    const subject = approvalSummary(tool, args);
    switch (tier) {
        case TIERS.SENSITIVE_READ:
            return `Reads a sensitive path (${subject || 'secret-like file'}). Confirm before exposing its contents to the agent.`;
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

function approvalSummary(tool, args = {}) {
    const summary = toolDisplaySummary(tool, args);
    if (tool !== 'shell') return summary;
    const display = shellCommandDisplay(args.command || args.cmd || summary || '');
    return display.cwdLabel ? `${display.command} in ${display.cwdLabel}` : display.command;
}

function shellHardBlockReason(tool, args = {}) {
    if (tool !== 'shell') return '';
    const command = args.command || args.cmd || '';
    const safety = validateShellCommand(command);
    if (!safety.safe) return safety.reason || 'Blocked by shell safety policy';
    const classification = classifyCommand(command);
    if (classification.classification === 'blocked') return classification.reason || 'Blocked by shell safety policy';
    return '';
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
    constructor({ autoApprove = false, planMode = false, cwd = process.cwd(), policy = null, trustStore = null, approvalLog = null } = {}) {
        this.autoApprove = autoApprove;
        this.planMode = planMode;
        this.cwd = cwd;
        this.policy = policy || loadEffectivePolicy({ cwd }).policy;
        this.trustStore = trustStore || new TrustStore({ cwd, policy: this.policy });
        this.approvalLog = approvalLog || new ApprovalLog({ cwd });
        this.approveAll = false;
        this.approvedToolTypes = new Set();
        this.history = [];
        this.rejectionHints = [];
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
        const trustActive = this.trustStore?.revoke?.() || false;
        return wasActive || trustActive;
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

        const tier = classifyTier(toolName, args);
        const hardBlock = shellHardBlockReason(toolName, args);
        if (hardBlock) {
            const reason = `Blocked by safety policy: ${hardBlock}`;
            this.history.push({ tool: toolName, decision: 'safety-block', tier, time: Date.now(), reason });
            this.approvalLog.append({ tool: toolName, args, tier, decision: 'safety_block', scope: 'none', reason });
            write(`  ${RED}✗${RST}  ${DIM}${reason}${RST}\n\n`);
            return { approved: false, tier, reason, blocked: true, code: 'safety_block' };
        }

        // Auto-approve everything in headless/autoApprove mode (no TTY prompts).
        // Non-overridable shell safety blocks are checked above.
        if (this.autoApprove) {
            this.history.push({ tool: toolName, decision: 'auto', tier, time: Date.now() });
            return { approved: true, tier };
        }

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

        const trust = this.trustStore?.find?.(toolName, args, tier);
        if (trust?.decision === 'deny') {
            this.history.push({ tool: toolName, decision: 'trusted-deny', tier, time: Date.now(), rule_id: trust.rule?.id });
            this.approvalLog.append({ tool: toolName, args, tier, decision: 'deny_trusted', scope: trust.rule?.scope, rule_id: trust.rule?.id });
            return { approved: false, tier, reason: `Denied by trust rule ${trust.rule?.id || ''}`.trim() };
        }
        if (trust?.decision === 'allow') {
            this.history.push({ tool: toolName, decision: 'auto_trusted', tier, time: Date.now(), rule_id: trust.rule?.id });
            this.approvalLog.append({ tool: toolName, args, tier, decision: 'auto_trusted', scope: trust.rule?.scope, rule_id: trust.rule?.id });
            write(renderTrustedApproval({ tool: toolName, args, scope: trust.rule?.scope, ruleId: trust.rule?.id }));
            return { approved: true, tier, scope: trust.rule?.scope, rule_id: trust.rule?.id };
        }
        if (trust?.decision === 'reask' && trust.reason) {
            context.reason = context.reason || context.why || `Re-asking: ${trust.reason}`;
        }

        // Honor approve-all / type-allow shortcuts for non-explicit tiers only.
        if (!requiresExplicitApproval(tier)) {
            if (this.approveAll) {
                this.history.push({ tool: toolName, decision: 'auto-all', tier, time: Date.now() });
                this.approvalLog.append({ tool: toolName, args, tier, decision: 'auto-all', scope: 'session' });
                return { approved: true, tier };
            }
            if (this.approvedToolTypes.has(toolName)) {
                this.history.push({ tool: toolName, decision: 'type-auto', tier, time: Date.now() });
                this.approvalLog.append({ tool: toolName, args, tier, decision: 'type-auto', scope: 'session' });
                return { approved: true, tier };
            }
        }

        return this._prompt(toolName, args, { ...context, tier });
    }

    async _prompt(toolName, args, context = {}) {
        const tier = context.tier || classifyTier(toolName, args);
        const why = context.reason || context.why || defaultWhy(tier, toolName, args);
        const summary = approvalSummary(toolName, args);
        const options = this._optionsFor(tier);

        let selected = 0; // arrow-driven cursor
        let printedHeight = 0;

        // For TTYs we redraw in place on every arrow key so the prompt feels
        // live. For non-TTYs / pipes we just print once and read a line.
        const isInteractive = process.stdin.isTTY;
        if (!isInteractive) {
            write(renderApprovalPrompt({ tool: toolName, args, tier, why, selected, options }) + '\n');
        }

        const drawPrompt = () => {
            // Move up over the previous render before re-printing.
            if (printedHeight > 0) {
                write(`\x1b[${printedHeight}F`); // cursor to start of N lines above
                write('\x1b[J');                   // clear from cursor to end of screen
            }
            const block = renderApprovalPrompt({ tool: toolName, args, tier, why, selected, options });
            write(block + '\n');
            printedHeight = block.split('\n').length;
        };

        if (isInteractive) drawPrompt();

        // ── Input loop ─────────────────────────────────────────────────
        const choose = async () => {
            for (;;) {
                const k = await this._readKey();

                if (k === 'up' || k === 'left') {
                    if (!isInteractive) continue;
                    selected = (selected - 1 + options.length) % options.length;
                    drawPrompt();
                    continue;
                }
                if (k === 'down' || k === 'right' || k === 'tab') {
                    if (!isInteractive) continue;
                    selected = (selected + 1) % options.length;
                    drawPrompt();
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
                        if (isInteractive) drawPrompt();
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
                this.approvalLog.append({ tool: toolName, args, tier, decision: 'approve', scope: 'once' });
                return { approved: true, tier };

            case 'allow-session': {
                if (!this.policy.hitl?.allowSessionTrust) return this._prompt(toolName, args, context);
                const rule = this.trustStore.add({ tool: toolName, args, tier, scope: 'SESSION' });
                write(`  ${GREEN}✓${RST}  ${DIM}trusted for this session: ${rule.pattern}${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'session-trust', tier, time: Date.now(), rule_id: rule.id });
                this.approvalLog.append({ tool: toolName, args, tier, decision: 'approve_trusted', scope: 'SESSION', rule_id: rule.id });
                return { approved: true, tier, scope: 'SESSION', rule_id: rule.id };
            }

            case 'allow-project': {
                if (!this.policy.hitl?.allowProjectTrust) return this._prompt(toolName, args, context);
                const rule = this.trustStore.add({ tool: toolName, args, tier, scope: 'PROJECT' });
                write(`  ${GREEN}✓${RST}  ${DIM}trusted for this project: ${rule.pattern}${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'project-trust', tier, time: Date.now(), rule_id: rule.id });
                this.approvalLog.append({ tool: toolName, args, tier, decision: 'approve_trusted', scope: 'PROJECT', rule_id: rule.id });
                return { approved: true, tier, scope: 'PROJECT', rule_id: rule.id };
            }

            case 'reject':
            {
                const reason = 'User stopped the command';
                write(`  ${RED}✗${RST}  ${DIM}stopped${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'no', tier, time: Date.now(), reason });
                this.approvalLog.append({ tool: toolName, args, tier, decision: 'reject', scope: 'once', reason });
                this._rememberRejection({ tool: toolName, args, tier, decision: 'reject', reason, note: '' });
                return { approved: false, tier, reason };
            }

            case 'allow-all':
                if (requiresExplicitApproval(tier)) return this._prompt(toolName, args, context);
                this.approveAll = true;
                write(`  ${GREEN}✓✓${RST} ${DIM}allow-all activated${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'approve-all', tier, time: Date.now() });
                this.approvalLog.append({ tool: toolName, args, tier, decision: 'approve-all', scope: 'session' });
                return { approved: true, tier };

            case 'allow-type':
                if (requiresExplicitApproval(tier)) return this._prompt(toolName, args, context);
                this.approvedToolTypes.add(toolName);
                write(`  ${GREEN}✓${RST}  ${DIM}always allow ${toolName}${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'type-approve', tier, time: Date.now() });
                this.approvalLog.append({ tool: toolName, args, tier, decision: 'type-approve', scope: 'session' });
                return { approved: true, tier };

            case 'why':
                write(`\n  ${DIM}${(context.reason || why).slice(0, 400)}${RST}\n\n`);
                printedHeight = 0;
                return this._prompt(toolName, args, context);

            case 'edit':
            case 'replan':
            {
                const note = await this._readLinePrompt(`  ${DIM}How would you like to proceed? ${RST}`);
                const reason = note ? `User asked to re-plan: ${note}` : 'User asked to re-plan';
                write(`  ${YELLOW}↩${RST}  ${DIM}${note ? `re-plan — ${truncateNote(note)}` : 'reject with hint — rework the plan'}${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'replan', tier, time: Date.now(), reason });
                this.approvalLog.append({ tool: toolName, args, tier, decision: 'replan', scope: 'once', reason });
                this._rememberRejection({ tool: toolName, args, tier, decision: 'replan', reason, note });
                return { approved: false, tier, reason };
            }

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

    _readLinePrompt(label) {
        return new Promise((resolve) => {
            if (!process.stdin.isTTY) {
                resolve('');
                return;
            }

            if (this._execPause) this._execPause();
            if (this._rl) this._rl.pause();

            const wasRaw = process.stdin.isRaw;
            if (typeof process.stdin.setRawMode === 'function') {
                process.stdin.setRawMode(false);
            }
            process.stdin.resume();
            write(label);

            let buffer = '';
            const cleanup = () => {
                process.stdin.off('data', onData);
                if (typeof process.stdin.setRawMode === 'function') {
                    process.stdin.setRawMode(wasRaw || false);
                }
                if (this._rl) this._rl.resume();
                if (this._execResume) this._execResume();
            };
            const finish = () => {
                cleanup();
                resolve(buffer.trim());
            };
            const onData = (data) => {
                const str = data.toString();
                if (data[0] === 0x03) process.exit(0);
                if (data[0] === 0x1b) {
                    buffer = '';
                    write('\n');
                    finish();
                    return;
                }
                if (str.includes('\n') || str.includes('\r')) {
                    buffer += str.replace(/[\r\n].*$/s, '');
                    finish();
                    return;
                }
                buffer += str;
            };

            process.stdin.on('data', onData);
        });
    }

    _optionsFor(tier) {
        const options = approvalOptions(tier);
        if (requiresExplicitApproval(tier)) {
            if (this.policy.hitl?.allowSessionTrust) {
                options.splice(1, 0, { key: 's', label: 'session', value: 'allow-session', hint: 'trust this pattern until expiry' });
            }
            if (this.policy.hitl?.allowProjectTrust) {
                options.splice(1, 0, { key: 'a', label: 'project', value: 'allow-project', hint: 'trust this pattern in this repo' });
            }
        }
        return options;
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
            trust: this.trustStore?.summary?.() || { sessionRules: 0, projectRules: 0 },
        };
    }

    _rememberRejection(entry) {
        this.rejectionHints.push({ ...entry, time: Date.now() });
        if (this.rejectionHints.length > 10) {
            this.rejectionHints.splice(0, this.rejectionHints.length - 10);
        }
    }

    consumeRejectionHints() {
        const hints = [...this.rejectionHints];
        this.rejectionHints = [];
        return hints;
    }
}

function truncateNote(note) {
    const text = String(note || '').trim();
    return text.length <= 120 ? text : text.slice(0, 119) + '…';
}
