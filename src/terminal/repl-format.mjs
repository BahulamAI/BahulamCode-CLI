/**
 * Pure display formatters used by repl.mjs.
 *
 * Extracted so the giant repl.mjs shrinks and the pieces become unit-
 * testable. Everything here is a pure function — no runtime state, no
 * mutable side effects beyond the color helpers from ansi.mjs (which
 * themselves just wrap strings in ANSI codes).
 */

import { c, stripAnsi } from './ansi.mjs';

// ── One-liners ───────────────────────────────────────────────────────

export function messageCountLabel(count) {
  return `${count} ${count === 1 ? 'message' : 'messages'}`;
}

export function sessionListTimestamp(s) {
  const value = s.updatedAt || s.startedAt;
  return value ? new Date(value).toLocaleString() : '?';
}

export function oneLineInstruction(text, max = 72) {
  const compact = String(text || '(no instruction)').replace(/\s+/g, ' ').trim();
  return compact.length > max ? compact.slice(0, max - 3) + '...' : compact;
}

/**
 * Truncate `text` to `maxColumns` visible columns, preserving ANSI
 * escape sequences and appending a dim ellipsis when truncation happens.
 */
export function fitAnsiLine(text, maxColumns) {
  const max = Math.max(1, Number(maxColumns) || 80);
  const value = String(text || '');
  if (stripAnsi(value).length <= max) return value;

  let visible = 0;
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\x1b') {
      const match = value.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        out += match[0];
        i += match[0].length - 1;
        continue;
      }
    }
    if (visible >= max - 1) break;
    out += value[i];
    visible++;
  }
  return `${out}${c.dim('…')}`;
}

// ── PRD-068 §5.14 helpers ────────────────────────────────────────────

export function endStatusMarker(status) {
  switch (status) {
    case 'completed':   return c.green('✓');
    case 'interrupted': return c.yellow('⚠');
    case 'errored':     return c.red('✗');
    default:            return c.dim('·');
  }
}

export function formatSessionCost(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return c.dim('     ');
  if (n < 0.01) return c.dim('<$0.01');
  return c.dim(`$${n.toFixed(2)}`);
}

export function formatRelativeTime(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const ago = Date.now() - t;
  const m = Math.floor(ago / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

// ── Resume-mode helpers ──────────────────────────────────────────────

export function resumeTailTurnCount(mode = '') {
  const match = String(mode || '').match(/^tail-(\d+)$/);
  if (!match) return null;
  return Math.max(1, Number(match[1]) || 1);
}

export function resumeModeLabel(mode = 'full') {
  if (mode === 'checkpoint-full') return 'checkpointed transcript';
  if (mode === 'summary') return 'summary only';
  const tailTurns = resumeTailTurnCount(mode);
  if (tailTurns) return `summary + last ${tailTurns} turns`;
  return mode || 'full';
}

export function replayStartOrderForMode(history = [], mode = '') {
  const match = String(mode || '').match(/^tail-(\d+)$/);
  if (!match) return null;
  const wanted = Math.max(1, Number(match[1]) || 1);
  let seen = 0;
  const userTurns = history.filter(m => m.role === 'user' && typeof m.content === 'string');
  for (let i = userTurns.length - 1; i >= 0; i--) {
    seen++;
    if (seen >= wanted) {
      const order = Number(userTurns[i].order);
      return Number.isFinite(order) ? order : null;
    }
  }
  return null;
}

export function filterResumeReplayEvents(events = []) {
  return events.filter(item => {
    const type = item?.event?.type;
    return !['status', 'session_info', 'complete', 'resumed', 'paused'].includes(type);
  });
}

export function mergeResumeReplayItems(userTurns = [], replayEvents = []) {
  const items = [];
  let order = 0;
  for (const message of userTurns) {
    items.push({
      kind: 'user',
      message,
      fileOrder: Number.isFinite(Number(message.order)) ? Number(message.order) : null,
      order: order++,
      time: Date.parse(message.timestamp || '') || 0,
    });
  }
  for (const event of replayEvents) {
    items.push({
      kind: 'event',
      event,
      fileOrder: Number.isFinite(Number(event.order)) ? Number(event.order) : null,
      order: order++,
      time: Date.parse(event.timestamp || '') || 0,
    });
  }
  return items.sort((a, b) => {
    if (a.fileOrder !== null && b.fileOrder !== null && a.fileOrder !== b.fileOrder) {
      return a.fileOrder - b.fileOrder;
    }
    if (a.fileOrder !== null && b.fileOrder === null) return -1;
    if (a.fileOrder === null && b.fileOrder !== null) return 1;
    const at = a.time || Number.MAX_SAFE_INTEGER;
    const bt = b.time || Number.MAX_SAFE_INTEGER;
    return at - bt || a.order - b.order;
  });
}

export function resumeProgressBar(percent, width = 12) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((p / 100) * width);
  return `${c.brand('█'.repeat(filled))}${c.gray('░'.repeat(width - filled))} ${String(p).padStart(3)}%`;
}
