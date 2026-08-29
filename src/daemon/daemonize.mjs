/**
 * . — auto-daemon spawn + start-or-attach.
 *
 * Two entrypoints:
 *
 *   spawnDetachedDaemon(cwd, {prompt, extraEnv})
 *     Forks a background bahulam child, detached from the current
 *     terminal, with BAHULAM_DAEMON_EVENTLOG=1 forced so it starts a
 *     socket server on session_info. Returns { pid, waitForSession() }
 *     — the parent can await a session_id becoming visible in
 *     ~/.bahulam/sessions/, or exit immediately (typical case: user
 *     types `bahulam daemonize "fix this bug"`, we spawn + print the
 *     session id + exit; they attach later with `bahulam attach <id>`).
 *
 *   findSessionForCwd(cwd)
 *     Scans ~/.bahulam/sessions/<id>/meta.json for entries where meta.cwd
 *     matches (after realpath), and where the pid is still alive and
 *     the socket file exists. Returns the newest such session id or null.
 *     Used by `bahulam` (no args) to decide start-vs-attach.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { daemonSessionsRoot, daemonSocketPath } from '../core/paths.mjs';

const POLL_INTERVAL_MS = 100;
const DEFAULT_WAIT_MS = 15_000;

/**
 * Look for a live daemon session bound to `cwd`. A session is "live" if:
 *   1. `~/.bahulam/sessions/<id>/meta.json` has `cwd` matching (realpath).
 *   2. `~/.bahulam/sockets/<id>.sock` exists.
 *   3. `meta.pid` is alive (`kill -0` succeeds — we don't send SIGTERM,
 *      just probe existence with signal 0).
 *
 * Returns the newest matching session id or null. Newest = highest
 * `opened_at` in meta.json (falls back to directory mtime).
 */
export async function findSessionForCwd(cwd) {
  const root = daemonSessionsRoot();
  let target;
  try { target = fs.realpathSync(cwd); } catch { target = cwd; }

  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return null; }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('sess_')) continue;
    const sid = entry.name;
    const dir = path.join(root, sid);
    let meta;
    try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf-8')); }
    catch { continue; }
    if (!meta.cwd) continue;
    let metaCwd;
    try { metaCwd = fs.realpathSync(meta.cwd); } catch { metaCwd = meta.cwd; }
    if (metaCwd !== target) continue;
    if (!fs.existsSync(daemonSocketPath(sid))) continue;
    if (!_pidAlive(meta.pid)) continue;
    candidates.push({ sid, openedAt: meta.opened_at || '', pid: meta.pid });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.openedAt || '').localeCompare(a.openedAt || ''));
  return candidates[0].sid;
}

/**
 * Spawn a detached bahulam child. The child inherits nothing on stdio
 * (piped to /dev/null via 'ignore') — it lives in the background,
 * writes its transcript to the event log, and any attach client renders
 * from there.
 *
 * Returns { pid, waitForSession(ms?) → sess_id | null }. Caller can
 * await the session_id becoming visible before exiting the parent so
 * the printed "sess_..." line isn't stale.
 */
export function spawnDetachedDaemon({
  cwd = process.cwd(),
  prompt = null,
  binPath = process.argv[1],   // the bahulam entrypoint that spawned US
  extraEnv = {},
} = {}) {
  const beforeSet = _listCurrentSessionsSync();

  const env = {
    ...process.env,
    BAHULAM_DAEMON_EVENTLOG: '1',
    // Spawned children auto-quit after the first turn's agent_complete
    // unless the operator opts into idle-hold. Cheap default that
    // matches the "bahulam daemonize <prompt>; check back later"
    // mental model. Override with BAHULAM_DAEMON_HOLD=1 to keep the
    // socket up for follow-up send_message commands.
    BAHULAM_DAEMON_SPAWNED: '1',
    ...extraEnv,
  };
  if (prompt) env.BAHULAM_DAEMON_INITIAL_PROMPT = String(prompt);

  const child = spawn(process.execPath, [binPath], {
    cwd,
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();  // parent can exit without waiting on child

  return {
    pid: child.pid,
    async waitForSession(ms = DEFAULT_WAIT_MS) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        // Find a session_id that's NEW since we spawned + belongs to our cwd.
        const now = _listCurrentSessionsSync();
        for (const sid of now) {
          if (beforeSet.has(sid)) continue;
          const dir = path.join(daemonSessionsRoot(), sid);
          try {
            const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'));
            if (meta.pid === child.pid) return sid;
            // pid mismatch is fine early — the daemon may not have written
            // meta.json yet; keep polling.
          } catch { /* not written yet */ }
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }
      return null;
    },
  };
}

// ── internals ────────────────────────────────────────────────────────

function _pidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) {
    // EPERM = process exists but we can't signal it → still alive.
    return err && err.code === 'EPERM';
  }
}

function _listCurrentSessionsSync() {
  try {
    const root = daemonSessionsRoot();
    const entries = fs.readdirSync(root, { withFileTypes: true });
    return new Set(entries.filter(e => e.isDirectory() && e.name.startsWith('sess_')).map(e => e.name));
  } catch { return new Set(); }
}
