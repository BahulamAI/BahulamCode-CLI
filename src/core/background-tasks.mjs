/**
 * BackgroundTasks — the one registry for long-running processes the agent
 * starts (docker build, npm run dev, test suites). Jobs get a run id,
 * a per-job timeout with SIGTERM→SIGKILL escalation, output spooled to
 * .bahulam/tmp/jobs/<id>.log (with a bounded in-memory tail), completion
 * listeners for wake-on-finish delivery, and best-effort cleanup of the
 * whole process group when the CLI exits.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const KILL_ESCALATION_MS = 5000;
const MAX_TAIL_BYTES = 64 * 1024;

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return String(str || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

class BackgroundTasks {
  constructor() {
    this.jobs = new Map();
    this._seq = 0;
    this._listeners = new Set();
    this._exitHookInstalled = false;
  }

  onExit(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  start({ command, cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS, name = '', on_complete = null }) {
    this._installExitHook();
    const id = `job-${++this._seq}-${Date.now().toString(36)}`;
    const logDir = path.join(cwd, '.bahulam', 'tmp', 'jobs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${id}.log`);
    const logStream = fs.createWriteStream(logPath);

    const proc = spawn('bash', ['-c', command], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    const job = {
      id,
      name: name || command.slice(0, 60),
      command,
      cwd,
      pid: proc.pid,
      status: 'running',
      exit_code: null,
      started_at: Date.now(),
      ended_at: null,
      log_path: logPath,
      tail: '',
      timed_out: false,
      on_complete,
      _proc: proc,
      _done: null,
    };

    const appendTail = (chunk) => {
      const next = job.tail + chunk.toString();
      job.tail = next.length > MAX_TAIL_BYTES ? next.slice(next.length - MAX_TAIL_BYTES) : next;
    };
    proc.stdout.on('data', (d) => { logStream.write(d); appendTail(d); });
    proc.stderr.on('data', (d) => { logStream.write(d); appendTail(d); });

    let killTimer = null;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      job.timed_out = true;
      this._kill(job, 'SIGTERM');
      killTimer = setTimeout(() => this._kill(job, 'SIGKILL'), KILL_ESCALATION_MS);
    }, timeoutMs) : null;
    if (timer?.unref) timer.unref();

    job._done = new Promise((resolve) => {
      proc.on('close', (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        job.exit_code = code;
        job.ended_at = Date.now();
        job.status = job.timed_out ? 'timeout'
          : job.status === 'killed' ? 'killed'
          : code === 0 ? 'completed' : 'failed';
        job.tail = stripAnsi(job.tail);
        logStream.end();
        for (const listener of this._listeners) {
          try { listener(this.describe(job.id)); } catch { /* listeners are best-effort */ }
        }
        resolve(this.describe(job.id));
      });
      proc.on('error', (err) => {
        job.status = 'failed';
        job.tail = `${job.tail}\n${err.message}`.trim();
        job.ended_at = Date.now();
        logStream.end();
        resolve(this.describe(job.id));
      });
    });

    proc.unref();
    this.jobs.set(id, job);
    return this.describe(id);
  }

  /** Await a job's completion; resolves with its final description. */
  wait(id) {
    const job = this.jobs.get(id);
    if (!job) return Promise.resolve(null);
    if (job.status !== 'running') return Promise.resolve(this.describe(id));
    // Background jobs are unref'd so fire-and-forget tasks do not pin the CLI
    // open. When a caller explicitly awaits wait(id), temporarily ref the
    // process so fast commands still get their close event before Node decides
    // the top-level await is unsettled.
    try { job._proc?.ref?.(); } catch { /* best effort */ }
    return job._done.finally(() => {
      try { job._proc?.unref?.(); } catch { /* best effort */ }
    });
  }

  describe(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    return {
      id: job.id,
      name: job.name,
      command: job.command,
      pid: job.pid,
      status: job.status,
      exit_code: job.exit_code,
      duration_s: Math.round(((job.ended_at || Date.now()) - job.started_at) / 1000),
      log_path: job.log_path,
      tail: job.tail,
      timed_out: job.timed_out,
      on_complete: job.on_complete || null,
    };
  }

  list() {
    return [...this.jobs.keys()].map(id => {
      const d = this.describe(id);
      return { ...d, tail: undefined };
    });
  }

  kill(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === 'running') {
      job.status = 'killed';
      this._kill(job, 'SIGTERM');
      setTimeout(() => this._kill(job, 'SIGKILL'), KILL_ESCALATION_MS)?.unref?.();
    }
    return this.describe(id);
  }

  _kill(job, signal) {
    if (!job?._proc?.pid) return;
    try {
      if (process.platform !== 'win32') {
        process.kill(-job._proc.pid, signal);
        return;
      }
    } catch { /* fall through */ }
    try { job._proc.kill(signal); } catch { /* already exited */ }
  }

  _installExitHook() {
    if (this._exitHookInstalled) return;
    this._exitHookInstalled = true;
    process.on('exit', () => {
      for (const job of this.jobs.values()) {
        if (job.status === 'running') this._kill(job, 'SIGKILL');
      }
    });
  }
}

export const backgroundTasks = new BackgroundTasks();
