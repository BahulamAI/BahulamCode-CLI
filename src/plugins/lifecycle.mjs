/**
 * Plugin lifecycle — install / seed / upgrade / uninstall / migrations.
 *
 * The manifest declares four optional hook files under `config.lifecycle`:
 *
 *   config:
 *     lifecycle:
 *       seed:          ./hooks/seed.mjs
 *       post_install:  ./hooks/post-install.mjs
 *       pre_uninstall: ./hooks/pre-uninstall.mjs
 *       migrations:
 *         - { version: "0.3.0", sql: ./migrations/0.3.0.sql }
 *         - { version: "0.4.0", run: ./migrations/0.4.0.mjs }
 *
 * All hooks receive one argument, a context object:
 *
 *   ctx = {
 *     pluginDir,    // absolute path to the installed plugin folder
 *     dataDir,      // ~/.bahulam/data/<name>
 *     state,        // per-plugin state handle (lazy getter — same shape as tool handlers see)
 *     args,         // CLI/programmatic invocation args (installer passes flags etc.)
 *     log(level, msg, meta?),  // structured log — routed to stdout + a per-plugin lifecycle log
 *     ranBefore(key),          // hook idempotency helper — returns true if the given key was recorded
 *     recordRun(key, extra?),  // mark a hook / migration as run
 *   }
 *
 * Hook contract:
 *   export async function run(ctx) { ... }
 *
 *   May return { keepData?: bool, warnings?: string[] } — pre_uninstall
 *   uses this to influence the caller's data-cleanup default.
 *
 * Migration entry:
 *   { version: "0.3.0", sql?: "./migrations/0.3.0.sql", run?: "./migrations/0.3.0.mjs" }
 *
 *   Exactly one of `sql` or `run` must be present. SQL files execute via
 *   the plugin state DB's `exec`. JS modules export `run(ctx)`; the ctx
 *   is the same shape as hook ctx (but `args` is null).
 *
 * State bookkeeping is stored in a JSON file at
 * `<dataDir>/_bahulam_lifecycle.json`:
 *
 *   {
 *     installed_at: "2026-09-17T...",
 *     installed_version: "0.3.0",
 *     last_upgrade_at: null,
 *     applied_migrations: ["0.3.0"],
 *     runs: { seed: {at: "...", version: "0.3.0"}, post_install: {...} }
 *   }
 *
 * The migration path is snapshot-then-roll-forward: before a batch of
 * migrations runs, the SQLite file is copied to
 * `<dataDir>/state.db.pre-<from>-to-<to>` and restored on failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const DATA_ROOT = () => path.join(os.homedir(), '.bahulam', 'data');
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function pluginDataDir(pluginName) {
  if (!PLUGIN_NAME_RE.test(pluginName)) throw new Error(`invalid plugin name for lifecycle: ${pluginName}`);
  const dir = path.join(DATA_ROOT(), pluginName);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function lifecyclePath(dataDir) {
  return path.join(dataDir, '_bahulam_lifecycle.json');
}

function readLifecycle(dataDir) {
  const p = lifecyclePath(dataDir);
  if (!fs.existsSync(p)) return { runs: {}, applied_migrations: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return { runs: {}, applied_migrations: [], ...parsed };
  } catch { return { runs: {}, applied_migrations: [] }; }
}

function writeLifecycle(dataDir, record) {
  fs.writeFileSync(lifecyclePath(dataDir), JSON.stringify(record, null, 2), 'utf-8');
}

function nowIso() { return new Date().toISOString(); }

function resolveHookPath(pluginDir, ref) {
  if (!ref) return null;
  // Ref is a POSIX relative path from the manifest — `./hooks/seed.mjs`
  const abs = path.resolve(pluginDir, ref);
  if (!fs.existsSync(abs)) throw new Error(`lifecycle hook not found: ${ref} (looked at ${abs})`);
  return abs;
}

/**
 * Load a hook module and return its `run` function. Cache-busted per
 * call so an operator can edit a hook and re-run install/upgrade
 * without a fresh Node process.
 */
async function loadHookRun(pluginDir, ref, label) {
  const abs = resolveHookPath(pluginDir, ref);
  if (!abs) return null;
  const url = `${pathToFileURL(abs).href}?t=${Date.now()}`;
  const mod = await import(url);
  if (typeof mod.run !== 'function') {
    throw new Error(`lifecycle ${label} hook ${ref} must export a run(ctx) function`);
  }
  return mod.run;
}

/**
 * Build a hook context. `stateFactory` is a thunk so hooks that never
 * touch state don't open the SQLite handle.
 */
function makeCtx({ pluginDir, dataDir, args, record, logger, stateFactory }) {
  const runs = record.runs || {};
  const applied = new Set(record.applied_migrations || []);
  return {
    pluginDir,
    dataDir,
    args: args || null,
    get state() { return stateFactory ? stateFactory() : null; },
    log: (level, msg, meta) => logger(level, msg, meta),
    ranBefore(key) {
      if (String(key).startsWith('migration:')) return applied.has(String(key).slice('migration:'.length));
      return Boolean(runs[key]);
    },
    recordRun(key, extra) {
      if (String(key).startsWith('migration:')) {
        applied.add(String(key).slice('migration:'.length));
        record.applied_migrations = [...applied];
      } else {
        record.runs = record.runs || {};
        record.runs[key] = { at: nowIso(), ...(extra || {}) };
      }
      writeLifecycle(dataDir, record);
    },
  };
}

function makeLogger(pluginName, dataDir) {
  const logPath = path.join(dataDir, '_bahulam_lifecycle.log');
  const quiet = process.env.BAHULAM_LIFECYCLE_QUIET === '1';
  return (level, msg, meta) => {
    const line = `${nowIso()} [${level}] ${pluginName}: ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`;
    try { fs.appendFileSync(logPath, line); } catch { /* best-effort */ }
    if (quiet) return;
    const target = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    try { target.write(line); } catch { /* best-effort */ }
  };
}

/**
 * Public API — runSeed / runPostInstall / runPreUninstall / runMigrations.
 *
 * All calls are idempotent: calling runSeed twice will not re-run the
 * seed unless the caller passes { force: true }. Post-install always
 * runs on install (both fresh + --force) and on update.
 */

export async function runSeed({ pluginName, pluginDir, manifest, args = {}, stateFactory = null } = {}) {
  const ref = manifest?.config?.lifecycle?.seed;
  if (!ref) return { ran: false, reason: 'no seed hook declared' };
  const dataDir = pluginDataDir(pluginName);
  const record = readLifecycle(dataDir);
  const logger = makeLogger(pluginName, dataDir);
  const version = manifest?.metadata?.version || 'unversioned';
  if (record.runs?.seed && !args.force) {
    logger('info', 'seed already ran; skipping (pass --force or --reseed to re-run)');
    return { ran: false, reason: 'already ran', prior: record.runs.seed };
  }
  const runFn = await loadHookRun(pluginDir, ref, 'seed');
  const ctx = makeCtx({ pluginDir, dataDir, args, record, logger, stateFactory });
  const started = Date.now();
  try {
    const result = await runFn(ctx);
    ctx.recordRun('seed', { version, duration_ms: Date.now() - started });
    logger('info', 'seed completed', { duration_ms: Date.now() - started });
    return { ran: true, duration_ms: Date.now() - started, result };
  } catch (err) {
    logger('error', 'seed failed', { message: err.message });
    throw err;
  }
}

export async function runPostInstall({ pluginName, pluginDir, manifest, args = {}, stateFactory = null } = {}) {
  const ref = manifest?.config?.lifecycle?.post_install;
  if (!ref) return { ran: false, reason: 'no post_install hook declared' };
  const dataDir = pluginDataDir(pluginName);
  const record = readLifecycle(dataDir);
  const logger = makeLogger(pluginName, dataDir);
  const runFn = await loadHookRun(pluginDir, ref, 'post_install');
  const ctx = makeCtx({ pluginDir, dataDir, args, record, logger, stateFactory });
  const started = Date.now();
  try {
    const result = await runFn(ctx);
    ctx.recordRun('post_install', { version: manifest?.metadata?.version, duration_ms: Date.now() - started });
    // Also stamp installed_at / installed_version on first install
    if (!record.installed_at) {
      record.installed_at = nowIso();
      record.installed_version = manifest?.metadata?.version || null;
      writeLifecycle(dataDir, record);
    }
    logger('info', 'post_install completed', { duration_ms: Date.now() - started });
    return { ran: true, duration_ms: Date.now() - started, result };
  } catch (err) {
    logger('error', 'post_install failed', { message: err.message });
    throw err;
  }
}

/**
 * pre_uninstall may return { keepData?: bool, warnings?: [] } which
 * uninstall commands use as the default for the data-cleanup decision.
 */
export async function runPreUninstall({ pluginName, pluginDir, manifest, args = {}, stateFactory = null } = {}) {
  const ref = manifest?.config?.lifecycle?.pre_uninstall;
  if (!ref) return { ran: false, reason: 'no pre_uninstall hook declared', result: {} };
  const dataDir = pluginDataDir(pluginName);
  const record = readLifecycle(dataDir);
  const logger = makeLogger(pluginName, dataDir);
  const runFn = await loadHookRun(pluginDir, ref, 'pre_uninstall');
  const ctx = makeCtx({ pluginDir, dataDir, args, record, logger, stateFactory });
  try {
    const result = await runFn(ctx);
    logger('info', 'pre_uninstall completed');
    return { ran: true, result: result || {} };
  } catch (err) {
    logger('error', 'pre_uninstall failed', { message: err.message });
    throw err;
  }
}

/**
 * Purge the data dir. Called by uninstall when --purge or interactive
 * y-answer wins.
 */
export function purgeData(pluginName) {
  const dir = path.join(DATA_ROOT(), pluginName);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { purged: true, dir };
  }
  return { purged: false, dir };
}

/**
 * Apply pending migrations sequentially, snapshotting the state DB
 * beforehand and restoring on failure.
 */
export async function runMigrations({ pluginName, pluginDir, manifest, stateFactory = null } = {}) {
  const list = Array.isArray(manifest?.config?.lifecycle?.migrations) ? manifest.config.lifecycle.migrations : [];
  if (!list.length) return { ran: 0, skipped: 0, applied: [] };

  const dataDir = pluginDataDir(pluginName);
  const record = readLifecycle(dataDir);
  const logger = makeLogger(pluginName, dataDir);
  const applied = new Set(record.applied_migrations || []);

  const pending = list.filter(m => !applied.has(m.version));
  if (!pending.length) {
    logger('info', `migrations up-to-date (${applied.size} applied)`);
    return { ran: 0, skipped: list.length, applied: [] };
  }

  // Snapshot the DB file first — restore on any failure.
  const dbPath = path.join(dataDir, 'state.db');
  const snapPath = fs.existsSync(dbPath)
    ? path.join(dataDir, `state.db.pre-${pending[0].version}-${nowIso().replace(/[:.]/g, '-')}`)
    : null;
  if (snapPath) {
    fs.copyFileSync(dbPath, snapPath);
    logger('info', `migration snapshot: ${path.basename(snapPath)}`);
  }

  const ranNow = [];
  try {
    for (const m of pending) {
      if (!m.version) throw new Error('migration entry missing version');
      if (!m.sql && !m.run) throw new Error(`migration ${m.version} needs one of sql/run`);
      if (m.sql && m.run) throw new Error(`migration ${m.version}: only one of sql/run allowed`);
      logger('info', `applying migration ${m.version}`);
      const started = Date.now();
      if (m.sql) {
        const abs = resolveHookPath(pluginDir, m.sql);
        const sqlText = fs.readFileSync(abs, 'utf-8');
        const state = stateFactory ? stateFactory() : null;
        if (!state) throw new Error(`migration ${m.version}: SQL migration requires a state handle`);
        state.exec ? state.exec(sqlText) : execViaQuery(state, sqlText);
      } else {
        const runFn = await loadHookRun(pluginDir, m.run, `migration:${m.version}`);
        const ctx = makeCtx({ pluginDir, dataDir, args: null, record, logger, stateFactory });
        await runFn(ctx);
      }
      applied.add(m.version);
      record.applied_migrations = [...applied];
      writeLifecycle(dataDir, record);
      ranNow.push({ version: m.version, duration_ms: Date.now() - started });
      logger('info', `migration ${m.version} applied`, { duration_ms: Date.now() - started });
    }
    return { ran: ranNow.length, skipped: list.length - pending.length, applied: ranNow };
  } catch (err) {
    logger('error', `migration failed — restoring snapshot`, { message: err.message });
    if (snapPath && fs.existsSync(snapPath)) {
      // Best-effort restore. If the failure was mid-write, the WAL may
      // linger; wiping it is safer than leaving inconsistent frames.
      try { fs.copyFileSync(snapPath, dbPath); } catch { /* fall through */ }
      for (const ext of ['-wal', '-shm']) {
        const aux = dbPath + ext;
        if (fs.existsSync(aux)) { try { fs.rmSync(aux); } catch { /* ok */ } }
      }
      // Restore lifecycle record to pre-migration state
      const preRecord = readLifecycle(dataDir);
      preRecord.applied_migrations = [...(preRecord.applied_migrations || [])].filter(v => !ranNow.some(r => r.version === v));
      writeLifecycle(dataDir, preRecord);
      logger('warn', 'snapshot restored — plugin is at the pre-migration schema. Fix and re-run install/update.');
    }
    err.migration_context = { attempted: ranNow.map(r => r.version), failed_on: pending[ranNow.length]?.version };
    throw err;
  }
}

// Fallback exec for JSON-backed state (no exec method, only query).
function execViaQuery(state, sqlText) {
  const stmts = sqlText.split(/;\s*$/m).map(s => s.trim()).filter(Boolean);
  for (const s of stmts) {
    if (typeof state.query === 'function') state.query(s);
    else throw new Error('cannot execute raw SQL against the JSON-backed state fallback');
  }
}

export function readLifecycleRecord(pluginName) {
  return readLifecycle(pluginDataDir(pluginName));
}
