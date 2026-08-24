/**
 * Device inventory and revocation.
 *
 *   bahulam device list             List all paired devices for this user.
 *   bahulam device revoke <id>      Revoke a device (kill switch).
 *                                    Revoked devices are dropped within *                                    revoking itself remotely.
 *
 *   bahulam device whoami           Print this device's registered id +
 *                                    pubkey (for cross-checking with
 *                                    `bahulam device list`).
 */

import { TarangAuth } from '../auth/tarang-auth.mjs';

const GATEWAY = (process.env.BAHULAM_GATEWAY_URL || 'https://gateway.bahulam.ai').replace(/\/+$/, '').replace(/\/v1$/, '');
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

export async function runDeviceCommand(args = []) {
  const sub = (args[0] || '').toLowerCase();
  const auth = new TarangAuth();
  const creds = auth.loadCredentials();
  if (!creds.token) {
    process.stderr.write(`${RED}Not logged in. Run ${BOLD}bahulam login${RESET}${RED} first.${RESET}\n`);
    return 1;
  }

  if (sub === 'list')   return await _list(creds.token, auth);
  if (sub === 'revoke') return await _revoke(creds.token, args[1], auth);
  if (sub === 'whoami') return _whoami(auth);

  process.stderr.write(`${BOLD}bahulam device${RESET} ${DIM}— list and revoke paired devices${RESET}\n\n`);
  process.stderr.write(`  bahulam device list             List paired devices\n`);
  process.stderr.write(`  bahulam device revoke <id>      Revoke a device (kill switch)\n`);
  process.stderr.write(`  bahulam device whoami           Show this device's registered id\n`);
  return 1;
}

async function _list(token, auth) {
  try {
    const res = await fetch(`${GATEWAY}/v1/devices`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      process.stderr.write(`${RED}Failed to list devices (${res.status}): ${body}${RESET}\n`);
      return 1;
    }
    const { devices } = await res.json();
    if (!devices || devices.length === 0) {
      process.stderr.write(`${DIM}No paired devices.${RESET}\n`);
      return 0;
    }
    const self = auth.getRawConfig()?.pairing?.device_id || '';
    process.stderr.write(`\n${BOLD}${devices.length} device(s)${RESET}\n`);
    for (const d of devices) {
      const badge = d.device_id === self ? ` ${GREEN}(this)${RESET}` : '';
      const status = d.status === 'active' ? GREEN + 'active' + RESET : RED + 'revoked' + RESET;
      const seen = d.last_seen_at ? `last seen ${d.last_seen_at}` : `paired ${d.created_at}`;
      process.stderr.write(`  ${d.device_id}${badge}  ${status}  ${BOLD}${d.name}${RESET}  ${DIM}${seen}${RESET}\n`);
    }
    process.stderr.write('\n');
    return 0;
  } catch (err) {
    process.stderr.write(`${RED}Network error: ${err.message}${RESET}\n`);
    return 1;
  }
}

async function _revoke(token, deviceId, auth) {
  if (!deviceId) {
    process.stderr.write(`Usage: ${BOLD}bahulam device revoke <device_id>${RESET}\n`);
    process.stderr.write(`${DIM}Run ${BOLD}bahulam device list${RESET}${DIM} to see ids.${RESET}\n`);
    return 1;
  }
  try {
    const res = await fetch(`${GATEWAY}/v1/devices/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      process.stderr.write(`${RED}Revoke failed (${res.status}): ${body}${RESET}\n`);
      return 1;
    }
    process.stderr.write(`${GREEN}✓ revoked${RESET} ${deviceId}\n`);
    // If revoking self, clear local pairing so the daemon doesn't keep
    // trying to reconnect with a dead key.
    const self = auth.getRawConfig()?.pairing?.device_id;
    if (self === deviceId) {
      auth.saveCredentials({
        pairing: null,
        remote: { ...(auth.getRawConfig()?.remote || {}), enabled: false },
      });
      process.stderr.write(`${YELLOW}⚠ this was THIS device; local pairing + remote both cleared.${RESET}\n`);
    }
    process.stderr.write(`${DIM}Relay drops the revoked connection within one heartbeat.${RESET}\n\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${RED}Network error: ${err.message}${RESET}\n`);
    return 1;
  }
}

function _whoami(auth) {
  const p = auth.getRawConfig()?.pairing;
  if (!p?.device_id) {
    process.stderr.write(`${DIM}not paired.${RESET} Run ${BOLD}bahulam pair get-code${RESET}${DIM} on this device.${RESET}\n`);
    return 0;
  }
  process.stderr.write(`  ${DIM}device_id:${RESET} ${p.device_id}\n`);
  process.stderr.write(`  ${DIM}name:${RESET}      ${p.device_name}\n`);
  process.stderr.write(`  ${DIM}pubkey:${RESET}    ${(p.pubkey_base64 || '').slice(0, 32)}…\n`);
  process.stderr.write(`  ${DIM}paired_at:${RESET} ${p.paired_at}\n`);
  return 0;
}
