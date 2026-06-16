/**
 * Tool cards — Mission Control (PRD-055 §6).
 *
 * One-line summary per tool: icon + label + args + outcome.
 *
 *   🔭 search_code "JWT validation"             → 4 matches in 2 files
 *   🔭 read_file auth.py L42-L88                → 47 lines
 *   🛠️ edit_file auth.py                        → +12 −4
 *   ⚙️  shell "npm test"                         → passed in 1.2s
 *
 * Two render points:
 *
 *   formatCardHead(tool, args)            — at tool invocation (no outcome)
 *   formatCard({ tool, args, result, … })  — once the result arrives
 *
 * Cards are recorded in a small ring buffer (`recordCard`, `lastCard`,
 * `getCard`) so the expand handler in repl.mjs can re-render details on `d`
 * / `/last` / `/expand <n>` without holding state in the REPL itself.
 *
 * No I/O — callers (repl, demo, headless adapter) are responsible for
 * `process.stderr.write(...)`. This keeps the module pure and testable.
 */

import { paint, width as visibleWidth } from './palette.mjs';
import { icon, toolFamily } from './icons.mjs';
import { term } from './term.mjs';
import {
  toolDisplayLabel,
  toolDisplaySummary,
  formatShellCommand,
} from '../terminal/tool-display.mjs';

// ── Family → label colorizer ─────────────────────────────────────────────

function paintLabel(tool, label) {
  switch (toolFamily(tool)) {
    case 'subAgent': return paint.brand.data(label);
    case 'search':   return paint.text.primary(label);
    case 'write':    return paint.brand.primary(label);
    case 'shell':    return paint.state.warn(label);
    case 'network':  return paint.brand.accent(label);
    default:         return paint.text.primary(label);
  }
}

// ── Args summary ─────────────────────────────────────────────────────────

function formatArgs(tool, args, cwd) {
  const summary = toolDisplaySummary(tool, args || {}, { cwd });
  if (!summary) return '';
  if (tool === 'shell') {
    return formatShellCommand(summary, paintShellAdapter);
  }
  return paint.text.muted(summary);
}

// Adapter so formatShellCommand (from legacy tool-display.mjs) keeps working
// against the new palette. It expects an object with .red/.blue/.yellow/.white.
const paintShellAdapter = {
  red:    (s) => paint.state.danger(s),
  blue:   (s) => paint.brand.data(s),
  yellow: (s) => paint.state.warn(s),
  white:  (s) => paint.text.primary(s),
};

// ── Result → outcome summary ─────────────────────────────────────────────

/**
 * Summarize a tool result into a compact outcome label.
 *
 * @returns {{ text: string, tone: 'success'|'warn'|'danger'|'dim' }}
 */
export function summarizeResult(tool, data) {
  if (!data) return { text: '', tone: 'dim' };

  if (data._blocked) {
    return { text: firstOutputLine(data) || 'blocked', tone: 'danger' };
  }
  if (data.success === false) {
    const msg = String(data.error || firstOutputLine(data) || 'failed').slice(0, 140);
    return { text: msg, tone: 'danger' };
  }

  switch (tool) {
    case 'read_file': {
      const lines = data._total_lines || lineCount(data.output || data.output_preview);
      return { text: `${lines} line${lines === 1 ? '' : 's'}`, tone: 'success' };
    }
    case 'read_files':
      return { text: 'files read', tone: 'success' };

    case 'search_code':
    case 'search_files':
    case 'grep': {
      const matches = countMatches(data);
      const files = countMatchFiles(data);
      if (matches === 0) return { text: 'no matches', tone: 'warn' };
      const filesPart = files > 0 ? ` in ${files} file${files === 1 ? '' : 's'}` : '';
      return { text: `${matches} match${matches === 1 ? '' : 'es'}${filesPart}`, tone: 'success' };
    }

    case 'list_files': {
      const n = lineCount(data.output);
      return { text: n > 0 ? `${n} item${n === 1 ? '' : 's'}` : 'empty', tone: 'success' };
    }

    case 'edit_file':
    case 'write_file':
    case 'write_project': {
      const delta = diffDelta(data);
      if (delta) return { text: delta, tone: 'success' };
      return { text: 'updated', tone: 'success' };
    }

    case 'delete_file':
      return { text: 'deleted', tone: 'warn' };

    case 'shell':
    case 'run_tests':
    case 'validate_build':
    case 'lint_check':
    case 'validate_file':
    case 'validate_structure': {
      const exit = data.exit_code ?? data.exitCode;
      if (exit != null && exit !== 0) {
        return { text: `exit ${exit}`, tone: 'danger' };
      }
      const head = firstOutputLine(data).slice(0, 100);
      return { text: head || 'ok', tone: 'success' };
    }

    case 'analyze_code': {
      // Backend returns "filename (N lines, ext)" — the filename already
      // appears in the card head, so strip it and keep just the metadata.
      const head = firstOutputLine(data);
      const m = head.match(/\((\d+)\s+lines?,?\s+([^)]+)\)/);
      if (m) return { text: `${m[1]} lines · ${m[2].trim()}`, tone: 'success' };
      return { text: head.slice(0, 80) || 'done', tone: 'success' };
    }

    case 'plan':
    case 'explore':
    case 'verify':
    case 'debug':
    case 'refactor': {
      const head = firstOutputLine(data).slice(0, 100);
      return { text: head || 'done', tone: 'success' };
    }

    default: {
      const head = firstOutputLine(data).slice(0, 100);
      return { text: head || 'done', tone: 'success' };
    }
  }
}

function firstOutputLine(data) {
  const o = data?.output_preview || data?.output || data?.message || '';
  return String(o).split('\n').map(l => l.trim()).find(Boolean) || '';
}

function lineCount(s) {
  if (!s) return 0;
  return String(s).split('\n').filter(Boolean).length;
}

function countMatches(data) {
  if (typeof data?.match_count === 'number') return data.match_count;
  return lineCount(data?.output);
}

function countMatchFiles(data) {
  if (typeof data?.file_count === 'number') return data.file_count;
  const out = String(data?.output || '');
  if (!out) return 0;
  const files = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/^([^:]+):/);
    if (m) files.add(m[1]);
  }
  return files.size;
}

function diffDelta(data) {
  const add = data?.lines_added ?? data?.additions;
  const rem = data?.lines_removed ?? data?.deletions;
  if (add == null && rem == null) return '';
  const a = add ?? 0;
  const r = rem ?? 0;
  return `+${a} −${r}`;
}

function tone(text, t) {
  switch (t) {
    case 'success': return paint.state.success(text);
    case 'warn':    return paint.state.warn(text);
    case 'danger':  return paint.state.danger(text);
    case 'dim':
    default:        return paint.text.dim(text);
  }
}

// ── Card head (printed at invocation) ────────────────────────────────────

/**
 * Render the leading half of a card — icon + colored label + args.
 * Width-aware: truncates args from the left when the line would overflow.
 */
export function formatCardHead(tool, args, opts = {}) {
  const cwd = opts.cwd || safeCwd();
  const cols = opts.columns || term().columns || 120;
  const indent = opts.indent || '  ';

  const iconText  = icon(tool);
  const label     = toolDisplayLabel(tool);
  const argsText  = formatArgs(tool, args, cwd);

  const leadVisible = visibleWidth(`${indent}${iconText} ${label}`);
  const budget = Math.max(20, cols - leadVisible - 4);
  const argsTruncated = truncateMiddle(argsText, budget);

  const head = `${indent}${iconText} ${paintLabel(tool, label)}`;
  return argsTruncated ? `${head} ${argsTruncated}` : head;
}

/**
 * Render a full card with outcome.
 *
 *   🔭 search_code "JWT"              → 4 matches in 2 files · 120ms
 *
 * `result` is the tool_result data from the SSE stream (same shape as
 * `renderToolResult` consumed). `durationMs` overrides what's on the result.
 */
export function formatCard({ tool, args, result, durationMs, indent, columns, cwd } = {}) {
  const cols = columns || term().columns || 120;
  const head = formatCardHead(tool, args, { indent, columns: cols, cwd });

  const summary = summarizeResult(tool, result);
  const duration = formatDuration(durationMs ?? result?.duration_ms ?? (result?.duration_s != null ? result.duration_s * 1000 : null));

  if (!summary.text && !duration) return head;

  const arrow = paint.text.dim('—');
  const body  = summary.text ? tone(summary.text, summary.tone) : '';
  // Hide the duration tail when the tool was effectively instant (<200ms).
  // For fast reads, "1ms" / "0ms" was noise that broke the prose feel.
  const showDuration = duration && (durationMs == null || durationMs >= 200);
  const tail  = showDuration ? paint.text.dim(` · ${duration}`) : '';

  const candidate = `${head}  ${arrow} ${body}${tail}`;
  if (visibleWidth(candidate) <= cols) return candidate;

  // Doesn't fit on one line → push outcome to a separate gutter line.
  const gutterIndent = (indent || '  ') + paint.text.dim('⎿  ');
  return `${head}\n${gutterIndent}${arrow} ${body}${tail}`;
}

function truncateMiddle(text, max) {
  if (!text) return '';
  if (visibleWidth(text) <= max) return text;
  // Truncate the plain text and re-trust palette helpers to skip codes.
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  if (plain.length <= max) return text;
  const keep = Math.max(8, max - 3);
  const head = plain.slice(0, Math.floor(keep / 2));
  const tail = plain.slice(plain.length - Math.ceil(keep / 2));
  return paint.text.muted(`${head}…${tail}`);
}

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function safeCwd() {
  try { return process.cwd(); } catch { return ''; }
}

// ── Ring buffer of recent cards (for expand / /last) ─────────────────────

const MAX_CARDS = 50;
const _cards = [];

/**
 * Record a card by its call_id (or generated id). Returns the stored entry.
 * The entry is updated in place when the matching result arrives.
 */
export function recordCard({ id, tool, args, head, result, durationMs, startedAt }) {
  const entry = { id, tool, args, head, result: result || null, durationMs: durationMs ?? null, startedAt: startedAt ?? null };
  // Replace if same id already exists (e.g. tool_call followed by tool_result)
  const existing = _cards.findIndex(c => c.id != null && c.id === id);
  if (existing >= 0) {
    _cards[existing] = { ..._cards[existing], ...entry };
    return _cards[existing];
  }
  _cards.push(entry);
  if (_cards.length > MAX_CARDS) _cards.shift();
  return entry;
}

/** Most recently recorded card (the one `d` / `/last` should expand). */
export function lastCard() {
  return _cards[_cards.length - 1] || null;
}

/** Look up a card by id, or 1-based index from the tail (-1 == lastCard). */
export function getCard(idOrIndex) {
  if (idOrIndex == null) return lastCard();
  if (typeof idOrIndex === 'number') {
    if (idOrIndex < 0) return _cards[_cards.length + idOrIndex] || null;
    return _cards[idOrIndex] || null;
  }
  return _cards.find(c => c.id === idOrIndex) || null;
}

/** All recorded cards in order. */
export function allCards() {
  return _cards.slice();
}

/** Drop all recorded cards (used by tests and `/clear`). */
export function clearCards() {
  _cards.length = 0;
}
