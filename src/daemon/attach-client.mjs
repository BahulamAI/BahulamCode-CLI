/**
 *   — Attach client.
 *
 * `bahulam attach <session-id>` connects to the daemon's Unix socket at
 * ~/.bahulam/sockets/<sess_id>.sock and mirrors the event stream in the
 * current terminal. It's the "observer + approver" surface — the local
 * counterpart to the mobile PWA. Every wire type is the same 
 * event/command schema the relay uses; only the transport differs.
 *
 * What this slice ships:
 *   • Connect + hello handshake (with `last_seq` resume support).
 *   • Renders replayed events (bracketed by replay_batch_{start,end})
 *     compactly so a long history doesn't spam the terminal.
 *   • Renders live events as they arrive.
 *   • Approve/deny keyboard shortcut on pending approvals.
 *   • Ctrl-D or `.bye` → clean bye + exit (daemon keeps running).
 *   • Ctrl-C → sends `interrupt` command (cancels current turn).
 *
 * What's deferred:
 *   • Full renderer parity (spinner, block boundaries, sub-agent window)
 *     —  refactors repl-render.mjs to be attach-mode-aware.
 *   • Input-lock steal-with-grace ().
 *   • Sending `send_message` / `switch_model` from the attach client
 *     ( ships read+approve; interactive prompt input lands in D).
 *
 * NOT wired here (/H concerns):
 *   • The daemon's approve/deny handlers don't yet resolve pending
 *     approvals (they stub as TODO in repl.mjs). Approvals we send from
 *     here will be dispatched to the daemon but the daemon-side pending
 *     approval registry is  work. This client sends the wire
 *     command correctly — that's the piece  is responsible for.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as readline from 'node:readline';

import { daemonSocketPath, daemonSessionDir } from '../core/paths.mjs';

const NL = '\n';
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';

export async function attachToSession(sessionId, { lastSeq = 0, humanHint = null } = {}) {
  if (!sessionId) {
    process.stderr.write('Usage: bahulam attach <session-id>\n');
    process.stderr.write(`Run ${BOLD}bahulam list${RESET} to see available sessions.\n`);
    return 1;
  }

  const sockPath = daemonSocketPath(sessionId);
  if (!fs.existsSync(sockPath)) {
    process.stderr.write(`No socket at ${sockPath}\n`);
    process.stderr.write(`Session may not be running. Try ${BOLD}bahulam list${RESET}.\n`);
    return 1;
  }

  // Read session meta for a nicer banner. Best-effort — attach still works if
  // meta.json is missing (e.g. daemon crashed before writing it).
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(`${daemonSessionDir(sessionId)}/meta.json`, 'utf-8')); }
  catch { /* ignore */ }

  return new Promise((resolve) => {
    const sock = net.createConnection(sockPath);
    let buf = '';
    let bye = false;

    // Track approvals we've seen but not yet answered — one-liner prompt shows
    // the most recent unanswered one. Keyed by apr_id.
    const pending = new Map();

    // Readline for keyboard commands (a/d/i/q). raw mode so single-key input
    // works without hitting Enter.
    let rl = null;
    let stdinRaw = false;

    function _teardownStdin() {
      if (stdinRaw && process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch { /* ignore */ }
        stdinRaw = false;
      }
      if (rl) { try { rl.close(); } catch { /* ignore */ } rl = null; }
    }

    function _shutdown(exitCode = 0) {
      _teardownStdin();
      try { sock.end(); } catch { /* ignore */ }
      resolve(exitCode);
    }

    sock.on('connect', () => {
      _printBanner(sessionId, meta, humanHint, lastSeq);
      // Send hello.
      const hello = {
        type: 'hello',
        attach_id: `att_local_${process.pid}`,
        last_seq: lastSeq,
        want_pty: false,
        kind: 'local',
        human_hint: humanHint || `${process.env.USER || 'user'}@${_hostShort()}`,
        protocol_versions: [1],
      };
      sock.write(JSON.stringify(hello) + NL);

      // Wire keyboard input. Prefer raw mode on a real TTY (single-key
      // response, no Enter needed). When stdin is piped (scripts, tests),
      // fall back to plain data events — each character still triggers
      // _handleKey, just without the raw-mode terminal setup.
      try {
        process.stdin.setEncoding('utf-8');
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
          stdinRaw = true;
        }
        process.stdin.on('data', ch => {
          // Piped input may deliver multiple chars per data event
          // (buffered). Feed one at a time so a batched "aq" still
          // resolves as approve+quit in order.
          for (const c of String(ch)) _handleKey(c);
        });
        process.stdin.on('end', () => {
          if (!bye) {
            bye = true;
            _send({ type: 'bye', attach_id: `att_local_${process.pid}` });
          }
        });
      } catch (err) {
        process.stderr.write(`${DIM}(stdin unavailable: ${err.message})${RESET}\n`);
      }
    });

    sock.setEncoding('utf-8');
    sock.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf(NL)) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        let frame;
        try { frame = JSON.parse(line); }
        catch { continue; }
        _renderFrame(frame, pending);
      }
    });

    sock.on('error', err => {
      process.stderr.write(`${RED}[attach] socket error: ${err.message}${RESET}\n`);
      _shutdown(1);
    });

    sock.on('end', () => {
      if (!bye) process.stderr.write(`${DIM}[attach] peer half-closed${RESET}\n`);
      _shutdown(bye ? 0 : 2);
    });

    // Ctrl-C → interrupt. Ctrl-D → bye. Otherwise pass to _handleKey below.
    function _handleKey(ch) {
      // Raw mode: ETX=0x03 (Ctrl-C), EOT=0x04 (Ctrl-D).
      if (ch === '\x03') {
        _send({ type: 'interrupt', attach_id: `att_local_${process.pid}` });
        process.stderr.write(`${YELLOW}[attach] interrupt sent${RESET}\n`);
        return;
      }
      if (ch === '\x04') {
        bye = true;
        _send({ type: 'bye', attach_id: `att_local_${process.pid}` });
        return;
      }
      // Answer the latest pending approval with a/d.
      const k = ch.toLowerCase();
      if (k === 'a' || k === 'd') {
        const latest = _latestPending(pending);
        if (!latest) return;
        _send({
          type: k === 'a' ? 'approve' : 'deny',
          attach_id: `att_local_${process.pid}`,
          data: { apr_id: latest.apr_id },
        });
        pending.delete(latest.apr_id);
        process.stderr.write(
          `${k === 'a' ? GREEN + '✓ approved' : RED + '✗ denied'}${RESET}${DIM} ${latest.apr_id}${RESET}\n`
        );
        _reprintPendingHint(pending);
        return;
      }
      if (k === 'q') {
        bye = true;
        _send({ type: 'bye', attach_id: `att_local_${process.pid}` });
        return;
      }
    }

    function _send(obj) {
      try { sock.write(JSON.stringify(obj) + NL); } catch { /* ignore */ }
    }
  });
}

// ── frame rendering ──────────────────────────────────────────────────

// Called on every wire frame. Renders human-readable output; batches long
// replay sequences into a one-line "replayed N events" summary so an attach
// to a long-running session doesn't spam the terminal.
let _replayCount = 0;
let _inReplay = false;

function _renderFrame(frame, pending) {
  switch (frame.type) {
    case 'hello_ok':
      return; // banner already printed
    case 'hello_error':
      process.stderr.write(`${RED}hello rejected: ${frame.data?.reason}${RESET}\n`);
      return;
    case 'replay_batch_start':
      _inReplay = true;
      _replayCount = 0;
      return;
    case 'replay_batch_end':
      _inReplay = false;
      if (_replayCount > 0) {
        process.stdout.write(`${DIM}  … replayed ${_replayCount} event(s) from before you attached${RESET}\n`);
      }
      _replayCount = 0;
      return;
    case 'snapshot':
      process.stdout.write(`${DIM}  (snapshot @ seq ${frame.data?.seq})${RESET}\n`);
      return;
    case 'command_error':
      process.stderr.write(`${RED}[cmd err ${frame.data?.code}] ${frame.data?.message}${RESET}\n`);
      return;
    case 'attach_joined':
      if (!_inReplay) {
        process.stderr.write(`${DIM}  + ${frame.data?.attach_id || 'attach'} joined${RESET}\n`);
      }
      return;
    case 'attach_left':
      if (!_inReplay) {
        process.stderr.write(`${DIM}  - ${frame.data?.attach_id || 'attach'} left (${frame.data?.reason})${RESET}\n`);
      }
      return;
  }

  if (_inReplay) { _replayCount += 1; return; }

  const seq = typeof frame.seq === 'number' ? frame.seq : '?';
  const ts = frame.ts ? frame.ts.slice(11, 19) : '        ';
  switch (frame.type) {
    case 'session_started':
      process.stdout.write(`${DIM}[${ts}]${RESET} ${BOLD}session${RESET} model=${frame.data?.model} cwd=${frame.data?.cwd}\n`);
      break;
    case 'turn_started':
      process.stdout.write(`${DIM}[${ts}]${RESET} ${BLUE}▶ turn${RESET} ${frame.turn_id} iter=${frame.data?.iteration || 0}\n`);
      break;
    case 'turn_ended':
      process.stdout.write(`${DIM}[${ts}]${RESET} ${BLUE}◀ turn${RESET} ${frame.turn_id} ${frame.data?.ok ? GREEN + 'ok' : RED + 'err'}${RESET}\n`);
      break;
    case 'thinking_delta': {
      const chunk = String(frame.data?.chunk || '').slice(0, 120);
      if (chunk.trim()) process.stdout.write(`${DIM}  ⋯ ${chunk}${RESET}\n`);
      break;
    }
    case 'tool_call': {
      const name = frame.data?.name || '?';
      const args = _briefArgs(frame.data?.args);
      process.stdout.write(`${DIM}[${ts}]${RESET} ${CYAN}⚙ ${name}${RESET}${DIM}(${args})${RESET}\n`);
      break;
    }
    case 'tool_result': {
      const ok = frame.data?.ok !== false;
      const dur = frame.data?.duration_ms ? ` ${frame.data.duration_ms}ms` : '';
      const summary = String(frame.data?.summary || '').split(NL)[0].slice(0, 80);
      process.stdout.write(`${DIM}  ${ok ? GREEN + '↳' : RED + '↳'}${RESET} ${summary}${DIM}${dur}${RESET}\n`);
      break;
    }
    case 'approval_required': {
      const apr_id = frame.data?.apr_id;
      pending.set(apr_id, frame.data);
      process.stdout.write(
        `${YELLOW}⚠ approval${RESET} ${BOLD}${frame.data?.kind || ''}${RESET}: ${frame.data?.subject || ''}\n`
      );
      _reprintPendingHint(pending);
      break;
    }
    case 'approval_decided':
      pending.delete(frame.data?.apr_id);
      process.stdout.write(
        `${DIM}[${ts}] ${frame.data?.decision === 'approve' ? GREEN + '✓' : RED + '✗'}${RESET}${DIM} ${frame.data?.apr_id} by ${frame.data?.decided_by}${RESET}\n`
      );
      _reprintPendingHint(pending);
      break;
    case 'diff':
      process.stdout.write(`${DIM}[${ts}]${RESET} 📝 ${frame.data?.path} (${frame.data?.hunks?.length || 0} hunk(s))\n`);
      break;
    case 'test_result':
      process.stdout.write(`${DIM}[${ts}]${RESET} 🧪 ${frame.data?.suite}: ${GREEN}${frame.data?.passed || 0} passed${RESET} ${RED}${frame.data?.failed || 0} failed${RESET}\n`);
      break;
    case 'tokens_used':
      process.stdout.write(`${DIM}[${ts}]  tok in=${frame.data?.prompt || 0} out=${frame.data?.completion || 0} cache=${frame.data?.cached || 0}${RESET}\n`);
      break;
    case 'agent_complete':
      process.stdout.write(`${GREEN}[${ts}] ✓ complete${RESET} ${DIM}${frame.data?.summary || ''}${RESET}\n`);
      break;
    case 'daemon_shutdown':
      process.stdout.write(`${DIM}[${ts}] daemon shutdown: ${frame.data?.reason}${RESET}\n`);
      break;
    default:
      // Unknown types are forward-compat: dim one-liner so we can see them
      // if the daemon starts emitting a new type before we know about it.
      process.stdout.write(`${DIM}[${ts}] ${frame.type} #${seq}${RESET}\n`);
  }
}

function _briefArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    let repr;
    if (typeof v === 'string') repr = v.length > 40 ? v.slice(0, 40) + '…' : v;
    else if (Array.isArray(v)) repr = `[${v.length}]`;
    else if (v && typeof v === 'object') repr = '{…}';
    else repr = String(v);
    parts.push(`${k}=${repr}`);
    if (parts.join(' ').length > 60) { parts.push('…'); break; }
  }
  return parts.join(' ');
}

function _printBanner(sessionId, meta, humanHint, lastSeq) {
  process.stderr.write(`${BOLD}bahulam attach${RESET} ${DIM}${sessionId}${RESET}`);
  if (meta?.cwd) process.stderr.write(` ${DIM}${meta.cwd}${RESET}`);
  if (meta?.model) process.stderr.write(` ${DIM}${meta.model}${RESET}`);
  process.stderr.write(`\n${DIM}  since seq ${lastSeq} · a=approve · d=deny · Ctrl-C=interrupt · Ctrl-D=detach${RESET}\n`);
}

function _latestPending(pending) {
  const it = pending.values();
  let last = null;
  for (const v of it) last = v;
  return last;
}

function _reprintPendingHint(pending) {
  if (pending.size === 0) return;
  const latest = _latestPending(pending);
  process.stdout.write(
    `${YELLOW}  → press ${BOLD}a${RESET}${YELLOW} to approve, ${BOLD}d${RESET}${YELLOW} to deny${RESET}${DIM} (${latest.subject || ''})${RESET}\n`
  );
}

function _hostShort() {
  try { return (process.env.HOSTNAME || process.env.HOST || 'host').split('.')[0]; }
  catch { return 'host'; }
}
