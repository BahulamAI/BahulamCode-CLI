/**
 *   — Pending-approval registry + timeout policy.
 *
 * Bridges the two paths that can answer an approval request:
 *
 *   1. Local TTY  — the existing approval.mjs prompt (arrow keys, dock).
 *   2. Remote     — a socket attach client (or later, mobile via relay)
 *                    sending an `approve` / `deny` command with an apr_id.
 *
 * Both race the same promise. Whichever resolves first wins; the loser's
 * resolver becomes a no-op. Cleanup on either resolution.
 *
 * Also owns the timeout policy from PRD §6.7:
 *   - `hold`         : never times out (default; safe for attended sessions)
 *   - `deny <sec>`   : auto-deny after N seconds if nobody has answered
 *   - `allow <sec>`  : auto-approve — gated behind the existing
 *                       `--dangerously-skip-permissions` opt-in, checked
 *                       by the caller (this module doesn't enforce it).
 *
 * NOT in this module:
 *   - The dispatch that turns a `check()` call into an `approval_required`
 *     event. That's an intercept wrapper wired at the ApprovalManager
 *     call sites (see attach-approval-bridge below).
 *   - The socket-server side — `socket-server.mjs` already parses
 *     `approve`/`deny` commands; the daemon wiring passes them here.
 */

import { randomBytes } from 'node:crypto';

/** Approvals we're waiting on. Key: apr_id → { resolve, sourceType, timer } */
const _pending = new Map();

/** Default timeout policy: never expires. Change via setTimeoutPolicy(). */
let _policy = { mode: 'hold', durationMs: 0 };

// ── policy ────────────────────────────────────────────────────────────

/**
 * Set the session-level timeout policy for pending approvals.
 * @param {{mode: 'hold'|'deny'|'allow', durationSec?: number}} p
 */
export function setTimeoutPolicy(p) {
  const mode = p?.mode || 'hold';
  const durationMs = Math.max(0, Number(p?.durationSec || 0)) * 1000;
  _policy = { mode, durationMs };
  return { mode, durationMs };
}

export function getTimeoutPolicy() {
  return { ..._policy };
}

// ── registry ──────────────────────────────────────────────────────────

/**
 * Register a new pending approval. Returns { apr_id, race } where
 *
 *   race       — a Promise<{decision, decided_by, note}> that resolves
 *                when ANY source (local TTY, socket, timeout) answers.
 *   cancel(id) — called after another source has already resolved to
 *                mark this pending entry as consumed and clean up the
 *                timer. Idempotent.
 *
 * The caller (typically the approval manager intercept) also races this
 * against the local TTY prompt. When the TTY prompt resolves, the caller
 * should call `cancel(apr_id)` so a late socket `approve` becomes a
 * no-op instead of getting an "unknown apr_id" error.
 *
 * @param {object} meta
 * @param {string} meta.kind             tool name / classifier tag
 * @param {string} meta.subject          human-readable one-liner
 * @param {number} [meta.expiresAtMs]    caller-provided override; otherwise
 *                                        we compute from the active policy.
 */
export function registerPending(meta = {}) {
  const apr_id = `apr_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  let resolve;
  const race = new Promise(r => { resolve = r; });

  const entry = {
    apr_id,
    kind: meta.kind || 'unknown',
    subject: meta.subject || '',
    resolve,
    consumed: false,
    timer: null,
  };
  _pending.set(apr_id, entry);

  // Wire policy timeout — only if a duration was set AND a mode that
  // implies an automatic decision. `hold` never schedules a timer.
  const policy = getTimeoutPolicy();
  if (policy.mode !== 'hold' && policy.durationMs > 0) {
    entry.timer = setTimeout(() => {
      if (entry.consumed) return;
      entry.consumed = true;
      _pending.delete(apr_id);
      resolve({
        decision: policy.mode === 'allow' ? 'approve' : 'deny',
        decided_by: 'timeout',
        note: `timeout:${policy.mode}:${policy.durationMs}ms`,
      });
    }, policy.durationMs);
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
  }

  return {
    apr_id,
    race,
    cancel() {
      if (entry.consumed) return;
      entry.consumed = true;
      _pending.delete(apr_id);
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    },
    expiresAt: policy.mode !== 'hold' && policy.durationMs > 0
      ? new Date(Date.now() + policy.durationMs).toISOString()
      : null,
  };
}

/**
 * Called by the socket server's approve/deny handlers. Resolves the
 * pending approval with the given decision. Returns true if the
 * apr_id existed and was resolved; false if unknown or already consumed.
 *
 * @param {'approve'|'deny'} decision
 * @param {string} apr_id
 * @param {string} decided_by  attach_id of the answering client
 * @param {string} [note]
 */
export function resolvePending(decision, apr_id, decided_by, note = '') {
  const entry = _pending.get(apr_id);
  if (!entry || entry.consumed) return false;
  entry.consumed = true;
  _pending.delete(apr_id);
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
  entry.resolve({ decision, decided_by, note });
  return true;
}

/**
 * Introspection — used by the socket server's `attach_joined` replay
 * ( follow-up) and by `bahulam status` to show pending approvals.
 */
export function listPending() {
  return Array.from(_pending.values(), e => ({
    apr_id: e.apr_id,
    kind: e.kind,
    subject: e.subject,
  }));
}

/**
 * Clean up all pending approvals (session end, daemon shutdown). Every
 * pending entry gets a synthetic `deny` decision so no `check()` call
 * hangs forever.
 */
export function shutdownAllPending(reason = 'shutdown') {
  for (const entry of Array.from(_pending.values())) {
    if (entry.consumed) continue;
    entry.consumed = true;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    entry.resolve({ decision: 'deny', decided_by: 'shutdown', note: reason });
  }
  _pending.clear();
}

// ── intercept helper for ApprovalManager ─────────────────────────────

/**
 * Wrap an ApprovalManager.check() call so that:
 *   (a) an approval_required event is emitted (broadcast to attaches),
 *   (b) a socket approve/deny can resolve the check before the TTY does.
 *
 * Usage in repl.mjs ( wiring):
 *
 *     const orig = approval.check.bind(approval);
 *     approval.check = (tool, args, req, ctx) =>
 *       interceptApproval(orig, { tool, args, req, ctx, sessionId, emit });
 *
 * `emit(event)` is the caller's hook that writes the approval_required
 * event to the daemon event log (tap) so it also fans out to sockets.
 * We do the emission here rather than inside registerPending so the
 * store stays transport-agnostic.
 */
export async function interceptApproval(origCheck, { tool, args, req, ctx, sessionId, emit } = {}) {
  const pending = registerPending({ kind: tool, subject: _subjectFromArgs(tool, args) });
  const eventData = {
    apr_id: pending.apr_id,
    kind: tool,
    subject: _subjectFromArgs(tool, args),
    expires_at: pending.expiresAt,
  };
  if (typeof emit === 'function') {
    try { emit('approval_required', eventData); } catch { /* never blocks approval */ }
  }

  // Race the local TTY prompt against the remote resolution promise.
  // Whichever resolves first wins; cancel the other.
  const local = origCheck(tool, args, req, ctx).then(v => ({ __src: 'local', v }));
  const remote = pending.race.then(v => ({ __src: 'remote', v }));

  const first = await Promise.race([local, remote]);
  pending.cancel();

  if (first.__src === 'local') {
    // TTY already answered; nothing else to do. Emit approval_decided so
    // remote watchers see the outcome.
    if (typeof emit === 'function') {
      try {
        emit('approval_decided', {
          apr_id: pending.apr_id,
          decision: first.v?.approved ? 'approve' : 'deny',
          decided_by: 'local_tty',
        });
      } catch { /* ignore */ }
    }
    return first.v;
  }

  // Remote answered. Build the same shape ApprovalManager.check() returns
  // so the caller (stream-client's tool_request handler) doesn't need to
  // care where the decision came from.
  if (typeof emit === 'function') {
    try {
      emit('approval_decided', {
        apr_id: pending.apr_id,
        decision: first.v.decision,
        decided_by: first.v.decided_by,
        note: first.v.note,
      });
    } catch { /* ignore */ }
  }
  return {
    approved: first.v.decision === 'approve',
    tier: 'destructive',  // remote answers always treated as an explicit tier decision
    reason: first.v.note || `Decided remotely by ${first.v.decided_by}`,
    remoteDecision: true,
  };
}

// ── helpers ──────────────────────────────────────────────────────────

function _subjectFromArgs(tool, args) {
  if (!args || typeof args !== 'object') return tool;
  // Best-effort short summary of the most common tool args.
  if (typeof args.command === 'string') return `${tool}: ${args.command.slice(0, 120)}`;
  if (typeof args.cmd === 'string')     return `${tool}: ${args.cmd.slice(0, 120)}`;
  if (typeof args.path === 'string')    return `${tool}: ${args.path}`;
  if (typeof args.file_path === 'string') return `${tool}: ${args.file_path}`;
  return tool;
}
