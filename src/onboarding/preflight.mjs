/**
 * Preflight diagnostic — Mission Control (PRD-055 §9).
 *
 * Prints a non-blocking summary of the runtime environment before the REPL
 * starts so the user can see what is and is not aligned:
 *
 *   🔭 Kepler v1.0.4 · initializing orbit
 *
 *     [✓] Auth token
 *     [✓] OpenRouter key
 *     [✓] Backend  http://127.0.0.1:8000
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

const OK   = (s) => `${paint.state.success('[✓]')} ${s}`;
const WARN = (s) => `${paint.state.warn('[⚠]')} ${s}`;
const FAIL = (s) => `${paint.state.danger('[✗]')} ${s}`;

// ── Individual checks (each returns { status, label, hint? }) ──────────

function checkAuthToken(auth) {
  const creds = auth.loadCredentials();
  if (creds.token) return { status: 'ok', label: `Auth token` };
  return { status: 'warn', label: 'Auth token missing', hint: '/login to sign in' };
}

function checkProviderKey(auth) {
  const creds = auth.loadCredentials();
  if (creds.openRouterKey) return { status: 'ok', label: 'OpenRouter key' };
  if (creds.anthropicKey)  return { status: 'ok', label: 'Anthropic key' };
  if (creds.openaiKey)     return { status: 'ok', label: 'OpenAI key' };
  if (creds.googleKey)     return { status: 'ok', label: 'Google key' };
  return { status: 'warn', label: 'No model provider key configured', hint: 'set OPENROUTER_API_KEY or run /config' };
}

async function checkBackend(auth, { timeoutMs = 1500 } = {}) {
  const creds = auth.loadCredentials();
  const url = creds.backendUrl;
  if (!url) return { status: 'warn', label: 'Backend not configured' };
  try {
    const reachable = await ping(url, timeoutMs);
    if (reachable) return { status: 'ok', label: `Backend  ${shorten(url, 48)}` };
    return { status: 'warn', label: `Backend  ${shorten(url, 48)}`, hint: 'unreachable — check network or start backend' };
  } catch {
    return { status: 'warn', label: `Backend  ${shorten(url, 48)}`, hint: 'unreachable' };
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
  for (const [name, kind] of LINTERS) {
    if (which(name)) present.push({ name, kind });
    else if (projectUses(cwd, kind)) missing.push({ name, kind });
  }
  if (present.length === 0 && missing.length === 0) {
    return { status: 'ok', label: 'Linters  none required' };
  }
  if (missing.length === 0) {
    return { status: 'ok', label: `Linters  ${present.map(p => p.name).join(', ')}` };
  }
  const hint = missing.map(m => `/install ${m.name} to enable lint_check for ${m.kind}`).join(' · ');
  return { status: 'warn', label: `Linter (${missing.map(m => m.name).join(', ')}) not found`, hint };
}

const LINTERS = [
  ['ruff',    'python'],
  ['eslint',  'javascript'],
  ['tsc',     'typescript'],
  ['cargo',   'rust'],
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
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.kepler', '.terraform']);
  const byExt = {};
  let total = 0;
  const stack = [cwd];
  while (stack.length && total < max) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.kepler') continue;
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
 * @param {object} opts.auth        — TarangAuth instance
 * @param {string} opts.cwd         — working directory
 * @param {string} opts.version     — package version string
 * @param {boolean} [opts.silent]   — if true, do not write (useful for tests)
 */
export async function runPreflight({ auth, cwd, version, silent = false } = {}) {
  const t = term();
  const write = (s) => { if (!silent) process.stderr.write(s); };

  const header = `${icons.search} ${paint.bold(paint.brand.primary('Kepler v' + (version || '?')))} ${paint.text.dim('· initializing orbit')}`;
  write('\n' + header + '\n\n');

  const checks = [];
  checks.push(checkAuthToken(auth));
  checks.push(checkProviderKey(auth));
  checks.push(await checkBackend(auth));
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
