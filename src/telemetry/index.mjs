/**
 * Telemetry — Funnel event emitter (PRD-076 W3).
 *
 * Buffers funnel events and flushes to {backend}/api/telemetry/funnel
 * on a timer and on process exit. Device ID is generated once per install
 * for anon-to-logged-in correlation.
 *
 * Opt-out: BAHULAM_DISABLE_TELEMETRY=1 or CLAUDE_CODE_DISABLE_TELEMETRY=1
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { bahulamHome } from '../core/paths.mjs';

const BUF_LIMIT = 500;
const FLUSH_INTERVAL_MS = 30_000;

let events = [];
let enabled = true;
let flushTimer = null;
let _backendUrl = null;
let _token = null;
let _deviceId = null;

/* ── Configuration ── */

export function disable() {
  enabled = false;
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
}

export function configure(backendUrl, token) {
  _backendUrl = backendUrl;
  _token = token;
}

/* ── Device ID ── */

function readOrCreateDeviceId() {
  const dir = bahulamHome();
  const idPath = path.join(dir, 'device_id');
  try {
    if (fs.existsSync(idPath)) {
      return fs.readFileSync(idPath, 'utf-8').trim();
    }
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = crypto.randomUUID();
    fs.writeFileSync(idPath, id, { mode: 0o600 });
    return id;
  } catch { return 'unknown'; }
}

export function getDeviceId() {
  if (!_deviceId) _deviceId = readOrCreateDeviceId();
  return _deviceId;
}

/* ── Tracking ── */

export function track(event, properties = {}) {
  if (!enabled) return;
  if (process.env.BAHULAM_DISABLE_TELEMETRY === '1') return;
  if (process.env.CLAUDE_CODE_DISABLE_TELEMETRY === '1') return;

  const entry = { event, properties: { ...properties }, device_id: getDeviceId(), timestamp: Date.now() };
  events.push(entry);
  if (events.length > BUF_LIMIT) events.splice(0, events.length - BUF_LIMIT);

  if (process.env.BAHULAM_DEBUG_TELEMETRY) {
    process.stderr.write(`[telemetry] ${event} ${JSON.stringify(properties).slice(0, 200)}\n`);
  }

  if (!flushTimer) {
    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
    flushTimer.unref();
  }
}

export function trackTiming(event, durationMs, properties = {}) {
  track(event, { ...properties, durationMs });
}

export function trackError(event, error) {
  track(`error.${event}`, { message: error.message, stack: error.stack?.split('\n').slice(0, 3).join('\n') });
}

/* ── Transport ── */

export async function flush() {
  if (!enabled || events.length === 0 || !_backendUrl) return;
  const batch = events.splice(0);
  const headers = { 'Content-Type': 'application/json' };
  if (_token) headers['Authorization'] = `Bearer ${_token}`;
  try {
    const resp = await fetch(`${_backendUrl}/api/telemetry/funnel`, {
      method: 'POST', headers,
      body: JSON.stringify({
        events: batch,
        user_id: _token ? undefined : undefined, // backend derives from token if present
        source: 'cli',
      }),
    });
    if (!resp.ok && resp.status >= 500) events.unshift(...batch);
  } catch { events.unshift(...batch); if (events.length > BUF_LIMIT * 2) events.splice(0, events.length - BUF_LIMIT); }
}

export async function shutdown() {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  await flush();
}

/* ── Debug ── */

export function getEvents() { return [...events]; }
export function clear() { events.length = 0; }
export function setEnabled(value) { enabled = value; }
export function getStats() {
  const counts = {};
  for (const e of events) counts[e.event] = (counts[e.event] || 0) + 1;
  return { totalEvents: events.length, enabled, eventCounts: counts };
}