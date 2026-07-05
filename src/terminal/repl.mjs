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
import { CheckpointManager } from '../core/checkpoints.mjs';
import { runPreflight } from '../onboarding/preflight.mjs';
import { printBanner as printBrandedBanner } from '../ui/banner.mjs';
import { renderMissionReport, saveReport, toMarkdown as missionMarkdown } from '../ui/mission-report.mjs';
import {
  getVerbosity,
  setVerbosity,
  label as verbosityLabel,
  MODES as V_MODES,
} from '../state/verbosity.mjs';
import { persistProjectArtifacts } from '../core/project-artifacts.mjs';
import { TarangAuth } from '../auth/tarang-auth.mjs';
import { ApprovalManager } from '../core/approval.mjs';
import { resolveBackendUrl } from '../core/backend-url.mjs';
import { formatMessageWindow, lowWindowStatus, messagesRemaining } from '../core/rate-limit-display.mjs';
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
import {
  renderSubAgentOpen,
  renderSubAgentClose,
  subAgentIndent,
  inSubAgent as inSubAgentBlock,
  resetSubAgents,
} from '../ui/sub-agent.mjs';

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
  toolCounts: {},      // per-tool histogram (mission report)
  subAgentCounts: {},  // per-sub-agent histogram (mission report)
  savedUsd: 0,         // total sub-agent cost (for "saved by routing")
  lastTask: '',        // most recent user prompt (mission report title)
  lastReasoning: '',   // captured from agent for /why
  budgetUsd: null,     // /budget cap, null = unlimited
  budgetExceeded: false,
  costBreakdown: [],   // per-model usage: [{ model, role, input_tokens, output_tokens, cost }]
  totalCost: 0,        // accumulated session cost (USD)
  costAccurate: false, // true if backend provides per-model breakdown
  isByok: false,       // set from session_info; hides cost + credits when true
  // ── Subscription / credit state (server-authoritative; set from
  //    session_info + complete events) ──
  subscriptionTier: null,        // 'free' | 'cli' | 'pro' | 'pro_plus' | 'enterprise'
  creditsTotal: null,            // remaining credits (included + purchased)
  creditsIncluded: null,         // remaining included credits this period
  creditsPurchased: null,        // remaining purchased credits
  creditsLimit: null,            // per-period included credits limit
  creditsCharged: 0,             // session-cumulative server-reported charges
  creditsLowWarned: false,       // emit the low-balance hint only once per turn
  rateLimit: null,               // rolling message-window state from backend
  msgsLowWarned: false,          // emit the low-window hint only once per turn
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
  '/checkpoint':'List recent file checkpoints',
  '/undo':     'Restore the last file checkpoint',
  '/preflight':'Re-run the onboarding diagnostic',
  '/report':   'Save the mission report as markdown',
  '/why':      'Print the agent reasoning for the last decision',
  '/map':      'Show the registered project tree',
  '/budget':   'Set / clear a hard session cost cap',
  '/quiet':    'Verbosity: hide sub-agent inner tools',
  '/verbose':  'Verbosity: show sub-agent inner tools',
  '/surgical': 'Verbosity: show everything (reasoning, expanded tools)',
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
  // Delegate the visual block to the branded banner module (PRD-055 §4.3,
  // gradient KEPLER letters in Deep Space Purple → Stellar Magenta → Neon
  // Cyan). The trailing status line stays here because it needs `auth`.
  printBrandedBanner();

  const creds = auth.loadCredentials();
  const env = process.env.TARANG_ENV || 'production';
  const authStatus = creds.token ? c.green('authenticated') : c.red('/login to start');
  process.stderr.write(`  ${c.gray('v' + VERSION)}  ${c.dim(env)}  ${authStatus}\n\n`);
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
  const elapsed = formatElapsed(session.startTime);

  // BYOK: user pays the provider directly, suppress credits entirely.
  // Otherwise prefer the server-authoritative session counter, falling back
  // to the local estimate when the backend hasn't pushed any number yet.
  const usedCr = session.creditsCharged > 0
    ? session.creditsCharged
    : costToCredits(session.totalCost);
  const right = [
    c.dim(`${formatTokens(totalTokens)} tok`),
    ...(session.rateLimit && !session.isByok ? [c.dim(formatMessageChip(session.rateLimit))] : []),
    ...(session.isByok ? [] : [c.dim(formatCredits(usedCr))]),
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
/**
 * Pull blocker bullet points from the completion payload — used by the
 * failure variant of the mission report.
 */
function extractBlockers(data) {
  const out = [];
  if (data?.error) out.push(String(data.error).slice(0, 160));
  if (Array.isArray(data?.failed_tests)) {
    for (const t of data.failed_tests.slice(0, 6)) {
      if (typeof t === 'string') out.push(t);
      else if (t?.name) out.push(`${t.name}${t.message ? ': ' + t.message : ''}`);
    }
  }
  return out;
}

function printTurnSummary(toolCount, durationS, turnCost) {
  const parts = [];
  if (toolCount > 0) parts.push(`${toolCount} tools`);
  if (durationS) parts.push(`${Number(durationS).toFixed(1)}s`);
  if (session.rateLimit && !session.isByok) parts.push(formatMessageChip(session.rateLimit));
  if (turnCost > 0 && !session.isByok) parts.push(formatCredits(costToCredits(turnCost)));
  if (parts.length > 0) {
    process.stderr.write(`\n  ${c.green('✓')} ${c.dim(parts.join(' · '))}\n`);
  }
}

function formatMessageChip(rateLimit) {
  const remaining = messagesRemaining(rateLimit);
  if (remaining === Infinity) return 'unlimited messages';
  const limit = Number(rateLimit?.msgs_per_window);
  if (typeof remaining === 'number' && Number.isFinite(limit)) {
    return `${remaining}/${limit} messages`;
  }
  return 'messages';
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
// Deferred-head strategy: we DON'T print the tool head when tool_call fires.
// Instead we buffer it and let renderToolResult emit one combined line
// "head  → outcome · duration\n". A spinner shows what's running in the
// meantime so the user still has feedback during slow tools.
//
// If something else needs to print before the result arrives (a streamed
// content event, a sub-agent open, an error, completion), we flush the
// buffered head as a regular two-line shape first so the interleaving
// content lands below it.
let _pendingHead = null; // { callId, head, indent }

function flushPendingHead() {
  if (!_pendingHead) return;
  process.stderr.write(`\n${_pendingHead.head}\n`);
  _pendingHead = null;
}

function clearPendingHead() {
  // Called by interleaving handlers — flush as 2-line shape (because we are
  // about to print something else) and continue.
  flushPendingHead();
}

function renderToolCall(data) {
  const tool = data?.tool || 'unknown';
  const args = data?.args || {};
  const indent = subAgentIndent();
  const callId = data?.call_id || data?._callId || `${tool}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // If a previous head is still pending (no result yet), flush it as a
  // regular two-line shape before starting the next one.
  flushPendingHead();

  const head = formatCardHead(tool, args, {
    cwd: safeCwd(),
    columns: process.stderr.columns || 120,
    indent,
  });

  recordCard({ id: callId, tool, args, head, startedAt: Date.now() });
  session.toolCounts[tool] = (session.toolCounts[tool] || 0) + 1;
  _pendingHead = { callId, head, indent };
  // Spinner shows what's running until the result arrives.
  startSpinner(`${tool}…`);
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
  const indent = subAgentIndent();
  const gutter = `${indent}${paint.text.dim('⎿')}  `;
  const callId = data.call_id || data._callId;
  // Either tool_result or tool_done is allowed to render — whichever wins
  // the race. Subsequent events for the same callId are duplicates.
  if (callId && _renderedToolResults.has(callId)) return;
  if (callId) _renderedToolResults.add(callId);

  const tool = data.tool || data._tool || '';
  const durationMs = data?.duration_ms ?? (data?.duration_s != null ? data.duration_s * 1000 : null);

  // Update the card buffer so /last and `d` can find it.
  if (callId) recordCard({ id: callId, tool, args: data.args, result: data, durationMs });

  if (data._blocked) session.blockedOps++;

  const { text, tone: t } = summarizeResult(tool, data);
  // Em dash reads more like prose than a system arrow.
  const arrow = paint.text.dim('—');
  const painter = t === 'success' ? paint.state.success
                : t === 'warn'    ? paint.state.warn
                : t === 'danger'  ? paint.state.danger
                                  : paint.text.dim;
  // Skip the duration tail when the tool was effectively instant (<200ms) —
  // "1ms" / "0ms" was noise that hurt the prose feel.
  const duration = (durationMs != null && durationMs < 200) ? '' : formatToolDuration(data);
  const tail = duration ? paint.text.dim(` · ${duration}`) : '';
  const outcome = `${arrow} ${painter(text || 'done')}${tail}`;
  const hasLint = (tool === 'write_file' || tool === 'edit_file') && data.lint;

  // ── Single-line combined emit ──
  // If the head for this call is still buffered (no interleaving content
  // landed), and the combined line fits the terminal width, emit ONE line
  // and skip the gutter entirely.
  if (_pendingHead && _pendingHead.callId === callId && !hasLint) {
    const cols = process.stderr.columns || 120;
    const combined = `${_pendingHead.head}  ${outcome}`;
    if (stripAnsi(combined).length <= cols) {
      process.stderr.write(`\n${combined}\n`);
      _pendingHead = null;
      return;
    }
    // Combined too wide — flush the head as 2-line and fall through.
    flushPendingHead();
  } else if (_pendingHead) {
    // Stale pending head (different callId) — flush it before printing this
    // result's gutter line below.
    flushPendingHead();
  }

  // Two-line shape: gutter under the (already-printed or just-flushed) head.
  process.stderr.write(`${gutter}${outcome}\n`);

  // Lint warnings stay visible alongside writes.
  if (hasLint) {
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
  // Any streamed content between renderToolCall and renderToolResult would
  // scroll the head off "the line above", breaking the in-place collapse.
  clearPendingHead();
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
  // Any buffered tool head needs to land BEFORE this content so the order
  // is preserved on screen.
  flushPendingHead();
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
        // Surface substantive thinking text as visible prose so the user can
        // follow the agent's reasoning, not just see a spinner blip. We
        // print at most one line per distinct thought, dim italic.
        if (text.length > 12 && text !== session._lastEmittedThinking) {
          flushPendingHead();
          stopSpinner();
          process.stderr.write(`  ${c.italic(c.dim(text.slice(0, 200)))}\n`);
          session._lastEmittedThinking = text;
        }
        startSpinner(text.slice(0, 80));
        // Capture reasoning so /why can replay it.
        session.lastReasoning = text;
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
      const indent = subAgentIndent();
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
      clearPendingHead();
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
      clearPendingHead();
      const agentType = data?.type || 'sub-agent';
      const model = data?.model || '';
      const query = data?.query || '';
      process.stderr.write(renderSubAgentOpen({ type: agentType, model, query }) + '\n');
      session.inSubAgent = inSubAgentBlock(); // kept for legacy readers
      session.subAgentCounts[agentType] = (session.subAgentCounts[agentType] || 0) + 1;
      startSpinner(`${agentType}: working...`);
      break;
    }

    case 'sub_agent_tool': {
      // The regular tool_call event renders the card, indented by the
      // sub-agent stack depth. Just update the spinner text here.
      const agentType = data?.type || 'sub-agent';
      const tool = data?.tool || '';
      if (tool) updateSpinner(`${agentType} → ${tool}`);
      break;
    }

    case 'sub_agent_complete': {
      stopSpinner();
      clearPendingHead();
      const agentType = data?.type || 'sub-agent';
      const usage = data?.usage || {};
      const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
      const costUsd = usage.cost_usd ?? usage.total_cost_usd ?? data?.cost_usd ?? null;
      if (typeof costUsd === 'number') session.savedUsd += costUsd;
      const summary = data?.result_summary
        || (data?.result_length > 0 ? `${agentType} returned ${data.result_length} chars` : '');
      process.stderr.write(renderSubAgentClose({
        type: agentType,
        success: data?.success !== false,
        summary,
        costUsd,
        tokens,
        durationS: data?.duration_s,
        toolCalls: data?.tool_calls,
        iterations: data?.iterations,
        error: data?.error,
      }) + '\n\n');
      session.inSubAgent = inSubAgentBlock();
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
      // BYOK users pay their model provider directly; the platform does not
      // charge them credits. Hide cost + credits when this flag is set.
      if (typeof data?.is_byok === 'boolean') session.isByok = data.is_byok;
      // Subscription tier + credit balance — backend is authoritative.
      if (data?.subscription_tier) session.subscriptionTier = data.subscription_tier;
      if (typeof data?.credits_included_limit === 'number') session.creditsLimit = data.credits_included_limit;
      const bal = data?.credits_balance;
      if (bal && typeof bal === 'object') {
        if (typeof bal.total === 'number')     session.creditsTotal = bal.total;
        if (typeof bal.included === 'number')  session.creditsIncluded = bal.included;
        if (typeof bal.purchased === 'number') session.creditsPurchased = bal.purchased;
      }
      if (data?.rate_limit) session.rateLimit = data.rate_limit;
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
      resetSubAgents();
      session.inSubAgent = false;

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
      if (data?.rate_limit) session.rateLimit = data.rate_limit;

      // ── Server-authoritative credits ──
      // Backend sends usage.credits_charged (this turn) + balance (remaining)
      // in the complete event. CLI uses these instead of the local
      // costToCredits estimate so /status and /cost match the dashboard.
      if (!session.isByok) {
        const msgStatus = lowWindowStatus(session.rateLimit);
        if (!session.msgsLowWarned && msgStatus !== 'ok') {
          const windowLine = formatMessageWindow(session.rateLimit);
          if (msgStatus === 'exhausted') {
            process.stderr.write(`\n  ${c.red('✗')} ${c.dim(`${windowLine}. Wait for the window to reset or upgrade at codekepler.ai/pricing.`)}\n`);
          } else {
            process.stderr.write(`\n  ${c.yellow('⚠')} ${c.dim(`${windowLine}. Message window is running low.`)}\n`);
          }
          session.msgsLowWarned = true;
        }

        const charged = data?.usage?.credits_charged;
        if (typeof charged === 'number') session.creditsCharged += charged;
        const bal = data?.balance;
        if (bal && typeof bal === 'object') {
          if (typeof bal.total === 'number')     session.creditsTotal = bal.total;
          if (typeof bal.included === 'number')  session.creditsIncluded = bal.included;
          if (typeof bal.purchased === 'number') session.creditsPurchased = bal.purchased;
        }
        // Warn once per turn when the remaining credits drop below 20% of the
        // tier's included limit (or below 10 absolute for tiny tiers).
        if (!session.creditsLowWarned && typeof session.creditsTotal === 'number' && session.creditsLimit) {
          const threshold = Math.max(10, Math.floor(session.creditsLimit * 0.2));
          if (session.creditsTotal <= threshold && session.creditsTotal > 0) {
            process.stderr.write(`\n  ${c.yellow('⚠')} ${c.dim(`${session.creditsTotal} of ${session.creditsLimit} credits remaining on the ${session.subscriptionTier || 'free'} plan. Upgrade at codekepler.ai/pricing.`)}\n`);
            session.creditsLowWarned = true;
          } else if (session.creditsTotal <= 0) {
            process.stderr.write(`\n  ${c.red('✗')} ${c.dim(`Credit balance exhausted on the ${session.subscriptionTier || 'free'} plan. Purchase credits at codekepler.ai/pricing or switch to BYOK.`)}\n`);
            session.creditsLowWarned = true;
          }
        }
      }

      // Sync cumulative session cost into the orbit (status bar shows it).
      if (_orbit) _orbit.onCost(session.totalCost);

      // Compact turn summary
      const tools = data?.tool_calls || session.toolCalls || 0;

      // Mission report — replaces the trailing "Done" when the turn did real
      // work (touched files or invoked tools). Plain chat turns keep the
      // tight printTurnSummary so the report does not feel ceremonial.
      const didRealWork = tools > 0 || session.filesChanged.length > 0;
      if (didRealWork) {
        const successOverall = data?.success !== false;
        const report = renderMissionReport({
          task: session.lastTask,
          success: successOverall,
          filesChanged: session.filesChanged,
          toolCounts: session.toolCounts,
          subAgents: { ...session.subAgentCounts, savedUsd: 0 },
          costUsd: null,
          durationS: data?.duration_s,
          testsPass: data?.tests_passed != null
            ? { passed: data.tests_passed, total: data.tests_total || data.tests_passed }
            : null,
          blockers: !successOverall ? (data?.blockers || extractBlockers(data)) : null,
          nextActions: successOverall
            ? ['/commit', '/pr', '/undo', '/report']
            : ['/why', '/undo', '/re-plan'],
        });
        process.stderr.write(report + '\n');
      } else {
        printTurnSummary(tools, data?.duration_s, turnCost);
      }
      break;
    }

    case 'cancelled':
      stopSpinner();
      flushContent();
      process.stderr.write(`\n  ${c.yellow('⏹')} Cancelled${data?.reason ? ': ' + c.dim(data.reason) : ''}\n`);
      break;

    case 'paused':
      stopSpinner();
      flushPendingHead();
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
      if (session.isByok) {
        process.stderr.write(`  ${c.dim('Billing')}      ${c.green('BYOK')} ${c.dim('(provider-billed)')}\n`);
      } else {
        // Server-authoritative remaining balance; fall back to the per-session
        // charged tally when balance hasn't been pushed yet.
        if (session.subscriptionTier) {
          process.stderr.write(`  ${c.dim('Plan')}         ${c.brand(session.subscriptionTier.toUpperCase())}\n`);
        }
        const messageWindow = formatMessageWindow(session.rateLimit);
        if (messageWindow) {
          process.stderr.write(`  ${c.dim('Messages')}     ${messageWindow}\n`);
        }
        if (typeof session.creditsTotal === 'number') {
          const limit = session.creditsLimit ? ` ${c.dim('/ ' + formatCredits(session.creditsLimit))}` : '';
          const used = session.creditsCharged ? ` ${c.dim(`(${formatCredits(session.creditsCharged)} used this session)`)}` : '';
          process.stderr.write(`  ${c.dim('Credits')}      ${formatCredits(session.creditsTotal)}${limit}${used}\n`);
        } else if (session.creditsCharged) {
          process.stderr.write(`  ${c.dim('Credits')}      ${formatCredits(session.creditsCharged)} ${c.dim('(used this session)')}\n`);
        }
      }
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
      if (session.isByok) {
        process.stderr.write(`  ${c.gray('Billing:')}   ${c.green('BYOK')} ${c.dim('(provider-billed)')}\n`);
      } else {
        process.stderr.write(`  ${c.gray('Credits:')}   ${formatCredits(costToCredits(session.totalCost))}${session.costAccurate ? '' : c.dim(' (est)')}\n`);
      }
      process.stderr.write(`  ${c.gray('Elapsed:')}  ${formatElapsed(session.startTime)}\n\n`);
      return;
    }

    case '/cost': {
      if (session.isByok) {
        process.stderr.write(`\n  ${c.bold('Billing')}  ${c.green('BYOK')} ${c.dim('— you pay your model provider directly. Kepler does not charge credits for BYOK usage.')}\n\n`);
        return;
      }
      // Prefer server-authoritative numbers when available.
      const used = session.creditsCharged || 0;
      const usedLabel = formatCredits(used);
      process.stderr.write(`\n  ${c.bold('Session Credits')}  ${c.brand(usedLabel)}`);
      if (used > 0 && !session.creditsCharged) process.stderr.write(`  ${c.yellow('(estimated)')}`);
      process.stderr.write('\n');
      if (session.subscriptionTier && typeof session.creditsTotal === 'number') {
        const remaining = formatCredits(session.creditsTotal);
        const limit = session.creditsLimit ? ` / ${formatCredits(session.creditsLimit)}` : '';
        process.stderr.write(`  ${c.dim('Plan')}            ${c.brand(session.subscriptionTier.toUpperCase())}  ${c.dim('· remaining')} ${c.brand(remaining)}${c.dim(limit)}\n`);
      }
      const messageWindow = formatMessageWindow(session.rateLimit);
      if (messageWindow) {
        process.stderr.write(`  ${c.dim('Messages')}        ${messageWindow}\n`);
      }
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

    case '/undo': {
      const result = ctx.checkpoints?.undo();
      if (!result) {
        process.stderr.write(`  ${c.gray('No checkpoints to undo.')}\n`);
        return;
      }
      if (result.restored) {
        process.stderr.write(`  ${c.green('↩')} ${c.dim('Restored')} ${result.filePath}\n`);
      } else {
        process.stderr.write(`  ${c.red('✗')} ${c.dim('Undo failed: ' + (result.error || 'unknown error'))}\n`);
      }
      return;
    }

    case '/checkpoint': {
      const list = ctx.checkpoints?.list(10) || [];
      if (!list.length) {
        process.stderr.write(`  ${c.gray('No checkpoints recorded yet — they are taken automatically before each edit.')}\n`);
        return;
      }
      process.stderr.write(`\n  ${c.bold('Recent checkpoints')}\n  ${c.gray('─'.repeat(40))}\n`);
      for (const ckpt of list) {
        const when = String(ckpt.timestamp).slice(11, 19);
        process.stderr.write(`  ${c.gray(when)}  ${c.white(ckpt.file)}  ${c.gray(formatTokens(ckpt.size) + ' bytes')}\n`);
      }
      process.stderr.write(`\n  ${c.gray('/undo restores the most recent one')}\n\n`);
      return;
    }

    case '/preflight': {
      await runPreflight({ auth: ctx.auth, cwd: safeCwd(), version: VERSION });
      return;
    }

    case '/report': {
      if (Object.keys(session.toolCounts).length === 0 && session.filesChanged.length === 0) {
        process.stderr.write(`  ${c.gray('Nothing to report yet — run a task first.')}\n`);
        return;
      }
      const state = {
        task: session.lastTask,
        success: true,
        filesChanged: session.filesChanged,
        toolCounts: session.toolCounts,
        subAgents: { ...session.subAgentCounts, savedUsd: session.isByok ? 0 : session.savedUsd },
        costUsd: session.isByok ? null : session.totalCost,
        durationS: (Date.now() - session.startTime) / 1000,
        nextActions: ['/commit', '/pr', '/undo'],
      };
      const out = saveReport(state, { cwd: safeCwd() });
      process.stderr.write(`  ${c.green('✓')} ${c.dim('Saved')} ${out}\n`);
      return;
    }

    case '/why': {
      if (!session.lastReasoning) {
        process.stderr.write(`  ${c.gray('No reasoning captured yet for this session.')}\n`);
        return;
      }
      process.stderr.write(`\n  ${c.bold('Last reasoning')}\n  ${c.gray('─'.repeat(40))}\n`);
      for (const line of String(session.lastReasoning).split('\n')) {
        process.stderr.write(`  ${c.dim(line)}\n`);
      }
      process.stderr.write('\n');
      return;
    }

    case '/map': {
      try {
        const resources = ctx.toolExecutor?.getProjectResources?.() || [];
        if (!resources.length) {
          process.stderr.write(`  ${c.gray('No project resources registered yet. Use get_project_overview to register one.')}\n`);
          return;
        }
        process.stderr.write(`\n  ${c.bold('Registered projects')}\n  ${c.gray('─'.repeat(40))}\n`);
        for (const r of resources) {
          process.stderr.write(`  ${c.brand('•')} ${c.white(r.id || r.name || '?')}  ${c.dim(r.root || r.path || '')}\n`);
        }
        process.stderr.write('\n');
      } catch (err) {
        process.stderr.write(`  ${c.red('/map failed: ' + err.message)}\n`);
      }
      return;
    }

    case '/budget': {
      const arg = rest.trim();
      if (!arg || arg === 'clear' || arg === 'off') {
        session.budgetUsd = null;
        session.budgetExceeded = false;
        process.stderr.write(`  ${c.gray('Budget cap cleared.')}\n`);
        return;
      }
      const n = Number(arg.replace(/^\$/, ''));
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write(`  ${c.gray('Usage: /budget <amount in USD>  or  /budget clear')}\n`);
        return;
      }
      session.budgetUsd = n;
      session.budgetExceeded = false;
      process.stderr.write(`  ${c.green('✓')} ${c.dim('Budget set: ')} $${n.toFixed(2)}\n`);
      return;
    }

    case '/quiet':
    case '/verbose':
    case '/surgical': {
      const mode = cmd === '/quiet' ? V_MODES.QUIET
                : cmd === '/verbose' ? V_MODES.VERBOSE
                : V_MODES.SURGICAL;
      setVerbosity(mode);
      process.stderr.write(`  ${c.green('✓')} ${c.dim('Verbosity: ')} ${c.brand(verbosityLabel(mode))}\n`);
      return;
    }

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
  // CheckpointManager records per-file snapshots before edits so /undo works.
  const checkpoints = new CheckpointManager(safeCwd());
  const toolExecutor = createToolExecutor({ checkpoints });
  const skipPerms = cliArgs.freeswim;
  const approval = new ApprovalManager({ autoApprove: skipPerms });

  // Session manager — persists conversation messages to .kepler/conversations/
  const sessionMgr = new SessionManager(safeCwd());
  _sessionMgr = sessionMgr; // expose to renderEvent

  // Local JSONL writer — writes cc-lens compatible session data to ~/.kepler/
  const jsonlWriter = new JsonlWriter(safeCwd(), VERSION);

  // Persistent stream client — session_id captured from backend on first turn
  let streamClient = null;

  const ctx = { auth, toolExecutor, approval, jsonlWriter, sessionMgr, checkpoints };

  // ── Print banner + preflight + init BEFORE mounting the status bar ──
  // The status bar shrinks the scroll region; if it mounts first, the
  // banner scrolls off-screen before the user ever sees it.
  printBanner(auth);

  // Preflight diagnostic (PRD-055 §9). Non-blocking; opt-out via
  // KEPLER_NO_PREFLIGHT=1 (used by tests / scripted runs).
  if (process.env.KEPLER_NO_PREFLIGHT !== '1' && !cliArgs.freeswim) {
    try { await runPreflight({ auth, cwd: safeCwd(), version: VERSION }); }
    catch { /* preflight is best-effort */ }
  }

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

  // Mission Control status bar is OPT-IN as of v2.0.1.
  // Set KEPLER_STATUS_BAR=1 (or KEPLER_MISSION=1) to enable the persistent
  // bottom-anchored ORBIT bar. Default off because the DECSTBM scroll
  // region was eating the prompt visibility on some terminals (issue
  // observed during v2.0.0 testing). The orbit state machine and tool
  // cards still work without the bar — the bar is just the rendering.
  const statusBarEnabled = (
    process.env.KEPLER_STATUS_BAR === '1' || process.env.KEPLER_MISSION === '1'
  ) && term().isTTY && !term().plain;
  if (statusBarEnabled) {
    _orbit = createOrbit();
    attachOrbit(_orbit);
    process.on('beforeExit', unmountStatusBar);
    process.on('exit',       unmountStatusBar);
  }

  // The prompt label is the USER speaking, not the agent. Use the signed-in
  // GitHub handle if known, otherwise fall back to "You".
  //
  // readline counts every byte of the prompt as a visible column when it
  // computes cursor position for line-wrapping; ANSI color codes throw the
  // math off and produce duplicated text on wrap. Wrap each escape sequence
  // in SOH (\x01) ... STX (\x02) so readline skips it when measuring width.
  function rlSafe(s) {
    return String(s || '').replace(/\x1b\[[0-9;]*m/g, '\x01$&\x02');
  }
  function userPrompt() {
    const who = session.user?.github_username || session.user?.email?.split('@')[0] || 'You';
    return rlSafe(`${c.brand(who)} ${c.dim('›')} `);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: userPrompt(),
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
    rl.setPrompt(userPrompt());  // refresh label in case session.user resolved
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

    // Budget cap (PRD-055 §10). Stop before the next paid call when exceeded.
    if (session.budgetUsd && session.totalCost >= session.budgetUsd) {
      session.budgetExceeded = true;
      process.stderr.write(`  ${c.yellow('⏹')} ${c.dim(`Budget reached ($${session.totalCost.toFixed(2)} of $${session.budgetUsd.toFixed(2)}). Use /budget clear to continue.`)}\n`);
      showPrompt();
      return;
    }

    // Regular prompt
    session.history.push({ role: 'user', content: input });
    session.turns++;
    session.toolCalls = 0;
    session.lastTask = input;
    // Reset per-turn counts so the mission report reflects this turn only.
    session.toolCounts = {};
    session.subAgentCounts = {};
    session.savedUsd = 0;
    session._lastEmittedThinking = '';
    session.creditsLowWarned = false;
    session.msgsLowWarned = false;

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
    let lastCtrlCAt = 0; // PRD-055 §8.4: first Ctrl+C cancels, second exits

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
          process.stderr.write(`\n  ${c.yellow('⏹')} ${c.dim('Cancelled.')}\n`);
          // cancel() now aborts the in-flight SSE reader; the for-await loop
          // wakes up immediately and the prompt returns. No more "stuck"
          // Cancelling… message.
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

        // Ctrl+C during execution — PRD-055 §8.4 two-step semantics:
        //   first press → cancel current backend run, stay in REPL
        //   second press within 2s → exit the CLI
        if (bytes[0] === 0x03) {
          stopSpinner();
          const now = Date.now();
          if (lastCtrlCAt && (now - lastCtrlCAt) < 2000) {
            process.stderr.write(`\n  ${c.dim('exiting…')}\n`);
            try { client.cancel(); } catch {}
            process.exit(0);
          }
          lastCtrlCAt = now;
          process.stderr.write(`\n  ${c.yellow('⏹')} ${c.dim('Cancelled. Press Ctrl+C again within 2s to exit.')}\n`);
          try { client.cancel(); } catch {}
          return;
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
