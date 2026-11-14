/**
 * Append-only event log for daemon-owned sessions.
 *
 * This module is the DURABLE side of the daemon. Every event the agent loop
 * emits (tool calls, approvals, diffs, usage updates, …) is written here so
 * that a detached-then-reattached client can reconstruct exactly what
 * happened while nobody was watching.
 *
 *   • Append-only, monotonic seq per session — never rewrite an earlier line.
 *   • Line-delimited JSON — one event per line, `JSON.parse` per line.
 *   • Rotate at ~100MB → events-1.jsonl, events-2.jsonl, … `events.jsonl`
 *     is always the live tail. Readers concatenate rolled files in order
 *     when resolving `sinceSeq` older than the current tail's first seq.
 *   • Snapshot every N events → `snapshot-<seq>.json` — a compacted view
 *     of session state so an attach client can seed from the snapshot and
 *     only stream events with seq > snapshot.seq.
 *   • Buffered writes (batch every FLUSH_INTERVAL_MS or on close) — writes
 *     are best-effort in Phase 1; loss of the last few events on an OS
 *     crash is acceptable, but ORDERING never breaks (append + monotonic
 *     counter guarantees it).
 *   • Perm 0600 on files, 0700 on the session directory — this is user
 *     data and may include tool arguments, code diffs, etc.
 *
 * NOT in scope for Slice A:
 *   • Wiring into the REPL / stream-client — Slice A is the writer +
 *     reader + snapshot API only. Slice B adds the daemon that calls it.
 *   • Encryption at rest — the local file is `0600` in the user's home;
 *     the wire-encrypted variant lands with the Phase 2 relay.
 *   • Session id minting — `mintSessionId()` here is the ONE approved
 *     source, so the daemon and the CLI agree on format, but ids are
 *     assigned wherever a session is created (Slice B).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import { daemonSessionDir, daemonSessionsRoot } from './paths.mjs';

// ── constants ────────────────────────────────────────────────────────

const EVENTS_FILE = 'events.jsonl';                // live tail
const EVENTS_ROLLED_PREFIX = 'events-';            // events-1.jsonl, events-2.jsonl, ...
const SNAPSHOT_PREFIX = 'snapshot-';               // snapshot-<seq>.json
const META_FILE = 'meta.json';
const SEQ_FILE = '.seq';                           // last seq written (source of truth on restart)

/** Rotate the live tail when it grows past this many bytes. */
const DEFAULT_ROTATE_AT_BYTES = 100 * 1024 * 1024;

/** Flush the write buffer at most this often. */
const FLUSH_INTERVAL_MS = 250;

/** Schema version stamped on every event; readers skip unknown majors. */
export const EVENT_SCHEMA_V = 2;
export const SUPPORTED_EVENT_SCHEMA_VERSIONS = [1, 2];

// ── session id ───────────────────────────────────────────────────────

/**
 * Mint a new session id in the `sess_<time36>_<rand>` format.
 * Lexicographically sortable by wall time (good enough for filesystem
 * listings and grouping), collision-safe with 48 bits of randomness.
 * No external ULID dependency — Node's crypto is enough.
 */
export function mintSessionId() {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = randomBytes(6).toString('hex');
  return `sess_${t}_${r}`;
}

// ── writer ────────────────────────────────────────────────────────────

/**
 * Create an EventLog bound to one session directory. Multiple daemons
 * MUST NOT open the same session — locking is enforced at the daemon
 * level (via daemon.pid), not here.
 *
 * @param {object} opts
 * @param {string} opts.sessionId          e.g. "sess_..."
 * @param {string} [opts.sessionDir]       override the default path
 *                                          (~/.bahulam/sessions/<id>/)
 * @param {number} [opts.rotateAtBytes]    default 100MB
 * @param {number} [opts.flushIntervalMs]  default 250ms
 * @returns {{
 *   sessionId: string,
 *   dir: string,
 *   writeEvent(type: string, data: object, opts?: {turnId?: string, ts?: string}): number,
 *   flush(): Promise<void>,
 *   close(): Promise<void>,
 *   currentSeq(): number,
 *   liveTailPath(): string,
 * }}
 */
export function createEventLog({
  sessionId,
  sessionDir,
  rotateAtBytes = DEFAULT_ROTATE_AT_BYTES,
  flushIntervalMs = FLUSH_INTERVAL_MS,
} = {}) {
  if (!sessionId) throw new Error('createEventLog: sessionId is required');
  const dir = sessionDir || daemonSessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  _repairTail(path.join(dir, EVENTS_FILE));

  // Recover the last seq from disk. If .seq is missing (fresh session or
  // interrupted crash before any write), scan the live tail to find it.
  let seq = _recoverSeq(dir);
  let livePath = path.join(dir, EVENTS_FILE);
  let liveBytes = _fileSize(livePath);

  const buffer = [];
  let flushTimer = null;
  let flushChain = Promise.resolve();
  let closed = false;

  function appendEvent(type, data, extra = {}) {
    if (closed) throw new Error('event log is closed');
    if (typeof type !== 'string' || !type) {
      throw new Error('writeEvent: type must be a non-empty string');
    }
    const nextSeq = seq + 1;
    const id = `${sessionId}:${nextSeq}`;
    let payload = data == null ? {} : data;
    if (typeof payload !== 'object' || Array.isArray(payload)) throw new Error('event data must be an object');
    const serialized = JSON.stringify(payload);
    let payloadRef;
    if (Buffer.byteLength(serialized) > 4096) {
      payloadRef = `payloads/event-${nextSeq}.json`;
      fs.mkdirSync(path.join(dir, 'payloads'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, payloadRef), serialized, { mode: 0o600 });
      // Keep bounded scalar metadata for cards; the complete payload is available on expand.
      payload = Object.fromEntries(Object.entries(payload).filter(([key, value]) =>
        key !== 'args' && (typeof value === 'boolean' || typeof value === 'number' ||
          (typeof value === 'string' && Buffer.byteLength(value) <= (key === 'preview' ? 2400 : 256)))));
      if (Buffer.byteLength(JSON.stringify(payload)) > 3072) payload = {};
    }
    const evt = {
      seq: nextSeq,
      ts: extra.ts || new Date().toISOString(),
      type,
      session_id: sessionId,
      v: EVENT_SCHEMA_V,
      turn_id: extra.turnId || null,
      agent_id: extra.agentId || 'main',
      ...(extra.parentAgentId ? { parent_agent_id: extra.parentAgentId } : {}),
      id,
      ...(payloadRef ? { payload_ref: payloadRef } : {}),
      data: payload,
    };
    const line = JSON.stringify(evt) + '\n';
    seq = nextSeq;
    buffer.push(line);
    _scheduleFlush();
    // Broadcast exactly what was serialized (no undefined fields or shared SSE objects).
    return JSON.parse(line);
  }

  function writeEvent(type, data, extra) { return appendEvent(type, data, extra).seq; }

  function _scheduleFlush() {
    if (flushTimer || closed) return;
    flushTimer = setTimeout(() => { _flushNow().catch(() => {}); }, flushIntervalMs);
  }

  async function _flushNow() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (buffer.length === 0) return;
    const pending = buffer.splice(0, buffer.length).join('');
    const persistedSeq = seq;
    const target = livePath;
    flushChain = flushChain.then(async () => {
      try {
        await fs.promises.appendFile(target, pending, { mode: 0o600 });
        liveBytes += Buffer.byteLength(pending, 'utf-8');
        // Persist seq AFTER the append lands so recovery never overreads.
        await fs.promises.writeFile(path.join(dir, SEQ_FILE), String(persistedSeq), { mode: 0o600 });
        if (liveBytes >= rotateAtBytes) await _rotate();
      } catch (err) {
        // Local logging is best-effort; do not throw into the daemon loop.
        // A follow-up flush will retry the same buffer content — no, wait,
        // we already consumed it. Log to stderr so an operator can spot
        // repeated failures (disk full, perm error, etc).
        try { process.stderr.write(`[event-log] flush failed: ${err.message}\n`); } catch {}
      }
    });
    await flushChain;
  }

  async function _rotate() {
    // Find the next rolled index. Simple linear scan; sessions rarely
    // roll more than a handful of times.
    let idx = 1;
    while (fs.existsSync(path.join(dir, `${EVENTS_ROLLED_PREFIX}${idx}.jsonl`))) idx += 1;
    const rolled = path.join(dir, `${EVENTS_ROLLED_PREFIX}${idx}.jsonl`);
    try {
      await fs.promises.rename(livePath, rolled);
      liveBytes = 0;
    } catch (err) {
      // Rotation failed — keep writing to the current tail; it will just be
      // larger than the target. Not catastrophic.
      try { process.stderr.write(`[event-log] rotate failed: ${err.message}\n`); } catch {}
    }
  }

  async function flush() { await _flushNow(); await flushChain; }

  async function close() {
    closed = true;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    await _flushNow();
    await flushChain;
  }

  return {
    sessionId,
    dir,
    writeEvent,
    appendEvent,
    flush,
    close,
    currentSeq: () => seq,
    liveTailPath: () => livePath,
  };
}

// ── reader ────────────────────────────────────────────────────────────

/**
 * Async iterator over events with `seq > sinceSeq`. Walks all rolled
 * files first, then the live tail, in seq order. Malformed lines are
 * skipped with a stderr warning rather than throwing — a torn last
 * line (crash mid-flush) shouldn't prevent replay of the good events
 * before it.
 *
 * Not a live tail — this only reads what is on disk at the moment the
 * iterator advances. A separate "watch" API can be added later if
 * needed, but the daemon's socket server can just piggyback on
 * writeEvent() to broadcast live to attached clients.
 *
 * @param {object} opts
 * @param {string} opts.sessionId       e.g. "sess_..."
 * @param {string} [opts.sessionDir]    override
 * @param {number} [opts.sinceSeq=0]    only yield events with seq > sinceSeq
 * @param {number} [opts.maxEvents]     stop after this many
 * @returns {AsyncGenerator<object>}
 */
export async function* readEvents({ sessionId, sessionDir, sinceSeq = 0, maxEvents } = {}) {
  if (!sessionId) throw new Error('readEvents: sessionId is required');
  const dir = sessionDir || daemonSessionDir(sessionId);
  const files = _listEventFilesInOrder(dir);
  let yielded = 0;
  for (const filePath of files) {
    for await (const line of _readLines(filePath)) {
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch {
        try { process.stderr.write(`[event-log] skipping malformed line in ${filePath}\n`); } catch {}
        continue;
      }
      if (!SUPPORTED_EVENT_SCHEMA_VERSIONS.includes(evt.v)) continue;
      if (typeof evt.seq !== 'number' || evt.seq <= sinceSeq) continue;
      yield evt;
      yielded += 1;
      if (maxEvents && yielded >= maxEvents) return;
    }
  }
}

/** Convenience: collect readEvents() into an array. */
export async function readAllEvents(opts) {
  const out = [];
  for await (const e of readEvents(opts)) out.push(e);
  return out;
}

// ── snapshots ─────────────────────────────────────────────────────────

/**
 * Write a snapshot of session state at a given seq. Callers decide
 * what "state" means — usually the message history + turn state +
 * cumulative usage. Files are named `snapshot-<seq>.json` so the
 * latest is easy to find with a directory listing.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} [opts.sessionDir]
 * @param {number} opts.seq        the seq this snapshot summarizes UP TO
 * @param {object} opts.state      arbitrary JSON-serializable snapshot
 * @returns {Promise<string>}      path written
 */
export async function writeSnapshot({ sessionId, sessionDir, seq, state }) {
  if (!sessionId) throw new Error('writeSnapshot: sessionId is required');
  if (typeof seq !== 'number') throw new Error('writeSnapshot: seq must be a number');
  const dir = sessionDir || daemonSessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, `${SNAPSHOT_PREFIX}${String(seq).padStart(12, '0')}.json`);
  const body = { seq, ts: new Date().toISOString(), v: EVENT_SCHEMA_V, state };
  await fs.promises.writeFile(p, JSON.stringify(body), { mode: 0o600 });
  return p;
}

/**
 * Read the highest-seq snapshot for a session, or null if none exists.
 * Attach clients call this first to seed their renderer, then readEvents()
 * with `sinceSeq = snapshot.seq` to catch up.
 */
export async function readLatestSnapshot({ sessionId, sessionDir } = {}) {
  const dir = sessionDir || daemonSessionDir(sessionId);
  let entries;
  try { entries = await fs.promises.readdir(dir); } catch { return null; }
  const snaps = entries
    .filter(n => n.startsWith(SNAPSHOT_PREFIX) && n.endsWith('.json'))
    .sort();
  if (snaps.length === 0) return null;
  const latest = snaps[snaps.length - 1];
  try {
    const raw = await fs.promises.readFile(path.join(dir, latest), 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

// ── session meta ──────────────────────────────────────────────────────

/**
 * Write or update session meta. Meta is the "what and where" — cwd,
 * model, product, opened_at, closed_at, and anything else the daemon
 * needs on next attach to explain itself to a client.
 */
export async function writeSessionMeta({ sessionId, sessionDir, meta }) {
  const dir = sessionDir || daemonSessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, META_FILE);
  let existing = {};
  try { existing = JSON.parse(await fs.promises.readFile(p, 'utf-8')); } catch {}
  const merged = { ...existing, ...meta, session_id: sessionId };
  await fs.promises.writeFile(p, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

export async function readSessionMeta({ sessionId, sessionDir } = {}) {
  const dir = sessionDir || daemonSessionDir(sessionId);
  try {
    const raw = await fs.promises.readFile(path.join(dir, META_FILE), 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

// ── session discovery ────────────────────────────────────────────────

/**
 * List all session ids visible under ~/.bahulam/sessions/. Used by
 * `bahulam list`. Cheap — one readdir, no per-session parsing.
 */
export async function listSessionIds() {
  const root = daemonSessionsRoot();
  let entries;
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter(e => e.isDirectory() && e.name.startsWith('sess_'))
    .map(e => e.name)
    .sort();
}

// ── internals ─────────────────────────────────────────────────────────

function _fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function _listEventFilesInOrder(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const rolled = entries
    .filter(n => n.startsWith(EVENTS_ROLLED_PREFIX) && n.endsWith('.jsonl'))
    .sort((a, b) => {
      const na = parseInt(a.slice(EVENTS_ROLLED_PREFIX.length), 10);
      const nb = parseInt(b.slice(EVENTS_ROLLED_PREFIX.length), 10);
      return na - nb;
    })
    .map(n => path.join(dir, n));
  const live = path.join(dir, EVENTS_FILE);
  return fs.existsSync(live) ? [...rolled, live] : rolled;
}

function _recoverSeq(dir) {
  // The marker may lag the append (crash between the two writes). Compare
  // against the last log file, including a rolled tail, before minting IDs.
  let lastSeq = 0;
  const seqFile = path.join(dir, SEQ_FILE);
  try {
    const raw = fs.readFileSync(seqFile, 'utf-8').trim();
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n >= 0) lastSeq = n;
  } catch {}
  // Check the last rolled file as well when the live tail was just rotated.
  const files = _listEventFilesInOrder(dir);
  try {
    for (const file of files.slice(-2)) {
      const raw = fs.readFileSync(file, 'utf-8');
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          if (Number.isSafeInteger(evt.seq) && evt.seq > lastSeq) lastSeq = evt.seq;
        } catch { /* torn last line */ }
      }
    }
    return lastSeq;
  } catch { return lastSeq; }
}

function _repairTail(file) {
  if (!fs.existsSync(file)) return;
  const bytes = fs.readFileSync(file);
  if (!bytes.length || bytes[bytes.length - 1] === 10) return;
  const end = bytes.lastIndexOf(10) + 1;
  try {
    JSON.parse(bytes.subarray(end).toString('utf8'));
    fs.appendFileSync(file, '\n');
  } catch { fs.truncateSync(file, end); }
}

// Async line reader — small enough that pulling in `readline` is overkill.
// Buffers whole file into memory; fine for logs up to the rotation limit.
async function* _readLines(filePath) {
  let raw;
  try { raw = await fs.promises.readFile(filePath, 'utf-8'); }
  catch { return; }
  for (const line of raw.split('\n')) {
    yield line;
  }
}
