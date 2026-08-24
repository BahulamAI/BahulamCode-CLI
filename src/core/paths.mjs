/**
 * Bahulam Code Paths — centralized path resolution for all CLI data.
 *
 * Everything lives under ~/.bahulam/:
 *   ~/.bahulam/
 *     config.json              — auth credentials + settings
 *     history.jsonl            — prompt history
 *     hooks.json               — global hooks
 *     conversations/           — conversation JSONL files
 *     projects/
 *       {hash}/                — per-project data (hash of project path)
 *         index/               — BM25 search index
 *         checkpoints/         — file undo checkpoints
 *         state.json           — current session state
 *         sessions/            — session metadata archive
 *         hooks.json           — project-specific hooks
 *     projects.json            — slug → project path mapping
 *
 * ── Legacy fallback ─────────────────────────────────────────────────────
 * Pre-rename installs stored everything under ~/.kepler/. The resolver below
 * prefers the new path but falls back to the legacy directory when it
 * exists and the new one doesn't, so existing users keep their config,
 * agents, workflows, and history until they explicitly migrate.
 *
 * Env vars:
 *   BAHULAM_HOME  preferred; explicit override for ~/.bahulam
 *   KEPLER_HOME   legacy; still honored for backward compat
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

const NEW_HOME_NAME = '.bahulam';
const LEGACY_HOME_NAME = '.kepler';

let _legacyNoticeShown = false;

/**
 * Resolve the CLI home directory. Priority:
 *   1. $BAHULAM_HOME (explicit new)
 *   2. $KEPLER_HOME  (explicit legacy — prints a one-time deprecation notice)
 *   3. ~/.bahulam    (if it exists)
 *   4. ~/.kepler     (if it exists — prints a one-time migration hint)
 *   5. ~/.bahulam    (fresh install, will be created on first write)
 */
function resolveHome() {
  if (process.env.BAHULAM_HOME) return process.env.BAHULAM_HOME;
  if (process.env.KEPLER_HOME) {
    maybeNoticeLegacyEnv();
    return process.env.KEPLER_HOME;
  }
  const home = os.homedir();
  const newPath = path.join(home, NEW_HOME_NAME);
  const legacyPath = path.join(home, LEGACY_HOME_NAME);
  try {
    if (fs.existsSync(newPath)) return newPath;
  } catch {}
  try {
    if (fs.existsSync(legacyPath)) {
      maybeNoticeLegacyDir(legacyPath, newPath);
      return legacyPath;
    }
  } catch {}
  return newPath;
}

function maybeNoticeLegacyEnv() {
  if (_legacyNoticeShown || process.env.B0_QUIET_MIGRATION === '1') return;
  _legacyNoticeShown = true;
  try {
    process.stderr.write(
      '  \x1b[2mnote: KEPLER_HOME is deprecated; set BAHULAM_HOME instead.\x1b[0m\n'
    );
  } catch {}
}

function maybeNoticeLegacyDir(legacyPath, newPath) {
  if (_legacyNoticeShown || process.env.B0_QUIET_MIGRATION === '1') return;
  _legacyNoticeShown = true;
  try {
    process.stderr.write(
      `  \x1b[2mnote: reading legacy ${legacyPath}. Move to ${newPath} when convenient (silence with B0_QUIET_MIGRATION=1).\x1b[0m\n`
    );
  } catch {}
}

/**
 * Hash a project path to a short directory name.
 * Uses first 16 chars of SHA-256 (same as Claude Code).
 */
export function projectHash(projectDir) {
    // Resolve symlinks (macOS: /tmp → /private/tmp) so the hash is stable
    let resolved = projectDir;
    try {
        resolved = fs.realpathSync(projectDir);
    } catch {
        // realpathSync fails if path doesn't exist yet — use as-is
    }
    return crypto.createHash('sha256')
        .update(resolved)
        .digest('hex')
        .slice(0, 16);
}

/** Root ~/.bahulam/ directory (or legacy ~/.kepler/ if that's what's present). */
export function bahulamHome() {
    return resolveHome();
}

/** Backward-compat alias. Prefer `bahulamHome()` in new code. */
export const keplerHome = bahulamHome;

/** ~/.bahulam/projects/{hash}/ for a given project path. */
export function projectDir(projectPath) {
    return path.join(bahulamHome(), 'projects', projectHash(projectPath));
}

/** ~/.bahulam/projects/{hash}/index/ — BM25 search index. */
export function indexDir(projectPath) {
    return path.join(projectDir(projectPath), 'index');
}

/** ~/.bahulam/projects/{hash}/checkpoints/ — file undo. */
export function checkpointsDir(projectPath) {
    return path.join(projectDir(projectPath), 'checkpoints');
}

/** ~/.bahulam/projects/{hash}/state.json — current session. */
export function statePath(projectPath) {
    return path.join(projectDir(projectPath), 'state.json');
}

/** ~/.bahulam/projects/{hash}/sessions/ — session archive. */
export function sessionsDir(projectPath) {
    return path.join(projectDir(projectPath), 'sessions');
}

/** ~/.bahulam/projects/{hash}/hooks.json — project hooks. */
export function projectHooksPath(projectPath) {
    return path.join(projectDir(projectPath), 'hooks.json');
}

/** ~/.bahulam/conversations/ — central conversation storage. */
export function conversationsDir() {
    return path.join(bahulamHome(), 'conversations');
}

/** ~/.bahulam/conversations/{sessionId}.jsonl */
export function conversationPath(sessionId) {
    return path.join(conversationsDir(), `${sessionId}.jsonl`);
}

/** ~/.bahulam/hooks.json — global hooks. */
export function globalHooksPath() {
    return path.join(bahulamHome(), 'hooks.json');
}

/** ~/.bahulam/history.jsonl — prompt history. */
export function historyPath() {
    return path.join(bahulamHome(), 'history.jsonl');
}

// ── PRD-092 daemon session paths ─────────────────────────────────────
//
// Daemon-owned sessions (bahulamd, detach/attach) live at:
//   ~/.bahulam/sessions/<sess_id>/            per-session dir
//     meta.json                                cwd, model, opened_at, ...
//     events.jsonl (+ events-1.jsonl, ...)    append-only event log
//     snapshot-<seq>.json                      periodic compacted snapshot
//     approvals/                               pending + decided approvals
//     input-lock.json                          who holds input right now
//     daemon.pid                               pid of the owning daemon
//   ~/.bahulam/sockets/<sess_id>.sock          Unix socket (0600)
//
// These are DIFFERENT from the projects/<hash>/sessions/ archive above.
// The archive is a historical index keyed on project path; daemon sessions
// are keyed on session id and are the live source of truth while running.

/** ~/.bahulam/sessions/ — root for daemon-owned sessions. */
export function daemonSessionsRoot() {
    return path.join(bahulamHome(), 'sessions');
}

/** ~/.bahulam/sessions/<sess_id>/ — per-session dir. */
export function daemonSessionDir(sessionId) {
    return path.join(daemonSessionsRoot(), sessionId);
}

/** ~/.bahulam/sockets/ — root for daemon Unix sockets (Phase 1). */
export function daemonSocketsDir() {
    return path.join(bahulamHome(), 'sockets');
}

/** ~/.bahulam/sockets/<sess_id>.sock — Unix socket path for a session. */
export function daemonSocketPath(sessionId) {
    return path.join(daemonSocketsDir(), `${sessionId}.sock`);
}

// ── Project-local config directory (.bahulam/ next to CLAUDE.md/etc) ────
//
// Project-scoped stuff (agents/*.yaml, memory/*.md, hooks/, settings.json,
// tasks/) used to live in .kepler/ inside the project. Same resolver logic
// applies — prefer .bahulam/, fall back to .kepler/ when only the legacy
// dir exists.

const PROJECT_NEW_NAME = '.bahulam';
const PROJECT_LEGACY_NAME = '.kepler';

/**
 * Resolve the project-local config directory for `cwd`. Same priority as
 * the home resolver. Returns an absolute path; the directory may not
 * exist yet (callers that write should mkdir -p first).
 */
export function projectConfigDir(cwd = process.cwd()) {
    const newPath = path.join(cwd, PROJECT_NEW_NAME);
    const legacyPath = path.join(cwd, PROJECT_LEGACY_NAME);
    try {
        if (fs.existsSync(newPath)) return newPath;
    } catch {}
    try {
        if (fs.existsSync(legacyPath)) return legacyPath;
    } catch {}
    return newPath;
}
