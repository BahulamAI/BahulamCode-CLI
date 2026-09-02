/**
 * Plugin state — the Shared Blackboard.
 *
 * Every plugin gets its own SQLite sidecar at ~/.bahulam/data/<name>/state.db.
 * Two built-in tables ship with every DB; plugins are free to `CREATE TABLE`
 * additional ones via `state.query(sql)`:
 *
 *   kv        — small structured values (watchlists, prefs, cursors, form
 *               state). One row per key, JSON-encoded value, last-write-wins
 *               with an updated_at timestamp.
 *
 *   records   — append-only event log (backtest runs, decisions, alerts,
 *               anything you want a history of). Named streams via the
 *               `stream` column; plugin owns the stream namespace.
 *
 * The exported `makePluginState(pluginName, {emit})` returns a proxy with
 * the methods handlers and view routes call. Every write fires `emit(evt)`
 * synchronously AFTER commit — the SSE bus turns that into a
 * `plugin_state_changed` event so views can re-render live. When the same
 * key/stream is written many times in quick succession the emit hook
 * debounces to at most one event per 50ms per (plugin, kind, target).
 *
 * We use Node's built-in `node:sqlite` (v22+, experimental) so plugin
 * authors get relational storage with zero install steps. The
 * ExperimentalWarning is silenced once at module load.
 *
 * A NOTE ON SAFETY: `state.query(sql, params)` is a raw SQL escape hatch
 * intended for the plugin's OWN tools and views — never expose it to
 * untrusted input (the plugin author owns the SQL). The higher-level
 * get/set/patch/append/list methods parameterize everything.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Silence the single "SQLite is an experimental feature" warning that
// node:sqlite emits at first import. Users would see it on every plugin
// launch otherwise, which is noise, not signal.
{
  const orig = process.emit;
  process.emit = function (name, warning, ...rest) {
    if (name === 'warning' && warning?.name === 'ExperimentalWarning'
        && /SQLite/i.test(String(warning.message || ''))) {
      return false;
    }
    return orig.call(this, name, warning, ...rest);
  };
}

const DATA_ROOT = () => path.join(os.homedir(), '.bahulam', 'data');
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const DEBOUNCE_MS = 50;

// Open handles cached per plugin — SQLite in WAL mode is happy with one
// handle per process, and this is a single-process dev tool. Handles live
// for the lifetime of the CLI; explicit close() is available for tests.
const _handles = new Map(); // pluginName -> { db, dir, path }

function pluginDataDir(pluginName) {
  if (!PLUGIN_NAME_RE.test(pluginName)) {
    throw new Error(`invalid plugin name for state dir: ${pluginName}`);
  }
  const dir = path.join(DATA_ROOT(), pluginName);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function openDb(pluginName) {
  if (_handles.has(pluginName)) return _handles.get(pluginName);
  const dir = pluginDataDir(pluginName);
  const dbPath = path.join(dir, 'state.db');
  const db = new DatabaseSync(dbPath);
  // WAL: multiple readers, one writer; robust against concurrent view+agent.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Bootstrap schema — idempotent so evolving plugins never crash on start.
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      stream     TEXT NOT NULL,
      payload    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_stream_idx
      ON records(stream, id DESC);
  `);
  const handle = { db, dir, path: dbPath };
  _handles.set(pluginName, handle);
  return handle;
}

function now() { return new Date().toISOString(); }

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (base == null || typeof base !== 'object') return patch;
  if (patch == null || typeof patch !== 'object') return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v)
        && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Build a per-plugin state proxy.
 * @param {string} pluginName  Must match /^[a-z0-9][a-z0-9._-]{0,63}$/i
 * @param {object} [opts]
 * @param {(evt: {plugin: string, op: string, kind: 'kv'|'records', target: string, at: string}) => void} [opts.emit]
 *   Called (debounced) after every write commits. The workspace server
 *   turns this into an SSE `plugin_state_changed` event for the browser.
 * @returns proxy with { get, set, patch, append, list, query, delete, close, db, path }
 */
export function makePluginState(pluginName, { emit = null } = {}) {
  const { db, path: dbPath } = openDb(pluginName);

  // One debounce timer per (kind, target). Fast writes coalesce into
  // exactly one plugin_state_changed event. Pending entry is stored so
  // close() can flush synchronously for tests and controlled shutdown.
  const timers = new Map();  // key -> timeout handle
  const pending = new Map(); // key -> event payload to fire on flush
  function fire(op, kind, target) {
    if (typeof emit !== 'function') return;
    const key = `${kind}:${target}`;
    if (timers.has(key)) clearTimeout(timers.get(key));
    pending.set(key, { plugin: pluginName, op, kind, target, at: now() });
    timers.set(key, setTimeout(() => {
      const evt = pending.get(key);
      timers.delete(key);
      pending.delete(key);
      if (evt) {
        try { emit(evt); }
        catch { /* emit failure must never surface into the tool call */ }
      }
    }, DEBOUNCE_MS));
  }
  function flushPending() {
    for (const [key, evt] of pending) {
      clearTimeout(timers.get(key));
      try { emit(evt); } catch { /* swallow */ }
    }
    timers.clear();
    pending.clear();
  }

  // Prepared statements are cached on first use (better-sqlite3-style perf,
  // node:sqlite exposes prepare() too).
  const stmts = {
    get:    db.prepare('SELECT value FROM kv WHERE key = ?'),
    upsert: db.prepare('INSERT INTO kv(key, value, updated_at) VALUES(?, ?, ?) '
                     + 'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'),
    del:    db.prepare('DELETE FROM kv WHERE key = ?'),
    keys:   db.prepare('SELECT key FROM kv ORDER BY key'),
    append: db.prepare('INSERT INTO records(stream, payload, created_at) VALUES(?, ?, ?)'),
    listAsc:  db.prepare('SELECT id, payload, created_at FROM records WHERE stream = ? ORDER BY id ASC  LIMIT ?'),
    listDesc: db.prepare('SELECT id, payload, created_at FROM records WHERE stream = ? ORDER BY id DESC LIMIT ?'),
  };

  return {
    /** Read one key. Returns `fallback` (default null) when the key is absent. */
    get(key, fallback = null) {
      const row = stmts.get.get(String(key));
      if (!row) return fallback;
      try { return JSON.parse(row.value); }
      catch { return fallback; }
    },

    /** Write one key with a whole value. Fires plugin_state_changed. */
    set(key, value) {
      const k = String(key);
      stmts.upsert.run(k, JSON.stringify(value), now());
      fire('set', 'kv', k);
      return value;
    },

    /**
     * Deep-merge a partial into an existing object under `key`. Arrays
     * replace; nested objects merge recursively. When the key is absent,
     * `patch` is stored as-is. Matches the "PATCH endpoint for surgeon
     * precision" contract.
     */
    patch(key, partial) {
      const k = String(key);
      const cur = this.get(k, null);
      const next = deepMerge(cur, partial);
      stmts.upsert.run(k, JSON.stringify(next), now());
      fire('patch', 'kv', k);
      return next;
    },

    /** Remove one key. */
    delete(key) {
      const k = String(key);
      const info = stmts.del.run(k);
      if (info.changes > 0) fire('delete', 'kv', k);
      return info.changes > 0;
    },

    /** List every kv key currently present. */
    keys() { return stmts.keys.all().map(r => r.key); },

    /** Append one row to a named stream. Returns the new row's id. */
    append(stream, payload) {
      const s = String(stream);
      const info = stmts.append.run(s, JSON.stringify(payload), now());
      fire('append', 'records', s);
      return Number(info.lastInsertRowid);
    },

    /**
     * Read from a stream.
     * @param {string} stream
     * @param {object} [opts]  { limit?: number = 50, order?: 'asc'|'desc' = 'desc' }
     * @returns [{ id, payload, created_at }]
     */
    list(stream, { limit = 50, order = 'desc' } = {}) {
      const s = String(stream);
      const cap = Math.max(1, Math.min(10000, Math.floor(limit)));
      const stmt = order === 'asc' ? stmts.listAsc : stmts.listDesc;
      return stmt.all(s, cap).map(r => ({
        id: r.id,
        payload: safeParse(r.payload),
        created_at: r.created_at,
      }));
    },

    /**
     * Raw SQL escape hatch — for the plugin's own advanced use. Always
     * use parameters, never string-concat user input into SQL. Returns
     * whatever the underlying prepared statement returns; SELECTs come
     * back as an array of rows.
     */
    query(sql, params = []) {
      const stmt = db.prepare(String(sql));
      const args = Array.isArray(params) ? params : [params];
      // node:sqlite prepared statements expose all() for SELECT-like
      // queries and run() for DML; iterate() is available too.
      const first = String(sql).trim().slice(0, 6).toUpperCase();
      if (first.startsWith('SELECT') || first.startsWith('PRAGMA')) {
        return stmt.all(...args);
      }
      const info = stmt.run(...args);
      // Any DML on kv/records is announced generically so views can
      // refresh; more specific writes go through set/patch/append.
      fire('query', 'kv', '*');
      return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
    },

    /** Direct DatabaseSync handle for callers that know what they need. */
    get db() { return db; },
    /** Absolute path to the DB file on disk. */
    get path() { return dbPath; },

    /** Test hook — closes the underlying handle. Flushes any pending
     * emit events synchronously so tests can observe them without a wait. */
    close() {
      flushPending();
      db.close();
      _handles.delete(pluginName);
    },
  };
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Test helper — reset all cached handles. Called by tests between cases so
 * a temp $HOME override actually takes effect.
 */
export function _resetForTests() {
  for (const h of _handles.values()) {
    try { h.db.close(); } catch { /* ignore */ }
  }
  _handles.clear();
}
