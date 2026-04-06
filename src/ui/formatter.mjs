/**
 * Formatter — Ink-style terminal output for Tarang events.
 * Handles all 22 SSE event types with rich display.
 * T9 + T12: Phase checklist, tool tracker, status bar.
 */

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';

export class EventFormatter {
    constructor({ verbose = false, showThinking = false } = {}) {
        this.verbose = verbose;
        this.showThinking = showThinking || !!process.env.SHOW_THINKING;
        this.phases = new Map();
        this.toolCalls = [];
        this.toolCount = 0;
        this.changes = [];
        this.sessionInfo = null;
        this.tokenCount = { input: 0, output: 0 };
    }

    /** Render an SSE event to terminal. Returns true if handled. */
    render(event) {
        const { type, data } = event;
        switch (type) {
            case 'status':
                this._status(data);
                return true;
            case 'session_info':
                this._sessionInfo(data);
                return true;
            case 'plan':
                this._plan(data);
                return true;
            case 'content':
                this._content(data);
                return true;
            case 'thinking':
                this._thinking(data);
                return true;
            case 'tool_call': case 'tool_request':
                this._toolCall(data);
                return true;
            case 'tool_done':
                this._toolDone(data);
                return true;
            case 'phase_update':
                this._phaseUpdate(data);
                return true;
            case 'phase_summary':
                this._phaseSummary(data);
                return true;
            case 'phase_start':
                this._phaseUpdate({ phase: data.phase, status: 'started', description: data.description });
                return true;
            case 'worker_update':
                this._workerUpdate(data);
                return true;
            case 'worker_start':
                this._workerUpdate({ worker: data.worker, status: `started (${data.type || 'worker'})` });
                return true;
            case 'worker_done':
                this._workerUpdate({ worker: data.worker, status: `done: ${data.summary || ''}` });
                return true;
            case 'delegation':
                this._delegation(data);
                return true;
            case 'change':
                this._change(data);
                return true;
            case 'error':
                this._error(data);
                return true;
            case 'complete':
                this._complete(data);
                return true;
            case 'cancelled':
                process.stderr.write(`\n${YELLOW}Cancelled${data.reason ? ': ' + data.reason : ''}${RESET}\n`);
                return true;
            case 'paused':
                process.stderr.write(`\n${CYAN}Paused${data.checkpoint ? ' at: ' + data.checkpoint : ''}${RESET}\n`);
                process.stderr.write(`${DIM}Press SPACE or run 'tarang resume' to continue.${RESET}\n`);
                return true;
            case 'resumed':
                process.stderr.write(`${GREEN}Resumed${data.instruction ? ': ' + data.instruction : ''}${RESET}\n`);
                return true;
            case 'pause_instruction':
                process.stderr.write(`${CYAN}Injected: ${data.instruction || ''}${RESET}\n`);
                return true;
            default:
                if (this.verbose) {
                    process.stderr.write(`${DIM}[${type}] ${JSON.stringify(data).slice(0, 120)}${RESET}\n`);
                }
                return false;
        }
    }

    _status(data) {
        process.stderr.write(`${DIM}${data.message || ''}${RESET}\n`);
    }

    _sessionInfo(data) {
        this.sessionInfo = data;
        if (this.verbose) {
            process.stderr.write(`${DIM}[session] ${data.session_id || data.task_id || ''}${RESET}\n`);
        }
    }

    _plan(data) {
        if (!data.milestones) return;
        process.stderr.write(`\n${BOLD}Plan:${RESET}\n`);
        for (const m of data.milestones) {
            const icon = m.status === 'completed' ? `${GREEN}✓${RESET}` :
                         m.status === 'failed' ? `${RED}✗${RESET}` :
                         m.status === 'started' ? `${YELLOW}◉${RESET}` : '○';
            process.stderr.write(`  ${icon} ${m.name}${m.description ? ': ' + m.description : ''}\n`);
        }
        process.stderr.write('\n');
    }

    _content(data) {
        process.stdout.write(data.text || data.message || '');
    }

    _thinking(data) {
        if (this.showThinking || this.verbose) {
            const text = (data.text || '').slice(0, this.verbose ? 500 : 200);
            process.stderr.write(`${DIM}${text}${RESET}\n`);
        }
    }

    _toolCall(data) {
        this.toolCount++;
        const n = this.toolCount;
        const name = data.tool || 'unknown';
        const argsPreview = JSON.stringify(data.args || {}).slice(0, 60);
        process.stderr.write(`${YELLOW}[${n}]${RESET} ${name} ${DIM}${argsPreview}${RESET}\n`);
        this.toolCalls.push({ name, callId: data.call_id, startTime: Date.now() });
    }

    _toolDone(data) {
        const duration = data.duration_ms ? `${data.duration_ms}ms` : '';
        if (this.verbose) {
            process.stderr.write(`${DIM}[tool] ${data.tool || ''} done ${duration}${RESET}\n`);
        }
    }

    _phaseUpdate(data) {
        const { phase, status } = data;
        this.phases.set(phase, status);
        const icon = status === 'completed' ? `${GREEN}✓${RESET}` :
                     status === 'failed' ? `${RED}✗${RESET}` :
                     status === 'started' ? `${YELLOW}◉${RESET}` : '○';
        process.stderr.write(`${icon} ${BOLD}${phase}${RESET}${data.description ? ': ' + data.description : ''}\n`);
    }

    _phaseSummary(data) {
        process.stderr.write(`\n${GREEN}Phase: ${data.phase}${RESET}\n`);
        if (data.summary) process.stderr.write(`  ${data.summary}\n`);
        if (data.changes) process.stderr.write(`  ${data.changes} changes\n`);
        process.stderr.write('\n');
    }

    _workerUpdate(data) {
        const { worker, status } = data;
        process.stderr.write(`${DIM}  [${worker}] ${status || ''}${RESET}\n`);
    }

    _delegation(data) {
        process.stderr.write(`${CYAN}  ${data.from || '?'} → ${data.to || '?'}${RESET}`);
        if (data.instruction) process.stderr.write(`: ${DIM}${data.instruction.slice(0, 80)}${RESET}`);
        process.stderr.write('\n');
    }

    _change(data) {
        this.changes.push(data);
        const icon = data.type === 'create' ? `${GREEN}+${RESET}` : `${YELLOW}~${RESET}`;
        process.stderr.write(`${DIM}  ${icon} ${data.path || ''}${RESET}\n`);
    }

    _error(data) {
        process.stderr.write(`\n${RED}✗ ${data.message || 'Unknown error'}${RESET}\n`);
    }

    _complete(data) {
        process.stderr.write(`\n${GREEN}✓ ${data.summary || 'Done'}`);
        if (data.changes) process.stderr.write(` (${data.changes} changes)`);
        if (data.duration_s) process.stderr.write(` in ${data.duration_s.toFixed(1)}s`);
        process.stderr.write(`${RESET}\n`);
        if (this.toolCount > 0) {
            process.stderr.write(`${DIM}  ${this.toolCount} tool calls${RESET}\n`);
        }
    }
}
