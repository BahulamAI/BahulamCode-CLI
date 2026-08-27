/**
 * Browser-local agent relay.
 *
 * Bridges a local workspace browser session to the same CLI-owned remote
 * agent path used by the terminal: TarangStreamClient + local ToolExecutor.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { TarangAuth } from '../auth/tarang-auth.mjs';
import { AgentHistoryTurnBuilder } from '../core/agent-history.mjs';
import { ApprovalManager } from '../core/approval.mjs';
import { JsonlWriter } from '../core/jsonl-writer.mjs';
import {
  buildResumeHistory,
  getRecentSessions,
  getSessionDetail,
} from '../core/local-store.mjs';
import { TarangStreamClient } from '../core/stream-client.mjs';
import { createToolExecutor } from '../core/tool-executor.mjs';
import { buildWorkScope } from '../core/work-scope.mjs';

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
    this.resumeLoaded = false;
    this.resumeSessionId = null;
    this.historyMode = 'full';
    this.displayHistory = [];
    this.agentHistory = [];
    this.jsonlWriter = null;
  }

  async loadHistory() {
    if (this.resumeLoaded) return this._historySnapshot();
    this.resumeLoaded = true;

    try {
      const match = await latestTranscriptForRoot(this.session.root_path);
      if (!match) return this._historySnapshot();

      const detail = await getSessionDetail(match.sessionId, { filePath: match.filePath });
      if (!detail) return this._historySnapshot();

      const history = buildResumeHistory({ ...detail, recapTailTurns: 8 }, this.historyMode);
      this.resumeSessionId = match.sessionId;
      this.displayHistory = history.displayHistory || [];
      this.agentHistory = history.agentHistory || [];
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

  async runTurn({ prompt, path = '.' } = {}) {
    const instruction = String(prompt || '').trim();
    if (!instruction) {
      const err = new Error('prompt is required');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    if (this.running) {
      const err = new Error('A local agent turn is already running for this workspace');
      err.code = 'CONFLICT';
      throw err;
    }

    await this.loadHistory();
    await this._ensureReady();

    this.running = true;
    this.turnCount += 1;
    const turnId = `turn_${Date.now().toString(36)}_${this.turnCount}`;
    const relayInstruction = this._buildInstruction(instruction, path);
    const writer = this._ensureJsonlWriter();
    const turnHistory = new AgentHistoryTurnBuilder();
    let content = '';
    let assistantContent = '';
    let eventCount = 0;
    let userTurnWritten = false;
    const writeUserTurn = () => {
      if (userTurnWritten) return;
      writer.writeUserTurn(instruction);
      writer.writeHistory(instruction);
      userTurnWritten = true;
    };
    if (this.client.sessionId) writeUserTurn();

    this.emit('agent_turn_started', {
      turn_id: turnId,
      prompt: instruction.slice(0, 500),
      cwd: this.session.root_path,
      path,
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
        writer.writeKeplerEvent(event);

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
      }

      if (!userTurnWritten && this.client.sessionId) writeUserTurn();
      this.displayHistory.push({
        role: 'user',
        content: instruction,
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
        this.agentHistory.push({ role: 'user', content: instruction }, ...structuredTurn);
      } else if (assistantContent) {
        this.agentHistory.push({ role: 'user', content: instruction }, { role: 'assistant', content: assistantContent });
      } else {
        this.agentHistory.push({ role: 'user', content: instruction });
      }
      await writer.flush();

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
    try {
      await this.jsonlWriter?.close?.();
    } catch {}
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
    const auth = new TarangAuth();
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

    const approval = new ApprovalManager({
      autoApprove: true,
      cwd: this.session.root_path,
    });

    this.creds = creds;
    this.toolExecutor = toolExecutor;
    this.client = new TarangStreamClient({
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
      skip_permissions: true,
      freeswim: true,
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

  _buildInstruction(prompt, currentPath) {
    const lines = [
      'You are running inside Bahulam Local IDE.',
      `The user granted this local workspace root: ${this.session.root_path}`,
    ];
    if (this.session.focus_path) lines.push(`The session focus file is: ${this.session.focus_path}`);
    if (currentPath) lines.push(`The browser currently selected: ${currentPath}`);
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

async function latestTranscriptForRoot(rootPath) {
  const target = realpathOrSelf(rootPath);
  const sessions = await getRecentSessions(Infinity);
  return sessions.find((session) => {
    const project = session.projectPath || session.project || '';
    return project && realpathOrSelf(project) === target;
  }) || null;
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
    .filter((entry) => entry?.role === 'user' || entry?.role === 'assistant' || entry?.role === 'tool')
    .map((entry) => ({
      role: entry.role,
      content: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content || ''),
      timestamp: entry.timestamp || null,
      tool: entry.tool || null,
      kind: entry.kind || null,
    }));
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter(key => obj[key] !== undefined).map(key => [key, obj[key]]));
}

function truncateOutput(value, max = 1600) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
