/**
 * Bash Tool — matches Claude Code's exact behavior.
 *
 * Features:
 * - Timeout with SIGTERM -> SIGKILL escalation
 * - run_in_background option
 * - description parameter
 * - 1MB output limit
 * - ANSI code stripping by default
 */
import { spawn } from 'child_process';

// Strip ANSI escape sequences
function stripAnsi(str) {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function trimShellBackgroundOperator(command) {
    const raw = String(command || '');
    let i = raw.length - 1;
    while (i >= 0 && /\s/.test(raw[i])) i -= 1;
    if (raw[i] !== '&') return raw;
    if (raw[i - 1] === '&' || raw[i - 1] === '\\') return raw;
    return raw.slice(0, i).trimEnd();
}

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB
const TIMEOUT_TAIL_BYTES = 64 * 1024;
const TRUNCATION_MARKER = '\n[output truncated at 1MB]';

export const BashTool = {
    name: 'shell',
    description: 'Execute a bash command and return its output.',
    inputSchema: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'The command to execute' },
            timeout: { type: 'number', description: 'Timeout in ms (max 600000)', default: 120000 },
            description: { type: 'string', description: 'Description of what this command does' },
            cwd: { type: 'string', description: 'Working directory for the command' },
            run_in_background: { type: 'boolean', description: 'Run in background', default: false },
        },
        required: ['command'],
    },
    validateInput(input) {
        const errors = [];
        if (!input.command) errors.push('command is required');
        return errors;
    },
    async call(input) {
        const timeout = Math.min(input.timeout || 120000, 600000);
        const abortSignal = input.signal || input._signal || null;

        if (input.run_in_background) {
            return runBackground(trimShellBackgroundOperator(input.command), input.cwd);
        }

        if (abortSignal?.aborted) {
            return 'Error: Command cancelled by user';
        }

        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            let stdoutTail = '';
            let stderrTail = '';
            let stdoutTruncated = false;
            let stderrTruncated = false;
            let killed = false;
            let cancelled = false;
            let exitCode = null;
            let killTimer = null;
            let settled = false;

            const proc = spawn('bash', ['-c', input.command], {
                cwd: input.cwd,
                env: { ...process.env },
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: process.platform !== 'win32',
                timeout: 0, // we handle timeout ourselves
            });

            function finish(value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (killTimer) clearTimeout(killTimer);
                abortSignal?.removeEventListener?.('abort', onAbort);
                resolve(value);
            }

            function terminate(reason) {
                killed = true;
                cancelled = reason === 'cancelled';
                killProcess(proc, 'SIGTERM');
                killTimer = setTimeout(() => {
                    killProcess(proc, 'SIGKILL');
                }, 5000);
            }

            function onAbort() {
                terminate('cancelled');
            }

            abortSignal?.addEventListener?.('abort', onAbort, { once: true });
            if (abortSignal?.aborted) {
                terminate('cancelled');
            }

            proc.stdout.on('data', (chunk) => {
                const text = chunk.toString();
                const next = appendHead(stdout, text, MAX_OUTPUT_BYTES);
                if (next.length < stdout.length + text.length) stdoutTruncated = true;
                stdout = next;
                stdoutTail = appendTail(stdoutTail, text, TIMEOUT_TAIL_BYTES);
            });

            proc.stderr.on('data', (chunk) => {
                const text = chunk.toString();
                const next = appendHead(stderr, text, MAX_OUTPUT_BYTES);
                if (next.length < stderr.length + text.length) stderrTruncated = true;
                stderr = next;
                stderrTail = appendTail(stderrTail, text, TIMEOUT_TAIL_BYTES);
            });

            // Timeout: SIGTERM first, then SIGKILL after 5s
            const timer = setTimeout(() => {
                terminate('timeout');
            }, timeout);

            proc.on('close', (code) => {
                exitCode = code;

                if (stdoutTruncated) stdout += TRUNCATION_MARKER;
                if (stderrTruncated) stderr += TRUNCATION_MARKER;

                // Strip ANSI by default
                stdout = stripAnsi(stdout);
                stderr = stripAnsi(stderr);

                if (killed) {
                    const tail = formatTimeoutTail(stdoutTail, stderrTail);
                    const message = cancelled
                        ? `Error: Command cancelled by user\n${tail}`.trim()
                        : `Error: Command timed out after ${timeout}ms\n${tail}`.trim();
                    finish(message);
                    return;
                }

                const output = (stdout + (stderr ? '\n' + stderr : '')).trim();
                if (code !== 0) {
                    finish(`Exit code: ${code}\n${output}`.trim());
                } else {
                    finish(output || '(no output)');
                }
            });

            proc.on('error', (err) => {
                finish(`Error: ${err.message}`);
            });

            // Close stdin
            proc.stdin.end();
        });
    },
};

function appendHead(current, chunk, maxBytes) {
    if (current.length >= maxBytes) return current;
    const next = current + chunk;
    return next.length > maxBytes ? next.slice(0, maxBytes) : next;
}

function appendTail(current, chunk, maxBytes) {
    const next = current + chunk;
    return next.length > maxBytes ? next.slice(next.length - maxBytes) : next;
}

function formatTimeoutTail(stdoutTail, stderrTail) {
    const out = stripAnsi(stdoutTail || '').trim();
    const err = stripAnsi(stderrTail || '').trim();
    const lines = [];
    if (out) {
        lines.push('[stdout tail]');
        lines.push(tailLines(out, 80));
    }
    if (err) {
        if (lines.length) lines.push('');
        lines.push('[stderr tail]');
        lines.push(tailLines(err, 80));
    }
    return lines.length ? lines.join('\n') : '(no output captured before timeout)';
}

function tailLines(text, maxLines) {
    const lines = String(text || '').split('\n');
    return lines.slice(-maxLines).join('\n');
}

function killProcess(proc, signal) {
    if (!proc?.pid) return;
    try {
        if (process.platform !== 'win32') {
            process.kill(-proc.pid, signal);
            return;
        }
    } catch { /* fall through to direct process kill */ }
    try { proc.kill(signal); } catch { /* already exited */ }
}

function unrefChildStdio(proc) {
    for (const stream of [proc?.stdout, proc?.stderr]) {
        try { stream?.unref?.(); } catch { /* best effort */ }
    }
}

// Background jobs store
const backgroundJobs = new Map();
let bgJobId = 0;

function runBackground(command, cwd) {
    const id = ++bgJobId;
    const proc = spawn('bash', ['-c', command], {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const job = { id, pid: proc.pid, command, status: 'running', stdout: '', stderr: '' };
    backgroundJobs.set(id, job);

    proc.on('close', (code) => {
        job.status = code === 0 ? 'completed' : `exited(${code})`;
        job.stdout = stripAnsi(stdout.slice(0, MAX_OUTPUT_BYTES));
        job.stderr = stripAnsi(stderr.slice(0, MAX_OUTPUT_BYTES));
    });

    proc.unref();
    unrefChildStdio(proc);
    return `Background job started: id=${id}, pid=${proc.pid}`;
}

export { backgroundJobs };
