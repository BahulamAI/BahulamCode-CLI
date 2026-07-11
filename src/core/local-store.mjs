/**
 * Local Store Reader — scans ~/.kepler/ JSONL files for historical stats.
 *
 * Provides read helpers for CLI commands (/stats, /history, /tokens, /tools, /sessions).
 * All data comes from local JSONL files — no cloud dependency.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';

const KEPLER_DIR = process.env.KEPLER_HOME || path.join(os.homedir(), '.kepler');
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
    startTime: null,
    endTime: null,
    gitBranch: null,
    // ── PRD-068 §5.14 derived fields ───────────────────────────────────
    endStatus: 'unknown',   // 'completed' | 'interrupted' | 'errored' | 'unknown'
    contextTokens: 0,       // projected transcript size when serialized
    costUsd: 0,             // sum of per-turn provider costs recorded in transcript
    partial: false,         // true if some lines failed to parse
    fileBytes: 0,           // raw file size (byte-based ctx fallback if no usage totals)
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
        if (ev.type === 'session_info' && typeof ev.total_cost_usd === 'number') meta.costUsd = ev.total_cost_usd;
        if (ev.type === 'error' || ev.error === true) hadError = true;
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

  // Projected context size — prefer recorded usage totals if available, else
  // fall back to the byte-based estimate (~4 chars/token for English).
  const usageTotal = meta.inputTokens + meta.outputTokens + meta.cacheReadTokens;
  meta.contextTokens = usageTotal > 0 ? usageTotal : Math.round(meta.fileBytes / 4);

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

  // PRD-068 §5.14.4: three-way mode picker.
  //   'full'       — every turn sent verbatim (unchanged)
  //   'recap+tail' — recap block as system prime + last N raw messages so the
  //                  agent has real conversation to reference for the recent
  //                  work. Best default when full won't fit.
  //   'summary'    — recap block only. Cheapest continuity, biggest lossiness.
  let agentHistory;
  if (mode === 'full') {
    agentHistory = fullAgentHistory;
  } else if (mode === 'recap+tail') {
    const tailTurns = Number.isFinite(Number(detail.recapTailTurns))
      ? Number(detail.recapTailTurns)
      : 8;
    // Keep the last `tailTurns` entries from the FULL history. This means
    // real assistant messages + tool_use / tool_result markers, matching how
    // the agent expects to see prior conversation.
    const tail = fullAgentHistory.slice(-tailTurns);
    agentHistory = [{ role: 'user', content: summary }, ...tail];
  } else {
    // 'summary' (was 'compact' — renamed per PRD-068 §5.14.4)
    agentHistory = [{ role: 'user', content: summary }];
  }

  return {
    displayHistory,
    agentHistory,
    summary,
    mode,
    stats: {
      userMessages: userPrompts.length,
      assistantMessages: assistantTexts.length,
      toolCalls,
      toolResults,
    },
  };
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
