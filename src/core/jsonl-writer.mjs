/**
 * JSONL Writer — writes cc-lens compatible session transcripts to ~/.bahulam/.
 *
 * Format mirrors Claude Code's ~/.claude/ JSONL structure so that
 * cc-lens (CLAUDE_CONFIG_DIR=~/.bahulam npx cc-lens) can read Bahulam sessions.
 *
 * Design:
 * - Non-blocking: buffered writes, flushed every 500ms or on turn end
 * - Accumulates content + tool_use blocks during a turn
 * - Writes single assistant entry on complete event
 * - Tracks UUID chain for cc-lens replay
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as childProcessModule from 'node:child_process';
import { bahulamHome } from './paths.mjs';

const BAHULAM_DIR = bahulamHome();
const FLUSH_INTERVAL_MS = 500;

/**
 * Sanitize a cwd path into a project slug for the directory name.
 * /Users/sree/Sites/myproject → -Users-sree-Sites-myproject
 * Mirrors the Claude Code / Bahulam CLI convention.
 */
function sanitizePath(p) {
  return p.replace(/\//g, '-').replace(/^-/, '-');
}

function normalizeToolResultContent(output) {
  if (typeof output === 'string') return output;
  if (output == null) return '';
  try {
    const serialized = JSON.stringify(output);
    return typeof serialized === 'string' ? serialized : String(output);
  } catch {
    return String(output);
  }
}

function sanitizeEventValue(value, depth = 0) {
  if (depth > 8) return '[truncated-depth]';
  if (typeof value === 'string') {
    return value.length > 10000 ? value.slice(0, 10000) + '\n[...truncated...]' : value;
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeEventValue(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      out[key] = sanitizeEventValue(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

export class JsonlWriter {
  /**
   * @param {string} cwd — project working directory
   * @param {string} version — CLI version string
   */
  constructor(cwd, version) {
    this.cwd = cwd;
    this.version = version;
    this.sessionId = null; // set by setSessionId() when backend assigns it
    this.slug = sanitizePath(cwd);
    this.projectDir = path.join(BAHULAM_DIR, 'projects', this.slug);

    // UUID chain for parent linking (cc-lens replay)
    this.lastUuid = null;

    // Write buffer
    this._buffer = [];
    this._flushTimer = null;
    this._flushPromise = null;
    this._transcriptPath = null; // set when sessionId is known
    this._ready = false;

    // Turn accumulator (reset per assistant turn)
    this._turnContent = [];    // [{type: 'text', text: '...'}, ...]
    this._turnToolCalls = [];  // [{id, name, input}, ...]
    this._turnToolResults = []; // [{tool_use_id, content, is_error}, ...]
    this._turnUsage = null;
    this._turnModel = null;
    this._pendingBahulamEvents = [];

    // Git branch (captured once at construction)
    this._gitBranch = this._detectGitBranch();

    this._ensureDir();
  }

  /**
   * Set the session ID (called when backend returns session_info).
   * Until this is called, entries are buffered with a local fallback ID.
   */
  setSessionId(id) {
    this.sessionId = id;
    this._transcriptPath = path.join(this.projectDir, `${id}.jsonl`);
    this._ready = true;
    if (this._pendingBahulamEvents.length > 0) {
      const pending = this._pendingBahulamEvents;
      this._pendingBahulamEvents = [];
      for (const event of pending) this.writeBahulamEvent(event);
    }
    // Flush any buffered entries now that we have a path
    if (this._buffer.length > 0) this._flush();
  }

  /**
   * Generate a local session ID (for --local mode or before backend assigns one).
   */
  ensureSessionId() {
    if (!this.sessionId) {
      this.setSessionId(randomUUID());
    }
  }

  // ── Write Methods (called from REPL) ──

  /**
   * Write a user turn entry.
   */
  writeUserTurn(content) {
    this.ensureSessionId();
    const uuid = randomUUID();
    const entry = {
      type: 'user',
      uuid,
      parentUuid: this.lastUuid,
      timestamp: new Date().toISOString(),
      cwd: this.cwd,
      sessionId: this.sessionId,
      version: this.version,
      gitBranch: this._gitBranch,
      message: { role: 'user', content },
    };
    this._appendEntry(entry);
    this.lastUuid = uuid;
  }

  /**
   * Write a Bahulam UI/SSE event for exact-ish terminal replay on /resume.
   * This is a Bahulam extension; cc-lens readers should ignore unknown types.
   */
  writeBahulamEvent(event) {
    if (!event || !event.type) return;
    const sanitized = sanitizeEventValue({
      type: event.type,
      data: event.data || {},
    });

    if (!this.sessionId) {
      this._pendingBahulamEvents.push(sanitized);
      return;
    }

    const entry = {
      type: 'bahulam_event',
      timestamp: new Date().toISOString(),
      cwd: this.cwd,
      sessionId: this.sessionId,
      version: this.version,
      event: sanitized,
    };
    this._appendEntry(entry);
  }

  /**
   * Accumulate content during streaming (call on content/content_partial events).
   */
  accumulateContent(text) {
    if (!text) return;
    // Merge into last text block or create new one
    const last = this._turnContent[this._turnContent.length - 1];
    if (last && last.type === 'text') {
      last.text += text;
    } else {
      this._turnContent.push({ type: 'text', text });
    }
  }

  /**
   * Accumulate a tool call (call on tool_call/tool_request events).
   */
  accumulateToolCall(callId, toolName, args) {
    this._turnToolCalls.push({
      type: 'tool_use',
      id: callId,
      name: toolName,
      input: args || {},
    });
  }

  /**
   * Record a tool result (call on tool_done/tool_result events).
   */
  recordToolResult(callId, output, isError, metadata = null) {
    const entry = {
      tool_use_id: callId,
      content: normalizeToolResultContent(output),
      is_error: !!isError,
    };
    const bahulamMeta = compactToolResultMetadata(metadata);
    if (bahulamMeta) entry.bahulam = bahulamMeta;
    this._turnToolResults.push(entry);
  }

  /**
   * Set usage and model for the current turn (call on complete event).
   */
  setTurnUsage(usage, model) {
    this._turnUsage = usage || null;
    this._turnModel = model || null;
  }

  /**
   * Finalize and write the assistant turn entry + tool result entries.
   * Call this on the 'complete' event.
   */
  flushAssistantTurn() {
    this.ensureSessionId();

    // Build content array: text blocks + tool_use blocks
    const contentBlocks = [...this._turnContent, ...this._turnToolCalls];
    if (contentBlocks.length === 0) {
      this._resetTurn();
      return;
    }

    // Simplify: if only one text block and no tools, use string content
    const content = (contentBlocks.length === 1 && contentBlocks[0].type === 'text')
      ? contentBlocks[0].text
      : contentBlocks;

    const uuid = randomUUID();
    const usage = this._turnUsage || {};
    const entry = {
      type: 'assistant',
      uuid,
      parentUuid: this.lastUuid,
      timestamp: new Date().toISOString(),
      cwd: this.cwd,
      sessionId: this.sessionId,
      version: this.version,
      message: {
        role: 'assistant',
        model: this._turnModel || undefined,
        usage: {
          input_tokens: usage.total_input_tokens || usage.input_tokens || 0,
          output_tokens: usage.total_output_tokens || usage.output_tokens || 0,
          cache_read_input_tokens: usage.cache_read_input_tokens || 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
        },
        content,
      },
    };
    this._appendEntry(entry);
    this.lastUuid = uuid;

    // Write tool result entries (as user messages with tool_result content)
    if (this._turnToolResults.length > 0) {
      const toolResultUuid = randomUUID();
      const toolResultEntry = {
        type: 'user',
        uuid: toolResultUuid,
        parentUuid: uuid,
        timestamp: new Date().toISOString(),
        cwd: this.cwd,
        sessionId: this.sessionId,
        version: this.version,
        message: {
          role: 'user',
          content: this._turnToolResults.map(r => {
            const block = {
              type: 'tool_result',
              tool_use_id: r.tool_use_id,
              content: r.content.slice(0, 5000), // truncate large outputs
              is_error: r.is_error,
            };
            if (r.bahulam) block.bahulam = r.bahulam;
            return block;
          }),
        },
      };
      this._appendEntry(toolResultEntry);
      this.lastUuid = toolResultUuid;
    }

    this._resetTurn();
    this._flush(); // force flush at end of turn
  }

  /**
   * Write a prompt entry to ~/.bahulam/history.jsonl.
   */
  writeHistory(prompt) {
    const entry = {
      display: prompt,
      pastedContents: {},
      timestamp: Date.now(),
      project: this.cwd,
      sessionId: this.sessionId,
    };
    const historyPath = path.join(BAHULAM_DIR, 'history.jsonl');
    fs.promises.appendFile(historyPath, JSON.stringify(entry) + '\n', { mode: 0o600 })
      .catch(() => {}); // best effort
  }

  /**
   * Final flush on session end.
   */
  async close() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    await this._flush();
    if (this._flushPromise) {
      await this._flushPromise;
    }
  }

  async flush() {
    await this._flush();
    if (this._flushPromise) await this._flushPromise;
  }

  get transcriptPath() {
    return this._transcriptPath;
  }

  // ── Internal ──

  _resetTurn() {
    this._turnContent = [];
    this._turnToolCalls = [];
    this._turnToolResults = [];
    this._turnUsage = null;
    this._turnModel = null;
  }

  _appendEntry(entry) {
    this._buffer.push(JSON.stringify(entry));
    if (!this._flushTimer && this._ready) {
      this._flushTimer = setTimeout(() => this._flush(), FLUSH_INTERVAL_MS);
    }
  }

  async _flush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._buffer.length === 0) {
      return this._flushPromise;
    }
    if (!this._transcriptPath) return; // no session ID yet, keep buffered

    const lines = this._buffer.join('\n') + '\n';
    this._buffer = [];

    const pending = this._flushPromise || Promise.resolve();
    const writePromise = pending.then(async () => {
      try {
        await fs.promises.appendFile(this._transcriptPath, lines, { mode: 0o600 });
      } catch {
        // If directory was deleted, try re-creating
        try {
          await this._ensureDirAsync();
          await fs.promises.appendFile(this._transcriptPath, lines, { mode: 0o600 });
        } catch {
          // silent — local logging is best-effort
        }
      }
    });

    this._flushPromise = writePromise;
    try {
      await writePromise;
    } finally {
      if (this._flushPromise === writePromise) {
        this._flushPromise = null;
      }
    }
  }

  _ensureDir() {
    try {
      fs.mkdirSync(this.projectDir, { recursive: true, mode: 0o700 });
    } catch { /* ignore */ }
    try {
      fs.mkdirSync(path.join(BAHULAM_DIR, 'projects'), { recursive: true, mode: 0o700 });
    } catch { /* ignore */ }
  }

  async _ensureDirAsync() {
    await fs.promises.mkdir(this.projectDir, { recursive: true, mode: 0o700 });
  }

  _detectGitBranch() {
    try {
      const { execSync } = childProcessModule;
      return execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.cwd,
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return undefined;
    }
  }
}

function compactToolResultMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const diffs = Array.isArray(metadata.file_diffs)
    ? metadata.file_diffs
    : metadata.file_diff ? [metadata.file_diff] : [];
  const out = {
    tool: metadata.tool || metadata._tool || '',
    lines_added: metadata.lines_added,
    lines_removed: metadata.lines_removed,
  };
  if (diffs.length) {
    out.file_diffs = diffs.map(diff => ({
      type: 'file_diff',
      path: diff.path || '',
      relative_path: diff.relative_path || '',
      lines_added: diff.lines_added || 0,
      lines_removed: diff.lines_removed || 0,
      truncated: !!diff.truncated,
      truncated_line_count: diff.truncated_line_count || 0,
      hunks: diff.hunks || [],
      unified: diff.unified || '',
    }));
  }

  for (const key of Object.keys(out)) {
    if (out[key] == null || out[key] === '' || (Array.isArray(out[key]) && out[key].length === 0)) {
      delete out[key];
    }
  }
  return Object.keys(out).length ? sanitizeEventValue(out) : null;
}
