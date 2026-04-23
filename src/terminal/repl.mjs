/**
 * Orca REPL — Full Claude-like terminal UX.
 *
 * Pure ANSI. No React. No Ink. No flickering.
 *
 * Features:
 * - Persistent status bar (model, cost, context, elapsed)
 * - Streaming content with live partial updates
 * - Tool execution display (transparent, collapsible)
 * - File diff display with +/- highlighting
 * - Phase/worker progress indicators
 * - Built-in agents (explore, review, architect)
 * - Permission prompts (Y/n/a/t)
 * - Input history & Tab autocomplete
 * - Safety guardrails on all tool execution
 */

import * as readline from 'node:readline';
import * as path from 'node:path';
import { c, progressBar, spinner, inPlace, renderMarkdown, formatElapsed, formatCost, stripAnsi } from './ansi.mjs';
import { calculateCost, formatCostValue, formatTokens } from '../core/pricing.mjs';
import { TarangStreamClient, EVENT_TYPES } from '../core/stream-client.mjs';
import { createToolExecutor } from '../core/tool-executor.mjs';
import { TarangAuth } from '../auth/tarang-auth.mjs';
import { ApprovalManager } from '../core/approval.mjs';
import { resolveBackendUrl } from '../core/backend-url.mjs';
import { BUILTIN_AGENTS, runAgent } from './agents.mjs';
import { ContextRetriever } from '../context/retriever.mjs';
import { buildProjectSkeleton } from '../context/skeleton.mjs';

const VERSION = '2.2.1';

// ── Safe CWD ──
// If the working directory gets deleted (by a rogue tool call),
// process.cwd() throws ENOENT. Detect and recover.

let _cachedCwd = null;

function safeCwd() {
  try {
    _cachedCwd = process.cwd();
    return _cachedCwd;
  } catch {
    // CWD deleted — try to recover
    const fallback = _cachedCwd || process.env.HOME || '/tmp';
    try {
      process.chdir(fallback);
      process.stderr.write(`  ${c.yellow('Working directory was deleted. Recovered to: ' + fallback)}\n`);
      _cachedCwd = fallback;
      return fallback;
    } catch {
      return process.env.HOME || '/tmp';
    }
  }
}

// ── Session State ──

const session = {
  startTime: Date.now(),
  inputTokens: 0,
  outputTokens: 0,
  toolCalls: 0,
  totalToolCalls: 0,   // across all turns
  turns: 0,
  history: [],         // conversation messages
  inputHistory: [],    // previous prompts (for Up/Down)
  user: null,          // { github_username, email, role }
  model: null,         // from backend user profile
  blockedOps: 0,       // safety guardrail blocks
  delegations: [],     // agent delegation events: { from, to, time }
  phases: [],          // phase history: { name, time }
  filesChanged: [],    // files modified this session
  lastTurnDuration: 0,
  costBreakdown: [],   // per-model usage: [{ model, role, input_tokens, output_tokens, cost }]
  totalCost: 0,        // accumulated session cost (USD)
  costAccurate: false, // true if backend provides per-model breakdown
};

// ── Commands ──

const COMMANDS = {
  '/help':     'Show commands',
  '/login':    'Sign in via browser',
  '/whoami':   'Show logged-in user',
  '/status':   'Session status & system info',
  '/stats':    'Progress bars & metrics',
  '/clear':    'Clear conversation',
  '/git':      'Git status',
  '/diff':     'Git diff',
  '/cost':     'Show session cost',
  '/history':  'Show conversation',
  '/compact':  'Compact conversation context',
  '/agents':   'List available agents',
  '/explore':  'Code explorer agent',
  '/review':   'Code review agent',
  '/architect':'Feature architect agent',
  '/safety':   'Show safety guardrail status',
  '/exit':     'Exit CLI',
};

// ── Banner ──

function printBanner(auth) {
  const creds = auth.loadCredentials();
  const env = process.env.TARANG_ENV || 'production';
  const authStatus = creds.token ? c.green('authenticated') : c.red('/login to start');

  process.stderr.write('\n');
  process.stderr.write(`  ${c.bold(c.cyan('orca'))} ${c.gray('v' + VERSION)}  ${c.dim('Orchestration of Composable Agents')}\n`);
  process.stderr.write(`  ${c.dim(env)}  ${authStatus}\n`);
  process.stderr.write('\n');
}

// ── Prompt Chrome ──
//
// Design: let the content breathe. The prompt area is a thin contextual
// strip — only shows what changed since last turn. No heavy borders.
//
// Layout after a response:
//
//   <assistant content>
//
//   ✓ 3 tools · 1.2s · $0.02                      ctx 21% · 42k tok
//   ╶─────────────────────────────────────────────────────────────────╴
//   orca ›
//
// Layout on first prompt (no stats yet):
//
//   ╶─────────────────────────────────────────────────────────────────╴
//   orca ›

/**
 * Build the contextual status strip — compact, one line.
 * Left side: last-turn summary (tools, time, cost)
 * Right side: session totals (ctx%, tokens)
 */
function buildContextStrip() {
  const totalTokens = session.inputTokens + session.outputTokens;
  const cost = formatCostValue(session.totalCost);
  const elapsed = formatElapsed(session.startTime);

  // Right side — always shown
  const right = [
    c.dim(`${formatTokens(totalTokens)} tok`),
    c.dim(cost),
    c.dim(elapsed),
  ].join(c.dim(' · '));

  return right;
}

/**
 * Print the prompt separator + prompt label.
 * Minimal horizontal rule with contextual info.
 */
function printPromptBlock() {
  const w = process.stdout.columns || 80;
  const strip = buildContextStrip();
  const stripPlain = stripAnsi(strip);

  // Rule with context strip right-aligned
  const ruleLen = Math.max(0, w - stripPlain.length - 4);
  process.stderr.write(
    c.dim('╶') + c.dim('─'.repeat(ruleLen)) + ' ' + strip + ' ' + c.dim('╴') + '\n'
  );
}

/**
 * Print a turn summary after a response completes.
 * Shows only when there's something meaningful to report.
 */
function printTurnSummary(toolCount, durationS, usage) {
  const parts = [];
  if (toolCount > 0) parts.push(`${toolCount} tools`);
  if (durationS) parts.push(`${Number(durationS).toFixed(1)}s`);
  if (usage) {
    const inp = usage.total_input_tokens || usage.input_tokens || 0;
    const out = usage.total_output_tokens || usage.output_tokens || 0;
    if (inp + out > 0) parts.push(formatCost(inp, out));
  }
  if (parts.length > 0) {
    process.stderr.write(`\n  ${c.green('✓')} ${c.dim(parts.join(' · '))}\n`);
  }
}

function updateStatusBar() {
  // No-op: status is printed inline via printPromptBlock before each prompt
}

// ── Tool Display Renderer ──

/**
 * Render a tool call in a transparent, informational way.
 * Shows tool name + key args on one line, no box borders for reads.
 */
function renderToolCall(data) {
  const tool = data?.tool || 'unknown';
  const args = data?.args || {};

  // Tool icon based on type
  const icons = {
    read_file: '📄', read_files: '📄', search_code: '🔍', search_files: '🔍',
    list_files: '📁', get_file_info: 'ℹ️', analyze_code: '🔬',
    write_file: '✏️', edit_file: '✏️', delete_file: '🗑️',
    shell: '⚡', validate_file: '✅', validate_build: '🔨',
    lint_check: '🧹', run_tests: '🧪', git_diff: '📊', git_status: '📊',
  };
  const icon = icons[tool] || '🔧';

  // Build description
  let desc, detail;
  switch (tool) {
    case 'read_file':
      desc = shortPath(args.file_path || args.path || '');
      if (!desc) desc = `(no path! keys: ${Object.keys(args).join(', ')})`;
      if (args.start_line && args.end_line) {
        detail = `lines ${args.start_line}-${args.end_line}`;
      } else if (args.start_line) {
        detail = `from line ${args.start_line}`;
      } else if (args.offset) {
        detail = `lines ${args.offset}-${(args.offset || 0) + (args.limit || 100)}`;
      } else {
        detail = '';
      }
      break;
    case 'write_file':
      desc = shortPath(args.file_path || args.path || '');
      if (!desc) desc = `(no path! keys: ${Object.keys(args).join(', ')})`;
      detail = args.content ? `${args.content.split('\n').length} lines` : '';
      break;
    case 'edit_file':
      desc = shortPath(args.file_path || args.path || 'file');
      detail = args.search ? `"${args.search.slice(0, 30)}${args.search.length > 30 ? '...' : ''}"` : '';
      break;
    case 'shell':
      desc = args.command || '';
      detail = '';
      break;
    case 'search_code':
      desc = `"${args.query || args.pattern || ''}"`;
      detail = args.path ? `in ${shortPath(args.path)}` : '';
      break;
    case 'analyze_code':
      desc = shortPath(args.file_path || args.path || 'file');
      detail = '';
      break;
    case 'run_tests':
      desc = args.command || 'npm test';
      detail = '';
      break;
    case 'git_diff':
      desc = args.file_path ? shortPath(args.file_path) : 'all changes';
      detail = '';
      break;
    case 'git_status':
      desc = '';
      detail = '';
      break;
    case 'list_files':
      desc = args.pattern || '**/*';
      detail = args.path ? `in ${shortPath(args.path)}` : '';
      break;
    case 'delete_file':
      desc = shortPath(args.file_path || args.path || 'file');
      detail = '';
      break;
    default:
      desc = tool;
      detail = Object.keys(args).slice(0, 2).join(', ');
  }

  const detailStr = detail ? `  ${c.gray(detail)}` : '';
  process.stderr.write(`  ${icon} ${c.dim(desc)}${detailStr}\n`);
}

/**
 * Render a tool result (success/failure, output snippet).
 */
function renderToolResult(data) {
  if (!data) return;

  if (data._blocked) {
    session.blockedOps++;
    process.stderr.write(`  ${c.red('🛡️ ' + (data.output || 'Blocked by safety guardrails'))}\n`);
    return;
  }

  if (data.success === false) {
    const msg = (data.output || data.message || 'Failed').slice(0, 120);
    process.stderr.write(`  ${c.red('✗ ' + msg)}\n`);
    return;
  }

  // For writes, show the change
  if (data._tool === 'write_file' || data._tool === 'edit_file') {
    const lint = data.lint;
    if (lint) {
      process.stderr.write(`  ${c.yellow('⚠ Lint: ' + lint.split('\n')[0].slice(0, 80))}\n`);
    }
  }
}

/**
 * Shorten a file path for display: /Users/sree/Sites/project/src/foo.mjs → src/foo.mjs
 */
function shortPath(p) {
  if (!p) return '';
  const cwd = safeCwd();
  if (p.startsWith(cwd)) return p.slice(cwd.length + 1);
  // Show last 2 segments
  const parts = p.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : p;
}

// ── Live Spinner ──
// A real animated spinner that ticks on an interval, not just per-call.
// Shows what's happening right now — thinking, tool executing, etc.

const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let _spinInterval = null;
let _spinFrame = 0;
let _spinText = '';

function startSpinner(text) {
  _spinText = text;
  _spinFrame = 0;
  if (_spinInterval) return; // already running
  _spinInterval = setInterval(() => {
    if (!_spinText) return;
    const frame = SPIN_FRAMES[_spinFrame % SPIN_FRAMES.length];
    _spinFrame++;
    inPlace(`  ${c.cyan(frame)} ${c.dim(_spinText)}`);
  }, 80);
}

function updateSpinner(text) {
  _spinText = text;
}

function stopSpinner() {
  if (_spinInterval) { clearInterval(_spinInterval); _spinInterval = null; }
  _spinText = '';
  inPlace('');
}

// ── Content Streaming Display ──

let _streamBuffer = '';
let _streamTimer = null;

function startContentStream() {
  _streamBuffer = '';
  stopSpinner();
}

function appendContent(text) {
  if (!text) return;
  _streamBuffer += text;

  // Debounce rendering to avoid flicker on rapid partial updates
  if (_streamTimer) clearTimeout(_streamTimer);
  _streamTimer = setTimeout(() => flushContent(), 50);
}

function flushContent() {
  if (_streamTimer) { clearTimeout(_streamTimer); _streamTimer = null; }
  if (!_streamBuffer) return;

  stopSpinner();
  const rendered = renderMarkdown(_streamBuffer);
  for (const line of rendered.split('\n')) {
    process.stdout.write(`  ${line}\n`);
  }
  _streamBuffer = '';
}

// ── Event Renderer ──

function renderEvent(event) {
  const { type, data } = event;

  switch (type) {
    case 'status': {
      const msg = data?.message || '';
      if (!msg || msg === 'Agent started') return;
      startSpinner(msg);
      break;
    }

    case 'thinking': {
      const text = data?.message || data?.text || '';
      if (text && !text.startsWith('Processing')) {
        startSpinner(text.slice(0, 80));
      }
      break;
    }

    case 'content': {
      const text = data?.text || '';
      if (text) {
        flushContent();
        stopSpinner();
        const rendered = renderMarkdown(text);
        for (const line of rendered.split('\n')) {
          process.stdout.write(`  ${line}\n`);
        }
      }
      break;
    }

    case 'content_partial': {
      const text = data?.text || '';
      if (text) {
        stopSpinner();
        appendContent(text);
      }
      break;
    }

    case 'tool_call':
    case 'tool_request': {
      session.toolCalls++;
      session.totalToolCalls++;
      stopSpinner();
      renderToolCall(data);
      // Don't start spinner here — approval prompt may follow.
      // Spinner resumes from 'status' or 'thinking' events after tool completes.
      break;
    }

    case 'tool_result':
    case 'tool_done': {
      stopSpinner();
      renderToolResult(data);
      break;
    }

    case 'change': {
      stopSpinner();
      const changeType = data?.type || 'modify';
      const filePath = shortPath(data?.path || '');
      const icon = changeType === 'create' ? c.green('+') :
                   changeType === 'delete' ? c.red('-') : c.yellow('~');
      process.stderr.write(`  ${icon} ${c.dim(filePath)}\n`);
      // Track changed files
      if (filePath && !session.filesChanged.includes(filePath)) {
        session.filesChanged.push(filePath);
      }
      break;
    }

    case 'phase_start':
    case 'phase_update': {
      const phase = data?.phase || data?.stage_name || '';
      if (phase) {
        stopSpinner();
        session.phases.push({ name: phase, time: Date.now() });
        process.stderr.write(`\n  ${c.cyan('▸')} ${c.bold(phase)}\n`);
      }
      break;
    }

    case 'phase_summary': {
      const summary = data?.summary || '';
      if (summary) {
        process.stderr.write(`  ${c.dim(summary.slice(0, 120))}\n`);
      }
      break;
    }

    case 'worker_start':
    case 'worker_update': {
      const worker = data?.worker || data?.name || '';
      const status = data?.status || data?.message || 'working';
      if (worker) startSpinner(`${worker}: ${status}`);
      break;
    }

    case 'worker_done': {
      stopSpinner();
      const worker = data?.worker || data?.name || '';
      if (worker) process.stderr.write(`  ${c.green('✓')} ${c.dim(worker)}\n`);
      break;
    }

    case 'delegation': {
      stopSpinner();
      const from = data?.from || '';
      const to = data?.to || '';
      session.delegations.push({ from, to, time: Date.now() });
      process.stderr.write(`\n  ${c.cyan('↳')} ${c.dim(from)} ${c.cyan('→')} ${c.bold(to)}`);
      if (data?.instruction) {
        process.stderr.write(`  ${c.dim(data.instruction.slice(0, 50))}`);
      }
      process.stderr.write('\n');
      break;
    }

    case 'session_info': {
      if (data?.model) session.model = data.model;
      if (data?.user) session.user = { ...session.user, ...data.user };
      break;
    }

    case 'error':
      stopSpinner();
      flushContent();
      process.stderr.write(`\n  ${c.red('✗')} ${data?.message || 'Unknown error'}\n`);
      if ((data?.message || '').includes('Authentication')) {
        process.stderr.write(`  ${c.dim('Run /login to re-authenticate')}\n`);
      }
      break;

    case 'complete': {
      stopSpinner();
      flushContent();

      // Update session token counts
      const usage = data?.usage;
      if (usage) {
        const inp = usage.total_input_tokens || usage.input_tokens || 0;
        const out = usage.total_output_tokens || usage.output_tokens || 0;
        session.inputTokens += inp;
        session.outputTokens += out;

        // Model-aware cost calculation
        const costResult = calculateCost(usage);
        session.totalCost += costResult.total;
        session.costAccurate = costResult.accurate;

        // Accumulate per-model breakdown
        for (const entry of costResult.breakdown) {
          const existing = session.costBreakdown.find(b => b.model === entry.model);
          if (existing) {
            existing.input_tokens += entry.input_tokens;
            existing.output_tokens += entry.output_tokens;
            existing.cache_read_tokens += entry.cache_read_tokens || 0;
            existing.cache_creation_tokens += entry.cache_creation_tokens || 0;
            existing.cost += entry.cost;
          } else {
            session.costBreakdown.push({ ...entry });
          }
        }
      }

      session.lastTurnDuration = data?.duration_s || 0;

      // Compact turn summary
      const tools = data?.tool_calls || session.toolCalls || 0;
      printTurnSummary(tools, data?.duration_s, usage);
      break;
    }

    case 'cancelled':
      stopSpinner();
      flushContent();
      process.stderr.write(`\n  ${c.yellow('⏹')} Cancelled${data?.reason ? ': ' + c.dim(data.reason) : ''}\n`);
      break;

    case 'paused':
      stopSpinner();
      process.stderr.write(`  ${c.yellow('⏸')} Paused${data?.reason ? '  ' + c.dim(data.reason) : ''}\n`);
      break;

    case 'resumed':
      process.stderr.write(`  ${c.green('▶')} Resumed\n`);
      break;

    default:
      break;
  }
}

// ── Slash Commands ──

async function handleCommand(input, ctx) {
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const rest = parts.slice(1).join(' ');

  switch (cmd) {
    case '/help':
      process.stderr.write(`\n  ${c.bold('Orca Commands')}\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(44))}\n`);
      for (const [name, desc] of Object.entries(COMMANDS)) {
        process.stderr.write(`  ${c.cyan(name.padEnd(14))} ${desc}\n`);
      }
      process.stderr.write(`\n  ${c.bold('Keyboard')}\n`);
      process.stderr.write(`  ${c.gray('Ctrl+C')}  exit   ${c.gray('↑↓')}  history   ${c.gray('Tab')}  autocomplete\n\n`);
      return;

    case '/login':
      process.stderr.write(`${c.cyan('Starting login flow...')}\n`);
      try {
        await ctx.auth.login();
        process.stderr.write(`${c.green('✓ Login successful!')}\n`);
        await fetchUser(ctx);
      } catch (err) {
        process.stderr.write(`${c.red('✗ Login failed: ' + err.message)}\n`);
      }
      return;

    case '/whoami': {
      if (!session.user) await fetchUser(ctx);
      if (session.user) {
        process.stderr.write(`\n  ${c.green('✓')} ${session.user.github_username}\n`);
        process.stderr.write(`  ${c.gray('Email:')}   ${session.user.email || 'n/a'}\n`);
        process.stderr.write(`  ${c.gray('User ID:')} ${session.user.id}\n`);
        process.stderr.write(`  ${c.gray('Role:')}    ${session.user.role || 'user'}\n\n`);
      } else {
        process.stderr.write(`  ${c.red('Not logged in. Run /login.')}\n`);
      }
      return;
    }

    case '/status': {
      const creds = ctx.auth.loadCredentials();
      const env = process.env.TARANG_ENV || 'production';
      const os = await import('node:os');
      const mem = process.memoryUsage();
      const approvalSummary = ctx.approval.getSummary();

      process.stderr.write(`\n  ${c.bold('Session')}\n`);
      process.stderr.write(`  ${c.dim('─'.repeat(44))}\n`);
      process.stderr.write(`  ${c.dim('User')}         ${session.user?.github_username || '—'}\n`);
      process.stderr.write(`  ${c.dim('Model')}        ${session.model || 'backend default'}\n`);
      if (env === 'local') {
        process.stderr.write(`  ${c.dim('Backend')}      ${creds.backendUrl}\n`);
      }
      process.stderr.write(`  ${c.dim('Env')}          ${env}\n`);
      process.stderr.write(`  ${c.dim('Turns')}        ${session.turns}\n`);
      process.stderr.write(`  ${c.dim('Tools')}        ${session.totalToolCalls} total, ${session.toolCalls} last turn\n`);
      process.stderr.write(`  ${c.dim('Duration')}     ${formatElapsed(session.startTime)}\n`);
      process.stderr.write(`  ${c.dim('Cost')}         ${formatCostValue(session.totalCost)}${session.costAccurate ? '' : c.dim(' (est)')}\n`);
      process.stderr.write(`  ${c.dim('CWD')}          ${safeCwd()}\n`);

      // Permissions
      process.stderr.write(`\n  ${c.bold('Permissions')}\n`);
      process.stderr.write(`  ${c.dim('─'.repeat(44))}\n`);
      process.stderr.write(`  ${c.dim('Approved')}     ${approvalSummary.approved}  ${c.dim('Denied')} ${approvalSummary.denied}\n`);
      if (approvalSummary.autoApproveAll) {
        process.stderr.write(`  ${c.dim('Mode')}         ${c.yellow('approve-all active')}\n`);
      }
      if (approvalSummary.autoApprovedTypes.length > 0) {
        process.stderr.write(`  ${c.dim('Auto-types')}   ${approvalSummary.autoApprovedTypes.join(', ')}\n`);
      }
      process.stderr.write(`  ${c.dim('Blocked')}      ${session.blockedOps} by safety guardrails\n`);

      // Orchestration
      if (session.delegations.length > 0 || session.phases.length > 0) {
        process.stderr.write(`\n  ${c.bold('Orchestration')}\n`);
        process.stderr.write(`  ${c.dim('─'.repeat(44))}\n`);
        if (session.delegations.length > 0) {
          process.stderr.write(`  ${c.dim('Delegations')}  ${session.delegations.length}\n`);
          for (const d of session.delegations.slice(-5)) {
            process.stderr.write(`    ${c.dim(d.from)} ${c.cyan('→')} ${d.to}\n`);
          }
        }
        if (session.phases.length > 0) {
          process.stderr.write(`  ${c.dim('Phases')}       ${session.phases.map(p => p.name).join(' → ')}\n`);
        }
      }

      // Files changed
      if (session.filesChanged.length > 0) {
        process.stderr.write(`\n  ${c.bold('Files Changed')} ${c.dim(`(${session.filesChanged.length})`)}\n`);
        process.stderr.write(`  ${c.dim('─'.repeat(44))}\n`);
        for (const f of session.filesChanged.slice(-10)) {
          process.stderr.write(`  ${c.dim('~')} ${f}\n`);
        }
        if (session.filesChanged.length > 10) {
          process.stderr.write(`  ${c.dim(`  ...and ${session.filesChanged.length - 10} more`)}\n`);
        }
      }

      // System
      process.stderr.write(`\n  ${c.bold('System')}\n`);
      process.stderr.write(`  ${c.dim('─'.repeat(44))}\n`);
      process.stderr.write(`  ${c.dim('Node')}         ${process.version}\n`);
      process.stderr.write(`  ${c.dim('Platform')}     ${process.platform} ${os.arch()}\n`);
      process.stderr.write(`  ${c.dim('Heap')}         ${(mem.heapUsed / 1024 / 1024).toFixed(0)} MB\n`);
      process.stderr.write(`  ${c.dim('Memory')}       ${((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024).toFixed(1)}G / ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)}G\n\n`);
      return;
    }

    case '/stats': {
      const os = await import('node:os');
      const mem = process.memoryUsage();
      const totalMem = os.totalmem();
      const usedMem = totalMem - os.freemem();
      const totalTokens = session.inputTokens + session.outputTokens;
      const ctxPct = Math.min(100, (totalTokens / 200000) * 100);

      process.stderr.write(`\n  ${c.bold('Metrics')}\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(40))}\n`);
      process.stderr.write(`  ${progressBar(ctxPct, 15, 'Context')} ${(totalTokens / 1000).toFixed(1)}k tok\n`);
      process.stderr.write(`  ${progressBar(Math.round((usedMem / totalMem) * 100), 15, 'Memory')} ${(usedMem / 1024 / 1024 / 1024).toFixed(1)}G\n`);
      process.stderr.write(`  ${progressBar(Math.round((mem.heapUsed / mem.heapTotal) * 100), 15, 'Heap')} ${(mem.heapUsed / 1024 / 1024).toFixed(0)}M\n`);
      process.stderr.write(`  ${c.gray('Turns:')}     ${session.turns}\n`);
      process.stderr.write(`  ${c.gray('Tools:')}     ${session.toolCalls}\n`);
      process.stderr.write(`  ${c.gray('Blocked:')}   ${session.blockedOps}\n`);
      process.stderr.write(`  ${c.gray('Cost:')}      ${formatCostValue(session.totalCost)}${session.costAccurate ? '' : c.dim(' (est)')}\n`);
      process.stderr.write(`  ${c.gray('Elapsed:')}  ${formatElapsed(session.startTime)}\n\n`);
      return;
    }

    case '/cost': {
      process.stderr.write(`\n  ${c.bold('Session Cost')}`);
      if (!session.costAccurate) {
        process.stderr.write(`  ${c.yellow('(estimated — backend not sending model breakdown)')}`);
      }
      process.stderr.write('\n');
      process.stderr.write(`  ${c.dim('─'.repeat(70))}\n`);

      if (session.costBreakdown.length > 0) {
        // Header
        process.stderr.write(`  ${c.dim('Model'.padEnd(36))}${c.dim('Input'.padStart(10))}${c.dim('Output'.padStart(10))}${c.dim('Cache'.padStart(10))}${c.dim('Cost'.padStart(10))}\n`);
        process.stderr.write(`  ${c.dim('─'.repeat(70))}\n`);

        for (const b of session.costBreakdown) {
          const modelLabel = b.model === 'unknown' ? c.yellow('unknown model') : b.model;
          const roleTag = b.role && b.role !== 'unknown' ? ` ${c.dim(`(${b.role})`)}` : '';
          const cacheTokens = (b.cache_read_tokens || 0) + (b.cache_creation_tokens || 0);
          const costStr = b.free ? c.green('free') : formatCostValue(b.cost);

          process.stderr.write(
            `  ${(modelLabel + roleTag).padEnd(36)}` +
            `${formatTokens(b.input_tokens).padStart(10)}` +
            `${formatTokens(b.output_tokens).padStart(10)}` +
            `${(cacheTokens > 0 ? formatTokens(cacheTokens) : '—').padStart(10)}` +
            `${costStr.padStart(10)}\n`
          );
        }

        process.stderr.write(`  ${c.dim('─'.repeat(70))}\n`);
      }

      process.stderr.write(
        `  ${c.bold('Total'.padEnd(36))}` +
        `${formatTokens(session.inputTokens).padStart(10)}` +
        `${formatTokens(session.outputTokens).padStart(10)}` +
        `${''.padStart(10)}` +
        `${formatCostValue(session.totalCost).padStart(10)}\n`
      );
      process.stderr.write(`  ${c.dim(`Turns: ${session.turns}  Duration: ${formatElapsed(session.startTime)}`)}\n\n`);
      return;
    }

    case '/history':
      if (session.history.length === 0) { process.stderr.write(`  ${c.gray('No conversation yet.')}\n`); return; }
      process.stderr.write(`\n  ${c.bold('Conversation')} (${session.history.length} messages)\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(40))}\n`);
      for (const msg of session.history.slice(-20)) {
        const role = msg.role === 'user' ? c.cyan('You') : c.green('Orca');
        process.stderr.write(`  ${role}: ${msg.content.slice(0, 80)}${msg.content.length > 80 ? '...' : ''}\n`);
      }
      process.stderr.write('\n');
      return;

    case '/compact': {
      const before = session.history.length;
      if (before <= 4) { process.stderr.write(`  ${c.gray('Nothing to compact.')}\n`); return; }
      session.history.splice(2, session.history.length - 6);
      process.stderr.write(`  ${c.gray(`Compacted: ${before} → ${session.history.length} messages`)}\n`);
      return;
    }

    case '/clear':
      session.history.length = 0;
      session.toolCalls = 0;
      process.stderr.write(`  ${c.gray('Conversation cleared.')}\n`);
      return;

    case '/git': {
      const { execSync } = await import('node:child_process');
      try { process.stdout.write(execSync('git status --short --branch', { encoding: 'utf-8' }) + '\n'); }
      catch (e) { process.stderr.write(`  ${c.red(e.message)}\n`); }
      return;
    }

    case '/diff': {
      const { execSync } = await import('node:child_process');
      try { process.stdout.write(execSync('git diff --stat', { encoding: 'utf-8' }) || '(no changes)\n'); }
      catch (e) { process.stderr.write(`  ${c.red(e.message)}\n`); }
      return;
    }

    case '/safety': {
      const { getSafetyRules } = await import('../core/safety.mjs');
      const rules = getSafetyRules();
      process.stderr.write(`\n  ${c.bold('Safety Guardrails')} ${c.green('ACTIVE')}\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(40))}\n`);
      process.stderr.write(`  ${c.gray('Protected files:')} ${rules.protectedNames.join(', ')}\n`);
      process.stderr.write(`  ${c.gray('Source dirs:')}     ${rules.sourceDirs.join(', ')}\n`);
      process.stderr.write(`  ${c.gray('Blocked patterns:')} ${rules.blockedPatterns}\n`);
      process.stderr.write(`  ${c.gray('High-risk patterns:')} ${rules.highRiskPatterns}\n`);
      process.stderr.write(`  ${c.gray('Ops blocked:')}     ${session.blockedOps}\n\n`);
      return;
    }

    case '/agents':
      process.stderr.write(`\n  ${c.bold('Built-in Agents')}\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(44))}\n`);
      for (const agent of BUILTIN_AGENTS) {
        process.stderr.write(`  ${c.cyan(('/' + agent.command).padEnd(14))} ${agent.description}\n`);
        process.stderr.write(`  ${' '.repeat(14)} ${c.gray(agent.detail)}\n`);
      }
      process.stderr.write(`\n  ${c.gray('Usage: /<agent> <instruction>')}\n`);
      process.stderr.write(`  ${c.gray('Example: /explore how does the auth flow work?')}\n\n`);
      return;

    case '/explore':
    case '/review':
    case '/architect': {
      if (!rest) {
        process.stderr.write(`  ${c.yellow('Usage:')} ${cmd} <instruction>\n`);
        process.stderr.write(`  ${c.gray(`Example: ${cmd} ${cmd === '/explore' ? 'how does authentication work?' : cmd === '/review' ? 'check src/core/ for bugs' : 'design a caching layer'}`)}\n`);
        return;
      }
      return await runAgent(cmd.slice(1), rest, ctx, session, renderEvent);
    }

    case '/exit':
    case '/quit':
      process.stderr.write(`\n  ${c.cyan('Goodbye!')}\n\n`);
      process.exit(0);

    default:
      process.stderr.write(`  ${c.gray(`Unknown: ${cmd}. Type /help.`)}\n`);
  }
}

// ── Fetch User Profile ──

async function fetchUser(ctx) {
  const creds = ctx.auth.loadCredentials();
  if (!creds.token) return;
  try {
    const resp = await fetch(`${creds.backendUrl}/api/user/me`, {
      headers: { 'Authorization': `Bearer ${creds.token}` },
    });
    if (resp.ok) {
      session.user = await resp.json();
      session.model = session.user.default_reasoning_model || session.user.default_orchestrator_model || null;
    }
  } catch {}
}

// ── Main REPL ──
// Cache CWD at startup so safeCwd() has a fallback if the dir gets deleted

export async function startTerminalRepl() {
  _cachedCwd = process.cwd(); // Cache startup CWD for recovery

  const auth = new TarangAuth();

  // BM25 retriever — indexes project files for search_code tool
  const retriever = new ContextRetriever(safeCwd());
  const toolExecutor = createToolExecutor({ retriever });
  const approval = new ApprovalManager({ autoApprove: false });
  const ctx = { auth, toolExecutor, approval };

  printBanner(auth);

  // Build BM25 index + project skeleton in background (non-blocking)
  let projectSkeleton = '';
  retriever.buildIndex()
    .then(({ fileCount, chunkCount }) => {
      process.stderr.write(`  ${c.dim(`Indexed ${fileCount} files (${chunkCount} chunks)`)}\n`);
      // Build skeleton after index (uses same file scan)
      projectSkeleton = buildProjectSkeleton(safeCwd());
      if (projectSkeleton) {
        process.stderr.write(`  ${c.dim(`Project skeleton ready`)}\n`);
      }
    })
    .catch(() => { /* index build failed — search_code falls back to grep */ });

  // Fetch user profile in background
  fetchUser(ctx);

  const PROMPT = `${c.cyan('orca')} ${c.dim('›')} `;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: PROMPT,
    completer: (line) => {
      if (line.startsWith('/')) {
        const hits = Object.keys(COMMANDS).filter(cmd => cmd.startsWith(line));
        return [hits.length ? hits : Object.keys(COMMANDS), line];
      }
      return [[], line];
    },
    historySize: 100,
  });

  // Give approval manager access to readline for pause/resume
  approval.setReadline(rl);

  // Helper: show prompt with separator + vertical breathing room
  function showPrompt() {
    printPromptBlock();
    process.stderr.write('\n');  // half-inch vertical gap above input line
    rl.prompt();
  }

  showPrompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Save to input history
    session.inputHistory.push(input);

    // Slash commands
    if (input.startsWith('/')) {
      await handleCommand(input, ctx);
      showPrompt();
      return;
    }

    // Regular prompt
    session.history.push({ role: 'user', content: input });
    session.turns++;
    session.toolCalls = 0;

    const creds = auth.loadCredentials();
    if (!creds.token) {
      process.stderr.write(`  ${c.red('Not logged in. Run /login first.')}\n`);
      showPrompt();
      return;
    }

    // Orca response label
    process.stderr.write(`\n${c.bold(c.cyan('orca'))}\n`);

    const client = new TarangStreamClient({
      baseUrl: creds.backendUrl,
      token: creds.token,
      toolExecutor,
      approvalManager: approval,
    });

    let assistantContent = '';

    try {
      startContentStream();

      const execContext = { cwd: safeCwd() };
      if (projectSkeleton) execContext.project_skeleton = projectSkeleton;

      for await (const event of client.execute(input, execContext, session.history)) {
        renderEvent(event);

        if (event.type === 'content' || event.type === 'content_partial') {
          const text = event.data?.text || '';
          if (text) assistantContent = text;
        }
      }

      flushContent();
    } catch (err) {
      inPlace('');
      flushContent();
      process.stderr.write(`  ${c.red('Error: ' + err.message)}\n`);
    }

    if (assistantContent) {
      session.history.push({ role: 'assistant', content: assistantContent });
    }

    showPrompt();
  });

  rl.on('close', () => {
    stopSpinner();
    process.stderr.write(`\n  ${c.dim('session ended')}\n\n`);
    process.exit(0);
  });
}
