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

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB
const TIMEOUT_TAIL_BYTES = 64 * 1024;

export const BashTool = {
    name: 'Bash',
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

        if (input.run_in_background) {
            return runBackground(input.command, input.cwd);
        }

        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            let stdoutTail = '';
            let stderrTail = '';
            let killed = false;
            let exitCode = null;

            const proc = spawn('bash', ['-c', input.command], {
                cwd: input.cwd,
                env: { ...process.env },
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: process.platform !== 'win32',
                timeout: 0, // we handle timeout ourselves
            });

            proc.stdout.on('data', (chunk) => {
                const text = chunk.toString();
                stdout = appendHead(stdout, text, MAX_OUTPUT_BYTES);
                stdoutTail = appendTail(stdoutTail, text, TIMEOUT_TAIL_BYTES);
            });

            proc.stderr.on('data', (chunk) => {
                const text = chunk.toString();
                stderr = appendHead(stderr, text, MAX_OUTPUT_BYTES);
                stderrTail = appendTail(stderrTail, text, TIMEOUT_TAIL_BYTES);
            });

            // Timeout: SIGTERM first, then SIGKILL after 5s
            const timer = setTimeout(() => {
                killed = true;
                killProcess(proc, 'SIGTERM');
                setTimeout(() => {
                    killProcess(proc, 'SIGKILL');
                }, 5000);
            }, timeout);

            proc.on('close', (code) => {
                clearTimeout(timer);
                exitCode = code;

                // Truncate if over limit
                if (stdout.length > MAX_OUTPUT_BYTES) {
                    stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + '\n[output truncated at 1MB]';
                }
                if (stderr.length > MAX_OUTPUT_BYTES) {
                    stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + '\n[output truncated at 1MB]';
                }

                // Strip ANSI by default
                stdout = stripAnsi(stdout);
                stderr = stripAnsi(stderr);

                if (killed) {
                    const tail = formatTimeoutTail(stdoutTail, stderrTail);
                    resolve(`Error: Command timed out after ${timeout}ms\n${tail}`.trim());
                    return;
                }

                const output = (stdout + (stderr ? '\n' + stderr : '')).trim();
                if (code !== 0) {
                    resolve(`Exit code: ${code}\n${output}`.trim());
                } else {
                    resolve(output || '(no output)');
                }
            });

            proc.on('error', (err) => {
                clearTimeout(timer);
                resolve(`Error: ${err.message}`);
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
    return `Background job started: id=${id}, pid=${proc.pid}`;
}

export { backgroundJobs };
