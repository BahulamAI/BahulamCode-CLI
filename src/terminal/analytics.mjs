import * as http from 'node:http';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import {
  getRecentSessions,
  getSessionStats,
  getToolBreakdown,
  getModelBreakdown,
  getHistory,
  getSessionDetail,
  getStorePaths,
} from '../core/local-store.mjs';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json');

function parseNumber(value, fallback) {
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

function readOption(args, name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx === args.length - 1) return fallback;
  return args[idx + 1];
}

function hasFlag(args, name) {
  return args.includes(name);
}

function basename(projectPath) {
  return projectPath ? path.basename(projectPath) : 'unknown';
}

function formatNumber(num) {
  return new Intl.NumberFormat('en-US').format(num || 0);
}

function formatWhen(value) {
  if (!value) return 'n/a';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'n/a' : date.toLocaleString();
}

function formatDuration(startTime, endTime) {
  if (!startTime || !endTime) return 'n/a';
  const ms = new Date(endTime).getTime() - new Date(startTime).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round((seconds % 60) * 10) / 10;
  return `${minutes}m ${rem}s`;
}

function truncate(text, max = 80) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function relativeDaysLabel(days) {
  return days === 0 ? 'all time' : `last ${days} days`;
}

function extractPrompt(entry) {
  return truncate(entry?.display || '', 120);
}

export function formatSessionsReport(sessions, limit) {
  if (!sessions.length) {
    return 'No local sessions found in ~/.orca/projects.\n';
  }

  const lines = [];
  lines.push(`ORCA SESSIONS  ${sessions.length} shown`);
  lines.push(`Recent local transcripts from ~/.orca/projects  (limit ${limit})`);
  lines.push('');

  for (const session of sessions) {
    const model = session.models[0] || 'backend default';
    const totalTokens = (session.inputTokens || 0) + (session.outputTokens || 0);
    lines.push(`${formatWhen(session.endTime || session.startTime)}  ${basename(session.project)}`);
    lines.push(`  session  ${session.sessionId}`);
    lines.push(`  prompt   ${truncate(session.firstPrompt || '(no prompt captured)', 96)}`);
    lines.push(`  usage    ${formatNumber(totalTokens)} tok  ${formatNumber(session.toolCalls.reduce((sum, tool) => sum + tool.count, 0))} tools  ${session.userMessages} user / ${session.assistantMessages} assistant`);
    lines.push(`  model    ${model}${session.gitBranch ? `  git:${session.gitBranch}` : ''}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function formatStatsReport(stats, tools, models, days, paths) {
  const lines = [];
  lines.push(`ORCA STATS  ${relativeDaysLabel(days)}`);
  lines.push(`Store: ${paths.orcaDir}`);
  lines.push('');
  lines.push(`Sessions        ${formatNumber(stats.totalSessions)}`);
  lines.push(`Messages        ${formatNumber(stats.totalUserMessages + stats.totalAssistantMessages)}  (${formatNumber(stats.totalUserMessages)} user, ${formatNumber(stats.totalAssistantMessages)} assistant)`);
  lines.push(`Tokens          ${formatNumber(stats.totalInputTokens + stats.totalOutputTokens)}  (${formatNumber(stats.totalInputTokens)} in, ${formatNumber(stats.totalOutputTokens)} out)`);
  lines.push(`Cache Read      ${formatNumber(stats.totalCacheReadTokens)}`);
  lines.push(`Tool Calls      ${formatNumber(stats.totalToolCalls)}`);
  lines.push('');

  lines.push('Top Tools');
  if (tools.length === 0) {
    lines.push('  none');
  } else {
    for (const tool of tools.slice(0, 8)) {
      lines.push(`  ${tool.name.padEnd(18)} ${formatNumber(tool.count)}`);
    }
  }
  lines.push('');

  lines.push('Models');
  if (models.length === 0) {
    lines.push('  none');
  } else {
    for (const model of models.slice(0, 8)) {
      lines.push(`  ${truncate(model.model, 42).padEnd(42)} ${formatNumber(model.sessions)} sessions`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

export function formatHistoryReport(entries, limit) {
  if (!entries.length) {
    return 'No local prompt history found in ~/.orca/history.jsonl.\n';
  }

  const lines = [];
  lines.push(`ORCA HISTORY  ${entries.length} shown`);
  lines.push(`Recent prompts from ~/.orca/history.jsonl  (limit ${limit})`);
  lines.push('');

  for (const entry of entries) {
    lines.push(`${formatWhen(entry.timestamp)}  ${basename(entry.project)}`);
    lines.push(`  ${extractPrompt(entry)}`);
    lines.push('');
  }

  return lines.join('\n');
}

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function openBrowser(url) {
  try {
    let child;
    if (process.platform === 'darwin') {
      child = spawn('open', [url], { stdio: 'ignore', detached: true });
    } else if (process.platform === 'win32') {
      child = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true });
    } else {
      child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    }
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function runSessionsCommand(args = []) {
  const limit = parseNumber(readOption(args, '--limit', '20'), 20);
  const sessions = getRecentSessions(limit);
  process.stdout.write(formatSessionsReport(sessions, limit));
}

export async function runStatsCommand(args = []) {
  const days = parseNumber(readOption(args, '--days', '30'), 30);
  const stats = getSessionStats(days);
  const tools = getToolBreakdown(days);
  const models = getModelBreakdown(days);
  const paths = getStorePaths();
  process.stdout.write(formatStatsReport(stats, tools, models, days, paths));
}

export async function runHistoryCommand(args = []) {
  const limit = parseNumber(readOption(args, '--limit', '50'), 50);
  const history = getHistory(limit);
  process.stdout.write(formatHistoryReport(history, limit));
}

// Dashboard removed — now using Orca Pulse (pulse/cli.js)

export async function _runDashboardCommand_REMOVED() { /* see pulse/cli.js */ }

export async function _OLD_runDashboardCommand(args = []) {
  const requestedPort = parseNumber(readOption(args, '--port', '4318'), 4318);
  const host = readOption(args, '--host', '127.0.0.1') || '127.0.0.1';
  const shouldOpen = !hasFlag(args, '--no-open');

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${requestedPort}`}`);

      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(dashboardHtml());
        return;
      }

      if (url.pathname === '/api/overview') {
        const days = parseNumber(url.searchParams.get('days') || '30', 30);
        const limit = parseNumber(url.searchParams.get('limit') || '18', 18);
        const historyLimit = parseNumber(url.searchParams.get('history_limit') || '40', 40);
        const [stats, tools, models, sessions] = await Promise.all([
          getSessionStats(days),
          getToolBreakdown(days),
          getModelBreakdown(days),
          getRecentSessions(limit),
        ]);
        json(res, 200, {
          stats,
          tools,
          models,
          sessions,
          history: getHistory(historyLimit),
          paths: getStorePaths(),
        });
        return;
      }

      if (url.pathname === '/api/session') {
        const sessionId = url.searchParams.get('session_id') || '';
        if (!sessionId) {
          json(res, 400, { error: 'session_id is required' });
          return;
        }
        const detail = await getSessionDetail(sessionId);
        if (!detail) {
          json(res, 404, { error: 'Session not found' });
          return;
        }
        json(res, 200, detail);
        return;
      }

      json(res, 404, { error: 'Not found' });
    } catch (err) {
      json(res, 500, { error: err.message || 'Internal error' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, resolve);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : requestedPort;
  const url = `http://${host}:${actualPort}`;

  process.stderr.write(`\x1b[36mOrca dashboard\x1b[0m ${url}\n`);
  process.stderr.write(`\x1b[2mReading local analytics from ${getStorePaths().orcaDir}\x1b[0m\n`);
  process.stderr.write(`\x1b[2mPress Ctrl+C to stop the dashboard server.\x1b[0m\n`);

  if (shouldOpen) {
    const opened = openBrowser(url);
    if (!opened) {
      process.stderr.write(`\x1b[33mUnable to open a browser automatically. Open ${url} manually.\x1b[0m\n`);
    }
  }

  const shutdown = () => {
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
