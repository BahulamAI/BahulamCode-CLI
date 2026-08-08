/**
 * Local Store Reader — scans ~/.bahulam/ JSONL files for historical stats.
 *
 * Provides read helpers for CLI commands (/stats, /history, /tokens, /tools, /sessions).
 * All data comes from local JSONL files — no cloud dependency.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { bahulamHome } from './paths.mjs';

const KEPLER_DIR = bahulamHome();
const PROJECTS_DIR = path.join(KEPLER_DIR, 'projects');

function normalizeBlock(block) {
  if (!block || typeof block !== 'object') {
    return { type: 'unknown', value: String(block ?? '') };
  }
  if (block.type === 'text') {
    return { type: 'text', text: block.text || '' };
  }
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id || null,
      name: block.name || 'unknown',
      input: block.input || {},
    };
  }
  if (block.type === 'tool_result') {
    return {
      type: 'tool_result',
      tool_use_id: block.tool_use_id || null,
      content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || ''),
      is_error: !!block.is_error,
    };
  }
  return { ...block };
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(normalizeBlock);
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function truncateText(text, max = 1200) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return compact.slice(0, max - 3) + '...';
}

function stringifyInput(input) {
  try {
    return JSON.stringify(input || {});
  } catch {
    return String(input || {});
  }
}

function entryText(entry) {
  if (typeof entry.content === 'string') return entry.content;
  if (!Array.isArray(entry.content)) return '';
  return entry.content
    .filter(block => block.type === 'text')
    .map(block => block.text || '')
    .filter(Boolean)
    .join('\n');
}

function entryToolUses(entry) {
  return Array.isArray(entry.content)
    ? entry.content.filter(block => block.type === 'tool_use')
    : [];
}

function entryToolResults(entry) {
  return Array.isArray(entry.content)
    ? entry.content.filter(block => block.type === 'tool_result')
    : [];
}

/**
 * List all session JSONL files across all projects.
 * Returns [{slug, sessionId, filePath, mtime}] sorted by mtime desc.
 */
function listSessionFiles() {
  const results = [];
  try {
    const slugs = fs.readdirSync(PROJECTS_DIR);
    for (const slug of slugs) {
      const slugDir = path.join(PROJECTS_DIR, slug);
      if (!fs.statSync(slugDir).isDirectory()) continue;
      const files = fs.readdirSync(slugDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const filePath = path.join(slugDir, file);
        const stat = fs.statSync(filePath);
        results.push({
          slug,
          sessionId: file.replace('.jsonl', ''),
          filePath,
          mtime: stat.mtimeMs,
        });
      }
    }
  } catch { /* projects dir may not exist yet */ }
  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

function findSessionFile(sessionId) {
  return listSessionFiles().find((entry) => entry.sessionId === sessionId) || null;
}

function looksLikeProjectRoot(dirPath) {
  return [
    '.git',
    'package.json',
    'pyproject.toml',
    'setup.py',
    'go.mod',
    'Cargo.toml',
  ].some(name => fs.existsSync(path.join(dirPath, name)));
}

function inferProjectRoot(rawPath) {
  if (!rawPath || typeof rawPath !== 'string' || !path.isAbsolute(rawPath)) return '';
  let current = rawPath;
  try {
    if (fs.existsSync(current) && fs.statSync(current).isFile()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(current) && looksLikeProjectRoot(current)) return current;
    current = path.dirname(current);
  }
  return fs.existsSync(rawPath) && fs.statSync(rawPath).isDirectory() ? rawPath : '';
}

function collectAbsoluteStrings(value, out = []) {
  if (typeof value === 'string') {
    if (path.isAbsolute(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAbsoluteStrings(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectAbsoluteStrings(item, out);
  }
  return out;
}

function collectAbsolutePathsFromText(text) {
  const out = [];
  const pattern = /\/(?:[^/\s'"`]+(?:[ /][^/\s'"`]+)*)/g;
  for (const match of String(text || '').matchAll(pattern)) {
    const raw = match[0].replace(/[),.;:]+$/, '');
    if (raw && path.isAbsolute(raw)) out.push(raw);
  }
  return out;
}

/**
 * Parse a session JSONL file and extract metadata.
 * Reads line-by-line (streaming) to handle large files.
 */
async function parseSessionMeta(filePath) {
  // PRD-068 §5.14.11: adds endStatus / contextTokens / costUsd / partial for
  // the /resume picker columns and the context-length driven mode decision.
  const meta = {
    sessionId: null,
    project: null,
    firstPrompt: null,
    userMessages: 0,
    assistantMessages: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolCalls: [],   // [{name, count}]
    models: [],      // [model strings]
    modelLimits: {},  // role -> {model, context_length, max_output, source}
    startTime: null,
    endTime: null,
    gitBranch: null,
    // ── PRD-068 §5.14 derived fields ───────────────────────────────────
    endStatus: 'unknown',   // 'completed' | 'interrupted' | 'errored' | 'unknown'
    contextTokens: 0,       // projected transcript size when serialized
    contextTokenSource: 'jsonl_bytes',
    costUsd: 0,             // sum of per-turn provider costs recorded in transcript
    partial: false,         // true if some lines failed to parse
    fileBytes: 0,           // raw file size (byte-based ctx fallback if no usage totals)
    resumeSummary: null,    // latest resume_summary marker, if the session has been checkpointed
  };

  const toolCounts = {};
  const modelSet = new Set();

  // endStatus tracking
  let lastMessageRole = null;
  let hadError = false;
  const pendingToolCalls = new Set(); // tool_use_ids awaiting a tool_result

  try {
    try { meta.fileBytes = fs.statSync(filePath).size; } catch {}

    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); }
      catch { meta.partial = true; continue; }

      if (obj.sessionId && !meta.sessionId) meta.sessionId = obj.sessionId;
      if (obj.cwd && !meta.project) meta.project = obj.cwd;
      if (obj.gitBranch && !meta.gitBranch) meta.gitBranch = obj.gitBranch;

      const ts = obj.timestamp;
      if (ts) {
        if (!meta.startTime || ts < meta.startTime) meta.startTime = ts;
        if (!meta.endTime || ts > meta.endTime) meta.endTime = ts;
      }

      // Backend kepler_event payloads may carry cost / error markers.
      if (obj.type === 'kepler_event' && obj.event) {
        const ev = obj.event;
        if (ev.type === 'complete' && typeof ev.cost_usd === 'number') meta.costUsd += ev.cost_usd;
        if (ev.type === 'session_info') {
          if (typeof ev.total_cost_usd === 'number') meta.costUsd = ev.total_cost_usd;
          const info = ev.data || ev;
          if (info.model_limits && typeof info.model_limits === 'object') {
            meta.modelLimits = info.model_limits;
          }
          if (info.models && typeof info.models === 'object') {
            for (const model of Object.values(info.models)) {
              if (typeof model === 'string' && model) modelSet.add(model);
            }
          }
        }
        if (ev.type === 'error' || ev.error === true) hadError = true;
        if (ev.type === 'resume_summary' && typeof ev.data?.summary === 'string') {
          meta.resumeSummary = {
            sourceMessageCount: Number(ev.data.source_message_count) || 0,
            previousSourceMessageCount: Number(ev.data.previous_source_message_count) || 0,
            fullMessageCount: Number(ev.data.full_message_count) || 0,
            summaryChars: ev.data.summary.length,
            summarySource: ev.data.summary_source || '',
            mode: ev.data.mode || '',
            modeLabel: ev.data.mode_label || '',
            timestamp: obj.timestamp || null,
          };
        }
      }

      if (obj.type === 'user') {
        meta.userMessages++;
        lastMessageRole = 'user';
        // Capture first user prompt (string content only)
        if (!meta.firstPrompt) {
          const content = obj.message?.content;
          if (typeof content === 'string' && content.length > 0) {
            meta.firstPrompt = content.slice(0, 100);
          }
        }
        // A user turn may carry tool_results — clear matched pending calls
        const content = obj.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              pendingToolCalls.delete(block.tool_use_id);
              if (block.is_error) hadError = true;
            }
          }
        }
      }

      if (obj.type === 'assistant') {
        meta.assistantMessages++;
        lastMessageRole = 'assistant';
        const usage = obj.message?.usage;
        if (usage) {
          meta.inputTokens += usage.input_tokens || 0;
          meta.outputTokens += usage.output_tokens || 0;
          meta.cacheReadTokens += usage.cache_read_input_tokens || 0;
          meta.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
        }
        const model = obj.message?.model;
        if (model) modelSet.add(model);

        // Count tool_use blocks — and track them as pending until we see the result
        const content = obj.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use' && block.name) {
              toolCounts[block.name] = (toolCounts[block.name] || 0) + 1;
              if (block.id) pendingToolCalls.add(block.id);
            }
          }
        }
      }
    }
  } catch { meta.partial = true; }

  meta.toolCalls = Object.entries(toolCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  meta.models = [...modelSet];

  // Projected context size for resume should estimate the serialized payload,
  // not cumulative provider usage. Provider input tokens are charged per turn
  // and include repeated/cache-read context, so summing them can show millions
  // of "context" tokens for a transcript that serializes far smaller.
  meta.contextTokens = Math.max(0, Math.round(meta.fileBytes / 4));

  // Derive endStatus from the tail of the transcript.
  if (hadError) {
    meta.endStatus = 'errored';
  } else if (pendingToolCalls.size > 0 || lastMessageRole === 'user') {
    meta.endStatus = 'interrupted';
  } else if (lastMessageRole === 'assistant') {
    meta.endStatus = 'completed';
  } else {
    meta.endStatus = 'unknown';
  }

  return meta;
}

/**
 * Get recent sessions with metadata.
 * @param {number} n — max sessions to return
 */
export async function getRecentSessions(n = 10) {
  const files = listSessionFiles().slice(0, n);
  const sessions = [];
  for (const f of files) {
    const meta = await parseSessionMeta(f.filePath);
    sessions.push({
      ...meta,
      slug: f.slug,
      filePath: f.filePath,
      mtime: f.mtime,
    });
  }
  return sessions;
}

/**
 * Return normalized entries for a single session transcript.
 * @param {string} sessionId
 */
export async function getSessionDetail(sessionId, options = {}) {
  const file = options.filePath
    ? {
        sessionId,
        slug: path.basename(path.dirname(options.filePath)),
        filePath: options.filePath,
        mtime: fs.statSync(options.filePath).mtimeMs,
      }
    : findSessionFile(sessionId);
  if (!file) return null;

  const entries = [];
  const replayEvents = [];
  const fileStream = fs.createReadStream(file.filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  let order = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const entryOrder = order++;

    if (obj.type === 'kepler_event' && obj.event?.type) {
      replayEvents.push({
        order: entryOrder,
        timestamp: obj.timestamp || null,
        event: obj.event,
      });
      continue;
    }

    const message = obj.message || {};
    entries.push({
      order: entryOrder,
      type: obj.type || null,
      timestamp: obj.timestamp || null,
      cwd: obj.cwd || null,
      role: message.role || null,
      model: message.model || null,
      usage: message.usage || null,
      content: normalizeMessageContent(message.content),
      uuid: obj.uuid || null,
      parentUuid: obj.parentUuid || null,
    });
  }

  const meta = await parseSessionMeta(file.filePath);
  return {
    sessionId: file.sessionId,
    slug: file.slug,
    filePath: file.filePath,
    mtime: file.mtime,
    meta,
    entries,
    replayEvents,
  };
}

/**
 * Convert a rich transcript into display history and backend continuity.
 * Display history is intentionally richer than backend history: it includes
 * tool calls/results so /history can reconstruct prior work.
 *
 * @param {object} detail - result from getSessionDetail()
 * @param {'compact'|'full'} mode
 */
export function buildResumeHistory(detail, mode = 'compact') {
  if (!detail) {
    return {
      displayHistory: [],
      agentHistory: [],
      summary: '',
      stats: { userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0 },
    };
  }

  const displayHistory = [];
  const fullAgentHistory = [];
  const userPrompts = [];
  const assistantTexts = [];
  const toolCounts = new Map();
  const importantResults = [];
  let toolCalls = 0;
  let toolResults = 0;

  for (const entry of detail.entries || []) {
    if (entry.role === 'user' && typeof entry.content === 'string') {
      const content = entry.content;
      displayHistory.push({ role: 'user', content, timestamp: entry.timestamp, order: entry.order });
      fullAgentHistory.push({ role: 'user', content });
      userPrompts.push(content);
      continue;
    }

    if (entry.role === 'assistant') {
      const text = entryText(entry);
      const tools = entryToolUses(entry);
      for (const tool of tools) {
        toolCalls++;
        toolCounts.set(tool.name, (toolCounts.get(tool.name) || 0) + 1);
        const line = `${tool.name} ${stringifyInput(tool.input)}`;
        displayHistory.push({
          role: 'tool',
          content: line,
          timestamp: entry.timestamp,
          order: entry.order,
          tool: tool.name,
          kind: 'call',
        });
      }
      if (text) {
        displayHistory.push({ role: 'assistant', content: text, timestamp: entry.timestamp, order: entry.order });
        assistantTexts.push(text);
      }

      const fullContent = [
        text,
        ...tools.map(tool => `[tool_call] ${tool.name} ${stringifyInput(tool.input)}`),
      ].filter(Boolean).join('\n\n');
      if (fullContent) fullAgentHistory.push({ role: 'assistant', content: fullContent });
      continue;
    }

    if (entry.role === 'user' && Array.isArray(entry.content)) {
      const results = entryToolResults(entry);
      for (const result of results) {
        toolResults++;
        const content = truncateText(result.content, 1200);
        const label = `[tool_result] ${result.tool_use_id || 'tool'}${result.is_error ? ' (error)' : ''}: ${content}`;
        displayHistory.push({
          role: 'tool',
          content: label,
          timestamp: entry.timestamp,
          order: entry.order,
          tool: result.tool_use_id || 'tool',
          kind: 'result',
        });
        fullAgentHistory.push({ role: 'user', content: label });
        if (importantResults.length < 12 && content) importantResults.push(label);
      }
    }
  }

  const toolSummary = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} x${count}`)
    .join(', ') || 'none recorded';
  const latestUser = userPrompts[userPrompts.length - 1] || detail.meta?.firstPrompt || '';
  const latestAssistant = assistantTexts[assistantTexts.length - 1] || '';
  const projectRoots = getTranscriptProjectRoots(detail);
  const summaryLines = [
    'Session continuity summary from the resumed local transcript.',
    `Session: ${detail.sessionId}`,
    detail.meta?.project ? `Project: ${detail.meta.project}` : '',
    projectRoots.length ? `Registered project roots: ${projectRoots.join(', ')}` : '',
    detail.meta?.startTime ? `Started: ${detail.meta.startTime}` : '',
    detail.meta?.endTime ? `Last activity: ${detail.meta.endTime}` : '',
    `Prior user requests (${userPrompts.length}):`,
    ...userPrompts.slice(-8).map(text => `- ${truncateText(text, 300)}`),
    `Assistant progress notes (${assistantTexts.length}):`,
    ...assistantTexts.slice(-6).map(text => `- ${truncateText(text, 400)}`),
    `Tools used: ${toolSummary}`,
    importantResults.length ? 'Important recent tool results:' : '',
    ...importantResults.slice(-8).map(text => `- ${truncateText(text, 500)}`),
    latestUser ? `Most recent user request: ${truncateText(latestUser, 500)}` : '',
    latestAssistant ? `Most recent assistant response: ${truncateText(latestAssistant, 500)}` : '',
  ].filter(Boolean);
  const summary = summaryLines.join('\n');
  const metadata = buildResumeMetadata({ detail, projectRoots, userPrompts, assistantTexts, toolCalls, toolResults, toolSummary });
  const originalRequest = userPrompts[0] || detail.meta?.firstPrompt || '';
  const summaryCheckpoint = latestResumeSummaryCheckpoint(detail);
  const priorSummary = String(summaryCheckpoint?.data?.summary || '').trim();
  const summaryCheckpointMessageCount = clampMessageCount(
    summaryCheckpoint?.data?.source_message_count,
    fullAgentHistory.length
  );

  // PRD-068 §5.14.4: resume mode picker.
  //   'full'            — every turn sent verbatim (unchanged)
  //   'checkpoint-full' — latest summary checkpoint + every message after it
  //   'tail-N'          — recap block + last N conversation messages
  //   'summary'         — recap block only. Cheapest continuity, biggest lossiness.
  let agentHistory;
  let sourceMessages = fullAgentHistory;
  let summaryMessageIndex = -1;
  let activeSummary = summary;
  let summaryCoveredMessageCount = 0;
  if (mode === 'full') {
    agentHistory = fullAgentHistory;
    summaryCoveredMessageCount = fullAgentHistory.length;
  } else if (mode === 'checkpoint-full') {
    sourceMessages = [];
    const tail = fullAgentHistory.slice(summaryCheckpointMessageCount);
    activeSummary = priorSummary
      || summaryForMessages(fullAgentHistory.slice(0, summaryCheckpointMessageCount), {
        fallback: summary,
        label: 'Summary checkpoint',
      });
    summaryCoveredMessageCount = summaryCheckpointMessageCount;
    agentHistory = [
      { role: 'user', content: metadata },
      { role: 'user', content: `Original user request from this resumed session:\n${originalRequest || '(unknown)'}` },
      { role: 'user', content: activeSummary || summary },
      ...tail,
    ];
    summaryMessageIndex = 2;
  } else if (mode === 'recap+tail' || /^tail-\d+$/.test(String(mode || ''))) {
    const tailTurns = tailTurnsForMode(mode, detail);
    const { tail, startIndex } = tailHistorySliceByRecentMessages(fullAgentHistory, tailTurns);
    const deltaStart = Math.min(summaryCheckpointMessageCount, startIndex);
    sourceMessages = fullAgentHistory.slice(deltaStart, startIndex);
    const deltaSummary = sourceMessages.length
      ? summaryForMessages(sourceMessages, {
          fallback: summary,
          label: `Summary of earlier turns before the last ${tailTurns} conversation messages`,
        })
      : '';
    activeSummary = combineResumeSummaries(priorSummary, deltaSummary)
      || summaryForMessages(fullAgentHistory.slice(0, startIndex), {
        fallback: summary,
        label: `Summary of earlier turns before the last ${tailTurns} conversation messages`,
      });
    summaryCoveredMessageCount = Math.min(
      fullAgentHistory.length,
      Math.max(summaryCheckpointMessageCount, startIndex)
    );
    agentHistory = [
      { role: 'user', content: metadata },
      { role: 'user', content: `Original user request from this resumed session:\n${originalRequest || '(unknown)'}` },
      { role: 'user', content: activeSummary },
      ...tail,
    ];
    summaryMessageIndex = 2;
  } else {
    // 'summary' (was 'compact' — renamed per PRD-068 §5.14.4)
    sourceMessages = fullAgentHistory.slice(summaryCheckpointMessageCount);
    const deltaSummary = priorSummary && sourceMessages.length
      ? summaryForMessages(sourceMessages, {
          fallback: summary,
          label: 'New turns after the previous resume summary',
        })
      : '';
    activeSummary = combineResumeSummaries(priorSummary, deltaSummary) || summary;
    summaryCoveredMessageCount = fullAgentHistory.length;
    agentHistory = [
      { role: 'user', content: metadata },
      { role: 'user', content: `Original user request from this resumed session:\n${originalRequest || '(unknown)'}` },
      { role: 'user', content: activeSummary },
    ];
    summaryMessageIndex = 2;
  }

  return {
    displayHistory,
    agentHistory,
    sourceMessages,
    summaryMessageIndex,
    summary: activeSummary,
    priorSummary,
    summaryCheckpointMessageCount,
    summaryCoveredMessageCount,
    fullMessageCount: fullAgentHistory.length,
    mode,
    stats: {
      userMessages: userPrompts.length,
      assistantMessages: assistantTexts.length,
      toolCalls,
      toolResults,
    },
  };
}

export function combineResumeSummaries(priorSummary, deltaSummary) {
  const prior = String(priorSummary || '').trim();
  const delta = String(deltaSummary || '').trim();
  if (prior && delta) {
    return [
      prior,
      '',
      'New activity since previous summary:',
      delta,
    ].join('\n');
  }
  return prior || delta || '';
}

function buildResumeMetadata({ detail, projectRoots, userPrompts, assistantTexts, toolCalls, toolResults, toolSummary }) {
  return [
    'Resume metadata.',
    `Session: ${detail.sessionId}`,
    detail.meta?.project ? `Project: ${detail.meta.project}` : '',
    projectRoots.length ? `Registered project roots: ${projectRoots.join(', ')}` : '',
    detail.meta?.startTime ? `Started: ${detail.meta.startTime}` : '',
    detail.meta?.endTime ? `Last activity: ${detail.meta.endTime}` : '',
    `Total user turns: ${userPrompts.length}`,
    `Assistant messages: ${assistantTexts.length}`,
    `Tool calls/results: ${toolCalls}/${toolResults}`,
    `Tools used: ${toolSummary}`,
  ].filter(Boolean).join('\n');
}

function summaryForMessages(messages, { fallback, label }) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) {
    return `${label}:\nNo earlier turns before the retained tail.`;
  }
  const lines = [label + ':'];
  for (const msg of list.slice(-24)) {
    const role = msg.role || 'message';
    lines.push(`- ${role}: ${truncateText(msg.content, 450)}`);
  }
  const text = lines.join('\n');
  return text.trim() || fallback;
}

function tailTurnsForMode(mode, detail) {
  const match = String(mode || '').match(/^tail-(\d+)$/);
  if (match) return Math.max(1, Number(match[1]) || 1);
  return Number.isFinite(Number(detail?.recapTailTurns))
    ? Math.max(1, Number(detail.recapTailTurns))
    : 8;
}

function tailHistorySliceByRecentMessages(history, turns) {
  const list = Array.isArray(history) ? history : [];
  const count = Math.max(1, Number(turns) || 1);
  const start = Math.max(0, list.length - count);
  return { tail: list.slice(start), startIndex: start };
}

function latestResumeSummaryCheckpoint(detail) {
  const events = Array.isArray(detail?.replayEvents) ? detail.replayEvents : [];
  let latest = null;
  for (const item of events) {
    const event = item?.event;
    const data = event?.data || {};
    if (event?.type !== 'resume_summary' || typeof data.summary !== 'string') continue;
    if (!latest || Number(item.order ?? -1) >= Number(latest.order ?? -1)) {
      latest = { ...item, data };
    }
  }
  return latest;
}

function clampMessageCount(value, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(Math.floor(n), Math.max(0, Number(max) || 0)));
}

export function getTranscriptProjectRoots(detail) {
  const roots = new Set();
  if (detail?.meta?.project && fs.existsSync(detail.meta.project)) {
    roots.add(detail.meta.project);
  }

  for (const entry of detail?.entries || []) {
    if (typeof entry.content === 'string') {
      for (const candidate of collectAbsolutePathsFromText(entry.content)) {
        const root = inferProjectRoot(candidate);
        if (root) roots.add(root);
      }
    }
    for (const tool of entryToolUses(entry)) {
      if (tool.name === 'get_project_overview') {
        const root = inferProjectRoot(tool.input?.path || tool.input?.root || tool.input?.cwd);
        if (root) roots.add(root);
      }
      for (const candidate of collectAbsoluteStrings(tool.input)) {
        const root = inferProjectRoot(candidate);
        if (root) roots.add(root);
      }
    }
  }

  return [...roots];
}

/**
 * Aggregate stats across sessions within a date range.
 * @param {number} days — look back this many days (0 = all time)
 */
export async function getSessionStats(days = 30) {
  const files = listSessionFiles();
  const cutoff = days > 0 ? Date.now() - (days * 86400000) : 0;
  const filtered = files.filter(f => f.mtime >= cutoff);

  const stats = {
    totalSessions: filtered.length,
    totalUserMessages: 0,
    totalAssistantMessages: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalToolCalls: 0,
    toolBreakdown: {},
    modelBreakdown: {},
  };

  for (const f of filtered) {
    const meta = await parseSessionMeta(f.filePath);
    stats.totalUserMessages += meta.userMessages;
    stats.totalAssistantMessages += meta.assistantMessages;
    stats.totalInputTokens += meta.inputTokens;
    stats.totalOutputTokens += meta.outputTokens;
    stats.totalCacheReadTokens += meta.cacheReadTokens;

    for (const tc of meta.toolCalls) {
      stats.toolBreakdown[tc.name] = (stats.toolBreakdown[tc.name] || 0) + tc.count;
      stats.totalToolCalls += tc.count;
    }
    for (const model of meta.models) {
      stats.modelBreakdown[model] = (stats.modelBreakdown[model] || 0) + 1;
    }
  }

  return stats;
}

/**
 * Get tool breakdown ranked by usage.
 * @param {number} days — look back period
 */
export async function getToolBreakdown(days = 30) {
  const stats = await getSessionStats(days);
  return Object.entries(stats.toolBreakdown)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get model breakdown with session counts.
 * @param {number} days — look back period
 */
export async function getModelBreakdown(days = 30) {
  const stats = await getSessionStats(days);
  return Object.entries(stats.modelBreakdown)
    .map(([model, sessions]) => ({ model, sessions }))
    .sort((a, b) => b.sessions - a.sessions);
}

/**
 * Read history.jsonl entries.
 * @param {number} n — max entries to return (most recent first)
 */
export function getHistory(n = 50) {
  const historyPath = path.join(KEPLER_DIR, 'history.jsonl');
  try {
    const content = fs.readFileSync(historyPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip bad lines */ }
    }
    return entries.slice(-n).reverse();
  } catch {
    return [];
  }
}

export function getStorePaths() {
  return {
    keplerDir: KEPLER_DIR,
    projectsDir: PROJECTS_DIR,
    historyPath: path.join(KEPLER_DIR, 'history.jsonl'),
  };
}
