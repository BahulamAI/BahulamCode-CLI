/**
 * Session Manager — persist session state, history, and conversation messages.
 *
 * All data lives under ~/.kepler/:
 *   ~/.kepler/
 *     projects/{hash}/
 *       state.json              — current session metadata
 *       sessions/               — session metadata archive
 *     conversations/
 *       {sessionId}.jsonl       — conversation messages (JSONL)
 *         Line 1: {"type":"header","instruction":"...","project":"..."}
 *         Line 2+: {"role":"user","content":"...","timestamp":"..."}
 *
 * Zero per-project files. /resume works from anywhere.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    projectDir as getProjectDir,
    statePath as getStatePath,
    sessionsDir as getSessionsDir,
    conversationsDir as getConversationsDir,
    conversationPath as getConversationPath,
} from './paths.mjs';

const MAX_SESSIONS = 100;

export class SessionManager {
    constructor(projectPath = process.cwd()) {
        this.projectPath = projectPath;
        this.projectKeplerDir = getProjectDir(projectPath);
        this.statePath = getStatePath(projectPath);
        this.sessionsDir = getSessionsDir(projectPath);
        this.conversationsDir = getConversationsDir();
        this.currentState = null;
    }

    _ensureDirs() {
        fs.mkdirSync(this.projectKeplerDir, { recursive: true });
        fs.mkdirSync(this.sessionsDir, { recursive: true });
        fs.mkdirSync(this.conversationsDir, { recursive: true });
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
        return getConversationPath(id);
    }

    /**
     * Append a message to the conversation JSONL file.
     * On first write, prepends a header line with session metadata.
     * @param {string} role - 'user' or 'assistant'
     * @param {string} content - message content
     * @param {object} [meta] - optional metadata (tokens, cost, tools)
     */
    saveMessage(role, content, meta = {}) {
        if (!this.currentState) return;
        this._ensureDirs();

        const convPath = this._conversationPath();

        // Write header line on first message (so listResumable can read metadata)
        if (!fs.existsSync(convPath)) {
            const header = {
                type: 'header',
                instruction: this.currentState.instruction || '',
                project: this.projectPath,
                project_name: path.basename(this.projectPath),
                started_at: this.currentState.started_at || new Date().toISOString(),
                session_id: this.currentState.session_id || '',
            };
            fs.appendFileSync(convPath, JSON.stringify(header) + '\n');
        }

        const entry = {
            role,
            content,
            timestamp: new Date().toISOString(),
            turn: this.currentState.turn_count || 0,
            ...meta,
        };

        fs.appendFileSync(convPath, JSON.stringify(entry) + '\n');
    }

    /**
     * Read the header line from a conversation JSONL file.
     * @param {string} filePath
     * @returns {object|null}
     */
    _readHeader(filePath) {
        try {
            const first = fs.readFileSync(filePath, 'utf-8').split('\n')[0];
            if (!first) return null;
            const parsed = JSON.parse(first);
            return parsed.type === 'header' ? parsed : null;
        } catch {
            return null;
        }
    }

    /**
     * Load all messages from a session's conversation file (skips header).
     * @param {string} sessionId - session to load
     * @returns {{ role: string, content: string }[]}
     */
    loadMessages(sessionId) {
        return this.loadConversation(sessionId).messages;
    }

    /**
     * Load the header and all messages from a session conversation file.
     * @param {string} sessionId
     * @returns {{ header: object|null, messages: { role: string, content: string }[] }}
     */
    loadConversation(sessionId) {
        const filePath = this._conversationPath(sessionId);
        if (!fs.existsSync(filePath)) return { header: null, messages: [] };

        const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
        const entries = lines
            .map(line => {
                try { return JSON.parse(line); } catch { return null; }
            })
            .filter(Boolean);
        const header = entries.find(entry => entry.type === 'header') || null;
        const messages = entries
            .filter(entry => entry.role) // skip header (type=header, no role)
            .map(entry => ({ role: entry.role, content: entry.content }));
        return { header, messages };
    }

    /**
     * Activate an existing conversation as the current session so additional
     * turns append to the same JSONL file.
     * @param {string} sessionId
     * @param {object|null} header
     * @param {{ role: string, content: string }[]} messages
     */
    activateSession(sessionId, header = null, messages = []) {
        this._ensureDirs();
        this.currentState = {
            instruction: header?.instruction || messages.find(m => m.role === 'user')?.content || '',
            started_at: header?.started_at || new Date().toISOString(),
            status: 'running',
            task_id: null,
            job_id: null,
            session_id: sessionId,
            tool_count: 0,
            turn_count: messages.filter(m => m.role === 'user').length,
            events: [],
            resumed_at: new Date().toISOString(),
        };
        this._writeState();
        return this.currentState;
    }

    /**
     * Get the most recent session that has a conversation file.
     * @returns {{ sessionId: string, instruction: string, startedAt: string }|null}
     */
    getLastSession() {
        if (!fs.existsSync(this.conversationsDir)) return null;

        // Sort by file modification time (most recent first)
        const files = fs.readdirSync(this.conversationsDir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => ({
                name: f,
                mtime: fs.statSync(path.join(this.conversationsDir, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime);

        if (files.length === 0) return null;

        const file = files[0].name;
        const sessionId = file.replace('.jsonl', '');
        const header = this._readHeader(path.join(this.conversationsDir, file));

        return {
            sessionId,
            instruction: header?.instruction || '',
            startedAt: header?.started_at || '',
            project: header?.project_name || '',
            projectPath: header?.project || '',
        };
    }

    /**
     * List sessions that have conversation history (resumable).
     * Reads metadata from JSONL header line — no cross-referencing needed.
     * @param {number} [limit=10]
     * @returns {Array<{ sessionId, instruction, startedAt, project, messageCount }>}
     */
    listResumable(limit = 10) {
        if (!fs.existsSync(this.conversationsDir)) return [];

        // Sort by modification time (most recent first)
        const files = fs.readdirSync(this.conversationsDir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => ({
                name: f,
                mtime: fs.statSync(path.join(this.conversationsDir, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, limit);

        return files.map(({ name }) => {
            const sessionId = name.replace('.jsonl', '');
            const convPath = path.join(this.conversationsDir, name);
            const lines = fs.readFileSync(convPath, 'utf-8').split('\n').filter(Boolean);
            const header = this._readHeader(convPath);

            // Message count = total lines minus header
            const messageCount = header ? lines.length - 1 : lines.length;

            return {
                sessionId,
                instruction: header?.instruction || '(no instruction)',
                startedAt: header?.started_at || '',
                project: header?.project_name || '',
                projectPath: header?.project || '',
                messageCount,
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
