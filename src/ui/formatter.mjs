/**
 * Formatter — Clean terminal output for Tarang events.
 *
 * Style reference: Claude Code screenshot
 *   ◐ Cyan spinner + cyan text for working/thinking
 *   ✓ Green checkmark + green path for file changes
 *   ✗ Red for errors
 *   White for content and summaries
 */

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

// Spinner frames
const SPINNER = ['◐', '◓', '◑', '◒'];

export class EventFormatter {
    constructor({ verbose = false } = {}) {
        this.verbose = verbose;
        this.toolCount = 0;
        this.toolCalls = [];
        this.changes = [];
        this.sessionInfo = null;
        this.tokenCount = { input: 0, output: 0 };
        this._spinnerFrame = 0;
        this._hasContent = false;
        this._lastContent = '';
        this._completed = false;
        this._seenCallIds = new Set();
        this._lastThinking = '';
    }

    render(event) {
        const { type, data } = event;
        switch (type) {
            case 'session_info':
                this.sessionInfo = data;
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
                this._complete(data);
                return true;
            case 'error':
                this._error(data);
                return true;
            case 'phase_start':
            case 'phase_update':
                this._phaseStart(data);
                return true;
            case 'phase_summary':
                this._phaseSummary(data);
                return true;
            case 'change':
                this._change(data);
                return true;
            case 'cancelled':
                process.stderr.write(`\n${YELLOW}  Cancelled${data?.reason ? ': ' + data.reason : ''}${RESET}\n`);
                return true;
            case 'paused':
                process.stderr.write(`${CYAN}  Paused${RESET}\n`);
                return true;
            case 'resumed':
                process.stderr.write(`${GREEN}  Resumed${RESET}\n`);
                return true;
            default:
                if (this.verbose) {
                    process.stderr.write(`${DIM}  [${type}] ${JSON.stringify(data).slice(0, 100)}${RESET}\n`);
                }
                return false;
        }
    }

    _spinner() {
        const frame = SPINNER[this._spinnerFrame % SPINNER.length];
        this._spinnerFrame++;
        return `${CYAN}${frame}${RESET}`;
    }

    _status(data) {
        const msg = data?.message || '';
        // Skip noisy statuses
        if (!msg || msg === 'Agent started') return;
        if (msg.startsWith('Creating agent') || msg.startsWith('Task type:')) {
            process.stderr.write(`${DIM}  ${msg}${RESET}\n`);
            return;
        }
        process.stderr.write(`  ${this._spinner()} ${CYAN}${msg}${RESET}\n`);
    }

    _thinking(data) {
        const text = data?.message || data?.text || '';
        if (!text || text === this._lastThinking) return;
        this._lastThinking = text;

        // Show iteration as a working indicator
        if (text.startsWith('Processing')) {
            // Skip generic "Processing (iteration N)..." — too noisy
            return;
        }

        // Show actual thinking text
        process.stderr.write(`  ${this._spinner()} ${CYAN}${text.slice(0, 200)}${RESET}\n`);
    }

    _content(data) {
        const text = data?.text || '';
        if (!text) return;

        // Deduplicate exact same content (CONTENT event may repeat)
        if (text === this._lastContent) return;
        this._lastContent = text;

        // Add newline separator before content block
        if (this.toolCount > 0 || this._hasContent) process.stdout.write('\n');
        this._hasContent = true;

        // Render content with 2-space indent
        const lines = text.split('\n');
        for (const line of lines) {
            process.stdout.write(`  ${line}\n`);
        }
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

        // Build human-readable description
        const desc = this._toolDescription(tool, args);
        process.stderr.write(`  ${this._spinner()} ${CYAN}${desc}${RESET}\n`);

        this.toolCalls.push({ name: tool, callId, startTime: Date.now() });
    }

    _toolDescription(tool, args) {
        switch (tool) {
            case 'read_file':
                return `Reading ${args.file_path || 'file'}...`;
            case 'read_files':
                const paths = args.file_paths || [];
                return `Reading ${paths.length} files...`;
            case 'write_file':
                return `Writing ${args.file_path || 'file'}...`;
            case 'write_project':
                const files = args.files || [];
                return `Writing ${files.length} files...`;
            case 'edit_file':
                return `Editing ${args.file_path || 'file'}...`;
            case 'list_files':
                return `Listing files${args.pattern ? ' (' + args.pattern + ')' : ''}...`;
            case 'search_files':
                return `Searching for "${args.pattern || ''}"...`;
            case 'search_code':
                return `Searching code: ${args.query || ''}...`;
            case 'shell':
                const cmd = (args.command || '').slice(0, 60);
                return `Running: ${cmd}${(args.command || '').length > 60 ? '...' : ''}`;
            case 'validate_build':
                return `Running build validation...`;
            case 'validate_file':
                return `Validating ${args.file_path || 'file'}...`;
            case 'lint_check':
                return `Linting ${args.file_path || 'file'}...`;
            default:
                return `${tool}...`;
        }
    }

    _toolDone(data) {
        const tool = data?.tool || '';
        const success = data?.success !== false;

        // Show file modifications as green checkmarks
        if (tool === 'write_file' || tool === 'edit_file' || tool === 'write_project') {
            const path = data?.result?.file_path || data?.args?.file_path || '';
            if (path) {
                const action = tool === 'edit_file' ? 'Modified' : tool === 'write_project' ? 'Created' : 'Written';
                process.stderr.write(`  ${GREEN}✓ ${action} ${path}${RESET}\n`);
                this.changes.push({ path, action });
            }
        }

        // Show validation results
        if (tool === 'validate_build' || tool === 'lint_check' || tool === 'validate_file') {
            if (success) {
                const label = tool === 'validate_build' ? 'Build passed' :
                              tool === 'lint_check' ? 'Lint check passed' :
                              'File validated';
                process.stderr.write(`  ${GREEN}✓ ${label}${RESET}\n`);
            } else {
                const msg = data?.result?.error || data?.result?.stderr || 'Failed';
                process.stderr.write(`  ${RED}✗ ${tool.replace('_', ' ')} failed: ${msg.slice(0, 100)}${RESET}\n`);
            }
        }

        // Show shell command results (if verbose or if failed)
        if (tool === 'shell' && !success) {
            const stderr = data?.result?.stderr || '';
            if (stderr) {
                process.stderr.write(`  ${RED}✗ Command failed: ${stderr.slice(0, 100)}${RESET}\n`);
            }
        }
    }

    _phaseStart(data) {
        const phase = data?.phase || data?.stage_name || '';
        if (phase && phase !== 'undefined') {
            process.stderr.write(`\n  ${this._spinner()} ${CYAN}${BOLD}${phase}${RESET}\n`);
        }
    }

    _phaseSummary(data) {
        if (data?.summary) {
            process.stderr.write(`  ${GREEN}✓${RESET} ${data.summary.slice(0, 200)}\n`);
        }
    }

    _change(data) {
        const icon = data?.type === 'create' ? `${GREEN}+${RESET}` : `${GREEN}~${RESET}`;
        process.stderr.write(`  ${icon} ${GREEN}${data?.path || ''}${RESET}\n`);
        this.changes.push(data);
    }

    _error(data) {
        const msg = data?.message || 'Unknown error';
        process.stderr.write(`\n  ${RED}✗ ${msg}${RESET}\n`);

        // Helpful suggestions for common errors
        if (msg.includes('Authentication') || msg.includes('token')) {
            process.stderr.write(`  ${DIM}Run /login to re-authenticate${RESET}\n`);
        } else if (msg.includes('API key') || msg.includes('OpenRouter')) {
            process.stderr.write(`  ${DIM}Run /config to set up your provider${RESET}\n`);
        } else if (msg.includes('Backend') || msg.includes('Network')) {
            process.stderr.write(`  ${DIM}Check if the backend is running at ${this.sessionInfo?.backend || 'localhost:8000'}${RESET}\n`);
        }
    }

    _complete(data) {
        // Only show once
        if (this._completed) return;
        this._completed = true;

        const duration = data?.duration_s ? `${Number(data.duration_s).toFixed(1)}s` : '';
        const tools = this.toolCount || data?.tool_calls || 0;
        const iterations = data?.iterations || 0;

        // Summary line
        const parts = [];
        if (duration) parts.push(duration);
        if (tools > 0) parts.push(`${tools} tool calls`);

        const stats = parts.length > 0 ? ` (${parts.join(', ')})` : '';
        process.stderr.write(`\n  ${GREEN}✓ Done${stats}${RESET}\n`);

        // Token usage if available
        const usage = data?.usage;
        if (usage && (usage.input_tokens || usage.total_tokens)) {
            const inp = usage.input_tokens || 0;
            const out = usage.output_tokens || 0;
            process.stderr.write(`  ${DIM}Tokens: ${inp.toLocaleString()} in / ${out.toLocaleString()} out${RESET}\n`);
        }
    }
}
