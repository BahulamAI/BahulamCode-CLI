/**
 * PRD-092 Slice M — session_directory publisher (daemon side).
 *
 * POSTs to the gateway's /v1/session-directory endpoint on session
 * lifecycle transitions so mobile clients + the web dashboard can see
 * daemons that aren't currently connected to the relay.
 *
 * The gateway's /relay/sessions endpoint shows LIVE relay connections
 * (in-memory hub state). This publisher covers the gap: daemons that
 * started, ran, and now sit idle waiting for input still appear.
 *
 * Fire-and-forget: a publish failure MUST NOT interrupt the turn or
 * crash the daemon. Errors log to stderr and the next transition retries.
 *
 * Called by:
 *   - src/core/headless.mjs on session_info (status=running)
 *   - src/core/headless.mjs on agent_complete (status=idle if held,
 *                                              closed if exiting)
 *   - src/terminal/repl.mjs on session_info (running) and REPL exit (closed)
 *
 * We hit the GATEWAY (BAHULAM_GATEWAY_URL) rather than Supabase directly
 * because (a) the daemon has a Bahulam bearer token, not a Supabase
 * JWT, and (b) the gateway already knows how to resolve that bearer to
 * a user_id via /internal/whoami. Same trust chain as pair/device/remote.
 */

import * as os from 'node:os';

const GATEWAY = (process.env.BAHULAM_GATEWAY_URL || 'https://gateway.bahulam.ai').replace(/\/+$/, '').replace(/\/v1$/, '');

/** One publish. Returns nothing; errors log to stderr. */
export async function publishSessionDirectory({
  sessionId,
  token,
  cwd = null,
  model = null,
  hostHint = null,
  status = 'running',
  origin = 'local',
} = {}) {
  if (!sessionId || !token) return;
  try {
    const res = await fetch(`${GATEWAY}/v1/session-directory`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session_id: sessionId,
        origin,
        host_hint: hostHint || _defaultHostHint(),
        cwd_display: cwd,
        model,
        status,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      try { process.stderr.write(`[session-directory] publish ${status} failed (${res.status}): ${body.slice(0, 200)}\n`); } catch {}
    }
  } catch (err) {
    try { process.stderr.write(`[session-directory] network error: ${err.message}\n`); } catch {}
  }
}

/** Convenience: mark a session closed. Best-effort; call from exit paths. */
export async function markSessionClosed({ sessionId, token }) {
  return publishSessionDirectory({ sessionId, token, status: 'closed' });
}

function _defaultHostHint() {
  try {
    const user = process.env.USER || process.env.USERNAME || 'user';
    const host = (os.hostname() || 'host').split('.')[0];
    return `${user}@${host}`;
  } catch { return 'unknown'; }
}
