/**
 * Device pairing — pair this laptop with a phone or another device
 * for remote session monitoring.
 *
 * Two directions:
 *
 *   bahulam pair get-code [name]      Generate a fresh 6-digit code. *
 * Two directions:
 *
 *   bahulam pair get-code [name]      Ask the gateway for a fresh 6-digit
 *                                     code + expiry, print it. Give this
 *                                     to a NEW device (phone, other laptop)
 *                                     that will run `bahulam pair` with it.
 *
 *   bahulam pair <code>               Register THIS device by claiming the
 *                                     code. Generates a per-device Ed25519
 *                                     keypair, POSTs to /v1/devices/pair,
 *                                     stashes the returned device_id +
 *                                     peer pubkeys in ~/.bahulam/config.json.
 *
 * Storage (config.json.pairing):
 *   { device_id, device_name, private_key, public_key, paired_at,
 *     peer_pubkeys: { device_id: pubkey_base64, ... } }
 *
 * The private key never leaves the device. Key format is PEM (Node's
 * default for generateKeyPair) so we don't need any conversion library.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { promisify } from 'node:util';
import { TarangAuth } from '../auth/tarang-auth.mjs';

const GATEWAY = (process.env.BAHULAM_GATEWAY_URL || 'https://gateway.bahulam.ai').replace(/\/+$/, '').replace(/\/v1$/, '');
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

export async function runPairCommand(args = []) {
  const auth = new TarangAuth();
  const creds = auth.loadCredentials();
  if (!creds.token) {
    process.stderr.write(`${RED}Not logged in. Run ${BOLD}bahulam login${RESET}${RED} first.${RESET}\n`);
    return 1;
  }

  const sub = (args[0] || '').toLowerCase();
  if (sub === 'get-code') {
    return await _getCode(creds.token, args[1]);
  }
  if (sub === 'status') {
    return _status(auth);
  }
  if (/^\d{6}$/.test(sub)) {
    return await _claimCode(creds.token, sub, args[1] || _defaultDeviceName(), auth);
  }
  _usage();
  return 1;
}

function _usage() {
  process.stderr.write(`${BOLD}bahulam pair${RESET} ${DIM}— pair a device for remote monitoring${RESET}\n\n`);
  process.stderr.write(`  bahulam pair get-code [name]     Get a 6-digit code (share with new device)\n`);
  process.stderr.write(`  bahulam pair <code> [name]       Register THIS device using a 6-digit code\n`);
  process.stderr.write(`  bahulam pair status              Show current pairing state\n`);
}

async function _getCode(token, deviceName) {
  const name = deviceName || _defaultDeviceName();
  try {
    const res = await fetch(`${GATEWAY}/v1/devices/code`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_name: name }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      process.stderr.write(`${RED}Failed to get code (${res.status}): ${body}${RESET}\n`);
      return 1;
    }
    const { code, expires_at } = await res.json();
    process.stderr.write(`\n  ${CYAN}${BOLD}${code}${RESET}\n\n`);
    process.stderr.write(`  ${DIM}Enter this code on the other device with:${RESET}\n`);
    process.stderr.write(`    ${BOLD}bahulam pair ${code}${RESET}\n`);
    process.stderr.write(`  ${DIM}Or at ${GATEWAY.replace('gateway.', 'pair.')} (until ${expires_at})${RESET}\n\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${RED}Network error: ${err.message}${RESET}\n`);
    return 1;
  }
}

async function _claimCode(token, code, name, auth) {
  // Generate a per-device Ed25519 keypair. Node's built-in — no npm dep.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const pubkeyBase64 = _pemPubkeyToBase64Raw(publicKey);

  try {
    const res = await fetch(`${GATEWAY}/v1/devices/pair`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        device_pubkey: pubkeyBase64,
        device_name: name,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      process.stderr.write(`${RED}Pairing failed (${res.status}): ${body}${RESET}\n`);
      process.stderr.write(`${DIM}The code may be invalid, expired, or already claimed.${RESET}\n`);
      return 1;
    }
    const { device_id, peer_pubkeys } = await res.json();

    auth.saveCredentials({
      pairing: {
        device_id,
        device_name: name,
        private_key: privateKey,
        public_key: publicKey,
        pubkey_base64: pubkeyBase64,
        paired_at: new Date().toISOString(),
        peer_pubkeys: peer_pubkeys || {},
      },
    });

    process.stderr.write(`\n${GREEN}✓ device paired${RESET}\n`);
    process.stderr.write(`  ${DIM}id:${RESET}    ${device_id}\n`);
    process.stderr.write(`  ${DIM}name:${RESET}  ${name}\n`);
    const peers = Object.keys(peer_pubkeys || {});
    process.stderr.write(`  ${DIM}peers:${RESET} ${peers.length}${peers.length ? ` (${peers.join(', ')})` : ''}\n`);
    process.stderr.write(`\n  ${DIM}Next: ${BOLD}bahulam remote enable${RESET}${DIM} to connect this device to the relay.${RESET}\n\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${RED}Network error: ${err.message}${RESET}\n`);
    return 1;
  }
}

function _status(auth) {
  const config = auth.getRawConfig();
  const p = config.pairing;
  if (!p || !p.device_id) {
    process.stderr.write(`${DIM}not paired. Run ${BOLD}bahulam pair get-code${RESET}${DIM} on this device or ${BOLD}bahulam pair <code>${RESET}${DIM} with a code from another.${RESET}\n`);
    return 0;
  }
  process.stderr.write(`\n${BOLD}pairing${RESET}\n`);
  process.stderr.write(`  ${DIM}id:${RESET}    ${p.device_id}\n`);
  process.stderr.write(`  ${DIM}name:${RESET}  ${p.device_name}\n`);
  process.stderr.write(`  ${DIM}since:${RESET} ${p.paired_at}\n`);
  const peers = Object.keys(p.peer_pubkeys || {});
  process.stderr.write(`  ${DIM}peers:${RESET} ${peers.length}${peers.length ? ` (${peers.join(', ')})` : ''}\n\n`);
  return 0;
}

// ── helpers ──────────────────────────────────────────────────────────

function _defaultDeviceName() {
  const user = process.env.USER || process.env.USERNAME || 'user';
  const host = (process.env.HOSTNAME || os.hostname() || 'host').split('.')[0];
  return `${user}@${host}`;
}

// Convert a Node-exported Ed25519 PEM pubkey to the raw 32-byte base64
// form the gateway stores. Node ships it wrapped in an SPKI DER; we
// strip the SPKI header prefix to get the raw pubkey bytes.
// SPKI Ed25519 header: 30 2a 30 05 06 03 2b 65 70 03 21 00 (12 bytes),
// followed by the 32-byte raw pubkey.
function _pemPubkeyToBase64Raw(pemStr) {
  const derBase64 = pemStr
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Buffer.from(derBase64, 'base64');
  // Strip the 12-byte SPKI Ed25519 header. If length isn't 44 (12+32),
  // fall back to sending the full DER base64 — the gateway just stores
  // it opaquely — the raw-vs-SPKI decision is a future
  // (session key wrap) concern anyway.
  if (der.length === 44) return der.slice(12).toString('base64');
  return derBase64;
}
