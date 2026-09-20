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
import { toolFamily } from './icons.mjs';
import { term } from './term.mjs';
import { wrapCode } from './code-layout.mjs';
import { renderFileDiffs } from './diff.mjs';
import { renderCommandHead, renderCommandResult, toolSource } from './command-card.mjs';
import {
  toolDisplayLabel,
  toolDisplaySummary,
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
  return paint.text.muted(summary);
}

// ── Result → outcome summary ─────────────────────────────────────────────

/**
 * Summarize a tool result into a compact outcome label.
 *
 * @returns {{ text: string, tone: 'success'|'warn'|'danger'|'dim' }}
 */
export function summarizeResult(tool, data, args = {}) {
  if (!data) return { text: '', tone: 'dim' };

  if (data._blocked) {
    return { text: firstOutputLine(data) || 'blocked', tone: 'danger' };
  }
  if (isNoChangeEditResult(tool, data)) {
    return { text: 'no changes', tone: 'warn' };
  }
  if (data._observation_timeout) {
    const ms = data._observation_timeout_ms;
    const duration = typeof ms === 'number' ? formatDuration(ms) : '';
    return { text: duration ? `observed ${duration} tail` : 'observed output tail', tone: 'warn' };
  }
  if (data._timed_out) {
    return { text: 'timed out', tone: 'danger' };
  }
  if (data.success === false) {
    // For shell / test / build / lint / validate failures, the actual output
    // usually holds the actionable line ("FAIL src/foo.test.js expected 3
    // got 2") while data.error is a generic wrapper ("Test suite failed",
    // "Command exited with code 1"). Prefer the first output line when it
    // has meaningful content; fall back to error for other tools.
    const shellFamily = new Set([
      'shell', 'run_tests', 'validate_build', 'lint_check',
      'validate_file', 'validate_structure',
    ]);
    const outputLine = firstOutputLine(data);
    const msg = shellFamily.has(tool) && outputLine
      ? String(outputLine).slice(0, 140)
      : String(data.error || outputLine || 'failed').slice(0, 140);
    return { text: msg, tone: 'danger' };
  }

  switch (tool) {
    case 'read_file': {
      const lines = readFileLineCount(data, args);
      if (lines == null) return { text: 'read', tone: 'success' };
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
      if (tool === 'edit_file' && delta === '+0 −0') {
        return { text: 'no changes', tone: 'warn' };
      }
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
      if (tool === 'shell') {
        const structured = structuredOutputSummary(data.output_preview || data.output);
        if (structured) return structured;
        // Multi-row preview: first N rows + a "+ M more" tail so long
        // outputs (e.g. `ls`) surface their scale instead of collapsing
        // to a single first line with no hint that more exists.
        const { preview, remaining } = outputPreviewRows(data, shellPreviewRows(data));
        if (!preview) return { text: 'ok', tone: 'success' };
        if (remaining === 0) return { text: preview, tone: 'success' };
        const tail = paint.text.dim(`+ ${remaining} more row${remaining === 1 ? '' : 's'}`);
        return { text: `${preview}\n${tail}`, tone: 'success' };
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

function structuredOutputSummary(output) {
  const raw = String(output || '').trim();
  if (!raw || !/^[\[{]/.test(raw)) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    const first = raw.split('\n').find(line => /^[\[{]/.test(line.trim()));
    if (!first) return null;
    try { value = JSON.parse(first.trim()); } catch { return null; }
  }
  return summarizeJsonOutput(value);
}

function summarizeJsonOutput(value) {
  if (Array.isArray(value)) {
    return { text: `json array · ${value.length} item${value.length === 1 ? '' : 's'}`, tone: 'success' };
  }
  if (!value || typeof value !== 'object') return null;

  if ('service' in value && 'profile' in value && 'inSync' in value) {
    const service = String(value.service || 'service');
    const profile = value.profile ? ` · ${value.profile}` : '';
    const status = value.inSync === true ? 'in sync'
      : value.inSync === false ? 'out of sync'
      : 'sync status unknown';
    const diffs = Array.isArray(value.diff) ? value.diff
      : Array.isArray(value.diffs) ? value.diffs
      : [];
    const diffText = diffs.length ? ` · ${diffs.length} diff${diffs.length === 1 ? '' : 's'}` : '';
    return {
      text: `${service} ${status}${profile}${diffText}`,
      tone: value.inSync === false ? 'warn' : 'success',
    };
  }

  const keys = Object.keys(value).slice(0, 4);
  return {
    text: keys.length ? `json · ${keys.join(', ')}` : 'json object',
    tone: 'success',
  };
}

export function formatCompactFileDiff(result, options = {}) {
  return renderFileDiffs(result, { showFileHeader: false, ...options });
}

function firstOutputLine(data) {
  const o = data?.output_preview || data?.output || data?.message || '';
  return String(o).split('\n').map(l => l.trim()).find(Boolean) || '';
}

// Preview the first N non-empty output rows, joined by \n. Returns
// { preview, remaining, total } — remaining is how many non-empty rows
// were dropped past N. Long individual rows get clipped to `perRow` chars.
function outputPreviewRows(data, n, perRow = 200) {
  const o = data?.output_preview ?? data?.output ?? data?.message ?? '';
  const rows = String(o).split('\n').map(l => l.trim()).filter(Boolean);
  const shown = rows.slice(0, n).map(l => l.length > perRow ? l.slice(0, perRow - 1) + '…' : l);
  return { preview: shown.join('\n'), remaining: Math.max(0, rows.length - n), total: rows.length };
}

// Default rows shown in the shell result preview. Overridable via env for
// power users; keep it small — the result line rides above every command
// and eats vertical space in a long session.
function shellPreviewRows(data = {}) {
  const raw = parseInt(process.env.BAHULAM_SHELL_PREVIEW_ROWS ?? '', 10);
  if (Number.isFinite(raw) && raw >= 1) return raw;
  const command = String(data?.args?.command || data?.command || '');
  if (/^\s*git\s+(diff|show)\b/i.test(command)) return 8;
  if (/^\s*git\s+status\b/i.test(command)) return 8;
  return 2;
}

function lineCount(s) {
  if (!s) return 0;
  return String(s).split('\n').filter(Boolean).length;
}

function physicalLineCount(text) {
  const value = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!value) return 0;
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function readFileLineCount(data = {}, args = {}) {
  const explicit = explicitReadLineCount(data);
  if (explicit != null) return explicit;

  const text = firstReadTextPayload(data);
  if (text != null) return physicalLineCount(text);

  const range = requestedRangeLineCount(args || data?.args || {});
  if (range != null) return range;

  return null;
}

function explicitReadLineCount(data = {}) {
  if (!data || typeof data !== 'object') return null;
  for (const key of ['_total_lines', 'line_count', 'lines_count', 'total_lines', 'lineCount', 'totalLines']) {
    const value = data[key];
    if (value == null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return Math.floor(number);
  }
  if (Array.isArray(data.lines)) return data.lines.length;
  if (data.result && typeof data.result === 'object' && data.result !== data) {
    return explicitReadLineCount(data.result);
  }
  return null;
}

function firstReadTextPayload(data = {}) {
  if (!data || typeof data !== 'object') return null;
  for (const key of ['content', 'text', 'output', 'output_preview', 'message']) {
    if (typeof data[key] === 'string') return data[key];
  }
  if (data.result && typeof data.result === 'object' && data.result !== data) {
    return firstReadTextPayload(data.result);
  }
  return null;
}

function requestedRangeLineCount(args = {}) {
  const start = Number(args.start_line ?? args.startLine);
  const end = Number(args.end_line ?? args.endLine);
  if (Number.isFinite(start) && Number.isFinite(end) && start > 0 && end >= start) {
    return Math.floor(end - start + 1);
  }
  const limit = Number(args.limit ?? args.max_lines ?? args.maxLines);
  if (Number.isFinite(limit) && limit >= 0) return Math.floor(limit);
  return null;
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

function isNoChangeEditResult(tool, data = {}) {
  if (tool !== 'edit_file') return false;
  if (data._no_change || data.no_change) return true;
  return data.success !== false && data.lines_added === 0 && data.lines_removed === 0;
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
 * Render the leading half of a card — colored verb + args.
 *
 * v2.0.3: dropped the leading tool icon (🔭/🛠️/⚙️). The label itself is a
 * present-progressive verb so the line reads like prose:
 *   "Reading src/ui/banner.mjs · lines 31-65 — 36 lines"
 * The icon was decorative noise that broke the conversational feel.
 * Mission report and sub-agent renderers still use the icons in their
 * own contexts.
 *
 * Width-aware: truncates args from the left when the line would overflow.
 */
export function formatCardHead(tool, args, opts = {}) {
  if (tool === 'shell') return renderCommandHead(args, { ...opts, indent: opts.indent ?? '  ' });
  const cwd = opts.cwd || safeCwd();
  const cols = opts.columns || term().columns || 120;
  const indent = opts.indent ?? (tool === 'shell' ? '' : '  ');

  const label     = toolDisplayLabel(tool);
  const argsText  = formatArgs(tool, args, cwd);
  const leadText  = formatHeadLead(tool, label);

  const leadVisible = visibleWidth(`${indent}${leadText}`);
  const budget = Math.max(20, cols - leadVisible - 4);

  const argsTruncated = truncateMiddle(argsText, budget);

  const head = `${indent}${leadText}`;
  const body = argsTruncated ? `${head} ${argsTruncated}` : head;
  return opts.source ? body + '\n' + wrapCode('Source: ' + opts.source, paint.text.muted, { columns: cols, indent }) : body;
}

function formatHeadLead(tool, label) {
  if (tool !== 'shell') return paintLabel(tool, label);
  return `${paint.text.dim('• shell ·')} ${paintLabel(tool, label)}`;
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
  const head = formatCardHead(tool, args, { indent, columns: cols, cwd, source: toolSource(result) });
  if (tool === 'shell') return head + '\n' + renderCommandResult(result, { args, columns: cols, indent: (indent ?? '  ') + '  ', durationMs, summary: summarizeResult(tool, result, args) });

  const summary = summarizeResult(tool, result, args);
  const duration = formatDuration(durationMs ?? result?.duration_ms ?? (result?.duration_s != null ? result.duration_s * 1000 : null));

  if (!summary.text && !duration) return head;

  const arrow = outcomeLead(tool);
  const body  = summary.text ? tone(summary.text, summary.tone) : '';
  // Hide the duration tail when the tool was effectively instant (<200ms).
  // For fast reads, "1ms" / "0ms" was noise that broke the prose feel.
  const showDuration = duration && (durationMs == null || durationMs >= 200);
  const tail  = showDuration ? paint.text.dim(` · ${duration}`) : '';

  const candidate = `${head}  ${arrow} ${body}${tail}`;
  if (!head.includes('\n') && visibleWidth(candidate) <= cols) return candidate;
  if (!head.includes('\n') && isInlineOutcomeTool(tool)) {
    // Reserve = outcome width + 4 (2 gap + a couple padding). Compact the head
    // to whatever remains. Floor at 12 so the head stays recognizable; on
    // very narrow terminals (cols - reserve < 12) fall through to the
    // two-line gutter shape below rather than emit an overflowing line.
    const reserve = visibleWidth(`${arrow} ${body}${tail}`) + 4;
    const headBudget = cols - reserve;
    if (headBudget >= 12) {
      const compactHead = truncateMiddle(head, headBudget);
      const combined = `${compactHead}  ${arrow} ${body}${tail}`;
      if (visibleWidth(combined) <= cols) return combined;
    }
  }

  // Doesn't fit on one line → push outcome to a separate gutter line.
  const gutterIndent = (indent || '  ') + paint.text.dim('⎿  ');
  return `${head}\n${gutterIndent}${arrow} ${body}${tail}`;
}

function outcomeLead(tool) {
  return isShellOutcomeTool(tool)
    ? `${paint.text.dim('result')} ${paint.text.dim('—')}`
    : paint.text.dim('—');
}

function isShellOutcomeTool(tool) {
  return [
    'shell', 'run_tests', 'validate_build', 'lint_check',
    'validate_file', 'validate_structure',
  ].includes(String(tool || '').toLowerCase());
}

function isInlineOutcomeTool(tool) {
  return [
    'read_file', 'read_files', 'read_batch', 'get_file_info',
    'search_code', 'search_files', 'grep', 'list_files',
  ].includes(String(tool || '').toLowerCase());
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

function truncateEndVisible(text, max) {
  if (!text) return '';
  if (visibleWidth(text) <= max) return text;
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const limit = Math.max(1, Math.floor(max));
  if (limit <= 1) return '';
  return paint.text.muted(`${plain.slice(0, limit - 1)}…`);
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
export function recordCard({ id, tool, args, head, result, durationMs, startedAt, source, cwd }) {
  // Result events often omit invocation fields. Missing values must not
  // erase the original command, context, source or start time.
  const entry = Object.fromEntries(Object.entries({ id, tool, args, head, result, durationMs, startedAt, source, cwd }).filter(([, value]) => value !== undefined));
  // Replace if same id already exists (e.g. tool_call followed by tool_result)
  const existing = _cards.findIndex(c => c.id != null && c.id === id);
  if (existing >= 0) {
    _cards[existing] = { ..._cards[existing], ...entry };
    return _cards[existing];
  }
  entry.result ??= null;
  entry.durationMs ??= null;
  entry.startedAt ??= null;
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
