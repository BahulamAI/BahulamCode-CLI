/**
 * Local machine identity and loopback enforcement.
 *
 * The local service is meant for browser + CLI on the same machine. It never
 * binds to a LAN interface, and every request is checked for loopback origin.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { localServiceRoot } from './paths.mjs';

const MACHINE_FILE = 'machine.json';

export function getLocalMachineIdentity() {
  const file = path.join(localServiceRoot(), MACHINE_FILE);
  try {
    const existing = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (existing?.id) return existing;
  } catch {}

  const identity = {
    id: `mach_${crypto.randomBytes(12).toString('hex')}`,
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    created_at: new Date().toISOString(),
  };
  fs.mkdirSync(localServiceRoot(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  return identity;
}

export function normalizeLoopbackHost(host = '127.0.0.1') {
  const value = String(host || '127.0.0.1').trim().toLowerCase();
  if (value === '127.0.0.1' || value === 'localhost') return '127.0.0.1';
  if (value === '::1' || value === '[::1]') return '::1';
  const err = new Error('Local service can only bind to loopback hosts: 127.0.0.1, localhost, or ::1');
  err.code = 'LOCAL_ONLY';
  throw err;
}

export function loopbackHostForUrl(host) {
  return host === '::1' ? '[::1]' : host;
}

export function assertLoopbackRequest(req) {
  const remoteAddress = req.socket?.remoteAddress || '';
  const hostHeader = parseHostHeader(req.headers.host || '');

  if (!isLoopbackAddress(remoteAddress)) {
    const err = new Error(`Rejected non-local request from ${remoteAddress || 'unknown address'}`);
    err.code = 'LOCAL_ONLY';
    throw err;
  }

  if (hostHeader && !isLoopbackHostHeader(hostHeader)) {
    const err = new Error(`Rejected non-local Host header: ${hostHeader}`);
    err.code = 'LOCAL_ONLY';
    throw err;
  }
}

export function isLoopbackAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  if (value === 'localhost' || value === '::1') return true;
  if (value.startsWith('127.')) return true;
  if (value.startsWith('::ffff:127.')) return true;
  return false;
}

function isLoopbackHostHeader(host) {
  const value = String(host || '').trim().toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
}

function parseHostHeader(hostHeader) {
  const value = String(hostHeader || '').trim();
  if (!value) return '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value.toLowerCase() : value.slice(0, end + 1).toLowerCase();
  }
  return value.split(':')[0].toLowerCase();
}
