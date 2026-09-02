/**
 * Sub-agent block renderer — Mission Control (PRD-055 §7).
 *
 * Renders the open/close pair for a sub-agent block, dimmed throughout so
 * the primary agent reads bright by contrast. Inner tool cards are indented
 * via the `subAgentIndent()` helper so they nest visually under the header.
 *
 *   🛰️ explore "JWT lifecycle"  ▸ running
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
import { formatSeconds } from '../terminal/ansi.mjs';

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
/**
 * Reduce a sub-agent query to its human-readable core. Handoff envelopes
 * ([User intent], ## Work Scope, Schema:, Active roots:) are machine
 * context — printing them flooded the transcript with 15+ lines per
 * spawn. Full text stays available via /expand on the recorded card.
 */
export function displayQuery(query, max = 140) {
  let s = String(query || '');
  const cut = s.search(/\n\s*(?:\[User intent\]|##\s*Work Scope|Schema:\s*kepler\.|Active roots:)/);
  if (cut >= 0) s = s.slice(0, cut);
  s = s.replace(/^\[Thoroughness:\s*[^\]]*\]\s*/i, '').replace(/\s+/g, ' ').trim();
  return truncate(s, max);
}

export function renderSubAgentOpen({ id, type, query, parentDepth } = {}) {
  const t = type || 'sub-agent';
  const depthBefore = Number.isFinite(parentDepth) ? Math.max(0, parentDepth) : _stack.length;
  _stack.push({ id: id || `${t}-${depthBefore}-${tag()}`, type: t, depth: depthBefore, startedAt: Date.now() });

  const indent = ' '.repeat(2 + depthBefore * 3);
  // Ordinal labels (explore#2) still get their base type's icon.
  const iconChar = SUB_ICONS[t] || SUB_ICONS[String(t).replace(/#\d+$/, '')] || icons.subAgent;
  const shown = displayQuery(query);
  const head = `${indent}${iconChar} ${paint.brand.data(t)} ${paint.text.dim(`"${shown}"`)}`;
  const tag1 = paint.text.dim('▸ running');

  return shown
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
  id,
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
  // Parallel sub-agents can complete out of stack order. Prefer exact id,
  // then type, and fall back to the latest open entry for legacy streams.
  let idx = -1;
  if (id) idx = _stack.findLastIndex(entry => entry.id === id);
  if (idx < 0 && type) idx = _stack.findLastIndex(entry => entry.type === type);
  if (idx < 0) idx = _stack.length - 1;
  const opened = idx >= 0 ? _stack.splice(idx, 1)[0] : null;
  const t = type || opened?.type || 'sub-agent';
  const closeDepth = Number.isFinite(opened?.depth) ? opened.depth : _stack.length;
  const indent = ' '.repeat(2 + closeDepth * 3);

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
  // Tokens: pass the OUTPUT (generation) count only. Summing input+output
  // across a multi-iteration sub-agent double-counts the context that is
  // re-shipped each iteration, and the resulting number reads huge and
  // misleading (e.g. 632.8k for a 16-iter run whose actual generation was
  // a fraction of that). Output tokens are the honest "work done" number.
  if (tokens > 0)                 parts.push(`${formatTokens(tokens)} gen`);
  if (typeof costUsd === 'number' && costUsd > 0) parts.push(formatCost(costUsd));
  if (durationS != null)          parts.push(formatSeconds(durationS));
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
