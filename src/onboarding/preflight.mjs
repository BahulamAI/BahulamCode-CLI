/**
 * Preflight diagnostic.
 *
 * Prints a non-blocking summary of the runtime environment before the REPL
 * starts so the user can see what is and is not aligned:
 *
 *   🔭 Bahulam Code v0.1.7 · initializing
 *
 *     [✓] Auth token
 *     [✓] OpenRouter key
 *     [✓] Backend  http://127.0.0.1:8150
 *     [✓] Git repository  main · clean
 *     [⚠] Linter (ruff) not found → /install ruff to enable lint_check
 *     [✓] Project map  142 files, Python + TypeScript
 *
 *   All systems aligned. What are we building today?
 *
 * Checks are non-blocking. A failure shows a one-line next-step hint.
 *
 * Exposed via `runPreflight()` (called from REPL startup) and `/preflight`
 * (registered as a slash command).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { paint } from '../ui/palette.mjs';
import { icons } from '../ui/icons.mjs';
import { term } from '../ui/term.mjs';
import { formatMessageWindow, lowWindowStatus } from '../core/rate-limit-display.mjs';

const OK   = (s) => `${paint.state.success('[✓]')} ${s}`;
const WARN = (s) => `${paint.state.warn('[⚠]')} ${s}`;
const FAIL = (s) => `${paint.state.danger('[✗]')} ${s}`;

// ── Individual checks (each returns { status, label, hint? }) ──────────

export async function checkAuthAndBackend(auth, { timeoutMs } = {}) {
  const creds = auth.loadCredentials();
  const hasToken = !!creds.token;
  const url = creds.backendUrl;

  // Bundled runtime mode: the local Python runtime replaces the cloud
  // backend for agent execution. Probing a remote /api/user/me here would
  // falsely paint the CLI as "Offline" even though the local runtime
  // is fully operational. Report bundled state directly.
  const bundledMode =
    process.env.BAHULAM_RUNTIME_MODE === 'bundled' ||
    process.env.TARANG_ENV === 'bundled';
  if (bundledMode) {
    return hasToken
      ? { status: 'ok', label: 'Bundled runtime · authenticated' }
      : { status: 'warn', label: 'Bundled runtime', hint: '/login to enable metered calls' };
  }

  // Local Docker backends round-trip Supabase and often take 2–4s. Give them
  // more headroom so preflight doesn't falsely report Offline.
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:|$|\/)/i.test(url || '');
  timeoutMs = timeoutMs ?? (isLocal ? 8000 : 2500);

  // No token: just probe whether the backend is reachable so we can hint
  // /login when it makes sense.
  if (!hasToken) {
    const reachable = url ? await ping(url, timeoutMs).catch(() => false) : false;
    return reachable
      ? { status: 'warn', label: 'Online', hint: '/login to sign in' }
      : { status: 'warn', label: 'Offline' };
  }

  // Token present: real authenticated round-trip against /api/user/me.
  // Three outcomes: valid (200), expired (401/403), unreachable (network).
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetch(`${url}/api/user/me`, {
        headers: { 'Authorization': `Bearer ${creds.token}` },
        signal: ctrl.signal,
      });
    } finally { clearTimeout(t); }

    if (resp.ok) {
      const user = await resp.json().catch(() => null);
      return { status: 'ok', label: 'Online', user };
    }
    if (resp.status === 401 || resp.status === 403) {
      return { status: 'warn', label: 'Online', hint: '/login again to refresh' };
    }
    return { status: 'warn', label: 'Offline' };
  } catch {
    return { status: 'warn', label: 'Offline' };
  }
}

/**
 * Fetch subscription tier + remaining credits from /api/billing/balance.
 * Skipped when not signed in or when the backend is offline.
 *
 * Returns one of:
 *   { status, label }                 — shown as a preflight row
 *   null                              — silent (e.g. BYOK or no signal)
 */
export async function checkCreditsAndPlan(auth, { timeoutMs = 2000 } = {}) {
  const creds = auth.loadCredentials();
  if (!creds.token || !creds.backendUrl) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetch(`${creds.backendUrl}/api/billing/balance`, {
        headers: { 'Authorization': `Bearer ${creds.token}` },
        signal: ctrl.signal,
      });
    } finally { clearTimeout(t); }
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    if (!data) return null;

    const tier = (data.tier || 'free').toUpperCase();
    const windowLabel = formatMessageWindow(data.rate_limit);
    if (windowLabel) {
      const status = lowWindowStatus(data.rate_limit);
      if (status === 'exhausted') {
        return { status: 'fail', label: windowLabel, hint: 'message window exhausted — try again after reset' };
      }
      if (status === 'low') {
        return { status: 'warn', label: windowLabel, hint: 'low message window — bahulam.ai/pricing' };
      }
      return { status: 'ok', label: windowLabel };
    }

    if (data.byok_enabled) {
      return { status: 'ok', label: `Plan: ${tier || 'BYOK'} · billed by your provider` };
    }
    const remaining = data.balance?.total;
    if (typeof remaining !== 'number') {
      return { status: 'ok', label: `Plan: ${tier}` };
    }
    if (remaining <= 0) {
      return { status: 'fail', label: `Plan: ${tier} · 0 credits remaining`, hint: 'bahulam.ai/pricing to purchase or upgrade' };
    }
    if (remaining < 25) {
      return { status: 'warn', label: `Plan: ${tier} · ${remaining} credits remaining`, hint: 'low balance — bahulam.ai/pricing' };
    }
    return { status: 'ok', label: `Plan: ${tier} · ${remaining} credits remaining` };
  } catch {
    return null;
  }
}

function checkGit(cwd) {
  if (!hasGitDir(cwd)) return { status: 'warn', label: 'Not a git repository', hint: '`git init` to enable diff / checkpoints' };
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', { cwd, encoding: 'utf-8' }).trim();
    const status = execSync('git status --porcelain 2>/dev/null', { cwd, encoding: 'utf-8' });
    const dirty = status.split('\n').filter(Boolean).length;
    const summary = dirty > 0
      ? `${branch} · ${paint.state.warn(`${dirty} dirty`)}`
      : `${branch} · clean`;
    return { status: 'ok', label: `Git repository  ${summary}` };
  } catch {
    return { status: 'warn', label: 'Git repository present but unreadable' };
  }
}

function checkLinters(cwd) {
  const present = [];
  const missing = [];
  for (const linter of LINTERS) {
    if (which(linter.bin)) present.push(linter);
    else if (projectUses(cwd, linter.kind)) missing.push(linter);
  }
  if (present.length === 0 && missing.length === 0) {
    return { status: 'ok', label: 'Linters  none required' };
  }
  if (missing.length === 0) {
    return { status: 'ok', label: `Linters  ${present.map(p => p.bin).join(', ')}` };
  }
  // Honest install command per linter. Falls back to "install via your
  // package manager" when there is no clean one-liner (e.g. cargo).
  const hint = missing.map(m => m.install
    ? `${m.bin}: ${m.install}`
    : `install ${m.bin} for ${m.kind} support`
  ).join(' · ');
  return { status: 'warn', label: `Linter (${missing.map(m => m.bin).join(', ')}) not found`, hint };
}

const LINTERS = [
  { bin: 'ruff',    kind: 'python',     install: 'pip install ruff' },
  { bin: 'eslint',  kind: 'javascript', install: 'npm i -g eslint' },
  { bin: 'tsc',     kind: 'typescript', install: 'npm i -g typescript' },
  // cargo ships with rustup; no clean one-liner — surface the warning
  // without a misleading "/install" command.
  { bin: 'cargo',   kind: 'rust',       install: null },
];

function projectUses(cwd, kind) {
  try {
    const files = fs.readdirSync(cwd);
    switch (kind) {
      case 'python':     return files.some(f => /\.py$/.test(f)) || files.includes('pyproject.toml') || files.includes('requirements.txt');
      case 'javascript': return files.includes('package.json');
      case 'typescript': return files.includes('tsconfig.json');
      case 'rust':       return files.includes('Cargo.toml');
      default:           return false;
    }
  } catch { return false; }
}

function checkProjectMap(cwd) {
  try {
    const counts = quickFileCount(cwd, { max: 5000 });
    if (!counts.total) return { status: 'warn', label: 'Project map  no files indexed yet' };
    const langs = topLanguages(counts.byExt, 2);
    const langStr = langs.length ? langs.join(' + ') : 'mixed';
    return { status: 'ok', label: `Project map  ${counts.total} files, ${langStr}` };
  } catch {
    return { status: 'warn', label: 'Project map  unreadable' };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function shorten(s, n) {
  const str = String(s || '');
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

function hasGitDir(cwd) {
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function which(name) {
  try {
    execSync(`command -v ${name}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch { return false; }
}

function ping(url, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve(false); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname || '/',
      method: 'GET',
      timeout: timeoutMs,
    }, (res) => {
      // Any response means the host is reachable, even 404.
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(false); });
    req.end();
  });
}

const EXT_TO_LANG = {
  '.py': 'Python', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript',
  '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.go': 'Go', '.rs': 'Rust',
  '.java': 'Java', '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.kt': 'Kotlin',
  '.c': 'C', '.cc': 'C++', '.cpp': 'C++', '.h': 'C/C++', '.hpp': 'C++',
};

function topLanguages(byExt, n) {
  const ranked = Object.entries(byExt)
    .map(([ext, count]) => [EXT_TO_LANG[ext], count])
    .filter(([lang]) => lang)
    .reduce((acc, [lang, count]) => { acc.set(lang, (acc.get(lang) || 0) + count); return acc; }, new Map());
  return [...ranked.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([lang]) => lang);
}

function quickFileCount(cwd, { max = 5000 } = {}) {
  // Shallow walk: skip node_modules, .git, dist, build, .venv, __pycache__.
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.bahulam', '.terraform']);
  const byExt = {};
  let total = 0;
  const stack = [cwd];
  while (stack.length && total < max) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.bahulam') continue;
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        total++;
        const ext = path.extname(e.name).toLowerCase();
        if (ext) byExt[ext] = (byExt[ext] || 0) + 1;
        if (total >= max) break;
      }
    }
  }
  return { total, byExt };
}

// ── Renderer ────────────────────────────────────────────────────────────

function formatRow(check) {
  switch (check.status) {
    case 'ok':   return `  ${OK(paint.text.primary(check.label))}`;
    case 'warn': return `  ${WARN(paint.text.primary(check.label))}` +
                        (check.hint ? `  ${paint.text.dim('→ ' + check.hint)}` : '');
    case 'fail': return `  ${FAIL(paint.text.primary(check.label))}` +
                        (check.hint ? `  ${paint.text.dim('→ ' + check.hint)}` : '');
    default:     return `  ${paint.text.dim(check.label)}`;
  }
}

/**
 * Run the preflight diagnostic. Writes to stderr and resolves with the
 * collected check results.
 *
 * @param {object} opts
 * @param {object} opts.auth        — BahulamAuth instance
 * @param {string} opts.cwd         — working directory
 * @param {string} opts.version     — package version string
 * @param {boolean} [opts.silent]   — if true, do not write (useful for tests)
 */
export async function runPreflight({ auth, cwd, version, silent = false } = {}) {
  const t = term();
  const write = (s) => { if (!silent) process.stderr.write(s); };

  const header = `${icons.search} ${paint.bold(paint.brand.primary('Bahulam Code v' + (version || '?')))} ${paint.text.dim('· initializing orbit')}`;
  write('\n' + header + '\n\n');

  const checks = [];
  const authCheck = await checkAuthAndBackend(auth);
  checks.push(authCheck);
  // Only ask the backend for plan + credits when the auth row is OK; no point
  // hitting /balance if we are not signed in or the backend is offline.
  if (authCheck.status === 'ok') {
    const plan = await checkCreditsAndPlan(auth);
    if (plan) checks.push(plan);
  }
  checks.push(checkGit(cwd));
  checks.push(checkLinters(cwd));
  checks.push(checkProjectMap(cwd));

  for (const c of checks) write(formatRow(c) + '\n');

  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;
  const tail = fails === 0 && warns === 0
    ? paint.state.success('All systems aligned.')
    : fails > 0
        ? paint.state.danger(`${fails} blocker${fails === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'} — see hints above.`)
        : paint.state.warn(`${warns} warning${warns === 1 ? '' : 's'} — non-blocking.`);

  write('\n  ' + tail + '\n\n');
  return checks;
}
