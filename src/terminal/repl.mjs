/**
 * Kepler REPL — Full Claude-like terminal UX.
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
import * as fs from 'node:fs';
import { c, progressBar, spinner, inPlace, renderMarkdown, renderDiff, formatElapsed, formatCost, stripAnsi } from './ansi.mjs';
import { calculateCost, formatCostValue, formatTokens, costToCredits, formatCredits } from '../core/pricing.mjs';
import { TarangStreamClient, EVENT_TYPES } from '../core/stream-client.mjs';
import { JsonlWriter } from '../core/jsonl-writer.mjs';
import { createToolExecutor } from '../core/tool-executor.mjs';
import { persistProjectArtifacts } from '../core/project-artifacts.mjs';
import { TarangAuth } from '../auth/tarang-auth.mjs';
import { ApprovalManager } from '../core/approval.mjs';
import { resolveBackendUrl } from '../core/backend-url.mjs';
import { BUILTIN_AGENTS, runAgent } from './agents.mjs';
import { SessionManager } from '../core/session-manager.mjs';
import { parseArgs } from '../config/cli-args.mjs';
import { toolDisplayLabel } from './tool-display.mjs';
import { createOrbit } from '../state/orbit.mjs';
import { attachOrbit, unmount as unmountStatusBar } from '../ui/status-bar.mjs';
import { term } from '../ui/term.mjs';
import {
  formatCardHead,
  summarizeResult,
  recordCard,
  lastCard,
  getCard,
  allCards,
} from '../ui/tool-card.mjs';
import { detailFor } from '../ui/tool-details.mjs';
import { paint } from '../ui/palette.mjs';

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
let _orbit = null;      // Mission Control orbit state machine; set in startTerminalRepl

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
  '/last':     'Expand last tool output',
  '/expand':   'Expand tool output by index (or "all")',
  '/fold':     'Hide previously expanded tool output',
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

  const CYAN = '\x1b[36m';
  const DIM = '\x1b[2m';
  const BOLD = '\x1b[1m';
  const YELLOW = '\x1b[33m';
  const RST = '\x1b[0m';

  process.stderr.write('\n');
  process.stderr.write(`${DIM}         ✦${RST}\n`);
  process.stderr.write(`${DIM}      ╭──────────────────────────╮${RST}\n`);
  process.stderr.write(`${DIM}      │${RST}  ${BOLD}${CYAN}K · E · P · L · E · R${RST}  ${DIM}│${RST}\n`);
  process.stderr.write(`${DIM}      ╰──────── ${YELLOW}◯${RST}${DIM} ───────────────╯${RST}\n`);
  process.stderr.write(`${DIM}            ╱ ╲${RST}\n`);
  process.stderr.write(`${DIM}       the agentic os${RST}\n`);
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
//   kepler ›
//
// Layout on first prompt (no stats yet):
//
//   ╶─────────────────────────────────────────────────────────────────╴
//   kepler ›

/**
 * Build the contextual status strip — compact, one line.
 * Left side: last-turn summary (tools, time, cost)
 * Right side: session totals (ctx%, tokens)
 */
function buildContextStrip() {
  const totalTokens = session.inputTokens + session.outputTokens;
  const credits = formatCredits(costToCredits(session.totalCost));
  const elapsed = formatElapsed(session.startTime);

  const right = [
    c.dim(`${formatTokens(totalTokens)} tok`),
    c.dim(credits),
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
  if (turnCost > 0) parts.push(formatCredits(costToCredits(turnCost)));
  if (parts.length > 0) {
    process.stderr.write(`\n  ${c.green('✓')} ${c.dim(parts.join(' · '))}\n`);
  }
}

function updateStatusBar() {
  // No-op: status is printed inline via printPromptBlock before each prompt
}

// ── Tool Display Renderer ──

/**
 * Render a tool call as the head of a Mission Control card — icon + label +
 * args. The result arrives later via `renderToolResult` and is appended as a
 * gutter line. Sub-agent calls are indented per session.inSubAgent.
 */
function renderToolCall(data) {
  const tool = data?.tool || 'unknown';
  const args = data?.args || {};
  const indent = session.inSubAgent ? '     ' : '  ';
  const callId = data?.call_id || data?._callId || `${tool}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const head = formatCardHead(tool, args, {
    cwd: safeCwd(),
    columns: process.stderr.columns || 120,
    indent,
  });

  recordCard({ id: callId, tool, args, head, startedAt: Date.now() });
  process.stderr.write(`\n${head}\n`);
}

/**
 * Render a tool result (success/failure, output snippet).
 */
const _renderedToolResults = new Set();

function formatToolDuration(data) {
  const ms = data?.duration_ms ?? (data?.duration_s != null ? data.duration_s * 1000 : null);
  if (ms == null) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function renderToolResult(data, eventType = 'tool_result') {
  if (!data) return;
  const indent = session.inSubAgent ? '     ' : '  ';
  const gutter = `${indent}${paint.text.dim('⎿')}  `;
  const callId = data.call_id || data._callId;
  if (eventType === 'tool_done' && callId && _renderedToolResults.has(callId)) return;
  if (callId) _renderedToolResults.add(callId);

  const tool = data.tool || data._tool || '';
  const durationMs = data?.duration_ms ?? (data?.duration_s != null ? data.duration_s * 1000 : null);

  // Update the card buffer so /last and `d` can find it.
  if (callId) recordCard({ id: callId, tool, args: data.args, result: data, durationMs });

  if (data._blocked) session.blockedOps++;

  const { text, tone: t } = summarizeResult(tool, data);
  const arrow = paint.text.dim('→');
  const painter = t === 'success' ? paint.state.success
                : t === 'warn'    ? paint.state.warn
                : t === 'danger'  ? paint.state.danger
                                  : paint.text.dim;
  const duration = formatToolDuration(data);
  const tail = duration ? paint.text.dim(` · ${duration}`) : '';
  process.stderr.write(`${gutter}${arrow} ${painter(text || 'done')}${tail}\n`);

  // Lint warnings stay visible alongside writes.
  if ((tool === 'write_file' || tool === 'edit_file') && data.lint) {
    process.stderr.write(`${gutter}${paint.state.warn('⚠ ' + String(data.lint).split('\n')[0].slice(0, 80))}\n`);
  }
}

// ── Expand handler — `d`, `/last`, `/expand` ───────────────────────────
//
// All three call into the same renderer so output is consistent across
// keypress and slash-command paths. `expandLast` and `expandIndex` write
// directly to stderr.

function expandLast() {
  const card = lastCard();
  if (!card) {
    process.stderr.write(`  ${paint.text.dim('(no tool to expand yet)')}\n`);
    return;
  }
  process.stderr.write('\n' + detailFor(card) + '\n\n');
}

function expandIndex(idxOrAll) {
  if (idxOrAll === 'all') {
    const cards = allCards();
    if (!cards.length) {
      process.stderr.write(`  ${paint.text.dim('(no tools to expand yet)')}\n`);
      return;
    }
    process.stderr.write('\n');
    for (const c of cards) process.stderr.write(detailFor(c) + '\n');
    process.stderr.write('\n');
    return;
  }
  const card = getCard(idxOrAll);
  if (!card) {
    process.stderr.write(`  ${paint.text.dim('(no card at index ' + idxOrAll + ')')}\n`);
    return;
  }
  process.stderr.write('\n' + detailFor(card) + '\n\n');
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
    inPlace(`  ${c.brand(frame)} ${c.dim(_spinText)}`);
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
let _streamedPartialText = '';
let _streamTimer = null;
let _renderedContentThisTurn = false;

function startContentStream() {
  _streamBuffer = '';
  _streamedPartialText = '';
  _renderedToolResults.clear();
  _renderedContentThisTurn = false;
  stopSpinner();
}

function appendContent(text) {
  if (!text) return;
  _streamBuffer += text;
  _streamedPartialText += text;

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

  // Push every event into the orbit state machine before rendering so the
  // bottom status bar reflects what is happening this very moment. The orbit
  // module is a no-op when status-bar is not mounted (non-TTY, --headless).
  if (_orbit) _orbit.onEvent(event);

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
      let text = data?.text || '';
      if (text) {
        flushContent();
        stopSpinner();
        if (_streamedPartialText && text.startsWith(_streamedPartialText)) {
          text = text.slice(_streamedPartialText.length);
        } else if (_streamedPartialText.includes(text)) {
          text = '';
        }
      }
      if (text) {
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
      renderToolResult(data, type);
      break;
    }

    case 'plan': {
      stopSpinner();
      flushContent();
      const milestones = data?.milestones || data?.steps || [];
      const title = data?.title || 'Plan';
      process.stderr.write(`\n  ${c.brand('▸')} ${c.bold(title)}\n`);
      for (const [index, milestone] of milestones.entries()) {
        const label = typeof milestone === 'string'
          ? milestone
          : milestone.name || milestone.title || milestone.description || `Step ${index + 1}`;
        const status = typeof milestone === 'object' ? milestone.status : '';
        const marker = status === 'complete' || status === 'completed' ? c.green('✓') : c.dim(`${index + 1}.`);
        process.stderr.write(`     ${marker} ${label}\n`);
      }
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
        process.stderr.write(`\n  ${c.brand('▸')} ${c.bold(phase)}\n`);
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
      process.stderr.write(`\n  ${c.brand('↳')} ${c.dim(from)} ${c.brand('→')} ${c.bold(to)}`);
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
      process.stderr.write(`\n  ${icon} ${c.bold(c.brand(`${agentType} agent`))} ${c.dim('started')}\n`);
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
      if (data?.tool_calls > 0) parts.push(`${data.tool_calls} tools`);
      if (data?.iterations > 0) parts.push(`${data.iterations} iterations`);
      if (resultLen > 0) parts.push(`${resultLen} chars`);
      if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
      if (data?.duration_s != null) parts.push(`${Number(data.duration_s).toFixed(1)}s`);
      const icon = agentType === 'explore' ? '🔭' : agentType === 'plan' ? '📐' : '🤖';
      const marker = data?.success === false ? c.red('✗') : c.green('✓');
      const label = data?.success === false ? `${agentType} agent failed` : `${agentType} agent complete`;
      process.stderr.write(`  ${icon} ${marker} ${c.dim(label)}${parts.length ? '  ' + c.dim(parts.join(' · ')) : ''}\n`);
      if (data?.error) process.stderr.write(`     ${c.red(String(data.error).slice(0, 140))}\n`);
      process.stderr.write('\n');
      break;
    }

    case 'plan_created': {
      process.stderr.write(`  ${c.dim('project plan prepared')}\n`);
      break;
    }

    case 'goal_created': {
      process.stderr.write(`  ${c.dim('project goal prepared')}\n`);
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

      // Sync cumulative session cost into the orbit (status bar shows it).
      if (_orbit) _orbit.onCost(session.totalCost);

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
      process.stderr.write(`\n  ${c.bold('Kepler Commands')}\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(44))}\n`);
      for (const [name, desc] of Object.entries(COMMANDS)) {
        process.stderr.write(`  ${c.brand(name.padEnd(14))} ${desc}\n`);
      }
      process.stderr.write(`\n  ${c.bold('Keyboard')}\n`);
      process.stderr.write(`  ${c.gray('Ctrl+C')}  exit   ${c.gray('↑↓')}  history   ${c.gray('Tab')}  autocomplete\n`);
      process.stderr.write(`  ${c.gray('d')}       expand last tool   ${c.gray('Space')}  pause/resume   ${c.gray('Esc')}  interrupt\n\n`);
      return;

    case '/login':
      process.stderr.write(`${c.brand('Starting login flow...')}\n`);
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
      process.stderr.write(`  ${c.dim('Credits')}      ${formatCredits(costToCredits(session.totalCost))}${session.costAccurate ? '' : c.dim(' (est)')}\n`);
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
            process.stderr.write(`    ${c.dim(d.from)} ${c.brand('→')} ${d.to}\n`);
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
      process.stderr.write(`  ${c.gray('Credits:')}   ${formatCredits(costToCredits(session.totalCost))}${session.costAccurate ? '' : c.dim(' (est)')}\n`);
      process.stderr.write(`  ${c.gray('Elapsed:')}  ${formatElapsed(session.startTime)}\n\n`);
      return;
    }

    case '/cost': {
      process.stderr.write(`\n  ${c.bold('Session Credits')}  ${c.brand(formatCredits(costToCredits(session.totalCost)))}`);
      if (!session.costAccurate) {
        process.stderr.write(`  ${c.yellow('(estimated)')}`);
      }
      process.stderr.write('\n');
      process.stderr.write(`  ${c.dim('─'.repeat(70))}\n`);

      if (session.costBreakdown.length > 0) {
        // Header
        process.stderr.write(`  ${c.dim('Model'.padEnd(36))}${c.dim('Input'.padStart(10))}${c.dim('Output'.padStart(10))}${c.dim('Cache'.padStart(10))}${c.dim('Credits'.padStart(10))}\n`);
        process.stderr.write(`  ${c.dim('─'.repeat(70))}\n`);

        for (const b of session.costBreakdown) {
          const modelLabel = b.model === 'unknown' ? c.yellow('unknown model') : b.model;
          const roleTag = b.role && b.role !== 'unknown' ? ` ${c.dim(`(${b.role})`)}` : '';
          const cacheTokens = (b.cache_read_tokens || 0) + (b.cache_creation_tokens || 0);
          const costStr = b.free ? c.green('free') : formatCredits(costToCredits(b.cost));

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
        `${formatCredits(costToCredits(session.totalCost)).padStart(10)}\n`
      );
      process.stderr.write(`  ${c.dim(`Turns: ${session.turns}  Duration: ${formatElapsed(session.startTime)}  Provider: ${formatCostValue(session.totalCost)}`)}\n\n`);
      return;
    }

    case '/history':
      if (session.history.length === 0) { process.stderr.write(`  ${c.gray('No conversation yet.')}\n`); return; }
      process.stderr.write(`\n  ${c.bold('Conversation')} (${session.history.length} messages)\n`);
      process.stderr.write(`  ${c.gray('─'.repeat(40))}\n`);
      for (const msg of session.history.slice(-20)) {
        const role = msg.role === 'user' ? c.white('You') : c.brand('Kepler');
        process.stderr.write(`  ${role}: ${msg.content.slice(0, 80)}${msg.content.length > 80 ? '...' : ''}\n`);
      }
      process.stderr.write('\n');
      return;

    case '/last':
      expandLast();
      return;

    case '/expand': {
      const arg = rest.trim();
      if (!arg) { expandLast(); return; }
      if (arg === 'all') { expandIndex('all'); return; }
      const n = Number(arg);
      if (!Number.isFinite(n)) {
        process.stderr.write(`  ${c.gray('Usage: /expand [n|all] — n is the 1-based index from the start of the session')}\n`);
        return;
      }
      // Users pass 1-based; getCard accepts negative (-1 = last) or positive index.
      expandIndex(n > 0 ? n - 1 : n);
      return;
    }

    case '/fold':
      process.stderr.write(`  ${c.gray('Output is folded by default — there is nothing to hide. Use /last or d to expand.')}\n`);
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
      try {
        const diff = execSync('git diff --no-ext-diff --unified=3', {
          encoding: 'utf-8',
          maxBuffer: 2 * 1024 * 1024,
        });
        process.stdout.write(diff ? renderDiff(diff) + '\n' : c.dim('(no changes)') + '\n');
      }
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
        process.stderr.write(`  ${c.brand(s.sessionId)}  ${c.dim(date)}  ${s.messageCount} msgs  ${c.dim(instr)}\n`);
      }
      process.stderr.write(`\n  ${c.dim('Resume with:')} kepler --resume <sessionId>\n`);
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
        const proj = s.project ? c.brand(s.project) + ' ' : '';
        const num = `[${i + 1}]`;
        process.stderr.write(`  ${c.brand(num)} ${proj}${c.dim(date)}  ${s.messageCount} msgs\n`);
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
        process.stderr.write(`  ${c.brand(('/' + agent.command).padEnd(14))} ${agent.description}\n`);
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
        process.stderr.write(`  ${c.green('✓')} ${c.dim('Signed out. Credentials cleared from ~/.kepler/config.json')}\n`);
        process.stderr.write(`  ${c.dim('Run /login to sign in again.')}\n`);
      } else {
        process.stderr.write(`  ${c.yellow('!')} ${c.dim('No credentials to clear.')}\n`);
      }
      return;
    }

    case '/exit':
    case '/quit':
      process.stderr.write(`\n  ${c.brand('Goodbye!')}\n\n`);
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

  // Projects are registered and indexed on demand through get_project_overview.
  const toolExecutor = createToolExecutor();
  const skipPerms = cliArgs.freeswim;
  const approval = new ApprovalManager({ autoApprove: skipPerms });

  // Session manager — persists conversation messages to .kepler/conversations/
  const sessionMgr = new SessionManager(safeCwd());
  _sessionMgr = sessionMgr; // expose to renderEvent

  // Local JSONL writer — writes cc-lens compatible session data to ~/.kepler/
  const jsonlWriter = new JsonlWriter(safeCwd(), VERSION);

  // Persistent stream client — session_id captured from backend on first turn
  let streamClient = null;

  const ctx = { auth, toolExecutor, approval, jsonlWriter, sessionMgr };

  // ── Mission Control orbit + status bar ──
  // Opt-out via KEPLER_STATUS_BAR=0 (debugging) or KEPLER_PLAIN=1 (PRD-055).
  // status-bar.mjs already no-ops when stdout is not a TTY, but the explicit
  // env opt-out is useful for debugging escape-sequence noise.
  const statusBarEnabled = process.env.KEPLER_STATUS_BAR !== '0' && term().isTTY && !term().plain;
  if (statusBarEnabled) {
    _orbit = createOrbit();
    attachOrbit(_orbit);
    // Always unmount before exit so the terminal scroll region is restored.
    process.on('beforeExit', unmountStatusBar);
    process.on('exit',       unmountStatusBar);
  }

  printBanner(auth);

  // ── Initialization ──
  process.stderr.write(`  ${c.brand('⠋')} ${c.dim('Initializing...')}\r`);
  await fetchUser(ctx);

  // Clear the spinner line
  process.stderr.write(`\r${' '.repeat(60)}\r`);
  process.stderr.write(`  ${c.green('✓')} ${c.dim('Ready; projects will be indexed on demand')}\n`);
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

  process.stderr.write(`\n  ${c.dim('Press')} ${c.brand('Enter')} ${c.dim('to start, or type a prompt below.')}\n`);

  const PROMPT = `${c.brand('kepler')} ${c.dim('›')} `;

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

    // Tell the orbit a new turn started — switches to DISCOVERY and updates
    // task / turn counters in the status bar.
    if (_orbit) _orbit.onUserInput(input);

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

    // Kepler response label
    process.stderr.write(`\n${c.bold(c.brand('kepler'))}\n`);

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
            if (_orbit) _orbit.onResume();
          } else {
            executionPaused = true;
            stopSpinner();
            process.stderr.write(`  ${c.yellow('⏸')} ${c.dim('Paused — press Space to resume, Esc to cancel')}\n`);
            client.pause();
            if (_orbit) _orbit.onPause();
          }
          return;
        }

        // Ctrl+C during execution
        if (bytes[0] === 0x03) {
          stopSpinner();
          client.cancel();
          process.exit(0);
        }

        // `d` — expand last tool card (Mission Control §6.2)
        if (bytes.length === 1 && (bytes[0] === 0x64 || bytes[0] === 0x44)) {
          stopSpinner();
          expandLast();
          return;
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
      execContext.project_resources = toolExecutor.getProjectResources();
      execContext.agent_context = toolExecutor.getAgentContext();

      for await (const event of client.execute(input, execContext, session.history)) {
        if (event.type === 'plan_created' || event.type === 'goal_created') {
          persistProjectArtifacts(
            event.data,
            toolExecutor.getProjectResources(),
            message => process.stderr.write(`  ${c.dim(message)}\n`),
          );
        }
        renderEvent(event);

        if (event.type === 'content_partial') {
          const text = event.data?.text || '';
          assistantContent += text;
          jsonlWriter.accumulateContent(text);
        } else if (event.type === 'content') {
          const text = event.data?.text || '';
          const newText = assistantContent && text.startsWith(assistantContent)
            ? text.slice(assistantContent.length)
            : text === assistantContent ? '' : text;
          if (text) {
            assistantContent = assistantContent && !text.startsWith(assistantContent)
              ? assistantContent + text
              : text;
          }
          if (newText) jsonlWriter.accumulateContent(newText);
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
