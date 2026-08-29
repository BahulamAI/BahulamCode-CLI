/**
 * Browser-local agent relay.
 *
 * Bridges a local workspace browser session to the same CLI-owned remote
 * agent path used by the terminal: BahulamStreamClient + local ToolExecutor.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { BahulamAuth } from '../auth/bahulam-auth.mjs';
import { AgentHistoryTurnBuilder } from '../core/agent-history.mjs';
import { JsonlWriter } from '../core/jsonl-writer.mjs';
import {
  buildResumeHistory,
  getRecentSessions,
  getSessionDetail,
} from '../core/local-store.mjs';
import { BahulamStreamClient } from '../core/stream-client.mjs';
import { createToolExecutor } from '../core/tool-executor.mjs';
import { buildWorkScope } from '../core/work-scope.mjs';
import { BrowserApprovalManager } from './approval-bridge.mjs';

const __require = createRequire(import.meta.url);
const VERSION = __require('../../package.json').version;

export class LocalAgentRelay {
  constructor({ session, emit } = {}) {
    if (!session?.id) throw new Error('LocalAgentRelay requires a session');
    if (typeof emit !== 'function') throw new Error('LocalAgentRelay requires an emit function');
    this.session = session;
    this.emit = emit;
    this.ready = null;
    this.running = false;
    this.turnCount = 0;
    this.client = null;
    this.toolExecutor = null;
    this.creds = null;
    this.approvalManager = null;
    this.resumeLoaded = false;
    this.resumeSessionId = null;
    this.historyMode = 'full';
    this.displayHistory = [];
    this.agentHistory = [];
    this.jsonlWriter = null;
    this.approvalAutoMode = false;
    this.pendingFollowups = [];
    this.flushingFollowups = false;
    this.cancellationRequested = false;
    this.cancellationEventEmitted = false;
  }

  async listHistorySessions() {
    const sessions = await transcriptsForRoot(this.session.root_path);
    return {
      ok: true,
      root_path: this.session.root_path,
      selected_session_id: this.resumeSessionId || null,
      sessions: sessions.map(serializeTranscriptSession),
    };
  }

  currentHistory() {
    return this._historySnapshot();
  }

  async startNewHistory() {
    if (this.running) {
      const err = new Error('A local agent turn is already running for this workspace');
      err.code = 'CONFLICT';
      throw err;
    }
    if (this.turnCount > 0) {
      const err = new Error('Start a new local workspace session to switch history after a turn has run');
      err.code = 'CONFLICT';
      throw err;
    }
    this.resumeLoaded = true;
    this.resumeSessionId = null;
    this.displayHistory = [];
    this.agentHistory = [];
    this.jsonlWriter = null;
    if (this.client) this.client.sessionId = null;
    this.emit('agent_history_new', {
      root_path: this.session.root_path,
    });
    return this._historySnapshot();
  }

  async loadHistory(options = {}) {
    const sessionId = typeof options === 'string' ? options : options.sessionId;
    if (!sessionId) return this._historySnapshot();
    return this.resumeHistory(sessionId);
  }

  async resumeHistory(sessionId) {
    const requestedSessionId = String(sessionId || '').trim();
    if (!requestedSessionId) {
      const err = new Error('session_id is required');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    if (this.running) {
      const err = new Error('A local agent turn is already running for this workspace');
      err.code = 'CONFLICT';
      throw err;
    }
    if (this.turnCount > 0 && this.resumeSessionId !== requestedSessionId) {
      const err = new Error('Start a new local workspace session to switch history after a turn has run');
      err.code = 'CONFLICT';
      throw err;
    }
    if (this.resumeLoaded && this.resumeSessionId === requestedSessionId) return this._historySnapshot();

    try {
      const match = await transcriptForRootBySessionId(this.session.root_path, requestedSessionId);
      if (!match) {
        const err = new Error(`No local transcript for this workspace session: ${requestedSessionId}`);
        err.code = 'NOT_FOUND';
        throw err;
      }

      const detail = await getSessionDetail(match.sessionId, { filePath: match.filePath });
      if (!detail) {
        const err = new Error(`Local transcript could not be read: ${requestedSessionId}`);
        err.code = 'NOT_FOUND';
        throw err;
      }

      const history = buildResumeHistory({ ...detail, recapTailTurns: 8 }, this.historyMode);
      this.resumeSessionId = match.sessionId;
      this.displayHistory = history.displayHistory || [];
      this.agentHistory = history.agentHistory || [];
      this.resumeLoaded = true;
      if (this.client) this.client.sessionId = this.resumeSessionId;
      if (this.jsonlWriter?.sessionId && this.jsonlWriter.sessionId !== this.resumeSessionId) {
        this.jsonlWriter = null;
      }
      this._ensureJsonlWriter();
      this.emit('agent_history_loaded', {
        backend_session_id: this.resumeSessionId,
        messages: this.displayHistory.length,
        agent_messages: this.agentHistory.length,
        root_path: this.session.root_path,
        transcript_path: match.filePath,
      });
    } catch (err) {
      this.emit('agent_history_error', {
        message: err.message || String(err),
        root_path: this.session.root_path,
      });
    }

    return this._historySnapshot();
  }

  async runTurn({ prompt, path = '.', attachments = [] } = {}) {
    const instruction = String(prompt || '').trim();
    const turnAttachments = normalizeTurnAttachments(attachments);
    if (!instruction && !turnAttachments.length) {
      const err = new Error('prompt is required');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    if (this.running) {
      const err = new Error('A local agent turn is already running for this workspace');
      err.code = 'CONFLICT';
      throw err;
    }

    if (!this.resumeLoaded) await this.startNewHistory();
    await this._ensureReady();

    this.running = true;
    this.cancellationRequested = false;
    this.cancellationEventEmitted = false;
    this.turnCount += 1;
    const turnId = `turn_${Date.now().toString(36)}_${this.turnCount}`;
    const userInstruction = instruction || 'Review the attached files.';
    const relayInstruction = this._buildInstruction(userInstruction, path, turnAttachments);
    const writer = this._ensureJsonlWriter();
    const turnHistory = new AgentHistoryTurnBuilder();
    let content = '';
    let assistantContent = '';
    let eventCount = 0;
    let userTurnWritten = false;
    const writeUserTurn = () => {
      if (userTurnWritten) return;
      writer.writeUserTurn(userInstruction);
      writer.writeHistory(userInstruction);
      userTurnWritten = true;
    };
    if (this.client.sessionId) writeUserTurn();

    this.emit('agent_turn_started', {
      turn_id: turnId,
      prompt: userInstruction.slice(0, 500),
      cwd: this.session.root_path,
      path,
      attachments: turnAttachments.length,
      backend_url: this.creds.backendUrl,
    });

    try {
      const execContext = await this._buildExecContext(relayInstruction);
      for await (const event of this.client.execute(
        relayInstruction,
        execContext,
        this.agentHistory.length ? this.agentHistory : null,
      )) {
        eventCount += 1;
        writer.writeBahulamEvent(event);

        const contentUpdate = contentDeltaForEvent(event, assistantContent);
        if (contentUpdate) {
          assistantContent = contentUpdate.next;
          if (contentUpdate.delta) {
            content += contentUpdate.delta;
            turnHistory.addAssistantText(contentUpdate.delta);
            writer.accumulateContent(contentUpdate.delta);
          }
        }

        if (event.type === 'session_info' && event.data?.session_id) {
          this.resumeSessionId = this.resumeSessionId || event.data.session_id;
          if (!writer.sessionId) writer.setSessionId(this.resumeSessionId);
          writeUserTurn();
        }

        if (event.type === 'tool_call' || event.type === 'tool_request') {
          const data = event.data || {};
          turnHistory.addToolUse(data);
          writer.accumulateToolCall(data.call_id || data.request_id, data.tool || data.name, data.args || data.input);
        }

        if (event.type === 'tool_done' || event.type === 'tool_result') {
          const data = event.data || {};
          turnHistory.addToolResult(data);
          writer.recordToolResult(
            data.call_id || data._callId || data.request_id || data.id || data.tool_use_id,
            data.output ?? data.result ?? data.message ?? '',
            data.success === false || data.is_error,
            data,
          );
        }

        if (event.type === 'complete') {
          writer.setTurnUsage(event.data?.usage, event.data?.model || this.creds?.modelConfig?.reasoning);
          writer.flushAssistantTurn();
        }

        this._emitAgentEvent(event, { turnId, contentText: contentUpdate?.delta });
        await this._flushQueuedFollowups();
      }

      const wasCancelled = this.cancellationRequested || Boolean(this.client?._cancelled);
      this._markUndeliveredFollowupsQueued(wasCancelled ? 'Task cancelled' : '');
      if (!userTurnWritten && (this.client.sessionId || wasCancelled)) writeUserTurn();
      if (wasCancelled) {
        writer.writeBahulamEvent({
          type: 'cancelled',
          data: {
            task_id: this.client?.currentTaskId || null,
            reason: 'Cancelled by user',
          },
        });
        writer.flushAssistantTurn();
      }

      this.displayHistory.push({
        role: 'user',
        content: userInstruction,
        timestamp: new Date().toISOString(),
        order: this.displayHistory.length,
      });
      if (assistantContent) {
        this.displayHistory.push({
          role: 'assistant',
          content: assistantContent,
          timestamp: new Date().toISOString(),
          order: this.displayHistory.length,
        });
      }
      const structuredTurn = turnHistory.finish();
      if (structuredTurn.length) {
        this.agentHistory.push({ role: 'user', content: userInstruction }, ...structuredTurn);
      } else if (assistantContent) {
        this.agentHistory.push({ role: 'user', content: userInstruction }, { role: 'assistant', content: assistantContent });
      } else {
        this.agentHistory.push({ role: 'user', content: userInstruction });
      }
      await writer.flush();

      if (wasCancelled) {
        if (!this.cancellationEventEmitted) {
          this.cancellationEventEmitted = true;
          this.emit('agent_turn_cancelled', {
            turn_id: turnId,
            event_count: eventCount,
            content_chars: content.length,
            backend_session_id: this.client.sessionId || null,
            transcript_session_id: writer.sessionId || null,
            reason: 'Cancelled by user',
          });
        }
        return {
          ok: false,
          status: 'cancelled',
          turn_id: turnId,
          event_count: eventCount,
          content,
          backend_session_id: this.client.sessionId || null,
          transcript_session_id: writer.sessionId || null,
        };
      }

      this.emit('agent_turn_complete', {
        turn_id: turnId,
        event_count: eventCount,
        content_chars: content.length,
        backend_session_id: this.client.sessionId || null,
        transcript_session_id: writer.sessionId || null,
      });

      return {
        ok: true,
        turn_id: turnId,
        event_count: eventCount,
        content,
        backend_session_id: this.client.sessionId || null,
        transcript_session_id: writer.sessionId || null,
      };
    } catch (err) {
      this._markUndeliveredFollowupsQueued(err.message || String(err));
      this.emit('agent_error', {
        turn_id: turnId,
        code: err.code || 'agent_relay_error',
        message: err.message || String(err),
      });
      throw err;
    } finally {
      this.running = false;
    }
  }

  async close() {
    this.approvalManager?.rejectAll?.();
    try {
      await this.jsonlWriter?.close?.();
    } catch {}
  }

  decideApproval(approvalId, decision = {}) {
    if (!this.approvalManager) {
      const err = new Error('Approval bridge is not ready');
      err.code = 'NOT_FOUND';
      throw err;
    }
    return this.approvalManager.decide(approvalId, decision);
  }

  async cancelTurn(reason = 'Cancelled by user') {
    const taskId = this.client?.currentTaskId || null;
    if (!this.running || !this.client) {
      return { ok: true, status: 'idle', task_id: taskId };
    }
    this.cancellationRequested = true;
    this._markUndeliveredFollowupsQueued(reason);
    try {
      this.approvalManager?.rejectAll?.(reason);
    } catch {}
    try {
      await this.client.cancel();
    } catch {}
    const result = {
      ok: true,
      status: 'cancelled',
      task_id: taskId,
      reason,
    };
    this.emit('agent_cancel_requested', result);
    return result;
  }

  setApprovalAutoMode(enabled, { emit = true } = {}) {
    this.approvalAutoMode = Boolean(enabled);
    if (this.approvalManager) this.approvalManager.setAutoMode(this.approvalAutoMode);
    const state = this.approvalMode();
    if (emit) this.emit('agent_approval_mode', state);
    return state;
  }

  approvalMode() {
    return {
      ok: true,
      mode: this.approvalAutoMode ? 'auto' : 'ask',
      auto: this.approvalAutoMode,
      summary: this.approvalManager?.browserSummary?.() || null,
    };
  }

  async sendFollowup({ instruction } = {}) {
    const text = String(instruction || '').trim();
    if (!text) {
      const err = new Error('instruction is required');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    if (!this.running || !this.client) {
      const err = new Error('No running agent turn to follow up');
      err.code = 'CONFLICT';
      throw err;
    }

    const item = {
      instruction: text,
      role: 'user',
      messageType: 'user_intervention',
      priority: 'high',
      idempotencyKey: `local-followup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    };
    if (!this.client.currentTaskId) {
      this.pendingFollowups.push(item);
      const result = {
        ok: true,
        status: 'waiting_for_task',
        intervention_id: item.idempotencyKey,
        task_id: null,
      };
      this.emit('agent_followup_status', {
        ...result,
        instruction: text.slice(0, 500),
      });
      return result;
    }
    return this._sendFollowupNow(item);
  }

  async _flushQueuedFollowups() {
    if (this.flushingFollowups || !this.client?.currentTaskId || !this.pendingFollowups.length) return;
    this.flushingFollowups = true;
    try {
      while (this.pendingFollowups.length && this.client?.currentTaskId) {
        const item = this.pendingFollowups.shift();
        await this._sendFollowupNow(item);
      }
    } finally {
      this.flushingFollowups = false;
    }
  }

  _markUndeliveredFollowupsQueued(error = '') {
    while (this.pendingFollowups.length) {
      const item = this.pendingFollowups.shift();
      const failed = Boolean(error);
      this.emit('agent_followup_status', {
        ok: !failed,
        status: failed ? 'error' : 'queued_next_turn',
        intervention_id: item.idempotencyKey,
        task_id: this.client?.currentTaskId || null,
        instruction: item.instruction.slice(0, 500),
        error: error || null,
        role: item.role || 'user',
        message_type: item.messageType || 'user_intervention',
        priority: item.priority || 'high',
      });
    }
  }

  async _sendFollowupNow(item) {
    const result = await this.client.sendIntervention(item.instruction, {
      idempotencyKey: item.idempotencyKey,
      priority: item.priority || 'high',
    });
    const payload = {
      ok: result.status !== 'error',
      status: result.status || 'unknown',
      intervention_id: result.interventionId || item.idempotencyKey,
      task_id: this.client.currentTaskId || null,
      role: item.role || 'user',
      message_type: item.messageType || 'user_intervention',
      priority: item.priority || 'high',
      error: result.error || null,
      http_status: result.httpStatus || null,
    };
    this._ensureJsonlWriter().writeBahulamEvent({
      type: 'user_intervention',
      data: {
        instruction: item.instruction,
        task_id: payload.task_id,
        intervention_id: payload.intervention_id,
        status: payload.status,
        role: payload.role,
        message_type: payload.message_type,
        priority: payload.priority,
      },
    });
    this.emit('agent_followup_status', {
      ...payload,
      instruction: item.instruction.slice(0, 500),
    });
    return payload;
  }

  async _ensureReady() {
    if (this.ready) return this.ready;
    this.ready = this._initialize().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  async _initialize() {
    const auth = new BahulamAuth();
    const creds = auth.loadCredentials();
    if (!creds.token) {
      const err = new Error('Not logged in. Run `bahulam login` from the CLI, then retry.');
      err.code = 'auth_required';
      throw err;
    }

    // This service process owns one local workspace. Set cwd to the granted
    // root so existing CLI tools, memory, hooks, and shell defaults behave the
    // same as a terminal launched from that workspace.
    if (this.session.root_path && process.cwd() !== this.session.root_path) {
      process.chdir(this.session.root_path);
    }

    const toolExecutor = createToolExecutor();
    await toolExecutor.waitForAutoRegister?.();
    await toolExecutor.registerProjectRoots?.([this.session.root_path], { forceRefresh: false });

    const approval = new BrowserApprovalManager({
      emit: this.emit,
      cwd: this.session.root_path,
    });
    approval.setAutoMode(this.approvalAutoMode);

    this.creds = creds;
    this.toolExecutor = toolExecutor;
    this.approvalManager = approval;
    this.client = new BahulamStreamClient({
      baseUrl: creds.backendUrl,
      token: creds.token,
      toolExecutor,
      approvalManager: approval,
      mode: 'remote',
    });
    if (this.resumeSessionId) this.client.sessionId = this.resumeSessionId;
    this._ensureJsonlWriter();

    this.emit('agent_relay_ready', {
      backend_url: creds.backendUrl,
      root_path: this.session.root_path,
      tools: toolExecutor.listTools?.().length || 0,
      backend_session_id: this.client.sessionId || null,
      approval_mode: this.approvalAutoMode ? 'auto' : 'ask',
    });
  }

  _ensureJsonlWriter() {
    if (!this.jsonlWriter) {
      this.jsonlWriter = new JsonlWriter(this.session.root_path, VERSION);
    }
    if (this.resumeSessionId && !this.jsonlWriter.sessionId) {
      this.jsonlWriter.setSessionId(this.resumeSessionId);
    }
    return this.jsonlWriter;
  }

  async _buildExecContext(instruction) {
    await this.toolExecutor.registerProjectRoots?.([this.session.root_path], { forceRefresh: false });
    const projectResources = this.toolExecutor.getProjectResources();
    const execContext = {
      cwd: this.session.root_path,
      project_resources: projectResources,
      work_scope: buildWorkScope({
        instruction,
        cwd: this.session.root_path,
        projectResources,
      }),
      agent_context: this.toolExecutor.getAgentContext(),
      local_service: {
        product: 'bahulam-local-service',
        session_id: this.session.id,
        machine_id: this.session.machine_id || null,
        root_path: this.session.root_path,
        focus_path: this.session.focus_path || '',
      },
    };

    const modelConfig = this.creds.modelConfig || {};
    if (Object.keys(modelConfig).length > 0) {
      execContext.model_overrides = modelConfig;
      if (modelConfig.reasoning) execContext.model_override = modelConfig.reasoning;
    }
    if (this.creds.modelMode) execContext.model_mode = this.creds.modelMode;
    if (this.creds.routePreference) execContext.model_route = this.creds.routePreference;
    return execContext;
  }

  _buildInstruction(prompt, currentPath, attachments = []) {
    const lines = [
      'You are running inside Bahulam Local IDE.',
      `The user granted this local workspace root: ${this.session.root_path}`,
    ];
    if (this.session.focus_path) lines.push(`The session focus file is: ${this.session.focus_path}`);
    if (currentPath) lines.push(`The browser currently selected: ${currentPath}`);
    if (attachments.length) {
      lines.push('', 'Attached files for this turn:');
      for (const file of attachments) {
        const hint = attachmentToolHint(file);
        const bits = [
          file.kind || file.viewer || 'file',
          file.mime_type || '',
          file.size != null ? `${file.size} bytes` : '',
          hint ? `suggested_tool=${hint}` : '',
        ].filter(Boolean).join(', ');
        lines.push(`- ${file.name || file.path} (${bits}) path=${file.path}`);
      }
      lines.push(
        'Use analyze_image(path=..., question=...) for images.',
        'Use read_table(path=...) for CSV/TSV/Excel-style tables.',
        'Use read_attachment(path=...) for text, PDFs, Markdown, JSON/YAML, and Jupyter notebooks.',
        'For unsupported binary files, inspect metadata or ask before attempting lossy conversion.',
      );
    }
    lines.push(
      'Use CLI-local tools for file, shell, code, and document work.',
      'Do not operate outside the granted workspace root unless the user explicitly asks and the local permission layer allows it.',
      '',
      'User request:',
      prompt,
    );
    return lines.join('\n');
  }

  _historySnapshot() {
    return {
      ok: true,
      backend_session_id: this.resumeSessionId || null,
      history_mode: this.resumeSessionId ? this.historyMode : 'new',
      messages: browserMessages(this.displayHistory),
      trace: browserTraceItems(this.displayHistory),
      agent_messages: this.agentHistory.length,
    };
  }

  _emitAgentEvent(event, { turnId, contentText = null }) {
    const type = event?.type || 'unknown';
    const data = event?.data || {};

    switch (type) {
      case 'session_info':
        this.emit('agent_session', { turn_id: turnId, ...pick(data, ['session_id', 'task_id', 'model', 'route']) });
        break;
      case 'status':
      case 'phase_update':
      case 'worker_update':
        this.emit('agent_status', { turn_id: turnId, type, message: data.message || data.status || data.phase || '', data });
        break;
      case 'thinking':
        this.emit('agent_reasoning', { turn_id: turnId, text: data.text || data.thinking || data.delta || '', data });
        break;
      case 'content_partial':
      case 'content': {
        const text = contentText ?? data.text ?? data.content ?? '';
        this.emit('agent_content', { turn_id: turnId, text, partial: type === 'content_partial' });
        return;
      }
      case 'tool_call':
      case 'tool_request':
        this.emit('agent_tool_call', {
          turn_id: turnId,
          tool: data.tool || '',
          call_id: data.call_id || data.request_id || '',
          args: data.args || {},
          internal: Boolean(data.internal || data.sub_agent),
          sub_agent: data.sub_agent || null,
        });
        break;
      case 'tool_result':
      case 'tool_done':
        this.emit('agent_tool_result', {
          turn_id: turnId,
          tool: data.tool || '',
          call_id: data.call_id || data.request_id || '',
          success: data.success !== false,
          duration_ms: data.duration_ms || null,
          output: truncateOutput(data.output || data.message || data.error || ''),
          internal: Boolean(data.internal || data.sub_agent),
          sub_agent: data.sub_agent || null,
        });
        break;
      case 'approval_required':
        this.emit('agent_approval_event', {
          turn_id: turnId,
          state: 'required',
          approval_id: data.tool_id || data.approval_id || '',
          tool: data.tool || '',
          call_id: data.call_id || data.request_id || data.tool_id || '',
          args: data.args || {},
          tier: data.tier || data.risk || '',
          reason: data.reason || '',
          data,
        });
        break;
      case 'approval_granted':
      case 'approval_denied':
        this.emit('agent_approval_event', {
          turn_id: turnId,
          state: type === 'approval_granted' ? 'granted' : 'denied',
          approval_id: data.tool_id || data.approval_id || '',
          tool: data.tool || '',
          call_id: data.call_id || data.request_id || data.tool_id || '',
          args: data.args || {},
          tier: data.tier || data.risk || '',
          reason: data.reason || '',
          data,
        });
        break;
      case 'user_intervention_accepted':
      case 'user_intervention_delivered':
      case 'user_intervention_queued':
        this.emit('agent_followup_event', { turn_id: turnId, type, data });
        break;
      case 'cancelled':
        this.cancellationRequested = true;
        if (!this.cancellationEventEmitted) {
          this.cancellationEventEmitted = true;
          this.emit('agent_turn_cancelled', {
            turn_id: turnId,
            task_id: data.task_id || this.client?.currentTaskId || null,
            reason: data.reason || 'Cancelled by user',
            data,
          });
        }
        break;
      case 'sub_agent_start':
      case 'sub_agent_complete':
      case 'delegation':
        this.emit('agent_activity', { turn_id: turnId, type, data });
        break;
      case 'error':
        this.emit('agent_error', { turn_id: turnId, ...data });
        break;
      case 'complete':
        this.emit('agent_complete', { turn_id: turnId, data });
        break;
      default:
        this.emit('agent_event', { turn_id: turnId, type, data });
        break;
    }
  }
}

function normalizeTurnAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .map((file) => ({
      name: String(file?.name || '').slice(0, 240),
      path: String(file?.path || file?.upload_path || '').trim(),
      size: Number.isFinite(Number(file?.size)) ? Number(file.size) : null,
      mime_type: String(file?.mime_type || '').slice(0, 120),
      kind: String(file?.kind || file?.viewer || '').slice(0, 80),
      viewer: String(file?.viewer || '').slice(0, 80),
    }))
    .filter((file) => file.path)
    .slice(0, 20);
}

function attachmentToolHint(file) {
  const kind = String(file?.kind || file?.viewer || '').toLowerCase();
  const mime = String(file?.mime_type || '').toLowerCase();
  const ext = String(file?.path || file?.name || '').split('.').pop().toLowerCase();
  if (kind === 'image' || mime.startsWith('image/')) return 'analyze_image';
  if (kind === 'spreadsheet' || kind === 'table' || ['csv', 'tsv', 'xlsx', 'xls', 'ods'].includes(ext)) return 'read_table';
  if (['pdf', 'markdown', 'text', 'code', 'config', 'notebook'].includes(kind) || ['txt', 'md', 'mdx', 'pdf', 'json', 'yaml', 'yml', 'toml', 'html', 'xml', 'ipynb', 'log', 'rst', 'sql', 'sh'].includes(ext)) return 'read_attachment';
  return '';
}

async function transcriptsForRoot(rootPath) {
  const target = realpathOrSelf(rootPath);
  const sessions = await getRecentSessions(Infinity);
  return sessions.filter((session) => {
    const project = session.projectPath || session.project || '';
    return project && realpathOrSelf(project) === target;
  });
}

async function transcriptForRootBySessionId(rootPath, sessionId) {
  const sessions = await transcriptsForRoot(rootPath);
  return sessions.find((session) => session.sessionId === sessionId) || null;
}

function serializeTranscriptSession(session) {
  const tools = Array.isArray(session.toolCalls)
    ? session.toolCalls.map((tool) => `${tool.name} x${tool.count}`).slice(0, 4)
    : [];
  return {
    session_id: session.sessionId,
    first_prompt: session.firstPrompt || '',
    project_path: session.projectPath || session.project || '',
    transcript_path: session.filePath || '',
    started_at: session.startTime || null,
    last_activity_at: session.endTime || null,
    status: session.endStatus || 'unknown',
    user_messages: session.userMessages || 0,
    assistant_messages: session.assistantMessages || 0,
    context_tokens: session.contextTokens || 0,
    tools,
    models: Array.isArray(session.models) ? session.models.slice(0, 3) : [],
  };
}

function realpathOrSelf(inputPath) {
  try {
    return fs.realpathSync(inputPath);
  } catch {
    return String(inputPath || '');
  }
}

function contentDeltaForEvent(event, current) {
  const type = event?.type || '';
  if (type !== 'content_partial' && type !== 'content') return null;
  const text = event?.data?.text ?? event?.data?.content ?? '';
  if (!text) return { delta: '', next: current };
  if (type === 'content_partial') return { delta: text, next: current + text };
  const delta = current && text.startsWith(current)
    ? text.slice(current.length)
    : text === current
      ? ''
      : text;
  const next = current && !text.startsWith(current) ? current + text : text;
  return { delta, next };
}

function browserMessages(history = []) {
  return history
    .filter((entry) => entry?.role === 'user' || entry?.role === 'assistant')
    .map((entry) => ({
      role: entry.role,
      content: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content || ''),
      timestamp: entry.timestamp || null,
    }));
}

function browserTraceItems(history = []) {
  return history
    .filter((entry) => entry?.role === 'tool')
    .map((entry) => ({
      type: `history_tool_${entry.kind || 'event'}`,
      timestamp: entry.timestamp || null,
      tool: entry.tool || null,
      kind: entry.kind || null,
      content: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content || ''),
    }));
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter(key => obj[key] !== undefined).map(key => [key, obj[key]]));
}

function truncateOutput(value, max = 1600) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
