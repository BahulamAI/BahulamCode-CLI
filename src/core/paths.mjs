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
 * Env vars:
 *   BAHULAM_HOME  explicit override for ~/.bahulam
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

/**
 * Resolve the CLI home directory. Priority:
 *   1. $BAHULAM_HOME (explicit override)
 *   2. ~/.bahulam    (standard location, created on first write)
 */
function resolveHome() {
  if (process.env.BAHULAM_HOME) return process.env.BAHULAM_HOME;
  return path.join(os.homedir(), '.bahulam');
}

/**
 * Hash a project path to a short directory name.
 * Uses first 16 chars of SHA-256 (same as Claude Code).
 */
export function projectHash(projectDir) {
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

/** Root ~/.bahulam/ directory. */
export function bahulamHome() {
    return resolveHome();
}

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

// ── daemon session paths ─────────────────────────────────────

/** ~/.bahulam/sessions/ — root for daemon-owned sessions. */
export function daemonSessionsRoot() {
    return path.join(bahulamHome(), 'sessions');
}

/** ~/.bahulam/sessions/<sess_id>/ — per-session dir. */
export function daemonSessionDir(sessionId) {
    return path.join(daemonSessionsRoot(), sessionId);
}

/** ~/.bahulam/sockets/ — root for daemon Unix sockets. */
export function daemonSocketsDir() {
    return path.join(bahulamHome(), 'sockets');
}

/** ~/.bahulam/sockets/<sess_id>.sock — Unix socket path for a session. */
export function daemonSocketPath(sessionId) {
    return path.join(daemonSocketsDir(), `${sessionId}.sock`);
}

// ── Project-local config directory (.bahulam/ inside the project) ────

/**
 * Resolve the project-local config directory for `cwd`.
 * Returns an absolute path; the directory may not exist yet.
 */
export function projectConfigDir(cwd = process.cwd()) {
    return path.join(cwd, '.bahulam');
}
