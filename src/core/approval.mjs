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

import { shellCommandDisplay, shellCommandProfile, toolDisplaySummary } from '../terminal/tool-display.mjs';
import {
  classify as classifyTier,
  TIERS,
  requiresExplicitApproval,
  requiresCheckpoint,
  label as tierLabel,
} from './risk-tier.mjs';
import {
  renderApprovalPrompt,
  renderApprovalDockPrompt,
  renderTrustedApproval,
  defaultOptions as approvalOptions,
} from '../ui/approval.mjs';
import { clearInputPrompt, isInputDockMounted, moveToContent, renderDockOverlay } from '../ui/input-dock.mjs';
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
    'agent_create', 'agent_sync',
    'workflow_create_multi', 'workflow_sync_multi',
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
    if (!safety.safe) return withShellRetryHint(safety.reason || 'Blocked by shell safety policy');
    const classification = classifyCommand(command);
    if (classification.classification === 'blocked') {
        return withShellRetryHint(classification.reason || 'Blocked by shell safety policy');
    }
    return '';
}

function withShellRetryHint(reason) {
    const text = String(reason || '').trim();
    if (/command substitution|backticks|\$\(\)/i.test(text)) {
        return `${text}. Retry with separate simple shell commands instead of backticks or $().`;
    }
    return text;
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
        this._approvalPromptActive = false;
        this._approvalPromptWasRaw = false;
    }

    setReadline(rl) { this._rl = rl; }

    setExecutionHooks({ onPause, onResume, onApprovalPromptEnd } = {}) {
        this._execPause = onPause || null;
        this._execResume = onResume || null;
        this._approvalPromptEnd = onApprovalPromptEnd || null;
    }

    _beginApprovalInput() {
        if (this._approvalPromptActive || !process.stdin.isTTY) return false;
        this._approvalPromptActive = true;
        this._approvalPromptWasRaw = process.stdin.isRaw;
        if (this._execPause) this._execPause();
        if (this._rl) this._rl.pause();
        if (typeof process.stdin.setRawMode === 'function') {
            process.stdin.setRawMode(true);
        }
        process.stdin.resume();
        return true;
    }

    _endApprovalInput() {
        if (!this._approvalPromptActive) return;
        if (typeof process.stdin.setRawMode === 'function') {
            process.stdin.setRawMode(this._approvalPromptWasRaw || false);
        }
        if (this._rl) this._rl.resume();
        if (this._execResume) this._execResume();
        this._approvalPromptActive = false;
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
            if (isInputDockMounted()) moveToContent();
            writeSafetyBlock(reason);
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
        const options = this._optionsFor(tier, toolName, args);

        let selected = 0; // arrow-driven cursor
        let printedHeight = 0;
        let showDetails = false;

        const isInteractive = process.stdin.isTTY;

        // In rich TTY mode approval lives in the fixed input dock, replacing
        // "+ add instruction" until the user decides. Fallback/plain mode
        // still renders in the transcript.
        const useDockPrompt = isInteractive && isInputDockMounted();
        if (!useDockPrompt && isInputDockMounted()) moveToContent();

        // For TTYs we redraw in place on every arrow key so the prompt feels
        // live. For non-TTYs / pipes we just print once and read a line.
        if (!isInteractive) {
            write(renderApprovalPrompt({ tool: toolName, args, tier, why, selected, options, showDetails }) + '\n');
        }

        const drawPrompt = () => {
            if (useDockPrompt) {
                const dock = renderApprovalDockPrompt({
                    tool: toolName,
                    args,
                    tier,
                    why,
                    selected,
                    options,
                    showDetails,
                    width: process.stderr.columns || process.stdout.columns || 96,
                });
                renderDockOverlay({
                    context: dock.context,
                    lines: dock.lines || [`${dock.prefix || ''}${dock.value || ''}`],
                    meta: dock.meta,
                    tips: dock.tips,
                    maxRows: dock.maxRows,
                });
                printedHeight = 0;
                return;
            }
            // Move up over the previous render before re-printing. Use a
            // bounded per-line clear instead of \x1b[J — a full clear-to-end
            // would wipe the input dock's bottom rule and tips row that live
            // below this render position.
            if (printedHeight > 0) {
                write(`\x1b[${printedHeight}F`); // cursor to start of N lines above
                for (let i = 0; i < printedHeight; i++) {
                    write('\x1b[2K');            // clear current line
                    write('\x1b[1E');            // to start of next line
                }
                write(`\x1b[${printedHeight}F`); // back to the anchor row
            }
            const block = renderApprovalPrompt({ tool: toolName, args, tier, why, selected, options, showDetails });
            write(block + '\n');
            printedHeight = block.split('\n').length;
        };

        const ownsApprovalInput = isInteractive ? this._beginApprovalInput() : false;

        try {
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
                    if (lower === 'd' && toolName === 'shell') {
                        showDetails = !showDetails;
                        if (isInteractive) drawPrompt();
                        continue;
                    }
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
        if (useDockPrompt) {
            clearInputPrompt();
            if (this._approvalPromptEnd) this._approvalPromptEnd();
            moveToContent();
        }
        const prompt = promptForLog(toolName, args, tier, why);

        switch (value) {
            case 'approve':
                this.history.push({ tool: toolName, decision: 'yes', tier, time: Date.now() });
                this.approvalLog.append({ tool: toolName, args, tier, decision: 'approve', scope: 'once', prompt });
                writeApprovalConfirmation(toolName, args, 'approved once');
                return { approved: true, tier };

            case 'allow-session': {
                if (!this.policy.hitl?.allowSessionTrust) return await this._prompt(toolName, args, context);
                const rule = this.trustStore.add({ tool: toolName, args, tier, scope: 'SESSION' });
                write(`  ${GREEN}✓${RST}  ${DIM}trusted for this session: ${rule.pattern}${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'session-trust', tier, time: Date.now(), rule_id: rule.id });
                this.approvalLog.append({ tool: toolName, args, tier, decision: 'approve_trusted', scope: 'SESSION', rule_id: rule.id, prompt });
                return { approved: true, tier, scope: 'SESSION', rule_id: rule.id };
            }

            case 'allow-project': {
                if (!this.policy.hitl?.allowProjectTrust) return await this._prompt(toolName, args, context);
                const rule = this.trustStore.add({ tool: toolName, args, tier, scope: 'PROJECT' });
                write(`  ${GREEN}✓${RST}  ${DIM}trusted for this project: ${rule.pattern}${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'project-trust', tier, time: Date.now(), rule_id: rule.id });
                this.approvalLog.append({ tool: toolName, args, tier, decision: 'approve_trusted', scope: 'PROJECT', rule_id: rule.id, prompt });
                return { approved: true, tier, scope: 'PROJECT', rule_id: rule.id };
            }

            case 'reject':
            {
                const reason = 'User stopped the command';
                write(`  ${RED}✗${RST}  ${DIM}stopped${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'no', tier, time: Date.now(), reason });
                this.approvalLog.append({ tool: toolName, args, tier, decision: 'reject', scope: 'once', reason, prompt });
                this._rememberRejection({ tool: toolName, args, tier, decision: 'reject', reason, note: '' });
                return { approved: false, tier, reason };
            }

            case 'allow-all':
                if (requiresExplicitApproval(tier)) return await this._prompt(toolName, args, context);
                this.approveAll = true;
                write(`  ${GREEN}✓✓${RST} ${DIM}allow-all activated${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'approve-all', tier, time: Date.now() });
                this.approvalLog.append({ tool: toolName, args, tier, decision: 'approve-all', scope: 'session', prompt });
                return { approved: true, tier };

            case 'allow-type':
                if (requiresExplicitApproval(tier)) return await this._prompt(toolName, args, context);
                this.approvedToolTypes.add(toolName);
                this.history.push({ tool: toolName, decision: 'type-approve', tier, time: Date.now() });
                this.approvalLog.append({ tool: toolName, args, tier, decision: 'type-approve', scope: 'session', prompt });
                writeApprovalConfirmation(toolName, args, 'always allow');
                return { approved: true, tier };

            case 'why':
                write(`\n  ${DIM}${(context.reason || why).slice(0, 400)}${RST}\n\n`);
                printedHeight = 0;
                return await this._prompt(toolName, args, context);

            case 'edit':
            case 'replan':
            {
                const note = await this._readLinePrompt(`  ${DIM}How would you like to proceed? ${RST}`);
                const reason = note ? `User asked to re-plan: ${note}` : 'User asked to re-plan';
                write(`  ${YELLOW}↩${RST}  ${DIM}${note ? `re-plan — ${truncateNote(note)}` : 'reject with hint — rework the plan'}${RST}\n\n`);
                this.history.push({ tool: toolName, decision: 'replan', tier, time: Date.now(), reason });
                this.approvalLog.append({ tool: toolName, args, tier, decision: 'replan', scope: 'once', reason, prompt });
                this._rememberRejection({ tool: toolName, args, tier, decision: 'replan', reason, note });
                return { approved: false, tier, reason };
            }

            default:
                return await this._prompt(toolName, args, context);
        }
        } finally {
            if (ownsApprovalInput) this._endApprovalInput();
        }
    }

    _readKey() {
        return new Promise((resolve) => {
            if (!process.stdin.isTTY) {
                resolve('return');
                return;
            }

            const managesInput = !this._approvalPromptActive;
            if (managesInput) {
                if (this._execPause) this._execPause();
                if (this._rl) this._rl.pause();
            }

            const wasRaw = process.stdin.isRaw;
            if (managesInput && typeof process.stdin.setRawMode === 'function') {
                process.stdin.setRawMode(true);
            }
            process.stdin.resume();
            process.stdin.once('data', (data) => {
                if (managesInput) {
                    if (typeof process.stdin.setRawMode === 'function') {
                        process.stdin.setRawMode(wasRaw || false);
                    }
                    if (this._rl) this._rl.resume();
                    if (this._execResume) this._execResume();
                }

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

            const managesInput = !this._approvalPromptActive;
            if (managesInput) {
                if (this._execPause) this._execPause();
                if (this._rl) this._rl.pause();
            }

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
                if (managesInput) {
                    if (this._rl) this._rl.resume();
                    if (this._execResume) this._execResume();
                }
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

    _optionsFor(tier, toolName, args) {
        return approvalOptions(tier, { tool: toolName, args });
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

function promptForLog(tool, args, tier, why) {
    return {
        title: `${approvalTitleForLog(tier)} · ${tierLabel(tier)} · ${tool || 'tool'}`,
        subject: approvalSummary(tool, args),
        reason: why || '',
    };
}

function approvalTitleForLog(tier) {
    switch (tier) {
        case TIERS.SENSITIVE_READ:
        case TIERS.SHELL_DANGEROUS:
        case TIERS.DESTRUCTIVE:
            return 'EXPLICIT APPROVAL';
        default:
            return 'APPROVAL';
    }
}

function writeApprovalConfirmation(tool, args, label) {
    if (tool === 'shell') {
        write(`  ${GREEN}✓${RST}  ${DIM}${label} · shell ${shellApprovalSubject(args)}${RST}\n`);
        return;
    }
    const subject = approvalSummary(tool, args);
    const suffix = subject ? ` · ${truncateNote(subject)}` : '';
    write(`  ${GREEN}✓${RST}  ${DIM}${label}${suffix}${RST}\n\n`);
}

function shellApprovalSubject(args = {}) {
    const profile = shellCommandProfile(args.command || args.cmd || '');
    const subject = profile.compact ? profile.summary : profile.command;
    return `$ ${truncateNote(subject)}`;
}

function writeSafetyBlock(reason) {
    const cols = Math.max(40, Math.min(process.stderr.columns || process.stdout.columns || 80, 140));
    const firstPrefix = `  ${RED}✗${RST}  ${DIM}`;
    const nextPrefix = `     ${DIM}`;
    const firstWidth = Math.max(24, cols - 5);
    const nextWidth = Math.max(24, cols - 5);
    const lines = wrapSafetyText(reason, firstWidth, nextWidth);

    write(`${firstPrefix}${lines[0] || ''}${RST}\n`);
    for (const line of lines.slice(1)) {
        write(`${nextPrefix}${line}${RST}\n`);
    }
    write('\n');
}

function wrapSafetyText(text, firstWidth, nextWidth) {
    const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!words.length) return [''];

    const lines = [];
    let line = '';
    let width = firstWidth;

    for (const word of words) {
        if (!line) {
            if (word.length <= width) {
                line = word;
            } else {
                const chunks = splitWord(word, width);
                lines.push(...chunks.slice(0, -1));
                line = chunks[chunks.length - 1] || '';
            }
            continue;
        }

        if (line.length + 1 + word.length <= width) {
            line += ` ${word}`;
            continue;
        }

        lines.push(line);
        width = nextWidth;
        if (word.length <= width) {
            line = word;
        } else {
            const chunks = splitWord(word, width);
            lines.push(...chunks.slice(0, -1));
            line = chunks[chunks.length - 1] || '';
        }
    }

    if (line) lines.push(line);
    return lines;
}

function splitWord(word, width) {
    const size = Math.max(8, width);
    const chunks = [];
    for (let i = 0; i < word.length; i += size) {
        chunks.push(word.slice(i, i + size));
    }
    return chunks;
}
