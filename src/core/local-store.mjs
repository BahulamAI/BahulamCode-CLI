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

/**
 * Parse a session JSONL file and extract metadata.
 * Reads line-by-line (streaming) to handle large files.
 */
async function parseSessionMeta(filePath) {
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
  };

  const toolCounts = {};
  const modelSet = new Set();

  try {
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }

      if (obj.sessionId && !meta.sessionId) meta.sessionId = obj.sessionId;
      if (obj.cwd && !meta.project) meta.project = obj.cwd;
      if (obj.gitBranch && !meta.gitBranch) meta.gitBranch = obj.gitBranch;

      const ts = obj.timestamp;
      if (ts) {
        if (!meta.startTime || ts < meta.startTime) meta.startTime = ts;
        if (!meta.endTime || ts > meta.endTime) meta.endTime = ts;
      }

      if (obj.type === 'user') {
        meta.userMessages++;
        // Capture first user prompt (string content only)
        if (!meta.firstPrompt) {
          const content = obj.message?.content;
          if (typeof content === 'string' && content.length > 0) {
            meta.firstPrompt = content.slice(0, 100);
          }
        }
      }

      if (obj.type === 'assistant') {
        meta.assistantMessages++;
        const usage = obj.message?.usage;
        if (usage) {
          meta.inputTokens += usage.input_tokens || 0;
          meta.outputTokens += usage.output_tokens || 0;
          meta.cacheReadTokens += usage.cache_read_input_tokens || 0;
          meta.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
        }
        const model = obj.message?.model;
        if (model) modelSet.add(model);

        // Count tool_use blocks
        const content = obj.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use' && block.name) {
              toolCounts[block.name] = (toolCounts[block.name] || 0) + 1;
            }
          }
        }
      }
    }
  } catch { /* file read error — return partial meta */ }

  meta.toolCalls = Object.entries(toolCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  meta.models = [...modelSet];

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
      mtime: f.mtime,
    });
  }
  return sessions;
}

/**
 * Return normalized entries for a single session transcript.
 * @param {string} sessionId
 */
export async function getSessionDetail(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return null;

  const entries = [];
  const fileStream = fs.createReadStream(file.filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const message = obj.message || {};
    entries.push({
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
  };
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
