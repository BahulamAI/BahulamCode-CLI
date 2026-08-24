/**
 * Unix socket server — accepts local CLI client connections and
 * dispatches relay events to attached clients.
 *
 * Commands accepted from local clients:
 *   • `approve` / `deny` — dispatched to the approval handler
 *   • `interrupt`, `send_message`, `switch_model` — forwarded to relay
 *   • `take_input_lock` / `release_input_lock` — lock management *   • Multi-attach input lock ().
 *   • Relay bridge ().
 *
 * Design invariants:
 *   • ONE writer per event log; the server never writes to the log
 *     directly. The tap does. The server only READS the log to replay.
 *   • Broadcast failures on ONE client MUST NOT affect other clients or
 *     the daemon's own event flow. Every socket write is try/catch'd.
 *   • The server is a passive fan-out: it does not mutate session
 *     state, it does not drive the SSE loop, it does not have opinions
 *     about which events matter.
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readEvents, readLatestSnapshot } from '../core/event-log.mjs';
import { daemonSocketPath, daemonSocketsDir } from '../core/paths.mjs';
import {
  onAttachJoined, onAttachLeft, takeInputLock, releaseInputLock, isHolder,
} from './input-lock.mjs';

const NL = '\n';

/**
 * Create + start a socket server for one session.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {object} [opts.onCommand] — { approve, deny, interrupt, sendMessage, ... }
 *                                     each handler is `async (payload, attachId) => void`.
 *                                     Missing keys → the server responds with a
 *                                     `command_error { code: "not_implemented" }` event.
 * @returns {Promise<{
 *   sockPath: string,
 *   broadcastEvent(event: object): void,
 *   attachedCount(): number,
 *   close(): Promise<void>,
 * }>}
 */
export async function startSocketServer({ sessionId, onCommand = {} } = {}) {
  if (!sessionId) throw new Error('startSocketServer: sessionId is required');

  const sockPath = daemonSocketPath(sessionId);
  fs.mkdirSync(daemonSocketsDir(), { recursive: true, mode: 0o700 });
  // If a stale socket exists (previous daemon crashed), remove it before bind.
  // The OS retains the inode across process death so `listen` will EADDRINUSE
  // even though nothing owns it.
  try { fs.unlinkSync(sockPath); } catch { /* file didn't exist, fine */ }

  /** @type {Set<AttachedClient>} */
  const clients = new Set();

  const server = net.createServer(sock => {
    // 0600 on the socket path itself. On most kernels this is enforced at
    // bind() time (see below), but re-chmod defensively in case umask lied.
    try { fs.chmodSync(sockPath, 0o600); } catch { /* best effort */ }

    const client = _createAttachedClient(sock, sessionId, onCommand);
    clients.add(client);
    sock.on('close', () => { clients.delete(client); });
  });

  server.on('error', err => {
    // Never crash on a listen error — log and let the caller notice via
    // attachedCount() staying at 0. The daemon session itself continues.
    try { process.stderr.write(`[socket-server] listen error: ${err.message}\n`); } catch {}
  });

  // Bind with umask temporarily narrowed so the socket file is created 0600
  // even if the user's shell umask would grant group/other read.
  const priorUmask = process.umask(0o077);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(sockPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally {
    process.umask(priorUmask);
  }
  // chmod again post-listen — belt and braces on platforms where the umask
  // trick doesn't cover socket files (rare but seen on some Linux configs).
  try { fs.chmodSync(sockPath, 0o600); } catch { /* ignore */ }

  return {
    sockPath,
    broadcastEvent(event) {
      // Fire-and-forget to every client. One slow reader must not throttle
      // the daemon; we let the OS socket buffer absorb bursts and drop on
      // the individual client if that client fills.
      const line = _serializeFrame(event);
      for (const client of clients) {
        try { client.write(line); }
        catch (err) { try { process.stderr.write(`[socket-server] write to ${client.id} failed: ${err.message}\n`); } catch {} }
      }
    },
    attachedCount: () => clients.size,
    async close() {
      // Close all client sockets first so they drain, then stop listening.
      for (const client of Array.from(clients)) {
        try { client.end(); } catch { /* ignore */ }
      }
      await new Promise(res => server.close(() => res()));
      try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    },
  };
}

// ── attached client (per-connection state) ───────────────────────────

let _nextAttachId = 1;

/**
 * @typedef {{ id: string, write: (line: string) => void, end: () => void }} AttachedClient
 */

function _createAttachedClient(sock, sessionId, onCommand) {
  const attachId = `att_${Date.now().toString(36)}_${(_nextAttachId++).toString(36)}`;
  let helloSeen = false;
  let buf = '';

  sock.setEncoding('utf-8');
  sock.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf(NL)) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim().length === 0) continue;
      _handleFrame(line).catch(err => {
        try { process.stderr.write(`[socket-server] frame handler crashed: ${err.message}\n`); } catch {}
      });
    }
  });
  sock.on('error', err => {
    try { process.stderr.write(`[socket-server] ${attachId} socket error: ${err.message}\n`); } catch {}
  });

  async function _handleFrame(line) {
    let msg;
    try { msg = JSON.parse(line); }
    catch { _sendError('invalid_json', 'frame is not valid JSON'); return; }
    if (!msg || typeof msg.type !== 'string') {
      _sendError('invalid_frame', 'missing type'); return;
    }

    if (!helloSeen && msg.type !== 'hello') {
      _sendError('hello_required', 'first frame must be hello'); return;
    }

    switch (msg.type) {
      case 'hello': {
        helloSeen = true;
        const lastSeq = Number(msg.last_seq) || 0;
        //  — input lock: first attach implicitly becomes holder;
        // later attaches join as watchers. The state is stored in
        // input-lock.mjs; the changed event is emitted from THAT module
        // (via wireEmit()) so it also fans out through the tap and hits
        // the event log for later attaches to replay.
        const lockInfo = onAttachJoined(attachId);
        _send({
          type: 'hello_ok', v: 1,
          data: {
            attach_id: attachId,
            session_id: sessionId,
            input_lock: { holder: lockInfo.holder, kind: lockInfo.kind },
          },
        });
        await _replaySince(lastSeq);
        _send({
          seq: 0, ts: new Date().toISOString(), type: 'attach_joined',
          session_id: sessionId, v: 1,
          data: {
            attach_id: attachId, kind: 'local',
            human_hint: msg.human_hint || null,
            input_role: lockInfo.kind,   // 'holder' | 'watch'
          },
        });
        return;
      }
      //  — input lock commands. Both handled internally by the
      // shared input-lock.mjs state; the resulting input_lock_changed
      // event is emitted from that module (via wireEmit) so all attaches
      // see the transition, including the daemon's local renderer.
      case 'take_input_lock': {
        const out = takeInputLock(attachId);
        _send({
          seq: 0, ts: new Date().toISOString(), type: 'input_lock_ack',
          session_id: sessionId, v: 1,
          data: { in_reply_to: msg.reply_to || null, ...out },
        });
        return;
      }
      case 'release_input_lock': {
        const out = releaseInputLock(attachId);
        _send({
          seq: 0, ts: new Date().toISOString(), type: 'input_lock_ack',
          session_id: sessionId, v: 1,
          data: { in_reply_to: msg.reply_to || null, ...out },
        });
        return;
      }

      case 'bye': {
        onAttachLeft(attachId);
        // Serialize attach_left, then end() only after the write drains.
        // Immediate sock.end() after sock.write() races the flush on some
        // kernels — the FIN can go out before the frame's last byte lands
        // in the client's read buffer, so the client sees close-without-
        // attach_left. Use the write completion callback to sequence.
        const frame = _serializeFrame({
          seq: 0, ts: new Date().toISOString(), type: 'attach_left',
          session_id: sessionId, v: 1, data: { attach_id: attachId, reason: 'bye' },
        });
        try {
          sock.write(frame, () => { try { sock.end(); } catch {} });
        } catch {
          try { sock.end(); } catch {}
        }
        return;
      }
      case 'approve':
      case 'deny': {
        const handler = onCommand[msg.type];
        if (typeof handler !== 'function') {
          _sendError('not_implemented', `command ${msg.type} has no handler`, msg.reply_to);
          return;
        }
        try { await handler(msg.data || {}, attachId); }
        catch (err) { _sendError('handler_failed', err.message, msg.reply_to); }
        return;
      }
      case 'interrupt':
      case 'send_message':
      case 'switch_model': {
        //  — typing-class commands require the input lock. Watch-
        // mode attaches get a `not_input_holder` error and can request
        // the lock via take_input_lock (steal-with-grace).
        if (!isHolder(attachId)) {
          _sendError('not_input_holder', `command ${msg.type} requires the input lock; send take_input_lock first`, msg.reply_to);
          return;
        }
        const handler = onCommand[msg.type];
        if (typeof handler !== 'function') {
          _sendError('not_implemented', `command ${msg.type} is not wired yet (deferred slice)`, msg.reply_to);
          return;
        }
        try { await handler(msg.data || {}, attachId); }
        catch (err) { _sendError('handler_failed', err.message, msg.reply_to); }
        return;
      }
      case 'wake': {
        const handler = onCommand[msg.type];
        if (typeof handler !== 'function') {
          _sendError('not_implemented', `command ${msg.type} is not wired yet (deferred slice)`, msg.reply_to);
          return;
        }
        try { await handler(msg.data || {}, attachId); }
        catch (err) { _sendError('handler_failed', err.message, msg.reply_to); }
        return;
      }
      default:
        _sendError('unknown_type', `unknown command: ${msg.type}`, msg.reply_to);
    }
  }

  async function _replaySince(lastSeq) {
    // Seed from snapshot (if any) so long-running sessions don't stream 100k
    // events at attach time. Then stream events with seq > snapshot.seq (or
    // > lastSeq, whichever's higher).
    let sinceSeq = lastSeq;
    const snap = await readLatestSnapshot({ sessionId }).catch(() => null);
    if (snap && typeof snap.seq === 'number' && snap.seq > sinceSeq) {
      _send({
        seq: 0, ts: new Date().toISOString(), type: 'snapshot',
        session_id: sessionId, v: 1, data: { seq: snap.seq, state: snap.state },
      });
      sinceSeq = snap.seq;
    }
    let firstSeq = null, lastSeqSeen = sinceSeq;
    const batch = [];
    for await (const evt of readEvents({ sessionId, sinceSeq })) {
      if (firstSeq == null) firstSeq = evt.seq;
      batch.push(evt);
      lastSeqSeen = evt.seq;
    }
    if (batch.length > 0) {
      _send({ seq: 0, ts: new Date().toISOString(), type: 'replay_batch_start',
              session_id: sessionId, v: 1, data: { from_seq: firstSeq, to_seq: lastSeqSeen } });
      for (const evt of batch) _send(evt);
      _send({ seq: 0, ts: new Date().toISOString(), type: 'replay_batch_end',
              session_id: sessionId, v: 1, data: { from_seq: firstSeq, to_seq: lastSeqSeen } });
    }
  }

  function _send(obj) {
    try { sock.write(_serializeFrame(obj)); }
    catch { /* silent — client will close and we'll clean up */ }
  }

  function _sendError(code, message, in_reply_to) {
    _send({
      seq: 0, ts: new Date().toISOString(), type: 'command_error',
      session_id: sessionId, v: 1,
      data: { code, message, ...(in_reply_to ? { in_reply_to } : {}) },
    });
  }

  return {
    id: attachId,
    write: line => sock.write(line),
    end: () => sock.end(),
  };
}

function _serializeFrame(obj) {
  return JSON.stringify(obj) + NL;
}
