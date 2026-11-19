/**
 * Event tap — bridges SSE events from the agent loop to the relay.
 *
 * Each SSE event type is mapped to a relay event type. The mapping
 * is a fixed table. Keeping it centralized avoids scattering
 * relay-specific concerns across the agent loop. *   • Cache-invariance ( §7): this tap is READ-ONLY on the SSE
 *     event. It never mutates `event`, never changes what stream-client
 *     yields, and writes to a local file only. `/api/execute` body is
 *     untouched.
 *
 * NOT in scope for .3:
 *   • Broadcasting events to attached socket clients (.4).
 *   • Compact snapshot writing (.4 — the daemon supervisor
 *     decides when to snapshot; the tap doesn't).
 *   • Deriving  events that don't have a direct SSE origin
 *     (e.g. `attach_joined`, `input_lock_changed` — those come from
 *     the socket server, not the SSE stream).
 */

import { displayPayloadStore } from './display-payload-store.mjs';
import { createEventLog } from '../core/event-log.mjs';
import { createHash } from 'node:crypto';
import { toLegacyEvent } from '../protocol/compat.mjs';
import { sanitizeDisplayValue } from '../core/display-sanitize.mjs';
import { isSensitiveConfigPath } from '../core/safety.mjs';

// ── env-var gate ─────────────────────────────────────────────────────

function _enabled() {
  const v = process.env.BAHULAM_DAEMON_EVENTLOG;
  return v === '1' || v === 'true';
}

// ── per-session lazy log holder ──────────────────────────────────────
//
// One active log at a time. Session id change (via new turn's session_info)
// closes the old log and opens a new one. `_current` is null when the tap
// hasn't seen a session id yet — session_info events don't always arrive
// before other events do, so we buffer nothing and simply drop events
// that arrive before the id is known. First real event a re-attach sees
// is session_started; anything before that is renderer-only anyway.

let _current = null;  // { sessionId, log }

function _openLogFor(sessionId) {
  if (_current && _current.sessionId === sessionId) return _current.log;
  if (_current) {
    // Fire-and-forget close on the previous log. The write chain resolves
    // internally; we don't await here because tapSseEvent is called from
    // a hot loop that can't afford to block.
    try { _current.log.close().catch(() => {}); } catch { /* ignore */ }
  }
  const log = createEventLog({ sessionId });
  _current = { sessionId, log, turnId: null };
  return log;
}

/** Test / bahulam-stop hook — close the active log and drop the ref. */
export async function closeActiveEventLog() {
  if (!_current) return;
  const { log } = _current;
  _current = null;
  try { await log.close(); } catch { /* ignore */ }
  _broadcasters.length = 0;
}

// ── broadcasters (.4) ─────────────────────────────────────────
//
// Live clients receive projected events independently of optional disk
// logging. Socket and dashboard clients also receive events when persistence
// is on. Broadcasters are fire-and-forget and must not block the tap.
//
// Registration is process-global (one bahulamd = one process = one tap
// registry). Multiple socket servers CAN register; the tap doesn't care.

const _broadcasters = [];
const _transientPayloads = new Map();
let _transientPayloadBytes = 0;
let _wireState = null;

/**
 * Register a broadcaster. Returns an unregister function.
 * Persistence is controlled by BAHULAM_DAEMON_EVENTLOG; live-only clients
 * opt in with `live: true`. Existing subscribers get v1; a new client can
 * request schema version 2.
 */
export function registerBroadcaster(fn, { schemaVersion = 1, live = false, retainDetails = false } = {}) {
  if (typeof fn !== 'function') throw new Error('registerBroadcaster: fn must be a function');
  if (![1, 2].includes(schemaVersion)) throw new Error('Unsupported broadcaster schema version');
  const subscriber = { fn, schemaVersion, live: live === true, retainDetails: retainDetails === true };
  _broadcasters.push(subscriber);
  return () => {
    const i = _broadcasters.indexOf(subscriber);
    if (i >= 0) _broadcasters.splice(i, 1);
    if (subscriber.live && !_broadcasters.some(entry => entry.live)) {
      _transientPayloads.clear();
      _transientPayloadBytes = 0;
    }
  };
}

/** Read an in-memory detail payload emitted to a live client when disk logging is off. */
export function readTransientPayload(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('memory:')) return undefined;
  const serialized = _transientPayloads.get(ref);
  return serialized ? JSON.parse(serialized) : undefined;
}

function retainTransientPayload(ref, serialized) {
  const bytes = Buffer.byteLength(serialized);
  if (bytes > 64 * 1024 * 1024) return false;
  while (_transientPayloads.size >= 128 || _transientPayloadBytes + bytes > 64 * 1024 * 1024) {
    const oldest = _transientPayloads.keys().next().value;
    if (!oldest) break;
    _transientPayloadBytes -= Buffer.byteLength(_transientPayloads.get(oldest) || '');
    _transientPayloads.delete(oldest);
  }
  _transientPayloads.set(ref, serialized);
  _transientPayloadBytes += bytes;
  return true;
}

function boundedMetadata(data) {
  const safe = Object.fromEntries(Object.entries(data).filter(([key, value]) =>
    key !== 'args' && ((key === 'scopes' && Array.isArray(value) && value.length <= 4 && value.every(scope => ['once', 'session', 'project', 'type'].includes(scope))) || typeof value === 'boolean' || typeof value === 'number' ||
      (typeof value === 'string' && Buffer.byteLength(value) <= (['preview', 'result'].includes(key) ? 2400 : 256)))));
  return Buffer.byteLength(JSON.stringify(safe)) <= 3072 ? safe : {};
}

// ── SSE →  event mapping ──────────────────────────────────────
//
// PRD-121 Phase 0. New producer-only types are accepted here, but wiring
// shell-output/lifecycle/artifact emitters belongs to the live-client phase.

const SSE_TO_V2 = Object.freeze({
  session_info: 'session_started', turn_started: 'turn_started', turn_ended: 'turn_ended',
  content_partial: 'text_delta', content: 'message_end', thinking: 'thinking_delta',
  tool_request: 'tool_requested', tool_call: 'tool_requested',
  tool_result: 'tool_finished', tool_done: 'tool_finished',
  tool_started: 'tool_started', tool_output_delta: 'tool_output_delta',
  approval_required: 'approval_required', approval_decided: 'approval_decided',
  sub_agent_start: 'agent_spawned', worker_start: 'agent_spawned',
  sub_agent_complete: 'agent_finished', worker_done: 'agent_finished',
  worker_update: 'agent_status', agent_status: 'agent_status',
  plan: 'plan_updated', plan_created: 'plan_updated', artifact_created: 'artifact_created',
  file_diff: 'diff', diff: 'diff', test_result: 'test_result',
  command_result: 'command_result',
  tokens_used: 'usage_update', usage_update: 'usage_update', complete: 'turn_ended',
  error: 'notice', reconnecting: 'notice', reconnected: 'notice',
  reconnect_failed: 'notice', stagnation_detected: 'notice', stagnation: 'notice',
  status: 'notice', phase_start: 'notice', phase_update: 'notice', phase_summary: 'notice',
  delegation: 'notice', sub_agent_tool: 'notice', sub_agent_tool_result: 'notice',
  summarize: 'notice', change: 'notice', goal_created: 'notice',
  followup_applied: 'notice', followup_held: 'notice', followup_save_failed: 'notice', user_intervention_queued: 'notice', user_intervention_accepted: 'notice', user_intervention_delivered: 'notice',
  cancelled: 'turn_ended', paused: 'notice', resumed: 'notice', pause_instruction: 'notice',
  approval_granted: 'approval_decided', approval_denied: 'approval_decided',
  graph_node_start: 'agent_spawned', graph_node_result: 'agent_finished',
  graph_run_start: 'notice', graph_run_result: 'notice',
});

function asText(value) {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value.message === 'string') return value.message;
  return JSON.stringify(value);
}

function truncateUtf8(value, maxBytes, fromEnd = false) {
  const chars = Array.from(String(value));
  const kept = [];
  let bytes = 0;
  const ordered = fromEnd ? chars.reverse() : chars;
  for (const char of ordered) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    kept.push(char);
    bytes += size;
  }
  return fromEnd ? kept.reverse().join('') : kept.join('');
}

function toolOutputPreview(output, ok) {
  const rows = String(output).replace(/\r\n?/g, '\n').split('\n');
  if (rows.at(-1) === '') rows.pop();
  const chosen = ok ? rows.slice(0, 3) : rows.slice(-20);
  const scan = ok ? chosen : chosen.slice().reverse();
  const kept = [];
  let remaining = 2400;
  for (const row of scan) {
    if (remaining <= 0) break;
    const separator = kept.length ? 1 : 0;
    const text = truncateUtf8(row, remaining - separator, !ok);
    if (!text && row) break;
    kept.push(text);
    remaining -= Buffer.byteLength(text) + separator;
  }
  return (ok ? kept : kept.reverse()).join('\n');
}

function compactToolPreview(name, args = {}) {
  const tool = String(name || '').toLowerCase();
  const filePath = args.file_path || args.path;
  if (isSensitiveConfigPath(filePath)) return 'content redacted · sensitive config file';
  if (tool === 'apply_patch' && String(args.patch ?? args.content ?? '').includes('.env')) {
    return 'patch content redacted · may contain sensitive config';
  }
  let label = 'content';
  let content;
  if (tool === 'write_file') content = args.content;
  else if (tool === 'edit_file' || tool === 'multi_edit') {
    label = 'replacement';
    content = args.replace ?? args.new_string ?? args.newString;
  } else if (tool === 'apply_patch') {
    label = 'patch';
    content = args.patch ?? args.content;
  }
  if (typeof content !== 'string') {
    if (tool === 'write_project' && Array.isArray(args.files)) {
      return `${args.files.length} files · ${args.files.slice(0, 2).map(file => {
        const path = file.path || file.file_path || 'unnamed';
        return isSensitiveConfigPath(path) ? `${path} [redacted]` : path;
      }).join(', ')}`;
    }
    return '';
  }
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const sample = lines.slice(0, 2).map(line => line.length > 72 ? `${line.slice(0, 69)}…` : line);
  const preview = `${label} · ${lines.length} lines\n${sample.join('\n')}`;
  const bytes = Buffer.from(preview, 'utf8');
  return bytes.length <= 240 ? preview : `${bytes.subarray(0, 237).toString('utf8')}…`;
}

function compactToolPrimary(args = {}) {
  for (const key of ['path', 'file_path', 'command', 'query', 'pattern', 'target', 'url']) {
    if (typeof args[key] === 'string' && args[key]) return args[key].slice(0, 220);
  }
  if (Array.isArray(args.files)) return `${args.files.length} files`;
  return '';
}

function normalizedUsage(src = {}) {
  src ||= {};
  const usage = src.tokens ?? src.usage ?? src;
  const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const input = numeric(usage.input_tokens ?? usage.total_input_tokens ?? usage.prompt_tokens ?? usage.input ?? usage.prompt);
  const output = numeric(usage.output_tokens ?? usage.total_output_tokens ?? usage.completion_tokens ?? usage.output ?? usage.completion);
  const total = numeric(typeof usage === 'number' ? usage : usage.total_tokens ?? usage.total)
    ?? (input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined);
  return { input_tokens: input, output_tokens: output, total_tokens: total,
    cost_usd: numeric(src.cost_usd ?? src.total_cost_usd ?? src.cost ?? usage.cost_usd ?? usage.total_cost_usd ?? usage.total_cost ?? usage.cost) };
}

function project(type, src, identity) {
  const toolId = src.call_id || src._callId || src.tool_call_id || src.tool_id || src.request_id || src.id || `unattributed:${identity.nextSeq}`;
  switch (type) {
    case 'tool_requested': {
      const name = src.tool || src.name || 'unknown';
      const args = src.args || src.tool_input || src.input || {};
      return { name, tool_id: toolId,
        args, primary: compactToolPrimary(args), preview: compactToolPreview(name, args), cwd: src.cwd,
        risk_tier: src.risk_tier, reason: src.reason };
    }
    case 'tool_started':
      return { tool_id: toolId };
    case 'tool_output_delta':
      return { tool_id: toolId, stream: src.stream === 'stderr' ? 'stderr' : 'stdout', chunk: asText(src.chunk ?? src.text) || '' };
    case 'tool_finished': {
      const ok = !src.error && !src.is_error && src.ok !== false && src.success !== false &&
        !(src.exit_code != null && Number(src.exit_code) !== 0);
      return { tool_id: toolId, ok,
        exit_code: src.exit_code, duration_ms: src.duration_ms ?? src.durationMs,
        summary: typeof src.output === 'string' ? src.output.slice(0, 220) :
          (src.summary ? asText(src.summary).slice(0, 220) :
            (src.output == null ? asText(src.error)?.slice(0, 220) : JSON.stringify(src.output).slice(0, 220))),
        preview: typeof src.output === 'string' ? toolOutputPreview(src.output, ok) :
          (src.summary ? truncateUtf8(asText(src.summary), 2400) :
            (src.error ? truncateUtf8(asText(src.error), 2400, !ok) : undefined)),
        output: src.output ?? asText(src.error), diff_stats: src.diff_stats, output_ref: src.output_ref };
    }
    case 'text_delta':
    case 'thinking_delta':
      return { chunk: asText(src.chunk ?? src.text ?? src.message) || '' };
    case 'message_end': {
      const text = asText(src.text || src.content) || '';
      return { text, final_text_hash: createHash('sha256').update(text).digest('hex') };
    }
    case 'session_started':
      return { cwd: src.cwd, model: src.model, product: src.product, session_id_from_backend: src.session_id };
    case 'turn_ended':
      return { ok: !src.error && src.ok !== false && identity.sourceType !== 'cancelled',
        outcome: identity.sourceType === 'cancelled' ? 'cancelled' : undefined,
        summary: asText(src.summary ?? src.message ?? src.reason), duration_ms: src.duration_ms, turn_cost_usd: src.turn_cost_usd };
    case 'agent_spawned':
      return { agent_id: identity.agentId, type: src.type || src.worker || src.name || src.agent || src.sub_agent || 'agent',
        task: src.task || src.query || '', model: src.model };
    case 'agent_finished': {
      const ok = !src.error && src.ok !== false && src.success !== false && src.status !== 'failed';
      const report = asText(src.report || src.summary || src.output) || '';
      const error = asText(src.error);
      return { agent_id: identity.agentId, ok,
        report: [report, error && !ok ? `Error: ${error}` : ''].filter(Boolean).join('\n\n'),
        tokens: typeof src.tokens === 'number' ? {total:src.tokens} : (src.tokens ?? normalizedUsage(src)), ...normalizedUsage(src), elapsed_ms: src.elapsed_ms ?? src.duration_ms, error };
    }
    case 'agent_status':
      return { agent_id: identity.agentId, status: src.status || src.message || (identity.sourceType === 'complete' ? 'done' : identity.sourceType === 'cancelled' ? 'cancelled' : 'working'),
        current_tool_id: src.current_tool_id, tokens: typeof src.tokens === 'number' ? {total:src.tokens} : (src.tokens ?? normalizedUsage(src)), ...normalizedUsage(src), elapsed_ms: src.elapsed_ms };
    case 'plan_updated':
      return { items: src.items || src.steps || src.plan?.items || [] };
    case 'usage_update': {
      const usage = src.usage || src;
      return { ...normalizedUsage(src),
        cache_tokens: usage.cache_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens ?? usage.cached,
        context_used_pct: usage.context_used_pct,
        per_agent: Object.fromEntries(Object.entries(usage.per_agent || {}).map(([id, value]) => [id, normalizedUsage(value)])) };
    }
    case 'test_result':
      return { ...src, ok: !src.error && src.ok !== false && src.success !== false && !(Number(src.failed) > 0) };
    case 'approval_required':
      return { ...src, apr_id: src.apr_id || '', name: src.name || src.tool || src.tool_name || src.kind,
        risk_tier: src.risk_tier || src.risk, cwd: src.cwd };
    case 'approval_decided':
      return { ...src, apr_id: src.apr_id || src.approval_id || src.request_id,
        decision: src.decision || (identity.sourceType === 'approval_denied' ? 'deny' : identity.sourceType === 'approval_granted' ? 'allow' : undefined) };
    case 'notice': {
      const source = identity.sourceType;
      const progress = ['status', 'phase_start', 'phase_update', 'phase_summary', 'sub_agent_tool', 'sub_agent_tool_result'];
      const title = source === 'delegation' ? `Delegation ${src.from || 'main'} → ${src.to || 'agent'}` :
        source.replaceAll('_', ' ');
      const description = asText(src.message ?? src.summary ?? src.reason ?? src.error ?? src.output ??
        src.phase ?? src.stage_name ?? src.path ?? src.goal ?? src.instruction ?? src.text ?? src.tool ?? src.name);
      return { level: source === 'error' || source === 'reconnect_failed' || src.success === false || src.error ? 'error' : 'info',
        title: ['error', 'reconnecting', 'reconnected', 'reconnect_failed', 'stagnation_detected', 'stagnation'].includes(source)
          ? asText(src.message || src.error) || title : title,
        cause: asText(src.cause) || description,
        next_step: src.next_step || (source === 'error' || source === 'reconnect_failed'
          ? 'Use /resume to continue or inspect the session log.' : undefined),
        retry: src.retry, source,
        progress_key: progress.includes(source) && src.success !== false && !src.error ? (source.startsWith('phase_') ? 'phase' : source.startsWith('sub_agent_tool') ? 'agent-tool' : source) : undefined,
        activity: source === 'paused' ? 'paused' : source === 'resumed' ? 'working' : undefined,
        current_tool: source.startsWith('sub_agent_tool') ? asText(src.tool || src.name) : undefined,
        tool_active: source.startsWith('sub_agent_tool') ? source === 'sub_agent_tool' : undefined };
    }
    case 'command_result':
      return { name: asText(src.name) || 'command', added_to_context: false,
        result: (asText(src.preview ?? src.result) || '(no output)').slice(0, 1200),
        output: asText(src.output ?? src.result) || '(no output)', ok: src.ok !== false };
    default: return src;
  }
}

/** Read-only SSE tap. Events persist when enabled and otherwise stay transient for live clients. */
export function tapSseEvent(event, { sessionId, turnId } = {}) {
  const persist = _enabled();
  const hasLiveClient = _broadcasters.some(subscriber => subscriber.live);
  if ((!persist && !hasLiveClient) || !event?.type || !sessionId) return;
  let type = SSE_TO_V2[event.type];
  if (!type) return;
  try {
    const log = persist ? _openLogFor(sessionId) : null;
    if (!_wireState || _wireState.sessionId !== sessionId) {
      _wireState = { sessionId, turnId: null, agentTurns: new Map(), seq: log?.currentSeq() || 0 };
    }
    const nextSeq = log ? log.currentSeq() + 1 : _wireState.seq + 1;
    const src = event.data || {};
    const scoped = type !== 'session_started';
    const agentEvent = type.startsWith('agent_') || event.type.startsWith('sub_agent_');
    // Graph node identity must be identical on lifecycle and namespaced inner events.
    // Explicit run IDs win; graph+node disambiguates simultaneous runs of the same agent.
    const agentId = src.sub_agent_run_id || src.agent_id || src.subagent_id || src.sub_agent_id || src.run_id ||
      (src.graph_run_id && src.node_id ? `graph:${src.graph_run_id}/node:${src.node_id}` :
        src.sub_agent || (agentEvent ? src.worker || src.name || 'unattributed-agent' :
          (src.internal ? 'unattributed-agent' : 'main')));
    const parentAgentId = agentId !== 'main' ? src.parent_agent_id || src.parent_run_id || 'main' : undefined;
    if (scoped && agentId === 'main') _wireState.turnId = turnId || src.turn_id || _wireState.turnId || `turn_${nextSeq}`;
    let eventTurnId = scoped ? _wireState.turnId : null;
    if (scoped && agentId !== 'main') {
      eventTurnId = turnId || src.turn_id || _wireState.agentTurns.get(agentId) || eventTurnId || `turn_${nextSeq}`;
      _wireState.agentTurns.set(agentId, eventTurnId);
    }
    if (type === 'turn_ended' && agentId !== 'main') type = 'agent_status';
    let data = sanitizeDisplayValue(project(type, src, { agentId, nextSeq, sourceType: event.type }));
    let wireEvent;
    if (log) {
      wireEvent = log.appendEvent(type, data, {
        turnId: eventTurnId, agentId, parentAgentId,
      });
    } else {
      const serialized = JSON.stringify(data);
      let payloadRef;
      if (Buffer.byteLength(serialized) > 4096) {
        const retain = _broadcasters.some(subscriber => subscriber.live && subscriber.retainDetails);
        payloadRef = retain ? displayPayloadStore().put(sessionId, serialized, event) : undefined;
        if (!payloadRef) payloadRef = `memory:${sessionId}:${nextSeq}`;
        if (payloadRef.startsWith('memory:') && !retainTransientPayload(payloadRef, serialized)) {
          throw new Error('live detail payload exceeds the 64 MiB display limit');
        }
        data = boundedMetadata(data);
      }
      wireEvent = {
        seq: nextSeq, ts: new Date().toISOString(), type, session_id: sessionId,
        v: 2, turn_id: eventTurnId, agent_id: agentId,
        ...(parentAgentId ? { parent_agent_id: parentAgentId } : {}),
        id: `${sessionId}:${nextSeq}`, ...(payloadRef ? { payload_ref: payloadRef } : {}), data,
      };
    }
    _wireState.seq = wireEvent.seq;
    if (type === 'agent_finished') _wireState.agentTurns.delete(agentId);
    if (type === 'turn_ended' && agentId === 'main') _wireState.turnId = null;
    for (const { fn, schemaVersion } of _broadcasters) {
      try {
        const frame = schemaVersion === 2 ? wireEvent : toLegacyEvent(wireEvent);
        if (frame) fn(frame);
      }
      catch (err) { try { process.stderr.write(`[event-tap] broadcaster failed: ${err.message}\n`); } catch {} }
    }
  } catch (err) {
    try { process.stderr.write(`[event-tap] writeEvent failed: ${err.message}\n`); } catch {}
  }
}
