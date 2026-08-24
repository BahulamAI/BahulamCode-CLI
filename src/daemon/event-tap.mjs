/**
 * PRD-092 Slice B.3 — SSE→PRD-092 event tap.
 *
 * Bridges the current SSE stream (from `stream-client.mjs`, consumed by
 * repl.mjs's `for await` loop) to the append-only event log defined in
 * `src/core/event-log.mjs`. One call per yielded SSE event; the tap
 * decides whether it maps to a first-class PRD-092 §5.1 event and, if
 * so, calls `log.writeEvent()`.
 *
 * Off by default. Enabled only when the env var
 *
 *   BAHULAM_DAEMON_EVENTLOG=1
 *
 * is set. Under any other value (unset, "0", empty), tapSseEvent is a
 * no-op — importing this module and calling it costs nothing.
 *
 * Design notes (why here, not inline in repl.mjs):
 *   • The mapping SSE-type → PRD-092-type is a fixed table. Keeping it
 *     out of the big dispatch switch means the daemon's persistence
 *     layer isn't visually tangled with the terminal renderer.
 *   • bahulamd (Slice B.4+) will call tapSseEvent from a headless loop
 *     with no terminal at all — same function, same table.
 *   • Cache-invariance (PRD-092 §7): this tap is READ-ONLY on the SSE
 *     event. It never mutates `event`, never changes what stream-client
 *     yields, and writes to a local file only. `/api/execute` body is
 *     untouched.
 *
 * NOT in scope for Slice B.3:
 *   • Broadcasting events to attached socket clients (Slice B.4).
 *   • Compact snapshot writing (Slice B.4 — the daemon supervisor
 *     decides when to snapshot; the tap doesn't).
 *   • Deriving PRD-092 events that don't have a direct SSE origin
 *     (e.g. `attach_joined`, `input_lock_changed` — those come from
 *     the socket server, not the SSE stream).
 */

import { createEventLog } from '../core/event-log.mjs';

// ── env-var gate ─────────────────────────────────────────────────────

function _enabled() {
  const v = process.env.BAHULAM_DAEMON_EVENTLOG;
  return v === '1' || v === 'true';
}

// ── per-session lazy log holder ──────────────────────────────────────
//
// One active log at a time. Session id change (via new turn's session_info)
// closes the old log and opens a new one. `_current` is null when the tap
// hasn't seen a session id yet — session_info events don't always arrive
// before other events do, so we buffer nothing and simply drop events
// that arrive before the id is known. First real event a re-attach sees
// is session_started; anything before that is renderer-only anyway.

let _current = null;  // { sessionId, log }

function _openLogFor(sessionId) {
  if (_current && _current.sessionId === sessionId) return _current.log;
  if (_current) {
    // Fire-and-forget close on the previous log. The write chain resolves
    // internally; we don't await here because tapSseEvent is called from
    // a hot loop that can't afford to block.
    try { _current.log.close().catch(() => {}); } catch { /* ignore */ }
  }
  const log = createEventLog({ sessionId });
  _current = { sessionId, log };
  return log;
}

/** Test / bahulam-stop hook — close the active log and drop the ref. */
export async function closeActiveEventLog() {
  if (!_current) return;
  const { log } = _current;
  _current = null;
  try { await log.close(); } catch { /* ignore */ }
}

// ── SSE → PRD-092 event mapping ──────────────────────────────────────
//
// Table (protocol spec §5.1). Only events that map to a first-class
// PRD-092 type are logged. Everything else (status, thinking with
// empty text, phase_update, worker_update, etc.) is renderer-transient
// and doesn't belong in a durable event log.

const SSE_TO_PRD092 = Object.freeze({
  session_info:       'session_started',
  turn_started:       'turn_started',
  turn_ended:         'turn_ended',
  thinking:           'thinking_delta',
  tool_request:       'tool_call',
  tool_call:          'tool_call',
  tool_result:        'tool_result',
  tool_done:          'tool_result',
  approval_required:  'approval_required',
  approval_decided:   'approval_decided',
  file_diff:          'diff',
  diff:               'diff',
  test_result:        'test_result',
  tokens_used:        'tokens_used',
  usage_update:       'usage_update',
  complete:           'agent_complete',
});

// Some SSE event bodies carry more than we want to log. Trim what makes
// sense per type so we don't bloat the log with, e.g., a 200KB rendered
// tool output when a summary would do. Everything else round-trips as-is.
function _projectData(prd092Type, data) {
  const src = data || {};
  switch (prd092Type) {
    case 'tool_call':
      return {
        name: src.tool || src.name,
        tool_id: src.tool_call_id || src.tool_id || src.id,
        args: src.args || src.tool_input || src.input || {},
        subagent_id: src.subagent_id || undefined,
        cwd: src.cwd || undefined,
      };
    case 'tool_result':
      return {
        tool_id: src.tool_call_id || src.tool_id || src.id,
        ok: src.error ? false : (src.ok !== false),
        summary: typeof src.output === 'string'
          ? src.output.slice(0, 4096)
          : (src.summary || undefined),
        duration_ms: src.duration_ms || src.durationMs || undefined,
        output_truncated: typeof src.output === 'string' && src.output.length > 4096 ? true : undefined,
      };
    case 'thinking_delta':
      return { chunk: src.message || src.text || '' };
    case 'session_started':
      return {
        cwd: src.cwd,
        model: src.model,
        product: src.product,
        session_id_from_backend: src.session_id,
      };
    case 'agent_complete':
      return { ok: src.error == null, summary: src.summary, duration_ms: src.duration_ms };
    default:
      return src;
  }
}

// ── the tap ──────────────────────────────────────────────────────────

/**
 * Tap one SSE event to the PRD-092 event log.
 *
 * @param {{type: string, data?: object}} event  the SSE frame from stream-client
 * @param {object} opts
 * @param {string} opts.sessionId  from session.id — required for log routing
 * @param {string} [opts.turnId]   optional; stamped on turn-scoped events
 *
 * Failure modes are ALL silent — a broken tap must never affect the
 * user-facing render path. If the env var isn't set or sessionId is
 * missing we skip; if the file write throws internally, event-log.mjs
 * logs to stderr and drops the event.
 */
export function tapSseEvent(event, { sessionId, turnId } = {}) {
  if (!_enabled()) return;
  if (!event || !event.type || !sessionId) return;
  const prd092Type = SSE_TO_PRD092[event.type];
  if (!prd092Type) return;
  const log = _openLogFor(sessionId);
  const data = _projectData(prd092Type, event.data);
  try {
    log.writeEvent(prd092Type, data, turnId ? { turnId } : undefined);
  } catch (err) {
    try { process.stderr.write(`[event-tap] writeEvent failed: ${err.message}\n`); } catch {}
  }
}
