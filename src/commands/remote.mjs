/**
 * PRD-092 Slice I — Remote relay control (client side).
 *
 *   bahulam remote enable    Turn on the daemon → relay outbound connect.
 *                            Flips config.remote.enabled = true. The
 *                            daemon (once running) checks this flag on
 *                            each session_info to decide whether to dial
 *                            wss://relay.bahulam.ai (Slice H).
 *
 *   bahulam remote disable   Kill switch. Flips config.remote.enabled =
 *                            false. Any running daemon drops its relay
 *                            connection within one heartbeat (Slice H
 *                            polls this flag).
 *
 *   bahulam remote status    Print current state: enabled flag, paired
 *                            device id, relay URL, last connect time
 *                            (if the daemon reported it).
 *
 * IMPORTANT: this command only flips a flag. The actual relay dial +
 * disconnect lives in the daemon (Slice H's relay-client.mjs). Enabling
 * remote WITHOUT first running `bahulam pair` is meaningless — the
 * daemon needs a device_id + keypair to authenticate to the relay.
 */

import { TarangAuth } from '../auth/tarang-auth.mjs';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

const DEFAULT_RELAY = (process.env.BAHULAM_RELAY_URL || 'wss://relay.bahulam.ai').replace(/\/+$/, '');

export async function runRemoteCommand(args = []) {
  const sub = (args[0] || '').toLowerCase();
  const auth = new TarangAuth();
  auth.loadCredentials();

  if (sub === 'enable')  return _enable(auth);
  if (sub === 'disable') return _disable(auth);
  if (sub === 'status')  return _status(auth);

  process.stderr.write(`${BOLD}bahulam remote${RESET} ${DIM}— PRD-092 relay control${RESET}\n\n`);
  process.stderr.write(`  bahulam remote enable    Connect the daemon to the relay for remote monitoring/control\n`);
  process.stderr.write(`  bahulam remote disable   Kill switch — drops relay connection within one heartbeat\n`);
  process.stderr.write(`  bahulam remote status    Show current remote-connection state\n`);
  return 1;
}

function _enable(auth) {
  const config = auth.getRawConfig();
  if (!config.pairing?.device_id) {
    process.stderr.write(`${YELLOW}⚠ this device is not paired yet.${RESET}\n`);
    process.stderr.write(`  ${DIM}Run ${BOLD}bahulam pair get-code${RESET}${DIM} (this device) or ${BOLD}bahulam pair <code>${RESET}${DIM} (with a code).${RESET}\n`);
    process.stderr.write(`  ${DIM}Enable will still write the flag, but the daemon can't connect without a device.${RESET}\n\n`);
  }
  auth.saveCredentials({
    remote: {
      enabled: true,
      relay_url: config.remote?.relay_url || DEFAULT_RELAY,
      enabled_at: new Date().toISOString(),
    },
  });
  process.stderr.write(`${GREEN}✓ remote enabled${RESET}\n`);
  process.stderr.write(`  ${DIM}relay:${RESET}  ${config.remote?.relay_url || DEFAULT_RELAY}\n`);
  process.stderr.write(`  ${DIM}A running daemon will pick this up on next session start.${RESET}\n\n`);
  return 0;
}

function _disable(auth) {
  const config = auth.getRawConfig();
  auth.saveCredentials({
    remote: {
      ...(config.remote || {}),
      enabled: false,
      disabled_at: new Date().toISOString(),
    },
  });
  process.stderr.write(`${GREEN}✓ remote disabled${RESET} ${DIM}(kill switch)${RESET}\n`);
  process.stderr.write(`  ${DIM}Any running daemon drops its relay connection within one heartbeat.${RESET}\n\n`);
  return 0;
}

function _status(auth) {
  const config = auth.getRawConfig();
  const r = config.remote || {};
  const p = config.pairing || {};
  process.stderr.write(`\n${BOLD}remote${RESET}\n`);
  process.stderr.write(`  ${DIM}enabled:${RESET} ${r.enabled ? GREEN + 'yes' + RESET : DIM + 'no' + RESET}\n`);
  process.stderr.write(`  ${DIM}relay:${RESET}   ${r.relay_url || DEFAULT_RELAY}\n`);
  if (r.enabled_at)  process.stderr.write(`  ${DIM}since:${RESET}   ${r.enabled_at}\n`);
  if (r.disabled_at && !r.enabled) process.stderr.write(`  ${DIM}stopped:${RESET} ${r.disabled_at}\n`);
  process.stderr.write(`  ${DIM}device:${RESET}  ${p.device_id ? `${p.device_id} (${p.device_name})` : DIM + 'not paired' + RESET}\n\n`);
  return 0;
}

/**
 * Read-only helper for the daemon (Slice H). Returns the effective
 * remote config: { enabled, relay_url, device_id, private_key,
 * public_key, peer_pubkeys } — or null if we shouldn't dial.
 */
export function loadRemoteConfig() {
  const auth = new TarangAuth();
  const config = auth.getRawConfig() || auth.loadCredentials() && auth.getRawConfig();
  if (!config?.remote?.enabled) return null;
  if (!config?.pairing?.device_id) return null;
  return {
    enabled: true,
    relay_url: config.remote.relay_url || DEFAULT_RELAY,
    device_id: config.pairing.device_id,
    private_key: config.pairing.private_key,
    public_key: config.pairing.public_key,
    pubkey_base64: config.pairing.pubkey_base64,
    peer_pubkeys: config.pairing.peer_pubkeys || {},
    token: auth.loadCredentials().token,
  };
}
