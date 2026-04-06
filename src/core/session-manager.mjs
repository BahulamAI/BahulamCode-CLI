/**
 * Session Manager — T13: persist session state and history.
 * Saves to .tarang/state.json and .tarang/sessions/.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const TARANG_DIR = '.tarang';
const STATE_FILE = 'state.json';
const SESSIONS_DIR = 'sessions';
const MAX_SESSIONS = 100;

export class SessionManager {
    constructor(projectDir = process.cwd()) {
        this.projectDir = projectDir;
        this.tarangDir = path.join(projectDir, TARANG_DIR);
        this.statePath = path.join(this.tarangDir, STATE_FILE);
        this.sessionsDir = path.join(this.tarangDir, SESSIONS_DIR);
        this.currentState = null;
    }

    _ensureDirs() {
        if (!fs.existsSync(this.tarangDir)) fs.mkdirSync(this.tarangDir, { recursive: true });
        if (!fs.existsSync(this.sessionsDir)) fs.mkdirSync(this.sessionsDir, { recursive: true });
    }

    /** Start tracking a new session. */
    start(instruction) {
        this._ensureDirs();
        this.currentState = {
            instruction,
            started_at: new Date().toISOString(),
            status: 'running',
            task_id: null,
            job_id: null,
            session_id: null,
            tool_count: 0,
            events: [],
        };
        this._writeState();
    }

    /** Update state from session_info event. */
    setSessionInfo(data) {
        if (!this.currentState) return;
        this.currentState.task_id = data.task_id || this.currentState.task_id;
        this.currentState.job_id = data.job_id || this.currentState.job_id;
        this.currentState.session_id = data.session_id || this.currentState.session_id;
        this._writeState();
    }

    /** Record a tool call. */
    recordToolCall(toolName) {
        if (!this.currentState) return;
        this.currentState.tool_count++;
    }

    /** Mark session as complete. */
    complete(summary) {
        if (!this.currentState) return;
        this.currentState.status = 'completed';
        this.currentState.completed_at = new Date().toISOString();
        this.currentState.summary = summary;
        const duration = (Date.now() - new Date(this.currentState.started_at).getTime()) / 1000;
        this.currentState.duration_s = Math.round(duration * 10) / 10;
        this._writeState();
        this._saveToHistory();
    }

    /** Mark session as failed. */
    fail(errorMessage) {
        if (!this.currentState) return;
        this.currentState.status = 'failed';
        this.currentState.error = errorMessage;
        this.currentState.completed_at = new Date().toISOString();
        this._writeState();
        this._saveToHistory();
    }

    /** Mark session as cancelled. */
    cancel() {
        if (!this.currentState) return;
        this.currentState.status = 'cancelled';
        this.currentState.completed_at = new Date().toISOString();
        this._writeState();
        this._saveToHistory();
    }

    /** Mark session as paused. */
    pause() {
        if (!this.currentState) return;
        this.currentState.status = 'paused';
        this._writeState();
    }

    /** Load saved state for resume. */
    loadState() {
        try {
            if (fs.existsSync(this.statePath)) {
                return JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
            }
        } catch { /* corrupt file */ }
        return null;
    }

    /** List recent sessions. */
    listSessions(limit = 20) {
        if (!fs.existsSync(this.sessionsDir)) return [];
        return fs.readdirSync(this.sessionsDir)
            .filter(f => f.endsWith('.json'))
            .sort()
            .reverse()
            .slice(0, limit)
            .map(file => {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, file), 'utf-8'));
                    return { file, ...data };
                } catch {
                    return { file, status: 'unreadable' };
                }
            });
    }

    _writeState() {
        this._ensureDirs();
        fs.writeFileSync(this.statePath, JSON.stringify(this.currentState, null, 2));
    }

    _saveToHistory() {
        this._ensureDirs();
        const filename = this.currentState.started_at.replace(/[:.]/g, '-') + '.json';
        fs.writeFileSync(
            path.join(this.sessionsDir, filename),
            JSON.stringify(this.currentState, null, 2)
        );
        this._pruneHistory();
    }

    _pruneHistory() {
        const files = fs.readdirSync(this.sessionsDir)
            .filter(f => f.endsWith('.json'))
            .sort();
        while (files.length > MAX_SESSIONS) {
            const oldest = files.shift();
            try { fs.unlinkSync(path.join(this.sessionsDir, oldest)); } catch {}
        }
    }
}
