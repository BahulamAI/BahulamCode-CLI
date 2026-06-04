/**
 * Orca Paths — centralized path resolution for all Orca data.
 *
 * Everything lives under ~/.orca/:
 *   ~/.orca/
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
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

const ORCA_HOME = process.env.ORCA_HOME || path.join(os.homedir(), '.orca');

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

/** Root ~/.orca/ directory. */
export function orcaHome() {
    return ORCA_HOME;
}

/** ~/.orca/projects/{hash}/ for a given project path. */
export function projectDir(projectPath) {
    return path.join(ORCA_HOME, 'projects', projectHash(projectPath));
}

/** ~/.orca/projects/{hash}/index/ — BM25 search index. */
export function indexDir(projectPath) {
    return path.join(projectDir(projectPath), 'index');
}

/** ~/.orca/projects/{hash}/checkpoints/ — file undo. */
export function checkpointsDir(projectPath) {
    return path.join(projectDir(projectPath), 'checkpoints');
}

/** ~/.orca/projects/{hash}/state.json — current session. */
export function statePath(projectPath) {
    return path.join(projectDir(projectPath), 'state.json');
}

/** ~/.orca/projects/{hash}/sessions/ — session archive. */
export function sessionsDir(projectPath) {
    return path.join(projectDir(projectPath), 'sessions');
}

/** ~/.orca/projects/{hash}/hooks.json — project hooks. */
export function projectHooksPath(projectPath) {
    return path.join(projectDir(projectPath), 'hooks.json');
}

/** ~/.orca/conversations/ — central conversation storage. */
export function conversationsDir() {
    return path.join(ORCA_HOME, 'conversations');
}

/** ~/.orca/conversations/{sessionId}.jsonl */
export function conversationPath(sessionId) {
    return path.join(conversationsDir(), `${sessionId}.jsonl`);
}

/** ~/.orca/hooks.json — global hooks. */
export function globalHooksPath() {
    return path.join(ORCA_HOME, 'hooks.json');
}

/** ~/.orca/history.jsonl — prompt history. */
export function historyPath() {
    return path.join(ORCA_HOME, 'history.jsonl');
}
