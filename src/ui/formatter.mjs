import { sgr, glyph, sectionHeading } from './chrome.mjs';
import { transcriptBoundary, transcriptHeader, transcriptLine } from './transcript-block.mjs';
import { renderCommandHead, renderCommandResult, toolSource } from './command-card.mjs';
import { renderFileDiffs } from './diff.mjs';
/**
 * Formatter — Clean terminal output for Bahulam events.
 *
 * Bahulam hierarchy: neutral content, indigo headings and active markers,
 * muted metadata, and status colors reserved for actual outcomes.
 */

import { toolDisplayLabel, toolDisplaySummary } from '../terminal/tool-display.mjs';
import { formatMessageWindow } from '../core/rate-limit-display.mjs';
import { formatAgentErrorGuidance } from '../core/error-guidance.mjs';


// Spinner frames
const SPINNER = ['◐', '◓', '◑', '◒'];

export class EventFormatter {
    constructor({ verbose = false } = {}) {
        this.verbose = verbose;
        this.toolCount = 0;
        this.toolCalls = [];
        this.changes = [];
        this.phases = new Map();
        this.sessionInfo = null;
        this.tokenCount = { input: 0, output: 0 };
        this._spinnerFrame = 0;
        this._hasContent = false;
        this._lastContent = '';
        this._completed = false;
        this._seenCallIds = new Set();
        this._lastThinking = '';
        this._lastBlock = null;
    }

    render(event) {
        const { type, data } = event;
        switch (type) {
            case 'session_info':
                this.sessionInfo = data;
                if (this.verbose) {
                    process.stderr.write(`${sgr.muted}  [session] ${data.session_id || ''}${sgr.reset}\n`);
                }
                return true;
            case 'status':
                this._status(data);
                return true;
            case 'thinking':
                this._thinking(data);
                return true;
            case 'content':
            case 'content_partial':
                this._content(data);
                return true;
            case 'tool_call':
            case 'tool_request':
                this._toolCall(data);
                return true;
            case 'tool_done':
                this._toolDone(data);
                return true;
            case 'complete':
                if (data?.rate_limit) {
                    this.sessionInfo = { ...(this.sessionInfo || {}), rate_limit: data.rate_limit };
                }
                this._complete(data);
                return true;
            case 'error':
                this._error(data);
                return true;
            case 'plan':
                this._plan(data);
                return true;
            case 'phase_start':
                this._phaseStart(data);
                return true;
            case 'phase_update':
                this._phaseUpdate(data);
                return true;
            case 'phase_summary':
                this._phaseSummary(data);
                return true;
            case 'change':
                this._change(data);
                return true;
            case 'worker_update':
            case 'worker_start':
            case 'worker_done':
                this._workerEvent(type, data);
                return true;
            case 'delegation':
                this._delegation(data);
                return true;
            case 'cancelled':
                this._boundary('status', { compactSame: true });
                process.stderr.write(`${sgr.warn}  Cancelled${data?.reason ? ': ' + data.reason : ''}${sgr.reset}\n`);
                this._lastBlock = 'status';
                return true;
            case 'paused':
                this._boundary('status', { compactSame: true });
                process.stderr.write(`${sgr.primary}  Paused${sgr.reset}\n`);
                this._lastBlock = 'status';
                return true;
            case 'resumed':
                this._boundary('status', { compactSame: true });
                process.stderr.write(`${sgr.success}  Resumed${sgr.reset}\n`);
                this._lastBlock = 'status';
                return true;
            case 'pause_instruction':
                this._pauseInstruction(data);
                return true;
            default:
                if (this.verbose) {
                    process.stderr.write(`${sgr.muted}  [${type}] ${JSON.stringify(data).slice(0, 100)}${sgr.reset}\n`);
                }
                return false;
        }
    }

    _spinner() {
        const frame = glyph(SPINNER[this._spinnerFrame % SPINNER.length], '*');
        this._spinnerFrame++;
        return `${sgr.primary}${frame}${sgr.reset}`;
    }

    _boundary(nextBlock, { compactSame = false } = {}) {
        const boundary = transcriptBoundary(this._lastBlock, nextBlock, { compactSame,
            ...(process.stderr.columns || process.stdout.columns ? { columns: process.stderr.columns || process.stdout.columns } : {}),
        });
        if (boundary) process.stderr.write(boundary);
    }

    _status(data) {
        const msg = data?.message || '';
        // Skip noisy per-turn statuses. Backend emits "Creating agent..." and
        // "Task type: ..." on every SSE turn (v3_sse.py:566), not just the first —
        // repeating them clutters the transcript.
        if (!msg || msg === 'Agent started') return;
        if (msg.startsWith('Creating agent') || msg.startsWith('Task type:')) return;
        this._boundary('status', { compactSame: true });
        process.stderr.write(`  ${this._spinner()} ${sgr.primary}${msg}${sgr.reset}\n`);
        this._lastBlock = 'status';
    }

    _thinking(data) {
        if (!this.verbose) return;

        const text = data?.message || data?.text || '';
        if (!text || text === this._lastThinking) return;
        this._lastThinking = text;

        // Skip generic "Processing (iteration N)..." — too noisy
        if (text.startsWith('Processing')) return;

        this._boundary('thinking');
        const clipped = text.length > 200 ? `${text.slice(0, 198)} …` : text;
        process.stderr.write(`  ${this._spinner()} ${sgr.primary}Thinking · ${clipped}${sgr.reset}\n`);
        this._lastBlock = 'thinking';
    }

    _content(data) {
        const text = data?.text || '';
        if (!text) return;

        // Deduplicate exact same content (CONTENT event may repeat)
        if (text === this._lastContent) return;
        this._lastContent = text;

        this._boundary('content', { compactSame: true });
        if (this._lastBlock !== 'content') process.stdout.write(transcriptHeader('Bahulam') + '\n');
        this._hasContent = true;

        // Render content with 2-space indent
        const lines = text.split('\n');
        for (const line of lines) {
            process.stdout.write(transcriptLine(line) + '\n');
        }
        this._lastBlock = 'content';
    }

    _toolCall(data) {
        const callId = data?.call_id;
        const tool = data?.tool || 'unknown';
        const args = data?.args || {};

        // Deduplicate: agent event + bridge event both fire
        if (callId) {
            if (this._seenCallIds.has(callId)) return;
            this._seenCallIds.add(callId);
        } else {
            // Agent event (no call_id) — skip if bridge event follows
            // Use tool+args as dedup key
            const key = `${tool}:${JSON.stringify(args)}`;
            if (this._seenCallIds.has(key)) return;
            this._seenCallIds.add(key);
        }

        this.toolCount++;
        this._boundary('tool', { compactSame: true });

        const label = toolDisplayLabel(tool);
        const summary = toolDisplaySummary(tool, args);
        if (tool === 'shell') {
            process.stderr.write(renderCommandHead(args, { source: toolSource(data) }) + '\n');
            this.toolCalls.push({ name: tool, callId, args, startTime: Date.now() });
            this._lastBlock = 'tool';
            return;
        }
        const detail = summary ? `${sgr.muted}${summary}${sgr.reset}` : '';
        process.stderr.write(`  ${this._spinner()} [${this.toolCount}] ${sgr.bold}${label}${sgr.reset}${detail ? `  ${detail}` : ''}\n`);

        this.toolCalls.push({ name: tool, callId, startTime: Date.now() });
        this._lastBlock = 'tool';
    }

    _toolDone(data) {
        const tool = data?.tool || '';
        const success = data?.success !== false;
        const durationMs = data?.duration_ms;
        const result = typeof data?.result === 'object' && data.result ? { ...data, ...data.result } : data;
        if (tool === 'shell') {
            const call = [...this.toolCalls].reverse().find(call => data?.call_id ? call.callId === data.call_id : call.name === tool);
            process.stderr.write(renderCommandResult(result, { args: data.args || call?.args || {}, durationMs }) + '\n');
            return;
        }
        if (result?.file_diff || result?.file_diffs) process.stderr.write(renderFileDiffs(result) + '\n');

        if (this.verbose) {
            const dur = durationMs ? ` (${durationMs}ms)` : '';
            process.stderr.write(`  ${success ? sgr.success : sgr.danger}${success ? glyph('✓', '+') : glyph('✗', 'x')}${sgr.reset} ${tool} ${success ? 'done' : 'failed'}${dur}\n`);
        }

        // Show file modifications as green checkmarks
        if (success && (tool === 'write_file' || tool === 'edit_file' || tool === 'write_project')) {
            const path = data?.result?.file_path || data?.args?.file_path || '';
            if (path) {
                const action = tool === 'edit_file' ? 'Modified' : tool === 'write_project' ? 'Created' : 'Written';
                process.stderr.write(`  ${sgr.success}✓ ${action} ${path}${sgr.reset}\n`);
                this.changes.push({ path, action });
            }
        }

        // Show validation results
        if (tool === 'validate_build' || tool === 'lint_check' || tool === 'validate_file') {
            if (success) {
                const label = tool === 'validate_build' ? 'Build passed' :
                              tool === 'lint_check' ? 'Lint check passed' :
                              'File validated';
                process.stderr.write(`  ${sgr.success}✓ ${label}${sgr.reset}\n`);
            } else {
                const msg = data?.result?.error || data?.result?.stderr || 'Failed';
                process.stderr.write(`  ${sgr.danger}✗ ${tool.replace('_', ' ')} failed: ${msg.slice(0, 100)}${sgr.reset}\n`);
            }
        }

        // Show shell command results (if verbose or if failed)
        if (tool === 'shell' && !success) {
            const stderr = data?.result?.stderr || '';
            if (stderr) {
                process.stderr.write(`  ${sgr.danger}✗ Command failed: ${stderr.slice(0, 100)}${sgr.reset}\n`);
            }
        }
    }

    _plan(data) {
        const milestones = data?.milestones || [];
        if (milestones.length === 0) return;
        this._boundary('plan');
        process.stderr.write(`  ${sgr.bold}Plan${sgr.reset}\n`);
        for (const m of milestones) {
            const icon = m.status === 'completed' ? `${sgr.success}✓${sgr.reset}` :
                         m.status === 'started' ? `${sgr.primary}◐${sgr.reset}` :
                         `${sgr.muted}○${sgr.reset}`;
            process.stderr.write(`  ${icon} ${m.name}\n`);
        }
        this._lastBlock = 'plan';
    }

    _phaseStart(data) {
        const phase = data?.phase || data?.stage_name || '';
        if (phase && phase !== 'undefined') {
            process.stderr.write('\n' + sectionHeading(phase) + '\n');
        }
    }

    _phaseUpdate(data) {
        const phase = data?.phase || data?.stage_name || '';
        const status = data?.status || '';
        if (phase && phase !== 'undefined') {
            this.phases.set(phase, status);
            process.stderr.write('\n' + sectionHeading(phase) + '\n');
        }
    }

    _phaseSummary(data) {
        if (data?.summary) {
            process.stderr.write(`  ${sgr.success}✓${sgr.reset} ${data.summary.slice(0, 200)}\n`);
        }
    }

    _workerEvent(type, data) {
        const worker = data?.worker || data?.name || '';
        const status = data?.status || '';
        if (type === 'worker_start') {
            process.stderr.write(`  ${this._spinner()} ${sgr.primary}${worker} starting${sgr.reset}\n`);
        } else if (type === 'worker_done') {
            process.stderr.write(`  ${sgr.success}✓${sgr.reset} ${worker} done\n`);
        } else {
            process.stderr.write(`  ${this._spinner()} ${sgr.primary}${worker}: ${status}${sgr.reset}\n`);
        }
    }

    _delegation(data) {
        const from = data?.from || '';
        const to = data?.to || '';
        const instruction = data?.instruction || '';
        process.stderr.write(`  ${sgr.primary}${from} → ${to}${sgr.reset}${instruction ? ': ' + instruction : ''}\n`);
    }

    _pauseInstruction(data) {
        const instruction = data?.instruction || '';
        if (instruction) {
            process.stderr.write(`  ${sgr.warn}Pause instruction: ${instruction}${sgr.reset}\n`);
        }
    }

    _change(data) {
        const icon = data?.type === 'create' ? `${sgr.success}+${sgr.reset}` : `${sgr.success}~${sgr.reset}`;
        process.stderr.write(`  ${icon} ${sgr.success}${data?.path || ''}${sgr.reset}\n`);
        this.changes.push(data);
    }

    _error(data) {
        const guidance = formatAgentErrorGuidance(data || {});
        process.stderr.write(`\n  ${sgr.danger}✗ ${guidance.title}${sgr.reset}\n`);
        for (const line of guidance.lines) {
            process.stderr.write(`  ${sgr.muted}${line}${sgr.reset}\n`);
        }
        if (guidance.meta.length) {
            process.stderr.write(`  ${sgr.muted}${guidance.meta.join(' · ')}${sgr.reset}\n`);
        }
    }

    _complete(data) {
        // Only show once
        if (this._completed) return;
        this._completed = true;

        const summary = data?.summary || '';
        const duration = data?.duration_s ? `${Number(data.duration_s).toFixed(1)}s` : '';
        const tools = this.toolCount || data?.tool_calls || 0;
        const changeCount = data?.changes || this.changes.length || 0;

        // Summary line
        const parts = [];
        if (duration) parts.push(duration);
        if (tools > 0) parts.push(`${tools} tool calls`);
        if (changeCount > 0) parts.push(`${changeCount} changes`);

        const success = data?.success !== false;
        const marker = success ? sgr.success + glyph('✓', '+') : sgr.danger + glyph('✗', 'x');
        const title = summary || (success ? 'Done' : 'Not completed');
        process.stderr.write(`\n  ${marker}${sgr.reset} ${sgr.bold}${title}${sgr.reset}\n`);
        if (parts.length) process.stderr.write(`  ${sgr.muted}${parts.join(glyph(' · ', ' / '))}${sgr.reset}\n`);

        const rateLimitLine = formatMessageWindow(data?.rate_limit || this.sessionInfo?.rate_limit);
        if (rateLimitLine) {
            process.stderr.write(`  ${sgr.muted}Messages: ${rateLimitLine}${sgr.reset}\n`);
        }

        // Token usage if available
        const usage = data?.usage;
        if (usage && (usage.input_tokens || usage.total_tokens)) {
            const inp = usage.input_tokens || 0;
            const out = usage.output_tokens || 0;
            process.stderr.write(`  ${sgr.muted}Tokens: ${inp.toLocaleString()} in / ${out.toLocaleString()} out${sgr.reset}\n`);
        }
    }
}
