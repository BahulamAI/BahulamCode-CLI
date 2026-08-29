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
import {
  toolDisplayLabel,
  toolDisplaySummary,
  formatShellCommand,
  shellCommandDisplay,
  shellCommandProfile,
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
    const profile = shellCommandProfile(summary, { cwd });
    if (profile.compact) return compactShellProfile(profile);
    const display = shellCommandDisplay(summary, { cwd });
    const command = `${paint.text.dim('$')} ${formatShellCommand(display.command, paintShellAdapter)}`;
    return display.cwdLabel
      ? `${command} ${paint.text.dim('in')} ${paint.brand.data(display.cwdLabel)}`
      : command;
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
export function summarizeResult(tool, data, args = {}) {
  if (!data) return { text: '', tone: 'dim' };

  if (data._blocked) {
    return { text: firstOutputLine(data) || 'blocked', tone: 'danger' };
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

export function formatCompactFileDiff(result, {
  indent = '  ',
  maxLines = Infinity,
  maxFiles = Infinity,
  columns = term().columns || 120,
  showFileHeader = false,
} = {}) {
  const diffs = fileDiffs(result)
    .map(normalizeFileDiff)
    .filter(diff => diff && (diff.redacted || diff?.hunks?.length));
  if (!diffs.length) return '';

  const out = [];
  let shown = 0;
  let truncated = false;
  const lineLimit = Number.isFinite(maxLines) ? Math.max(0, Math.floor(maxLines)) : Infinity;
  const fileLimit = Number.isFinite(maxFiles) ? Math.max(0, Math.floor(maxFiles)) : diffs.length;
  const lineBudget = Math.max(40, columns - visibleWidth(indent) - 4);

  for (const diff of diffs.slice(0, fileLimit)) {
    if (showFileHeader || diffs.length > 1) {
      if (shown >= lineLimit) { truncated = true; break; }
      out.push(`${indent}${paint.brand.primary(diff.relative_path || diff.path || 'file')} ${paint.text.dim(diffDelta(diff))}`);
      shown++;
    }

    if (diff.redacted) {
      if (shown >= lineLimit) { truncated = true; break; }
      const subject = (showFileHeader || diffs.length > 1)
        ? ''
        : `${[diff.relative_path || diff.path || 'file', diffDelta(diff)].filter(Boolean).join(' ')} · `;
      out.push(`${indent}${paint.text.dim(`${subject}diff redacted for sensitive config`)}`);
      shown++;
      continue;
    }

    for (const hunk of diff.hunks || []) {
      if (shown >= lineLimit) { truncated = true; break; }
      out.push(`${indent}${paint.text.dim(`@@ -${hunk.old_start},${hunk.old_count} +${hunk.new_start},${hunk.new_count} @@`)}`);
      shown++;

      for (const line of hunk.lines || []) {
        if (shown >= lineLimit) { truncated = true; break; }
        out.push(`${indent}${paintDiffLine(line, lineBudget)}`);
        shown++;
      }
      if (truncated) break;
    }
    if (truncated) break;
  }

  if (diffs.length > fileLimit) truncated = true;
  if (truncated) out.push(`${indent}${paint.text.dim('… diff preview truncated; use /last to expand')}`);
  return out.join('\n');
}

function fileDiffs(result) {
  if (!result) return [];
  if (Array.isArray(result.file_diffs)) return result.file_diffs;
  if (result.file_diff) return [result.file_diff];
  if (result.type === 'file_diff' || result.hunks || result.unified) return [result];
  return [];
}

function normalizeFileDiff(diff) {
  if (!diff) return null;
  return {
    ...diff,
    hunks: normalizeHunks(diff),
  };
}

function normalizeHunks(diff) {
  if (Array.isArray(diff?.hunks) && diff.hunks.length) {
    return diff.hunks.map(normalizeHunk).filter(hunk => hunk.lines.length);
  }
  if (diff?.unified) return parseUnifiedHunks(diff.unified);
  return [];
}

function normalizeHunk(hunk = {}) {
  const lines = Array.isArray(hunk.lines)
    ? hunk.lines.map(normalizeDiffLine).filter(Boolean)
    : typeof hunk.body === 'string'
      ? parseDiffBody(hunk.body)
      : [];
  const oldCount = hunk.old_count ?? hunk.old_lines ?? hunk.oldCount ?? countDiffLines(lines, 'old');
  const newCount = hunk.new_count ?? hunk.new_lines ?? hunk.newCount ?? countDiffLines(lines, 'new');
  return {
    ...hunk,
    old_start: hunk.old_start ?? hunk.oldStart ?? 1,
    old_count: oldCount,
    new_start: hunk.new_start ?? hunk.newStart ?? 1,
    new_count: newCount,
    lines,
  };
}

function normalizeDiffLine(line) {
  if (typeof line === 'string') return parseUnifiedLine(line);
  if (!line || typeof line !== 'object') return null;
  const rawType = String(line.type || line.kind || '').toLowerCase();
  const text = String(line.text ?? line.content ?? line.value ?? '');
  if (rawType === 'add' || rawType === 'added' || rawType === '+') return { ...line, type: 'add', text };
  if (rawType === 'remove' || rawType === 'removed' || rawType === 'delete' || rawType === '-') return { ...line, type: 'remove', text };
  if (rawType === 'context' || rawType === 'same' || rawType === ' ') return { ...line, type: 'context', text };
  return parseUnifiedLine(text);
}

function parseDiffBody(body) {
  return String(body || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(line => line && !line.startsWith('@@'))
    .map(parseUnifiedLine)
    .filter(Boolean);
}

function parseUnifiedHunks(unified) {
  const hunks = [];
  let current = null;
  for (const raw of String(unified || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) continue;
    const header = raw.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (header) {
      current = {
        old_start: Number(header[1]) || 1,
        old_count: Number(header[2] || 1),
        new_start: Number(header[3]) || 1,
        new_count: Number(header[4] || 1),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) {
      if (!raw || (!raw.startsWith('+') && !raw.startsWith('-') && !raw.startsWith(' '))) continue;
      current = { old_start: 1, old_count: 0, new_start: 1, new_count: 0, lines: [] };
      hunks.push(current);
    }
    const line = parseUnifiedLine(raw);
    if (line) current.lines.push(line);
  }
  for (const hunk of hunks) {
    if (!hunk.old_count) hunk.old_count = countDiffLines(hunk.lines, 'old');
    if (!hunk.new_count) hunk.new_count = countDiffLines(hunk.lines, 'new');
  }
  return hunks.filter(hunk => hunk.lines.length);
}

function parseUnifiedLine(raw) {
  const line = String(raw ?? '');
  if (!line && raw !== '') return null;
  if (line.startsWith('+') && !line.startsWith('+++')) return { type: 'add', text: line.slice(1) };
  if (line.startsWith('-') && !line.startsWith('---')) return { type: 'remove', text: line.slice(1) };
  if (line.startsWith(' ')) return { type: 'context', text: line.slice(1) };
  return { type: 'context', text: line };
}

function countDiffLines(lines, side) {
  return lines.filter(line => {
    if (side === 'old') return line.type !== 'add';
    return line.type !== 'remove';
  }).length;
}

function paintDiffLine(line, maxWidth) {
  const text = truncatePlain(String(line?.text ?? ''), Math.max(20, maxWidth - 2));
  if (line?.type === 'add') return paint.state.success(`+ ${text}`);
  if (line?.type === 'remove') return paint.state.danger(`- ${text}`);
  return paint.text.dim(`  ${text}`);
}

function truncatePlain(text, max) {
  if (text.length <= max) return text;
  if (max <= 1) return '';
  return text.slice(0, max - 1) + '…';
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
  const cwd = opts.cwd || safeCwd();
  const cols = opts.columns || term().columns || 120;
  const indent = opts.indent ?? (tool === 'shell' ? '' : '  ');

  const label     = toolDisplayLabel(tool);
  const argsText  = formatArgs(tool, args, cwd);
  const leadText  = formatHeadLead(tool, label);

  const leadVisible = visibleWidth(`${indent}${leadText}`);
  const budget = Math.max(20, cols - leadVisible - 4);

  if (tool === 'shell') {
    const profile = shellCommandProfile(toolDisplaySummary(tool, args || {}, { cwd }), { cwd });
    if (profile.compact) {
      const head = `${indent}${leadText}`;
      if (profile.preview) {
        const fullArgs = compactShellProfile(profile);
        if (visibleWidth(fullArgs) <= budget) return `${head} ${fullArgs}`;
        const previewTail = `${paint.text.dim(' · preview:')} ${paint.text.primary(profile.preview)}`;
        const baseArgs = compactShellProfile(profile, { includePreview: false, includeDetails: false });
        const baseBudget = budget - visibleWidth(previewTail);
        if (baseBudget >= 12) {
          const baseTruncated = truncateEndVisible(baseArgs, baseBudget);
          return `${head} ${baseTruncated}${previewTail}`;
        }
      }
      const argsTruncated = truncateMiddle(argsText, budget);
      return argsTruncated ? `${head} ${argsTruncated}` : head;
    }
  }

  if (tool === 'shell' && visibleWidth(argsText) > budget) {
    const wrapWidth = Math.max(32, cols - visibleWidth(indent) - 4);
    const display = shellCommandDisplay(toolDisplaySummary(tool, args || {}, { cwd }), { cwd });
    const commandLines = wrapCommand(display.command, wrapWidth)
      .map((line, index) => `${indent}${paint.text.dim(index === 0 ? '$ ' : '> ')}${formatShellCommand(line, paintShellAdapter)}`);
    const head = `${indent}${leadText}`;
    const cwdLine = display.cwdLabel
      ? `\n${indent}${paint.text.dim('  in ')}${paint.brand.data(display.cwdLabel)}`
      : '';
    return `${head}\n${commandLines.join('\n')}${cwdLine}`;
  }

  const argsTruncated = truncateMiddle(argsText, budget);

  const head = `${indent}${leadText}`;
  return argsTruncated ? `${head} ${argsTruncated}` : head;
}

function formatHeadLead(tool, label) {
  if (tool !== 'shell') return paintLabel(tool, label);
  return `${paint.text.dim('• shell ·')} ${paintLabel(tool, label)}`;
}

function compactShellProfile(profile, { includePreview = true, includeDetails = true } = {}) {
  const previewSuffix = profile.preview ? ` · preview: ${profile.preview}` : '';
  const summary = previewSuffix && profile.summary.endsWith(previewSuffix)
    ? profile.summary.slice(0, -previewSuffix.length)
    : profile.summary;
  const parts = [`${paint.text.dim('$')} ${paint.text.primary(summary)}`];
  if (profile.cwdLabel) parts.push(`${paint.text.dim('in')} ${paint.brand.data(profile.cwdLabel)}`);
  if (includeDetails) parts.push(paint.text.dim(profile.detailHint || 'details: F2 or /last'));
  if (includePreview && profile.preview) parts.push(`${paint.text.dim('preview:')} ${paint.text.primary(profile.preview)}`);
  return parts.join(' · ');
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

function wrapCommand(command, width) {
  const text = String(command || '');
  if (!text) return ['(empty command)'];
  const lines = [];
  for (const physicalLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    for (const token of physicalLine.match(/\S+\s*/g) || [physicalLine]) {
      const next = line + token;
      if (line && visibleWidth(next.trimEnd()) > width) {
        lines.push(line.trimEnd());
        line = token;
        continue;
      }
      if (!line && visibleWidth(token.trimEnd()) > width) {
        lines.push(...chunkLongToken(token.trimEnd(), width));
        line = '';
        continue;
      }
      line = next;
    }
    if (line.trimEnd()) lines.push(line.trimEnd());
    else if (!physicalLine.trim()) lines.push('');
  }
  return lines.length ? lines : ['(empty command)'];
}

function chunkLongToken(token, width) {
  const chunks = [];
  const size = Math.max(8, width);
  for (let i = 0; i < token.length; i += size) {
    chunks.push(token.slice(i, i + size));
  }
  return chunks;
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
