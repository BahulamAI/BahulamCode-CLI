/**
 * Relay WebSocket client — connects to the gateway relay and routes
 * session events to attached CLI clients.
 *
 * On connect the client authenticates with a bearer token, then
 * registers as a device on each active session. Events from the
 * relay are dispatched to the appropriate session handler. *   • Heartbeat / keepalive via WebSocket ping (20s).
 *   • Kill-switch check: BAHULAM_RELAY_KILL=1 env var, plus config
 *     `remote.enabled = false` polled every 10s from the file so
 *     `bahulam remote disable` in another terminal drops us fast.
 *
 * Deferred (Phase 2.5):
 *   • ChaCha20-Poly1305 AEAD payload encryption. My envelope shape is
 *     already compatible — swap the `control` field for `aead: {...}`
 *     without changing the transport.
 *   • X25519 wrap key derivation from paired peer_pubkeys.
 *   • Signed command verification (Ed25519 signatures INSIDE the aead
 *     payload per PRD §4).
 *   • Session-key rotation.
 *
 * Non-fatal design principle: any relay error MUST NOT affect the local
 * session. If the relay is down / unreachable / kicks us, the daemon
 * keeps running for local attaches. Reconnect quietly in the background.
 */

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';

const HEARTBEAT_MS = 20_000;
const REVOKE_POLL_MS = 10_000;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 30_000;

/**
 * Start the relay bridge for a session. Returns { stop } — call to
 * cleanly disconnect. Safe to call even without a valid config; if
 * `remote.enabled = false` we log a note and return a stop() no-op.
 *
 * @param {object} opts
 * @param {string}   opts.sessionId
 * @param {object}   opts.remoteConfig    — from remote.mjs loadRemoteConfig()
 * @param {Function} opts.registerBroadcaster — from event-tap.mjs
 * @param {object}   opts.onCommand       — { approve, deny, interrupt, send_message, ... }
 *                                            same shape as socket-server's onCommand.
 */
export function startRelayBridge({ sessionId, remoteConfig, registerBroadcaster, onCommand = {} } = {}) {
  if (!remoteConfig?.enabled) {
    return { stop: async () => {} };
  }
  if (!remoteConfig.device_id || !remoteConfig.token) {
    process.stderr.write(`${YELLOW}[relay] remote enabled but device or token missing — skipping.${RESET}\n`);
    return { stop: async () => {} };
  }
  if (typeof globalThis.WebSocket !== 'function') {
    process.stderr.write(`${YELLOW}[relay] WebSocket not available in this Node runtime (need ≥22). Skipping.${RESET}\n`);
    return { stop: async () => {} };
  }

  const url = _buildUrl(remoteConfig.relay_url, sessionId, remoteConfig.device_id, remoteConfig.token);
  const state = {
    stopped: false,
    ws: null,
    reconnectAttempt: 0,
    heartbeatTimer: null,
    revokeTimer: null,
    unregisterBroadcaster: null,
  };

  function _log(msg) {
    try { process.stderr.write(`${DIM}[relay] ${msg}${RESET}\n`); } catch {}
  }

  function _envelope(controlBody, to = 'session') {
    return JSON.stringify({
      v: 1,
      sess: sessionId,
      from: remoteConfig.device_id,
      to,
      // No AEAD until Phase 2.5 — send as a `control` field which
      // gateway's relay.py forwards untouched (see routes/relay.py:_send_envelope).
      // Payload is one  event/command exactly as it would appear
      // on the local socket, but plaintext for now.
      control: controlBody,
    });
  }

  function _send(controlBody) {
    if (!state.ws || state.ws.readyState !== 1 /* OPEN */) return false;
    try { state.ws.send(_envelope(controlBody)); return true; }
    catch (err) { _log(`send failed: ${err.message}`); return false; }
  }

  function _connect() {
    if (state.stopped) return;
    if (process.env.BAHULAM_RELAY_KILL === '1') {
      _log('BAHULAM_RELAY_KILL=1 — refusing to dial');
      return;
    }
    _log(`dial ${url.replace(/token=[^&]+/, 'token=***')}`);
    const ws = new WebSocket(url, ['bahulam.v1']);
    state.ws = ws;

    ws.addEventListener('open', () => {
      state.reconnectAttempt = 0;
      try { process.stderr.write(`${GREEN}[relay] connected${RESET}\n`); } catch {}
      // Send a `daemon_hello` control frame so peers (mobile) know who joined.
      _send({ type: 'daemon_hello', device_id: remoteConfig.device_id, session_id: sessionId });
      _startHeartbeat();
      _startRevokePoll();
    });

    ws.addEventListener('message', ev => {
      let env;
      try { env = JSON.parse(String(ev.data)); }
      catch { return; }
      // Ignore our own broadcasts echoed back.
      if (env.from === remoteConfig.device_id) return;
      const control = env.control;
      if (!control || !control.type) return;
      _dispatchIncoming(control, env.from);
    });

    ws.addEventListener('close', ev => {
      _stopHeartbeat();
      state.ws = null;
      if (state.stopped) return;
      // Codes: 1008 policy (bad auth / bad envelope) → don't reconnect.
      if (ev && (ev.code === 1008 || ev.code === 4001 || ev.code === 4003)) {
        _log(`closed with policy code ${ev.code} (${ev.reason || 'no reason'}) — not reconnecting`);
        return;
      }
      _scheduleReconnect(ev?.code);
    });

    ws.addEventListener('error', err => {
      _log(`ws error: ${err?.message || err}`);
      // 'close' will fire after, which triggers reconnect.
    });
  }

  function _scheduleReconnect(closeCode) {
    if (state.stopped) return;
    state.reconnectAttempt += 1;
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, state.reconnectAttempt - 1));
    const jitter = base * 0.5 * (Math.random() - 0.5);  // ±25%
    const wait = Math.max(BACKOFF_BASE_MS, Math.floor(base + jitter));
    _log(`reconnect in ${wait}ms (attempt ${state.reconnectAttempt}${closeCode ? `, close ${closeCode}` : ''})`);
    setTimeout(() => { if (!state.stopped) _connect(); }, wait);
  }

  function _startHeartbeat() {
    _stopHeartbeat();
    state.heartbeatTimer = setInterval(() => {
      // WebSocket doesn't have a JS-level ping in the browser API. Send a
      // small control-frame keepalive instead. Gateway routes as any other
      // envelope; peer clients can ignore type=keepalive.
      _send({ type: 'keepalive', ts: Date.now() });
    }, HEARTBEAT_MS);
    if (typeof state.heartbeatTimer.unref === 'function') state.heartbeatTimer.unref();
  }

  function _stopHeartbeat() {
    if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
  }

  function _startRevokePoll() {
    _stopRevokePoll();
    state.revokeTimer = setInterval(() => {
      // Re-read the local config; if remote was disabled or the device
      // is missing, drop the connection. Fast reaction to `bahulam remote
      // disable` in another terminal, or to `bahulam device revoke <self>`
      // which clears the pairing block.
      try {
        const fresh = _reloadConfig();
        if (!fresh?.enabled || fresh?.device_id !== remoteConfig.device_id) {
          _log('local config changed (disabled or device mismatch) — disconnecting');
          stop();
        }
      } catch { /* ignore, next poll retries */ }
    }, REVOKE_POLL_MS);
    if (typeof state.revokeTimer.unref === 'function') state.revokeTimer.unref();
  }

  function _stopRevokePoll() {
    if (state.revokeTimer) { clearInterval(state.revokeTimer); state.revokeTimer = null; }
  }

  function _dispatchIncoming(control, fromDevice) {
    const handler = onCommand[control.type];
    if (typeof handler !== 'function') {
      _log(`unknown control type from ${fromDevice}: ${control.type}`);
      return;
    }
    // Pass fromDevice as the attach id so decisions get attributed.
    Promise.resolve()
      .then(() => handler(control.data || {}, `relay:${fromDevice}`))
      .catch(err => _log(`handler for ${control.type} failed: ${err.message}`));
  }

  async function stop() {
    if (state.stopped) return;
    state.stopped = true;
    _stopHeartbeat();
    _stopRevokePoll();
    if (state.unregisterBroadcaster) { try { state.unregisterBroadcaster(); } catch {} }
    if (state.ws) {
      try { state.ws.close(1000, 'client_stop'); } catch {}
      state.ws = null;
    }
  }

  // Register a broadcaster that forwards every daemon event to the relay.
  // Return the unregister so stop() can clean up.
  if (typeof registerBroadcaster === 'function') {
    state.unregisterBroadcaster = registerBroadcaster(evt => {
      // Forward every event as a control-frame envelope so mobile sees
      // the same  §5.1 shape it does from the mock relay.
      _send(evt);
    });
  }

  _connect();
  return { stop, _debug: state };
}

// ── helpers ──────────────────────────────────────────────────────────

function _buildUrl(relayBase, sessionId, deviceId, token) {
  // relay_url from config is like "wss://relay.bahulam.ai" or
  // "wss://gateway.bahulam.ai" (the router mounts /relay/*). We append
  // /relay/session/<sess_id>?device=&token= regardless.
  const base = String(relayBase || '').replace(/\/+$/, '');
  const enc = encodeURIComponent;
  return `${base}/relay/session/${enc(sessionId)}?device=${enc(deviceId)}&token=${enc(token)}`;
}

// Re-read the config from disk on each poll so the daemon reacts to
// out-of-band changes (bahulam remote disable, bahulam device revoke)
// without needing a signal. Lazy dynamic import: cache the resolved
// loader function so subsequent polls are one function call each.
let _loadRemoteConfigCached = null;
let _loadRemoteConfigPromise = null;

function _reloadConfig() {
  if (_loadRemoteConfigCached) return _loadRemoteConfigCached();
  // First call: kick off the import in the background. Subsequent polls
  // pick up the cached function once it's resolved. This poll returns
  // null in the meantime (no config → stay connected, which is safe;
  // the next poll in 10s will have the loader ready).
  if (!_loadRemoteConfigPromise) {
    _loadRemoteConfigPromise = import('../commands/remote.mjs')
      .then(mod => { _loadRemoteConfigCached = mod.loadRemoteConfig || (() => null); })
      .catch(() => { _loadRemoteConfigCached = () => null; });
  }
  return null;
}
