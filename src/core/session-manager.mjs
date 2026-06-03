/**
 * Session Manager — persist session state, history, and conversation messages.
 *
 * Storage layout:
 *   .orca/
 *     state.json                        — current session metadata
 *     sessions/
 *       2026-06-03T21-30-00-000Z.json   — session metadata archive
 *     conversations/
 *       sess_abc123.jsonl               — conversation messages (JSONL)
 *
 * Messages are appended per-turn as JSONL for crash safety.
 * --resume loads the last session's conversation back into memory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const ORCA_DIR = '.orca';
const STATE_FILE = 'state.json';
const SESSIONS_DIR = 'sessions';
const CONVERSATIONS_DIR = 'conversations';
const MAX_SESSIONS = 100;

export class SessionManager {
    constructor(projectDir = process.cwd()) {
        this.projectDir = projectDir;
        this.orcaDir = path.join(projectDir, ORCA_DIR);
        this.statePath = path.join(this.orcaDir, STATE_FILE);
        this.sessionsDir = path.join(this.orcaDir, SESSIONS_DIR);
        this.conversationsDir = path.join(this.orcaDir, CONVERSATIONS_DIR);
        this.currentState = null;
    }

    _ensureDirs() {
        if (!fs.existsSync(this.orcaDir)) fs.mkdirSync(this.orcaDir, { recursive: true });
        if (!fs.existsSync(this.sessionsDir)) fs.mkdirSync(this.sessionsDir, { recursive: true });
        if (!fs.existsSync(this.conversationsDir)) fs.mkdirSync(this.conversationsDir, { recursive: true });
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
            turn_count: 0,
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

    // ── Conversation Persistence ──

    /**
     * Get the JSONL file path for a session's conversation.
     * @param {string} [sessionId] - defaults to current session
     */
    _conversationPath(sessionId) {
        const id = sessionId || this.currentState?.session_id || this.currentState?.task_id || 'unknown';
        return path.join(this.conversationsDir, `${id}.jsonl`);
    }

    /**
     * Append a message to the conversation JSONL file.
     * Called after each user input and assistant response.
     * @param {string} role - 'user' or 'assistant'
     * @param {string} content - message content
     * @param {object} [meta] - optional metadata (tokens, cost, tools)
     */
    saveMessage(role, content, meta = {}) {
        if (!this.currentState) return;
        this._ensureDirs();

        const entry = {
            role,
            content,
            timestamp: new Date().toISOString(),
            turn: this.currentState.turn_count || 0,
            ...meta,
        };

        const line = JSON.stringify(entry) + '\n';
        fs.appendFileSync(this._conversationPath(), line);
    }

    /**
     * Load all messages from a session's conversation file.
     * @param {string} sessionId - session to load
     * @returns {{ role: string, content: string }[]}
     */
    loadMessages(sessionId) {
        const filePath = this._conversationPath(sessionId);
        if (!fs.existsSync(filePath)) return [];

        const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
        return lines.map(line => {
            try {
                const entry = JSON.parse(line);
                return { role: entry.role, content: entry.content };
            } catch {
                return null;
            }
        }).filter(Boolean);
    }

    /**
     * Get the most recent session ID that has a conversation file.
     * @returns {{ sessionId: string, instruction: string, startedAt: string }|null}
     */
    getLastSession() {
        // Check state.json first
        const state = this.loadState();
        if (state?.session_id) {
            const convPath = this._conversationPath(state.session_id);
            if (fs.existsSync(convPath)) {
                return {
                    sessionId: state.session_id,
                    instruction: state.instruction || '',
                    startedAt: state.started_at || '',
                    status: state.status || 'unknown',
                };
            }
        }

        // Fall back to most recent conversation file
        if (!fs.existsSync(this.conversationsDir)) return null;
        const files = fs.readdirSync(this.conversationsDir)
            .filter(f => f.endsWith('.jsonl'))
            .sort()
            .reverse();

        if (files.length === 0) return null;
        const sessionId = files[0].replace('.jsonl', '');

        // Try to find matching session metadata
        const sessions = this.listSessions(50);
        const match = sessions.find(s => s.session_id === sessionId);

        return {
            sessionId,
            instruction: match?.instruction || '',
            startedAt: match?.started_at || '',
            status: match?.status || 'unknown',
        };
    }

    /**
     * List sessions that have conversation history (resumable).
     * @param {number} [limit=10]
     * @returns {Array<{ sessionId, instruction, startedAt, messageCount }>}
     */
    listResumable(limit = 10) {
        if (!fs.existsSync(this.conversationsDir)) return [];

        const files = fs.readdirSync(this.conversationsDir)
            .filter(f => f.endsWith('.jsonl'))
            .sort()
            .reverse()
            .slice(0, limit);

        return files.map(f => {
            const sessionId = f.replace('.jsonl', '');
            const convPath = path.join(this.conversationsDir, f);
            const lineCount = fs.readFileSync(convPath, 'utf-8').split('\n').filter(Boolean).length;

            // Find matching metadata
            const sessions = this.listSessions(100);
            const match = sessions.find(s => s.session_id === sessionId);

            return {
                sessionId,
                instruction: match?.instruction || '',
                startedAt: match?.started_at || '',
                status: match?.status || 'completed',
                messageCount: lineCount,
            };
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
