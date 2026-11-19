/**
 * File Checkpointing — save and restore file state before edits.
 *
 * Before any file edit, a checkpoint is created containing the
 * original file content. The /undo command restores the last checkpoint.
 * Checkpoints are stored in ~/.bahulam/projects/{hash}/checkpoints/
 *
 * Durability contract
 * -------------------
 * A checkpoint is a safety net: if it fails to write, the edit it was
 * protecting is unrecoverable. So:
 *   - checkpoint files and restore targets are written atomically
 *     (tmp → fsync → rename → fsync dir) so a crash mid-write cannot
 *     leave a truncated file;
 *   - a missing source file is the ONLY expected reason to return null.
 *     Every other failure is recorded on `lastError` and reported to
 *     stderr, because a silently-absent checkpoint reads to the user
 *     as "there was nothing to undo" rather than "the net didn't deploy";
 *   - history is rehydrated from disk, so checkpoints survive a process
 *     restart instead of becoming orphaned files that /undo can't see.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { checkpointsDir } from './paths.mjs';

const CHECKPOINT_PREFIX = 'ckpt_';
const CHECKPOINT_SUFFIX = '.json';

/** fsync a directory so a rename inside it is crash-durable. */
function fsyncDir(dir) {
    let fd;
    try {
        fd = fs.openSync(dir, 'r');
        fs.fsyncSync(fd);
    } catch {
        // Directory fsync is unsupported on some platforms (Windows). The
        // rename is still atomic there; only the durability hint is lost.
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* already closed */ }
        }
    }
}

/**
 * Write `data` to `filePath` atomically and durably.
 *
 * Symlinks are resolved first: rename() would otherwise replace the link
 * itself instead of the file it points at.
 */
function writeFileDurable(filePath, data, mode) {
    let target = filePath;
    try { target = fs.realpathSync(filePath); } catch { /* new file — write in place */ }

    const dir = path.dirname(target);
    const tmp = path.join(
        dir,
        `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    );

    const fd = fs.openSync(tmp, 'w', mode ?? 0o666);
    try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }

    try {
        fs.renameSync(tmp, target);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* tmp already gone */ }
        throw err;
    }

    fsyncDir(dir);
}

export class CheckpointManager {
    /**
     * @param {string} [baseDir] - project root directory
     */
    constructor(baseDir = process.cwd()) {
        this.baseDir = baseDir;
        this.checkpointDir = checkpointsDir(baseDir);
        this.history = []; // Stack of checkpoint IDs
        this.maxCheckpoints = 50;
        // Last non-fatal checkpoint failure, surfaced by /undo and callers
        // so "no checkpoints" is never confused with "checkpointing broke".
        this.lastError = null;
    }

    /** Record a failure that must not be swallowed silently. */
    _fail(message) {
        this.lastError = message;
        try {
            process.stderr.write(`[checkpoints] ${message}\n`);
        } catch {
            // stderr unavailable (closed pipe, detached daemon) — lastError
            // still carries the message for programmatic callers.
        }
    }

    /**
     * Rebuild the in-memory id stack from on-disk checkpoint files.
     *
     * Without this, `history` is process-local: every restart orphans the
     * .json files on disk and /undo reports "no checkpoints" while the
     * snapshots are sitting right there.
     */
    _rehydrate() {
        if (this.history.length > 0) return;

        let names;
        try {
            names = fs.readdirSync(this.checkpointDir);
        } catch {
            return; // no checkpoint dir yet — nothing to restore
        }

        const found = [];
        for (const name of names) {
            if (!name.startsWith(CHECKPOINT_PREFIX) || !name.endsWith(CHECKPOINT_SUFFIX)) continue;
            const id = name.slice(0, -CHECKPOINT_SUFFIX.length);
            let mtime = 0;
            try {
                mtime = fs.statSync(path.join(this.checkpointDir, name)).mtimeMs;
            } catch {
                continue;
            }
            found.push({ id, mtime });
        }

        found.sort((a, b) => a.mtime - b.mtime);
        this.history.push(...found.slice(-this.maxCheckpoints).map(entry => entry.id));
    }

    /**
     * Create a checkpoint for a file before editing.
     * @param {string} filePath - absolute path to the file
     * @returns {string|null} checkpoint ID, or null if the file doesn't exist
     */
    save(filePath) {
        const absPath = path.resolve(filePath);

        let content;
        try {
            content = fs.readFileSync(absPath, 'utf-8');
        } catch (err) {
            if (err?.code === 'ENOENT') return null; // nothing to snapshot — expected
            this._fail(`could not read ${absPath} for checkpoint: ${err?.message || err}`);
            return null;
        }

        const id = `${CHECKPOINT_PREFIX}${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

        const checkpoint = {
            id,
            filePath: absPath,
            relativePath: path.relative(this.baseDir, absPath),
            content,
            timestamp: new Date().toISOString(),
            size: content.length,
        };

        try {
            fs.mkdirSync(this.checkpointDir, { recursive: true });
            // Durable: a truncated checkpoint file is worse than none, because
            // /undo would find it, fail to parse it, and lose the edit anyway.
            writeFileDurable(
                path.join(this.checkpointDir, `${id}${CHECKPOINT_SUFFIX}`),
                JSON.stringify(checkpoint)
            );
        } catch (err) {
            this._fail(`could not write checkpoint for ${absPath}: ${err?.message || err}`);
            return null;
        }

        this.lastError = null;
        this.history.push(id);

        // Trim old checkpoints
        while (this.history.length > this.maxCheckpoints) {
            const old = this.history.shift();
            try {
                fs.unlinkSync(path.join(this.checkpointDir, `${old}${CHECKPOINT_SUFFIX}`));
            } catch {
                // Already deleted — the trim is best-effort by design.
            }
        }

        return id;
    }

    /**
     * Restore the most recent checkpoint (undo last edit).
     * @returns {{ filePath: string, restored: boolean, id: string }|null}
     */
    undo() {
        this._rehydrate();
        if (this.history.length === 0) return null;

        const id = this.history.pop();
        const ckptFile = path.join(this.checkpointDir, `${id}${CHECKPOINT_SUFFIX}`);

        try {
            const raw = fs.readFileSync(ckptFile, 'utf-8');
            const checkpoint = JSON.parse(raw);

            // Preserve the file's existing permissions across the restore.
            let mode;
            try {
                mode = fs.statSync(checkpoint.filePath).mode & 0o777;
            } catch {
                mode = undefined; // file was deleted — restore it fresh
            }

            writeFileDurable(checkpoint.filePath, checkpoint.content, mode);
            fs.unlinkSync(ckptFile);

            return {
                id: checkpoint.id,
                filePath: checkpoint.filePath,
                restored: true,
            };
        } catch (err) {
            return { id, filePath: null, restored: false, error: err.message };
        }
    }

    /**
     * List recent checkpoints.
     * @param {number} [limit=10]
     * @returns {Array}
     */
    list(limit = 10) {
        this._rehydrate();
        const result = [];
        const ids = this.history.slice(-limit).reverse();

        for (const id of ids) {
            try {
                const raw = fs.readFileSync(
                    path.join(this.checkpointDir, `${id}${CHECKPOINT_SUFFIX}`),
                    'utf-8'
                );
                const ckpt = JSON.parse(raw);
                result.push({
                    id: ckpt.id,
                    file: ckpt.relativePath,
                    timestamp: ckpt.timestamp,
                    size: ckpt.size,
                });
            } catch (err) {
                // Don't invent plausible-looking metadata: an unreadable
                // checkpoint is reported as unreadable.
                result.push({
                    id,
                    file: null,
                    timestamp: null,
                    size: 0,
                    unreadable: err?.message || String(err),
                });
            }
        }

        return result;
    }

    /**
     * Clear all checkpoints.
     */
    clear() {
        this.history.length = 0;
        this.lastError = null;
        let entries;
        try {
            entries = fs.readdirSync(this.checkpointDir);
        } catch (err) {
            if (err?.code !== 'ENOENT') {
                this._fail(`could not read ${this.checkpointDir}: ${err?.message || err}`);
            }
            return; // directory doesn't exist — nothing to clear
        }

        for (const entry of entries) {
            if (!entry.startsWith(CHECKPOINT_PREFIX) || !entry.endsWith(CHECKPOINT_SUFFIX)) continue;
            try {
                fs.unlinkSync(path.join(this.checkpointDir, entry));
            } catch (err) {
                if (err?.code !== 'ENOENT') {
                    this._fail(`could not delete ${entry}: ${err?.message || err}`);
                }
            }
        }
    }
}
