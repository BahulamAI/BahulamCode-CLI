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
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let DatabaseSync = null;

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

if (process.env.BAHULAM_PLUGIN_STATE_BACKEND !== 'json') {
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    DatabaseSync = null;
  }
}

const DATA_ROOT = () => path.join(os.homedir(), '.bahulam', 'data');
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const DEBOUNCE_MS = 50;

// Open handles cached per plugin — SQLite in WAL mode is happy with one
// handle per process, and this is a single-process dev tool. Handles live
// for the lifetime of the CLI; explicit close() is available for tests.
const _handles = new Map(); // pluginName -> { db, dir, path }

class JsonStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = String(sql || '').trim().replace(/\s+/g, ' ').toUpperCase();
  }

  get(...args) {
    if (this.sql === 'SELECT VALUE FROM KV WHERE KEY = ?') {
      const key = String(args[0]);
      return this.db.store.kv[key] ? { value: this.db.store.kv[key].value } : undefined;
    }
    throw new Error('Raw SELECT is only available with native node:sqlite');
  }

  all(...args) {
    if (this.sql === 'SELECT KEY FROM KV ORDER BY KEY') {
      return Object.keys(this.db.store.kv).sort().map(key => ({ key }));
    }
    if (this.sql === 'SELECT ID, PAYLOAD, CREATED_AT FROM RECORDS WHERE STREAM = ? ORDER BY ID ASC LIMIT ?') {
      return this.db.records(String(args[0]), Number(args[1]), 'asc');
    }
    if (this.sql === 'SELECT ID, PAYLOAD, CREATED_AT FROM RECORDS WHERE STREAM = ? ORDER BY ID DESC LIMIT ?') {
      return this.db.records(String(args[0]), Number(args[1]), 'desc');
    }
    if (this.sql === 'SELECT COUNT(*) AS N FROM RECORDS WHERE STREAM = ?') {
      return [{ n: this.db.store.records.filter(row => row.stream === String(args[0])).length }];
    }
    throw new Error('Raw SELECT is only available with native node:sqlite');
  }

  run(...args) {
    if (this.sql.startsWith('INSERT INTO KV(')) {
      const [key, value, updated_at] = args;
      this.db.store.kv[String(key)] = { value: String(value), updated_at: String(updated_at) };
      this.db.save();
      return { changes: 1, lastInsertRowid: 0 };
    }
    if (this.sql === 'DELETE FROM KV WHERE KEY = ?') {
      const key = String(args[0]);
      const existed = Object.prototype.hasOwnProperty.call(this.db.store.kv, key);
      if (existed) {
        delete this.db.store.kv[key];
        this.db.save();
      }
      return { changes: existed ? 1 : 0, lastInsertRowid: 0 };
    }
    if (this.sql === 'INSERT INTO RECORDS(STREAM, PAYLOAD, CREATED_AT) VALUES(?, ?, ?)') {
      const row = {
        id: this.db.store.nextRecordId++,
        stream: String(args[0]),
        payload: String(args[1]),
        created_at: String(args[2]),
      };
      this.db.store.records.push(row);
      this.db.save();
      return { changes: 1, lastInsertRowid: row.id };
    }
    if (this.sql === 'DELETE FROM RECORDS WHERE STREAM = ?') {
      const stream = String(args[0]);
      const before = this.db.store.records.length;
      this.db.store.records = this.db.store.records.filter(row => row.stream !== stream);
      const changes = before - this.db.store.records.length;
      if (changes) this.db.save();
      return { changes, lastInsertRowid: 0 };
    }
    if (this.sql === 'DELETE FROM RECORDS WHERE STREAM = ? AND ID = ?') {
      const stream = String(args[0]);
      const id = Number(args[1]);
      const before = this.db.store.records.length;
      this.db.store.records = this.db.store.records.filter(row => !(row.stream === stream && row.id === id));
      const changes = before - this.db.store.records.length;
      if (changes) this.db.save();
      return { changes, lastInsertRowid: 0 };
    }
    throw new Error('Raw DML is only available with native node:sqlite');
  }
}

class JsonStateDb {
  constructor(dbPath) {
    this.path = dbPath;
    this.store = {
      kv: {},
      records: [],
      nextRecordId: 1,
    };
    try {
      if (fs.existsSync(dbPath)) {
        const parsed = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
        if (parsed && typeof parsed === 'object') {
          this.store = {
            kv: parsed.kv && typeof parsed.kv === 'object' ? parsed.kv : {},
            records: Array.isArray(parsed.records) ? parsed.records : [],
            nextRecordId: Number(parsed.nextRecordId) || 1,
          };
        }
      } else {
        this.save();
      }
    } catch {
      this.save();
    }
  }

  exec() {}

  prepare(sql) {
    return new JsonStatement(this, sql);
  }

  records(stream, limit, order) {
    const cap = Math.max(1, Math.min(10000, Math.floor(limit) || 50));
    const rows = this.store.records
      .filter(row => row.stream === stream)
      .sort((a, b) => order === 'asc' ? a.id - b.id : b.id - a.id)
      .slice(0, cap);
    return rows.map(row => ({ id: row.id, payload: row.payload, created_at: row.created_at }));
  }

  save() {
    fs.writeFileSync(this.path, JSON.stringify(this.store, null, 2));
  }

  close() {
    this.save();
  }
}

function pluginDataDir(pluginName) {
  if (!PLUGIN_NAME_RE.test(pluginName)) {
    throw new Error(`invalid plugin name for state dir: ${pluginName}`);
  }
  const dir = path.join(DATA_ROOT(), pluginName);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function openDb(pluginName, { tables = [] } = {}) {
  let handle = _handles.get(pluginName);
  if (!handle) {
    const dir = pluginDataDir(pluginName);
    const dbPath = path.join(dir, 'state.db');
    const db = DatabaseSync ? new DatabaseSync(dbPath) : new JsonStateDb(dbPath);
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

    -- Workplane document storage. Host infrastructure, not plugin-declared:
    -- every plugin with config.workplane gets these, and a plugin manifest
    -- cannot reshape them.
    --
    -- The snapshot is the current document; the event log is APPEND-ONLY and is
    -- the history. Keeping history in a bounded array inside one JSON value —
    -- which is what the browser fallback still does — discards the very thing
    -- content-addressed commits exist to make verifiable.
    CREATE TABLE IF NOT EXISTS workplane_documents (
      document_id    TEXT PRIMARY KEY,
      revision       INTEGER NOT NULL,
      head_commit_id TEXT,
      snapshot       TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workplane_events (
      commit_id    TEXT PRIMARY KEY,
      document_id  TEXT NOT NULL,
      revision     INTEGER NOT NULL,
      parent_id    TEXT,
      command_id   TEXT NOT NULL,
      actor_id     TEXT NOT NULL,
      actor_type   TEXT NOT NULL,
      actor_label  TEXT,
      operations   TEXT NOT NULL,
      committed_at TEXT NOT NULL
    );
    -- One commit per revision per document: the database refuses a second
    -- writer's revision N rather than leaving the conflict to be noticed later.
    CREATE UNIQUE INDEX IF NOT EXISTS workplane_events_revision_idx
      ON workplane_events(document_id, revision);
    -- Periodic full snapshots. Events record what changed, not what it changed
    -- FROM, so a past revision can only be rebuilt by replaying FORWARD from a
    -- known-good document. Without checkpoints, pruning old events would make
    -- every revision before the prune unreachable. PRD section 19.1.
    CREATE TABLE IF NOT EXISTS workplane_checkpoints (
      document_id TEXT NOT NULL,
      revision    INTEGER NOT NULL,
      snapshot    TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (document_id, revision)
    );
    CREATE TABLE IF NOT EXISTS workplane_receipts (
      document_id          TEXT NOT NULL,
      command_id           TEXT NOT NULL,
      payload_fingerprint  TEXT NOT NULL,
      revision             INTEGER NOT NULL,
      PRIMARY KEY (document_id, command_id)
    );
  `);
    handle = { db, dir, path: dbPath, schemaSig: null, declaredTables: new Set() };
    _handles.set(pluginName, handle);
  }
  // Declared tables are applied on every open call, not just the first —
  // a plugin installed mid-session (or a version bump that adds columns)
  // must still converge the DB. The signature check makes the repeat
  // calls free once the schema already matches.
  applyDeclaredSchema(handle, tables);
  return handle;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Render one normalized column as the DDL fragment it contributes. */
function columnToSql(col) {
  const parts = [quoteIdent(col.name), col.type];
  if (col.primary) parts.push('PRIMARY KEY');
  if (col.autoincrement) parts.push('AUTOINCREMENT');
  if (col.not_null) parts.push('NOT NULL');
  // `default` is author-supplied SQL text (e.g. "'medium'", "0"), which is
  // why normalizeState stringifies it and why it is never parameterized.
  if (col.default != null) parts.push(`DEFAULT ${col.default}`);
  if (col.references) parts.push(`REFERENCES ${col.references}`);
  return parts.join(' ');
}

/**
 * Create/evolve the tables a plugin declared in `config.state.tables`.
 *
 * Additive by contract: a table that exists is left alone apart from
 * genuinely new columns, which are appended with ALTER TABLE. Nothing is
 * ever dropped or retyped, so bumping a plugin version can't cost the
 * user their data. Re-running with an unchanged declaration is a no-op.
 *
 * Silently does nothing on the JSON fallback backend, where arbitrary SQL
 * isn't available — plugins that need declared tables need node:sqlite.
 */
function applyDeclaredSchema(handle, tables) {
  if (!DatabaseSync) return;
  if (!Array.isArray(tables) || tables.length === 0) {
    handle.declaredTables = new Set();
    handle.schemaSig = null;
    return;
  }
  const sig = JSON.stringify(tables);
  if (handle.schemaSig === sig) return;

  const { db } = handle;
  for (const table of tables) {
    let existing = new Set();
    try {
      existing = new Set(db.prepare(`PRAGMA table_info(${quoteIdent(table.name)})`).all().map(r => String(r.name)));
    } catch { /* table doesn't exist yet — created below */ }

    try {
      if (existing.size === 0) {
        const defs = table.columns.map(columnToSql).join(', ');
        db.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdent(table.name)} (${defs});`);
      } else {
        for (const col of table.columns) {
          if (existing.has(col.name)) continue;
          // SQLite refuses PRIMARY KEY / NOT NULL-without-default on ALTER
          // TABLE ADD COLUMN. Strip those rather than fail the migration.
          const addable = {
            ...col,
            primary: false,
            autoincrement: false,
            not_null: col.not_null && col.default != null,
          };
          db.exec(`ALTER TABLE ${quoteIdent(table.name)} ADD COLUMN ${columnToSql(addable)};`);
        }
      }
      for (const index of (table.indexes || [])) {
        const cols = index.columns.map(quoteIdent).join(', ');
        const idxName = `${table.name}_${index.columns.join('_')}_idx`;
        db.exec(
          `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quoteIdent(idxName)} `
          + `ON ${quoteIdent(table.name)} (${cols});`,
        );
      }
    } catch (err) {
      if (process.env.DEBUG) {
        console.error(`Failed to apply declared schema for table ${table.name}: ${err.message}`);
      }
    }
  }

  handle.declaredTables = new Set(tables.map(t => t.name));
  handle.schemaSig = sig;
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

const WORKPLANE_WIDGET_TYPES = new Set([
  'metric', 'bar_chart', 'line_chart', 'donut_chart', 'table', 'alert', 'three_scene',
]);
const WORKPLANE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;

function normalizeWorkplaneWidget(widget) {
  if (!widget || typeof widget !== 'object' || Array.isArray(widget)) throw new Error('workplane widget must be an object');
  const id = String(widget.id || '').trim();
  const type = String(widget.type || '').trim();
  if (!WORKPLANE_ID.test(id)) throw new Error(`invalid workplane widget id: ${id || '(missing)'}`);
  if (!WORKPLANE_WIDGET_TYPES.has(type)) throw new Error(`unsupported workplane widget type: ${type || '(missing)'}`);
  // Widgets are declarative data only. In particular, raw html/script is
  // intentionally absent: the runtime, not an agent, owns executable UI.
  const copy = JSON.parse(JSON.stringify(widget));
  copy.id = id;
  copy.type = type;
  delete copy.html;
  delete copy.script;
  if (type === 'three_scene') {
    const scene = copy.scene;
    if (!scene || scene.kind !== 'bar_landscape' || !Array.isArray(scene.data)) {
      throw new Error('three_scene requires a bar_landscape scene with data');
    }
    copy.scene = {
      kind: 'bar_landscape',
      data: scene.data.slice(0, 32).map(item => ({
        label: String(item?.label || '').slice(0, 80),
        value: Number.isFinite(Number(item?.value)) ? Number(item.value) : 0,
      })),
    };
  }
  return copy;
}

const CHECKPOINT_EVERY = 25;
const WORKPLANE_FALLBACK_KEY = 'workplane_document';
const WORKPLANE_FALLBACK_MAX_EVENTS = 500;

/** JSON-value fallback for runtimes without node:sqlite. Bounded history. */
function fallbackRead(io, documentId) {
  const raw = io.get(WORKPLANE_FALLBACK_KEY, null);
  return raw && raw.document?.id === String(documentId) ? raw : undefined;
}

function fallbackCommit(io, documentId, { document, event, receipt }) {
  const current = fallbackRead(io, documentId) ?? { events: [], receipts: {} };
  const events = [...(current.events ?? []), event];
  const overflow = events.length - WORKPLANE_FALLBACK_MAX_EVENTS;
  const kept = overflow > 0 ? events.slice(overflow) : events;
  io.set(WORKPLANE_FALLBACK_KEY, {
    document,
    events: kept,
    receipts: { ...(current.receipts ?? {}), [receipt.commandId]: receipt },
    ...(overflow > 0 ? { compactedBefore: kept[0].revision } : {}),
  });
}

/**
 * Synthetic key for an event written before content addressing. The table needs
 * a primary key; this is NOT a commit id and must never be presented as one.
 */
const LEGACY_COMMIT_PREFIX = 'legacy_';

function rowToEvent(row) {
  // Map a synthetic key back to "absent". Returning it as a commitId would make
  // a pre-chain event look verifiable, and the chain check would then report
  // "broken" — a false accusation — instead of "unverifiable".
  const synthetic = String(row.commit_id ?? '').startsWith(LEGACY_COMMIT_PREFIX);
  return {
    documentId: row.document_id,
    revision: row.revision,
    commandId: row.command_id,
    operations: JSON.parse(row.operations),
    actor: {
      id: row.actor_id,
      type: row.actor_type,
      ...(row.actor_label ? { label: row.actor_label } : {}),
    },
    committedAt: row.committed_at,
    ...(synthetic ? {} : { commitId: row.commit_id, parentId: row.parent_id ?? null }),
  };
}

/**
 * Build a per-plugin state proxy.
 * @param {string} pluginName  Must match /^[a-z0-9][a-z0-9._-]{0,63}$/i
 * @param {object} [opts]
 * @param {(evt: {plugin: string, op: string, kind: 'kv'|'records', target: string, at: string}) => void} [opts.emit]
 *   Called (debounced) after every write commits. The workspace server
 *   turns this into an SSE `plugin_state_changed` event for the browser.
 * @param {object[]} [opts.tables]
 *   Tables declared in the plugin manifest's `config.state.tables`. They
 *   are created (and additively migrated) when the DB opens, so a plugin
 *   can own real domain tables — questions, documents, answers — without
 *   shipping its own migration logic.
 * @returns proxy with { get, set, patch, append, list, query, delete, getConfig,
 *   upsertWorkplaneWidgets, removeWorkplaneWidgets, summary, readTable, close, db, path }
 */
export function makePluginState(pluginName, { emit = null, tables = [], configFields = [] } = {}) {
  const { db, path: dbPath, declaredTables } = openDb(pluginName, { tables });

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

  // Minimal kv accessor for the Workplane fallback path, so it does not depend
  // on the proxy object existing while the proxy is still being constructed.
  const kvIo = {
    get(key, fallback = null) {
      const row = stmts.get.get(String(key));
      if (!row) return fallback;
      try { return JSON.parse(row.value); } catch { return fallback; }
    },
    set(key, value) {
      stmts.upsert.run(String(key), JSON.stringify(value), now());
      fire('set', 'kv', String(key));
      return value;
    },
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

    /**
     * Read the slices a manifest flagged as `context_always` so the agent
     * can orient itself at session start without spending a tool call.
     *
     * Returns `{ kv: { <key>: value }, streams: { <stream>: [rows] } }`.
     * Anything the declaration doesn't name is deliberately omitted —
     * this is the "small and high-signal" tier, and its whole value is
     * that it stays cheap.
     *
     * @param {object[]} decl normalized `config.state.context_always`
     */
    summary(decl = []) {
      const out = { kv: {}, streams: {} };
      for (const item of (Array.isArray(decl) ? decl : [])) {
        if (!item || typeof item !== 'object') continue;
        try {
          if (item.kind === 'records' && item.stream) {
            out.streams[item.stream] = this.list(item.stream, {
              limit: item.limit || 5,
              order: 'desc',
            });
          } else if (item.kind === 'kv' && item.key && item.key !== '_config') {
            out.kv[item.key] = this.get(item.key, null);
          }
        } catch { /* one unreadable slice must not blank the whole summary */ }
      }
      return out;
    },

    /**
     * Read a single config field value. Falls back to the declared default
     * if a field definition exists but no stored value is found.
     * These values are for trusted in-process tool handlers, not automatic
     * model context. Handlers must not return credentials in tool results.
     */
    getConfig(key) {
      const all = this.get('_config', {});
      const val = all[key];
      if (Object.hasOwn(all, key) && val !== undefined) {
        // Tool handlers execute locally and may read declared credentials;
        // the browser-facing API has no route to this method.
        return val;
      }
      const field = configFields.find(f => f.name === key);
      return field?.default ?? null;
    },

    /**
     * Returns all declared config fields with their current values
     * (credential values are returned as-is since this is used by
     * tool handlers running in-process; the browser API layer
     * handles redaction before sending to the panel).
     */
    getAllConfig() {
      const stored = this.get('_config', {});
      const out = {};
      for (const f of configFields) {
        out[f.name] = Object.hasOwn(stored, f.name) ? stored[f.name] : (f.default ?? null);
      }
      return out;
    },

    /**
     * Atomically upsert typed, declarative widgets into the shared workplane.
     * The renderer can safely choose layout and visual treatment while tools
     * (and agents directing them) decide the current outcome to show.
     */
    upsertWorkplaneWidgets(widgets, { title = null } = {}) {
      if (!Array.isArray(widgets)) throw new Error('workplane widgets must be an array');
      const current = this.get('workplane', {});
      const byId = new Map(Array.isArray(current?.widgets) ? current.widgets.map(item => [item?.id, item]) : []);
      for (const widget of widgets) {
        const normalized = normalizeWorkplaneWidget(widget);
        byId.set(normalized.id, normalized);
      }
      const next = {
        version: 1,
        ...(typeof current?.title === 'string' ? { title: current.title } : {}),
        ...(typeof title === 'string' && title.trim() ? { title: title.trim() } : {}),
        widgets: [...byId.values()],
        updated_at: now(),
      };
      return this.set('workplane', next);
    },

    removeWorkplaneWidgets(ids) {
      const remove = new Set((Array.isArray(ids) ? ids : [ids]).map(id => String(id)));
      const current = this.get('workplane', {});
      return this.set('workplane', {
        ...(current && typeof current === 'object' ? current : {}),
        version: 1,
        widgets: (Array.isArray(current?.widgets) ? current.widgets : []).filter(widget => !remove.has(widget?.id)),
        updated_at: now(),
      });
    },

    /**
     * Workplane document storage.
     *
     * A narrow, purpose-built surface rather than a general table-write API:
     * the authority needs exactly these six operations, and exposing arbitrary
     * writes to reach them would be a far larger security surface for no gain.
     *
     * On the native backend the three writes commit in ONE SQLite transaction,
     * so a crash cannot leave an acknowledged change with no durable record.
     * Without node:sqlite (Node < 22) it falls back to a single JSON value under
     * the `kv` key, which keeps the same interface but CANNOT keep unbounded
     * history — `historyComplete()` reports which mode is in effect.
     */
    workplane: {
      native: Boolean(DatabaseSync),
      // `io` is the proxy's own kv path, used only by the non-native fallback.

      loadDocument(documentId) {
        if (!DatabaseSync) return fallbackRead(kvIo, documentId)?.document;
        const row = db.prepare('SELECT snapshot FROM workplane_documents WHERE document_id = ?').get(String(documentId));
        if (row) return JSON.parse(row.snapshot);
        // A document written before the tables existed lives in the kv blob.
        // Adopt it rather than starting empty, which would silently discard it.
        return this.adoptLegacy(documentId)?.document;
      },

      /**
       * One-time migration of a document from the old single-JSON-value layout
       * into the tables. Idempotent: it does nothing once a row exists.
       *
       * Events from before content addressing have no commitId, so they are
       * given a synthetic one derived from document and revision. They cannot
       * be verified — verifyHistory reports them as unverifiable rather than
       * broken, which is the honest answer.
       */
      adoptLegacy(documentId) {
        if (!DatabaseSync) return undefined;
        const legacy = fallbackRead(kvIo, documentId);
        if (!legacy?.document) return undefined;
        const existing = db.prepare('SELECT 1 FROM workplane_documents WHERE document_id = ?').get(String(documentId));
        if (existing) return legacy;

        const id = String(documentId);
        const now = new Date().toISOString();
        const events = Array.isArray(legacy.events) ? legacy.events : [];
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const event of events) {
            db.prepare(`INSERT OR IGNORE INTO workplane_events
                (commit_id, document_id, revision, parent_id, command_id,
                 actor_id, actor_type, actor_label, operations, committed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(
                event.commitId ?? `${LEGACY_COMMIT_PREFIX}${id}_${event.revision}`,
                id, event.revision, event.parentId ?? null, event.commandId ?? `legacy_${event.revision}`,
                event.actor?.id ?? 'unknown', event.actor?.type ?? 'system', event.actor?.label ?? null,
                JSON.stringify(event.operations ?? []), event.committedAt ?? now,
              );
          }
          for (const receipt of Object.values(legacy.receipts ?? {})) {
            db.prepare(`INSERT OR IGNORE INTO workplane_receipts
                (document_id, command_id, payload_fingerprint, revision) VALUES (?, ?, ?, ?)`)
              .run(id, receipt.commandId, receipt.payloadFingerprint, receipt.revision);
          }
          db.prepare(`INSERT INTO workplane_documents
              (document_id, revision, head_commit_id, snapshot, updated_at) VALUES (?, ?, ?, ?, ?)`)
            .run(id, legacy.document.revision, events[events.length - 1]?.commitId ?? null,
                 JSON.stringify(legacy.document), now);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        return legacy;
      },

      /** Atomic across snapshot, event, and receipt. */
      commit(documentId, { document, event, receipt }) {
        if (!DatabaseSync) return fallbackCommit(kvIo, documentId, { document, event, receipt });
        const now = new Date().toISOString();
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare(`INSERT INTO workplane_documents
              (document_id, revision, head_commit_id, snapshot, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(document_id) DO UPDATE SET
              revision = excluded.revision,
              head_commit_id = excluded.head_commit_id,
              snapshot = excluded.snapshot,
              updated_at = excluded.updated_at`)
            .run(String(documentId), document.revision, event.commitId ?? null, JSON.stringify(document), now);

          // Append-only. The unique index on (document_id, revision) makes a
          // second writer's revision N fail here rather than silently win.
          db.prepare(`INSERT INTO workplane_events
              (commit_id, document_id, revision, parent_id, command_id,
               actor_id, actor_type, actor_label, operations, committed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
              event.commitId ?? `${LEGACY_COMMIT_PREFIX}${documentId}_${event.revision}`,
              String(documentId), event.revision, event.parentId ?? null, event.commandId,
              event.actor.id, event.actor.type, event.actor.label ?? null,
              JSON.stringify(event.operations), event.committedAt,
            );

          db.prepare(`INSERT INTO workplane_receipts
              (document_id, command_id, payload_fingerprint, revision)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(document_id, command_id) DO NOTHING`)
            .run(String(documentId), receipt.commandId, receipt.payloadFingerprint, receipt.revision);

          // Checkpoint inside the same transaction, so a snapshot can never
          // record a revision the event log does not also contain.
          if (document.revision === 1 || document.revision % CHECKPOINT_EVERY === 0) {
            db.prepare(`INSERT INTO workplane_checkpoints
                (document_id, revision, snapshot, created_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(document_id, revision) DO NOTHING`)
              .run(String(documentId), document.revision, JSON.stringify(document), now);
          }

          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        fire('set', 'kv', `workplane:${documentId}`);
      },

      receipt(documentId, commandId) {
        if (!DatabaseSync) {
          return fallbackRead(kvIo, documentId)?.receipts?.[String(commandId)];
        }
        const row = db.prepare('SELECT command_id, payload_fingerprint, revision FROM workplane_receipts WHERE document_id = ? AND command_id = ?')
          .get(String(documentId), String(commandId));
        return row
          ? { commandId: row.command_id, payloadFingerprint: row.payload_fingerprint, revision: row.revision }
          : undefined;
      },

      eventsAfter(documentId, revision, limit = 500) {
        if (!DatabaseSync) {
          return (fallbackRead(kvIo, documentId)?.events ?? []).filter((e) => e.revision > revision);
        }
        return db.prepare(`SELECT * FROM workplane_events
            WHERE document_id = ? AND revision > ?
            ORDER BY revision ASC LIMIT ?`)
          .all(String(documentId), Number(revision), Math.max(1, Math.min(5000, limit)))
          .map(rowToEvent);
      },

      /**
       * Checkpoints at or before `revision`, newest first.
       * A caller rebuilds a past revision from the nearest one plus the events
       * that follow it.
       */
      checkpoints(documentId, { atOrBefore = Number.MAX_SAFE_INTEGER, limit = 4 } = {}) {
        if (!DatabaseSync) return [];
        return db.prepare(`SELECT revision, snapshot FROM workplane_checkpoints
            WHERE document_id = ? AND revision <= ?
            ORDER BY revision DESC LIMIT ?`)
          .all(String(documentId), Number(atOrBefore), Math.max(1, Math.min(50, limit)))
          .map((row) => ({ revision: row.revision, document: JSON.parse(row.snapshot) }));
      },

      /**
       * Write a checkpoint for the CURRENT document on demand — used before
       * pruning history, so revisions that survive stay reachable.
       */
      writeCheckpoint(documentId) {
        if (!DatabaseSync) return false;
        const document = this.loadDocument(documentId);
        if (!document) return false;
        db.prepare(`INSERT INTO workplane_checkpoints
            (document_id, revision, snapshot, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(document_id, revision) DO NOTHING`)
          .run(String(documentId), document.revision, JSON.stringify(document), new Date().toISOString());
        return true;
      },

      /** Full history, oldest first. Append-only, so nothing is ever dropped. */
      history(documentId, { from = 0, limit = 500 } = {}) {
        return this.eventsAfter(documentId, from - 1, limit);
      },

      /**
       * Whether history is genuinely complete. False on the JSON fallback,
       * where old events are discarded — a caller verifying a commit chain has
       * to know the difference between "broken" and "not all here".
       */
      historyComplete() {
        return Boolean(DatabaseSync);
      },
    },

    /**
     * Read rows from a table the plugin declared in `config.state.tables`.
     * Backs the auto-generated `context_tools`.
     *
     * Only declared tables are reachable, so a manifest typo can't turn a
     * generated tool into arbitrary table access. `where` is plugin-authored
     * SQL (same trust model as `query()`); values are always bound.
     *
     * @param {string} table
     * @param {object} [opts]
     * @param {string} [opts.where]   e.g. "topic = ?"
     * @param {any[]}  [opts.params]  bound positionally against `where`
     * @param {number} [opts.limit]
     * @returns {object[]}
     */
    readTable(table, { where = '', params = [], limit = 50 } = {}) {
      if (!DatabaseSync) {
        throw new Error('Declared state tables require the native node:sqlite backend');
      }
      const name = String(table || '');
      if (!declaredTables.has(name)) {
        throw new Error(`unknown declared state table: ${name || '(none)'}`);
      }
      const args = Array.isArray(params) ? params : [params];
      const cap = Math.max(1, Math.min(1000, Math.floor(limit) || 50));
      const clause = where ? ` WHERE ${where}` : '';
      return db.prepare(`SELECT * FROM ${quoteIdent(name)}${clause} LIMIT ?`).all(...args, cap);
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
