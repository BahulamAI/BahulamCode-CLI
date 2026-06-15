/**
 * Sub-agent block renderer — Mission Control (PRD-055 §7).
 *
 * Renders the open/close pair for a sub-agent block, dimmed throughout so
 * the primary agent reads bright by contrast. Inner tool cards are indented
 * via the `subAgentIndent()` helper so they nest visually under the header.
 *
 *   🛰️ explore "JWT lifecycle"  ▸ running (deepseek/deepseek-v4-flash)
 *        🔭 Search code "expire"        → 6 matches
 *        🔭 Read file auth.py L120-180   → 60 lines
 *        └ ✅ returned 3 files identified · $0.004 · 2.1s
 *
 * Maintains a depth stack so concurrent / nested sub-agents indent further
 * and so callers can ask `inSubAgent()` / `depth()` without threading state.
 *
 * No I/O — caller writes the returned strings to stderr. This keeps the
 * module testable from a plain Node script.
 */

import { paint } from './palette.mjs';
import { icons } from './icons.mjs';

const SUB_ICONS = {
  explore: '🔭',
  plan:    '📐',
  verify:  '✅',
  debug:   '🪲',
  refactor:'♻️',
};

// ── Active stack ─────────────────────────────────────────────────────────

const _stack = []; // [{ id, type, startedAt }]

/** How many sub-agents are currently open. */
export function depth() { return _stack.length; }
export function inSubAgent() { return _stack.length > 0; }

/**
 * Indent string for a tool card line nested under N sub-agents.
 * 5 cols per level matches the existing `'     '` legacy indent.
 */
export function subAgentIndent(extraDepth = 0) {
  const d = _stack.length + extraDepth;
  if (d <= 0) return '  ';
  return ' '.repeat(2 + d * 3);
}

// ── Render ───────────────────────────────────────────────────────────────

/**
 * Open a sub-agent block. Pushes onto the stack; returns the lines to print.
 *
 * @returns {string} ANSI-styled multi-line block (no trailing newline).
 */
export function renderSubAgentOpen({ id, type, model, query, parentDepth } = {}) {
  const t = type || 'sub-agent';
  const depthBefore = _stack.length;
  _stack.push({ id: id || `${t}-${depthBefore}-${tag()}`, type: t, startedAt: Date.now() });

  const indent = ' '.repeat(2 + depthBefore * 3);
  const iconChar = SUB_ICONS[t] || icons.subAgent;
  const head = `${indent}${iconChar} ${paint.brand.data(t)} ${paint.text.dim(`"${truncate(query || '', 60)}"`)}`;
  const tag1 = paint.text.dim(`▸ running${model ? ` (${model})` : ''}`);

  return query
    ? `\n${head}  ${tag1}`
    : `\n${indent}${iconChar} ${paint.brand.data(t)}  ${tag1}`;
}

/**
 * Close the most recent sub-agent block. Pops the stack; returns the close
 * line with optional cost / token / duration attribution per PRD §7.3.
 *
 *   └ ✅ returned 3 files identified · 1.2k tok · $0.004 · 2.1s
 *   └ ✗ explore agent failed
 *
 * Caller passes `success` (default true), `summary` ("returned N files"),
 * and any of `{ costUsd, tokens, durationS, toolCalls, iterations }`.
 */
export function renderSubAgentClose({
  type,
  success = true,
  summary = '',
  costUsd,
  tokens,
  durationS,
  toolCalls,
  iterations,
  error,
} = {}) {
  // Match-pop: if the type doesn't match the top of stack we still pop the
  // top entry — backends never emit interleaved open/close, so this is the
  // safe behavior.
  const opened = _stack.pop();
  const t = type || opened?.type || 'sub-agent';
  const indent = ' '.repeat(2 + _stack.length * 3);

  if (!success) {
    const line = `${indent}${paint.text.dim('└')} ${paint.state.danger('✗')} ${paint.text.dim(`${t} agent failed`)}`;
    if (error) {
      return `${line}\n${indent}    ${paint.state.danger(truncate(error, 140))}`;
    }
    return line;
  }

  const parts = [];
  if (toolCalls > 0)              parts.push(`${toolCalls} tools`);
  if (iterations > 0)             parts.push(`${iterations} iter`);
  if (tokens > 0)                 parts.push(`${formatTokens(tokens)} tok`);
  if (typeof costUsd === 'number' && costUsd > 0) parts.push(formatCost(costUsd));
  if (durationS != null)          parts.push(`${Number(durationS).toFixed(1)}s`);
  const detail = parts.length ? paint.text.dim(' · ' + parts.join(' · ')) : '';

  const body = summary
    ? paint.text.dim(summary)
    : paint.text.dim(`${t} returned`);

  return `${indent}${paint.text.dim('└')} ${paint.state.success('✅')} ${body}${detail}`;
}

/**
 * Force-clear the stack. Use after a `complete` event or when cancelling so
 * a stale entry doesn't keep indenting future output.
 */
export function resetSubAgents() { _stack.length = 0; }

// ── helpers ──────────────────────────────────────────────────────────────

function truncate(text, n) {
  const s = String(text || '');
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function formatTokens(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatCost(usd) {
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  if (usd < 0.01)  return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function tag() {
  // Avoid Date.now()/Math.random() drift across re-renders — depth+counter is
  // enough to keep ids unique within a process.
  tag._n = (tag._n || 0) + 1;
  return tag._n.toString(36);
}
