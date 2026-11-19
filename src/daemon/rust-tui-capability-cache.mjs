// Renderer-only, process-local cache. Never persist terminal replies to sessions.
import { createHash } from 'node:crypto';

const entries = new Map();
const TTL = 5 * 60_000;
const booleanFields = ['synchronized_output', 'focus_reporting', 'mouse_sgr',
  'bracketed_paste', 'keyboard_protocol', 'sixel'];

export function terminalIdentity(env) {
  // Transport identities separate remote/multiplexed terminals. Only the hash
  // is retained; addresses and socket paths are never reported to the UI.
  return createHash('sha256').update(JSON.stringify([
    process.platform, ...['TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
      'TMUX', 'STY', 'SSH_TTY', 'SSH_CONNECTION', 'WT_SESSION'].map(key => env[key] || ''),
  ])).digest('hex');
}

export function cachedCapabilities(identity, now = Date.now()) {
  const entry = entries.get(identity);
  if (!entry || now - entry.time >= TTL || now < entry.time) {
    entries.delete(identity);
    return '';
  }
  return JSON.stringify(entry.probe);
}

export function rememberCapabilities(identity, probe, now = Date.now()) {
  if (probe?.complete !== true || probe.status !== 'active (DA1 received)') return;
  if (booleanFields.some(key => probe[key] != null && typeof probe[key] !== 'boolean')) return;
  // Background and geometry are transient, even when identity/version is stable.
  const safe = { complete: true, ...Object.fromEntries(booleanFields.map(key => [key, probe[key] ?? null])) };
  entries.delete(identity);
  entries.set(identity, { time: now, probe: safe });
  if (entries.size > 8) entries.delete(entries.keys().next().value);
}
