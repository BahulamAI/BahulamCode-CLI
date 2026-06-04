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
import { JsonlWriter } from '../core/jsonl-writer.mjs';
import { createToolExecutor } from '../core/tool-executor.mjs';
import { TarangAuth } from '../auth/tarang-auth.mjs';
import { ApprovalManager } from '../core/approval.mjs';
import { resolveBackendUrl } from '../core/backend-url.mjs';
import { BUILTIN_AGENTS, runAgent } from './agents.mjs';
import { ContextRetriever } from '../context/retriever.mjs';
import { buildProjectSkeleton } from '../context/skeleton.mjs';
import { SessionManager } from '../core/session-manager.mjs';
import { parseArgs } from '../config/cli-args.mjs';

import { createRequire } from 'node:module';
const __require = createRequire(import.meta.url);
const VERSION = __require('../../package.json').version;

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

let _sessionMgr = null; // Set in startTerminalRepl, used by renderEvent

const session = {
  id: null,                  // set by backend on first turn via session_info event
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
  inSubAgent: false,   // true while a sub-agent is running (for indented tool display)
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
  '/revoke':   'Revoke auto-approvals',
  '/resume':   'Resume a previous session',
  '/sessions': 'List resumable sessions',
  '/logout':   'Sign out and clear credentials',
  '/exit':     'Exit CLI',
};

// ── Banner ──

function printBanner(auth) {
  const creds = auth.loadCredentials();
  const env = process.env.TARANG_ENV || 'production';
  const authStatus = creds.token ? c.green('authenticated') : c.red('/login to start');

  const art = [
    '   ██████╗ ██████╗  ██████╗ █████╗',
    '  ██╔═══██╗██╔══██╗██╔════╝██╔══██╗',
    '  ██║   ██║██████╔╝██║     ███████║',
    '  ██║   ██║██╔══██╗██║     ██╔══██║',
    '  ╚██████╔╝██║  ██║╚██████╗██║  ██║',
    '   ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝',
  ];
  process.stderr.write('\n');
  for (const line of art) {
    process.stderr.write(c.cyan(line) + '\n');
  }
  process.stderr.write('\n');
  process.stderr.write(`  ${c.gray('v' + VERSION)}  ${c.dim(env)}  ${authStatus}\n`);
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
function printTurnSummary(toolCount, durationS, turnCost) {
  const parts = [];
  if (toolCount > 0) parts.push(`${toolCount} tools`);
  if (durationS) parts.push(`${Number(durationS).toFixed(1)}s`);
  if (turnCost > 0) parts.push(formatCostValue(turnCost));
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
  const indent = session.inSubAgent ? '     ' : '  ';

  // Build summary string (what the tool will do)
  let summary;
  switch (tool) {
    case 'read_file': {
      const fp = shortPath(args.file_path || args.path || '');
      const range = args.start_line && args.end_line
        ? ` lines ${args.start_line}-${args.end_line}`
        : args.start_line ? ` from line ${args.start_line}` : '';
      summary = `${fp}${range}`;
      break;
    }
    case 'write_file': {
      const fp = shortPath(args.file_path || args.path || '');
      const lines = args.content ? `, ${args.content.split('\n').length} lines` : '';
      summary = `${fp}${lines}`;
      break;
    }
    case 'edit_file': {
      const fp = shortPath(args.file_path || args.path || '');
      const search = args.search ? `, "${(args.search || '').slice(0, 30)}..."` : '';
      summary = `${fp}${search}`;
      break;
    }
    case 'shell':
      summary = args.command || '';
      break;
    case 'search_code':
      summary = `"${args.query || args.pattern || ''}"`;
      break;
    case 'list_files':
      summary = `${args.pattern || '*'}${args.path ? ` in ${shortPath(args.path)}` : ''}`;
      break;
    case 'delete_file':
      summary = shortPath(args.file_path || args.path || '');
      break;
    case 'read_files':
      summary = (args.file_paths || args.paths || []).map(shortPath).join(', ');
      break;
    case 'write_project': {
      const files = (args.files || []).map(f => shortPath(f.path || f.file_path || ''));
      summary = files.length > 0 ? files.join(', ') : '';
      break;
    }
    default:
      summary = Object.values(args || {}).filter(v => typeof v === 'string').join(', ').slice(0, 60);
  }

  // Render: ⏺ ToolName(summary)
  // Use terminal width minus tool name and padding, minimum 60
  const cols = process.stderr.columns || 120;
  const maxSummary = Math.max(60, cols - tool.length - 10);
  let displaySummary = summary || '';
  if (displaySummary.length > maxSummary) {
    displaySummary = '...' + displaySummary.slice(-(maxSummary - 3));
  }
  const summaryStr = displaySummary ? `(${displaySummary})` : '';
  process.stderr.write(`\n${indent}${c.cyan('⏺')} ${c.bold(tool)}${c.dim(summaryStr)}\n`);
}

/**
 * Render a tool result (success/failure, output snippet).
 */
function renderToolResult(data) {
  if (!data) return;
  const indent = session.inSubAgent ? '     ' : '  ';
  const gutter = `${indent}${c.dim('⎿')}  `;

  if (data._blocked) {
    session.blockedOps++;
    process.stderr.write(`${gutter}${c.red(data.output || 'Blocked by safety guardrails')}\n`);
    return;
  }

  if (data.success === false) {
    const msg = (data.output || data.message || 'Failed').slice(0, 120);
    process.stderr.write(`${gutter}${c.red(msg)}\n`);
    return;
  }

  // For writes, show lint warnings
  if (data._tool === 'write_file' || data._tool === 'edit_file') {
    const lint = data.lint;
    if (lint) {
      process.stderr.write(`${gutter}${c.yellow('⚠ ' + lint.split('\n')[0].slice(0, 80))}\n`);
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
let _renderedContentThisTurn = false;

function startContentStream() {
  _streamBuffer = '';
  _renderedContentThisTurn = false;
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
  _renderedContentThisTurn = true;
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
        _renderedContentThisTurn = true;
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
      flushContent();
      renderToolCall(data);
      break;
    }

    // ── HITL: Framework-level approval events ──

    case 'approval_required': {
      stopSpinner();
      flushContent();
      break;
    }

    case 'approval_granted': {
      // approval.mjs _prompt already rendered the result line for human approvals.
      // Nothing extra needed here — avoid duplicate output.
      break;
    }

    case 'approval_denied': {
      const reason = data?.reason || 'User denied';
      const toolName = data?.tool || '';
      const indent = session.inSubAgent ? '     ' : '  ';
      process.stderr.write(`${indent}${c.red('✗')} ${c.dim(`Denied ${toolName}: ${reason}`)}\n`);
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

    // ── Sub-Agent Activity ──

    case 'sub_agent_start': {
      stopSpinner();
      session.inSubAgent = true;
      const agentType = data?.type || 'sub-agent';
      const model = data?.model || '';
      const query = data?.query || '';
      const icon = agentType === 'explore' ? '🔭' : agentType === 'plan' ? '📐' : '🤖';
      process.stderr.write(`\n  ${icon} ${c.bold(c.cyan(`${agentType} agent`))} ${c.dim('started')}\n`);
      if (model) process.stderr.write(`     ${c.gray('model:')} ${c.dim(model)}\n`);
      if (query) process.stderr.write(`     ${c.gray('query:')} ${c.dim(query)}\n`);
      startSpinner(`${agentType}: working...`);
      break;
    }

    case 'sub_agent_tool': {
      // No separate display — the regular tool_call event shows full detail
      // indented under the sub-agent block. Just update the spinner text.
      const agentType = data?.type || 'sub-agent';
      const tool = data?.tool || '';
      if (tool) updateSpinner(`${agentType} → ${tool}`);
      break;
    }

    case 'sub_agent_complete': {
      stopSpinner();
      session.inSubAgent = false;
      const agentType = data?.type || 'sub-agent';
      const model = data?.model || '';
      const resultLen = data?.result_length || 0;
      const usage = data?.usage || {};
      const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
      const parts = [];
      if (resultLen > 0) parts.push(`${resultLen} chars`);
      if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
      const icon = agentType === 'explore' ? '🔭' : agentType === 'plan' ? '📐' : '🤖';
      process.stderr.write(`  ${icon} ${c.green('✓')} ${c.dim(`${agentType} agent complete`)}${parts.length ? '  ' + c.dim(parts.join(' · ')) : ''}\n\n`);
      break;
    }

    case 'session_info': {
      if (data?.session_id) {
        session.id = data.session_id;
        // Track in session manager so conversations save to the right file
        if (_sessionMgr) _sessionMgr.setSessionInfo({ session_id: data.session_id });
      }
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

      const summary = data?.summary || '';
      if (summary && !_renderedContentThisTurn) {
        const rendered = renderMarkdown(summary);
        for (const line of rendered.split('\n')) {
          process.stdout.write(`  ${line}\n`);
        }
        _renderedContentThisTurn = true;
      }

      // Update session token counts
      const usage = data?.usage;
      let turnCost = 0;
      if (usage) {
        const inp = usage.total_input_tokens || usage.input_tokens || 0;
        const out = usage.total_output_tokens || usage.output_tokens || 0;
        session.inputTokens += inp;
        session.outputTokens += out;

        // Model-aware cost calculation
        const costResult = calculateCost(usage);
        turnCost = costResult.total;
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
      printTurnSummary(tools, data?.duration_s, turnCost);
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
      process.stderr.write(`  ${c.dim('ID')}           ${session.id || c.dim('(not assigned yet)')}\n`);
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
      const summary = ctx.approval.getSummary();
      process.stderr.write(`\n  ${c.bold('Safety Guardrails')} ${c.green('ACTIVE')}\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(40))}\n`);
      process.stderr.write(`  ${c.gray('Approval mode:')}  ${ctx.approval.getModeLabel()}\n`);
      process.stderr.write(`  ${c.gray('Approved:')}       ${summary.approved}  ${c.gray('Denied:')} ${summary.denied}\n`);
      process.stderr.write(`  ${c.gray('Protected files:')} ${rules.protectedNames.join(', ')}\n`);
      process.stderr.write(`  ${c.gray('Source dirs:')}     ${rules.sourceDirs.join(', ')}\n`);
      process.stderr.write(`  ${c.gray('Blocked patterns:')} ${rules.blockedPatterns}\n`);
      process.stderr.write(`  ${c.gray('High-risk patterns:')} ${rules.highRiskPatterns}\n`);
      process.stderr.write(`  ${c.gray('Ops blocked:')}     ${session.blockedOps}\n\n`);
      return;
    }

    case '/revoke': {
      const wasActive = ctx.approval.revoke();
      if (wasActive) {
        process.stderr.write(`  ${c.green('✓')} ${c.dim('Auto-approvals revoked. All tool calls will prompt again.')}\n`);
      } else {
        process.stderr.write(`  ${c.gray('No auto-approvals were active.')}\n`);
      }
      return;
    }

    case '/sessions': {
      const resumable = ctx.sessionMgr.listResumable(10);
      if (resumable.length === 0) {
        process.stderr.write(`  ${c.gray('No resumable sessions found.')}\n`);
        return;
      }
      process.stderr.write(`\n  ${c.bold('Resumable Sessions')}\n`);
      process.stderr.write(`  ${c.dim('─'.repeat(60))}\n`);
      for (const s of resumable) {
        const date = s.startedAt ? new Date(s.startedAt).toLocaleDateString() : '?';
        const instr = s.instruction ? s.instruction.slice(0, 40) : '(no instruction)';
        process.stderr.write(`  ${c.cyan(s.sessionId)}  ${c.dim(date)}  ${s.messageCount} msgs  ${c.dim(instr)}\n`);
      }
      process.stderr.write(`\n  ${c.dim('Resume with:')} orca --resume <sessionId>\n`);
      return;
    }

    case '/resume': {
      const parts = input.split(/\s+/);
      const targetId = parts[1]; // /resume <sessionId>

      if (targetId) {
        // Direct resume by ID
        const messages = ctx.sessionMgr.loadMessages(targetId);
        if (messages.length === 0) {
          process.stderr.write(`  ${c.yellow('!')} ${c.dim('No conversation found for session ' + targetId)}\n`);
          return;
        }
        session.history = messages;
        session.id = targetId;
        session.turns = Math.floor(messages.length / 2);
        process.stderr.write(`  ${c.green('↺')} ${c.dim(`Resumed: ${messages.length} messages`)}\n`);
        return;
      }

      // No ID given — list sessions and let user pick by number
      const resumable = ctx.sessionMgr.listResumable(10);
      if (resumable.length === 0) {
        process.stderr.write(`  ${c.gray('No resumable sessions found.')}\n`);
        return;
      }

      process.stderr.write(`\n  ${c.bold('Pick a session to resume:')}\n\n`);
      for (let i = 0; i < resumable.length; i++) {
        const s = resumable[i];
        const date = s.startedAt ? new Date(s.startedAt).toLocaleString() : '?';
        const instr = (s.instruction || '(no instruction)').slice(0, 45);
        const proj = s.project ? c.cyan(s.project) + ' ' : '';
        const num = `[${i + 1}]`;
        process.stderr.write(`  ${c.cyan(num)} ${proj}${c.dim(date)}  ${s.messageCount} msgs\n`);
        process.stderr.write(`      ${c.dim(instr)}\n`);
      }
      process.stderr.write(`\n  ${c.dim('Enter number (or Esc to cancel):')} `);

      // Read single key for selection
      const rl = ctx._rl || null;
      if (rl) rl.pause();
      const choice = await new Promise((resolve) => {
        if (!process.stdin.isTTY) { resolve(null); return; }
        const wasRaw = process.stdin.isRaw;
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.once('data', (data) => {
          process.stdin.setRawMode(wasRaw || false);
          if (rl) rl.resume();
          const bytes = [...data];
          if (bytes[0] === 0x1b || bytes[0] === 0x03) { resolve(null); return; }
          const num = parseInt(data.toString(), 10);
          resolve(isNaN(num) ? null : num);
        });
      });

      if (!choice || choice < 1 || choice > resumable.length) {
        process.stderr.write(`\n  ${c.dim('Cancelled.')}\n`);
        return;
      }

      const picked = resumable[choice - 1];
      const messages = ctx.sessionMgr.loadMessages(picked.sessionId);
      if (messages.length === 0) {
        process.stderr.write(`\n  ${c.yellow('!')} ${c.dim('No messages in that session.')}\n`);
        return;
      }

      session.history = messages;
      session.id = picked.sessionId;
      session.turns = Math.floor(messages.length / 2);
      process.stderr.write(`\n  ${c.green('↺')} ${c.dim(`Resumed: ${messages.length} messages`)}`);
      if (picked.instruction) {
        process.stderr.write(` ${c.dim('—')} ${c.dim(picked.instruction.slice(0, 50))}`);
      }
      process.stderr.write('\n');
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

    case '/logout': {
      const success = ctx.auth.logout();
      if (success) {
        process.stderr.write(`  ${c.green('✓')} ${c.dim('Signed out. Credentials cleared from ~/.orca/config.json')}\n`);
        process.stderr.write(`  ${c.dim('Run /login to sign in again.')}\n`);
      } else {
        process.stderr.write(`  ${c.yellow('!')} ${c.dim('No credentials to clear.')}\n`);
      }
      return;
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

  const cliArgs = parseArgs(process.argv.slice(2));
  const auth = new TarangAuth();

  // BM25 retriever — indexes project files for search_code tool
  const retriever = new ContextRetriever(safeCwd());
  const toolExecutor = createToolExecutor({ retriever });
  const skipPerms = cliArgs.freeswim;
  const approval = new ApprovalManager({ autoApprove: skipPerms });

  // Session manager — persists conversation messages to .orca/conversations/
  const sessionMgr = new SessionManager(safeCwd());
  _sessionMgr = sessionMgr; // expose to renderEvent

  // Local JSONL writer — writes cc-lens compatible session data to ~/.orca/
  const jsonlWriter = new JsonlWriter(safeCwd(), VERSION);

  // Persistent stream client — session_id captured from backend on first turn
  let streamClient = null;

  const ctx = { auth, toolExecutor, approval, jsonlWriter, sessionMgr };

  printBanner(auth);

  // ── Initialization with progress ──
  // BM25 indexing is CPU-bound and blocks the event loop, so setInterval
  // spinners won't tick during it. Instead, show a static "Initializing..."
  // message, then yield to the event loop between phases so the spinner runs.
  let projectSkeleton = '';

  // Phase 1: Show immediate feedback
  process.stderr.write(`  ${c.cyan('⠋')} ${c.dim('Initializing...')}\r`);

  // Fetch user in parallel (network I/O, won't block event loop)
  const userPromise = fetchUser(ctx);

  // Phase 2: BM25 index — CPU-bound, blocks event loop.
  // Wrap in a microtask break so the initial message renders first.
  const indexResult = await new Promise((resolve) => {
    // Let the event loop flush stderr before blocking
    setImmediate(async () => {
      try {
        process.stderr.write(`\r  ${c.cyan('⠹')} ${c.dim('Indexing project files...')}${' '.repeat(20)}\r`);
        const result = await retriever.buildIndex();
        resolve(result);
      } catch {
        resolve({ fileCount: 0, chunkCount: 0 });
      }
    });
  });

  // Phase 3: Build skeleton (fast, synchronous)
  process.stderr.write(`\r  ${c.cyan('⠼')} ${c.dim('Building project skeleton...')}${' '.repeat(20)}\r`);
  await new Promise(r => setImmediate(r)); // yield so message renders
  projectSkeleton = buildProjectSkeleton(safeCwd());

  // Wait for user fetch
  await userPromise;

  // Clear the spinner line
  process.stderr.write(`\r${' '.repeat(60)}\r`);

  // Show init summary
  if (indexResult.fileCount > 0) {
    process.stderr.write(`  ${c.green('✓')} ${c.dim(`Indexed ${indexResult.fileCount} files (${indexResult.chunkCount} chunks)`)}\n`);
  }
  if (projectSkeleton) {
    process.stderr.write(`  ${c.green('✓')} ${c.dim('Project skeleton ready')}\n`);
  }
  if (session.user) {
    process.stderr.write(`  ${c.green('✓')} ${c.dim(`Logged in as ${session.user.github_username || session.user.email || 'user'}`)}\n`);
  }
  // ── Resume previous session ──
  if (cliArgs.resume) {
    const lastSession = cliArgs.resumeSessionId
        ? { sessionId: cliArgs.resumeSessionId }
        : sessionMgr.getLastSession();

    if (lastSession) {
      const messages = sessionMgr.loadMessages(lastSession.sessionId);
      if (messages.length > 0) {
        session.history = messages;
        session.id = lastSession.sessionId;
        session.turns = Math.floor(messages.length / 2);
        process.stderr.write(`  ${c.green('↺')} ${c.dim(`Resumed session: ${messages.length} messages`)}`);
        if (lastSession.instruction) {
          process.stderr.write(` ${c.dim('—')} ${c.dim(lastSession.instruction.slice(0, 50))}`);
        }
        process.stderr.write('\n');
      } else {
        process.stderr.write(`  ${c.yellow('!')} ${c.dim('No conversation found for session ' + lastSession.sessionId)}\n`);
      }
    } else {
      process.stderr.write(`  ${c.yellow('!')} ${c.dim('No previous session to resume')}\n`);
    }
  }

  process.stderr.write(`\n  ${c.dim('Press')} ${c.cyan('Enter')} ${c.dim('to start, or type a prompt below.')}\n`);

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
  ctx._rl = rl; // expose to /resume command for readline pause

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

    // Start session tracking on first turn
    if (session.turns === 1) {
      sessionMgr.start(input);
    }
    sessionMgr.saveMessage('user', input);

    // Local JSONL: write user turn + history
    jsonlWriter.writeUserTurn(input);
    jsonlWriter.writeHistory(input);

    const creds = auth.loadCredentials();
    if (!creds.token) {
      process.stderr.write(`  ${c.red('Not logged in. Run /login first.')}\n`);
      showPrompt();
      return;
    }

    // Orca response label
    process.stderr.write(`\n${c.bold(c.cyan('orca'))}\n`);

    // Create or reuse stream client — sessionId persists across turns
    if (!streamClient || streamClient.baseUrl !== creds.backendUrl || streamClient.token !== creds.token) {
      streamClient = new TarangStreamClient({
        baseUrl: creds.backendUrl,
        token: creds.token,
        toolExecutor,
        approvalManager: approval,
      });
    }
    const client = streamClient;

    let assistantContent = '';

    // ── Execution keypress listener (Esc = cancel, Space = pause/resume) ──
    let executionPaused = false;
    let keypressCleanup = null;
    let execListenerActive = false;

    if (process.stdin.isTTY) {
      rl.pause();
      const wasRaw = process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      execListenerActive = true;

      const onData = (data) => {
        if (!execListenerActive) return; // paused for approval menu
        const bytes = [...data];

        // Esc key (single byte 0x1b, not part of arrow sequence)
        if (bytes.length === 1 && bytes[0] === 0x1b) {
          stopSpinner();
          process.stderr.write(`\n  ${c.yellow('⏹')} ${c.dim('Cancelling...')}\n`);
          client.cancel();
          return;
        }

        // Space — toggle pause/resume
        if (bytes.length === 1 && bytes[0] === 0x20) {
          if (executionPaused) {
            executionPaused = false;
            process.stderr.write(`  ${c.green('▶')} ${c.dim('Resumed')}\n`);
            client.resume();
          } else {
            executionPaused = true;
            stopSpinner();
            process.stderr.write(`  ${c.yellow('⏸')} ${c.dim('Paused — press Space to resume, Esc to cancel')}\n`);
            client.pause();
          }
          return;
        }

        // Ctrl+C during execution
        if (bytes[0] === 0x03) {
          stopSpinner();
          client.cancel();
          process.exit(0);
        }
      };

      process.stdin.on('data', onData);

      // Let approval manager pause/resume this listener
      approval.setExecutionHooks({
        onPause: () => { execListenerActive = false; },
        onResume: () => { execListenerActive = true; },
      });

      keypressCleanup = () => {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(wasRaw || false);
        execListenerActive = false;
        approval.setExecutionHooks({}); // clear hooks
        rl.resume();
      };
    }

    try {
      startContentStream();

      const execContext = { cwd: safeCwd() };
      if (skipPerms) execContext.freeswim = true;
      if (projectSkeleton) execContext.project_skeleton = projectSkeleton;

      for await (const event of client.execute(input, execContext, session.history)) {
        renderEvent(event);

        if (event.type === 'content' || event.type === 'content_partial') {
          const text = event.data?.text || '';
          if (text) assistantContent = text;
          // Local JSONL: accumulate content
          jsonlWriter.accumulateContent(text);
        }

        // Local JSONL: capture session ID from backend
        if (event.type === 'session_info' && event.data?.session_id) {
          jsonlWriter.setSessionId(event.data.session_id);
        }

        // Local JSONL: accumulate tool calls
        if (event.type === 'tool_call' || event.type === 'tool_request') {
          const d = event.data || {};
          jsonlWriter.accumulateToolCall(d.call_id || d.request_id, d.tool, d.args);
        }

        // Local JSONL: record tool results
        if (event.type === 'tool_done' || event.type === 'tool_result') {
          const d = event.data || {};
          jsonlWriter.recordToolResult(d.call_id || d._callId, d.output, d.success === false);
        }

        // Local JSONL: flush assistant turn on complete
        if (event.type === 'complete') {
          jsonlWriter.setTurnUsage(event.data?.usage, session.model);
          jsonlWriter.flushAssistantTurn();
        }
      }

      flushContent();
    } catch (err) {
      inPlace('');
      flushContent();
      process.stderr.write(`  ${c.red('Error: ' + err.message)}\n`);
    } finally {
      // Clean up execution keypress listener
      if (keypressCleanup) keypressCleanup();
    }

    if (assistantContent) {
      session.history.push({ role: 'assistant', content: assistantContent });
      sessionMgr.saveMessage('assistant', assistantContent);
    }

    showPrompt();
  });

  rl.on('close', async () => {
    stopSpinner();
    await jsonlWriter.close();
    process.stderr.write(`\n  ${c.dim('session ended')}\n\n`);
    process.exit(0);
  });
}
