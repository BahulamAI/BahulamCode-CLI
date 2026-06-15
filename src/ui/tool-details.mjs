/**
 * Tool detail formatters — Mission Control (PRD-055 §6.3).
 *
 * One function per high-value tool, all sharing the same signature so the
 * expand handler can dispatch by `tool`:
 *
 *   detailFor(card) → string         // multi-line, ANSI-styled, no trailing \n
 *
 * Falls back to a generic dump when there's no dedicated formatter.
 *
 * Pure: no I/O. The REPL writes the returned string to stderr.
 */

import { paint } from './palette.mjs';
import { icon, toolFamily } from './icons.mjs';
import { toolDisplayLabel } from '../terminal/tool-display.mjs';

const MAX_DETAIL_LINES = 60;
const MAX_LINE_WIDTH = 220;

// ── Dispatch ─────────────────────────────────────────────────────────────

export function detailFor(card) {
  if (!card) return paint.text.dim('  (no card to expand)');
  const { tool } = card;

  const header = renderHeader(card);
  const body = renderBody(card);
  return body ? `${header}\n${body}` : header;
}

function renderBody(card) {
  const { tool } = card;
  switch (tool) {
    case 'read_file':       return detailReadFile(card);
    case 'read_files':      return detailReadFiles(card);
    case 'search_code':
    case 'search_files':
    case 'grep':            return detailSearch(card);
    case 'list_files':      return detailListFiles(card);
    case 'edit_file':       return detailEditFile(card);
    case 'write_file':      return detailWriteFile(card);
    case 'write_project':   return detailWriteProject(card);
    case 'delete_file':     return detailDeleteFile(card);
    case 'shell':           return detailShell(card);
    case 'run_tests':
    case 'validate_build':
    case 'lint_check':
    case 'validate_file':
    case 'validate_structure': return detailValidator(card);
    case 'plan':            return detailPlan(card);
    case 'explore':
    case 'verify':
    case 'debug':
    case 'refactor':
    case 'analyze_code':    return detailGenericOutput(card);
    default:                return detailGenericOutput(card);
  }
}

// ── Header / framing ─────────────────────────────────────────────────────

function renderHeader(card) {
  const { tool, args, durationMs, result } = card;
  const label = toolDisplayLabel(tool);
  const fam = toolFamily(tool);
  const accent = fam === 'write' ? paint.brand.primary
              : fam === 'shell' ? paint.state.warn
              : fam === 'subAgent' ? paint.brand.data
              : paint.text.primary;

  const lines = [
    `  ${paint.text.dim('━━')} ${icon(tool)} ${accent(label)} ${paint.text.dim('━━')}`,
  ];

  const args1 = oneLineArgs(tool, args);
  if (args1) lines.push(`    ${paint.text.dim('args  ')} ${args1}`);
  if (durationMs != null) {
    lines.push(`    ${paint.text.dim('time  ')} ${paint.text.muted(formatDuration(durationMs))}`);
  }
  if (result?.success === false) {
    lines.push(`    ${paint.state.danger('error ')} ${result?.error || 'failed'}`);
  }
  return lines.join('\n');
}

function oneLineArgs(tool, args) {
  if (!args) return '';
  try {
    const compact = JSON.stringify(args);
    if (compact.length <= 140) return paint.text.muted(compact);
    return paint.text.muted(compact.slice(0, 137) + '…');
  } catch {
    return paint.text.muted(String(args));
  }
}

// ── Read ────────────────────────────────────────────────────────────────

function detailReadFile(card) {
  const output = String(card.result?.output ?? card.result?.output_preview ?? '');
  if (!output) return paint.text.dim('    (empty file)');
  const startLine = Number(card.args?.start_line) || 1;
  return numbered(output, startLine);
}

function detailReadFiles(card) {
  const output = String(card.result?.output ?? '');
  return clip(output);
}

// ── Search / list ───────────────────────────────────────────────────────

function detailSearch(card) {
  const output = String(card.result?.output ?? '');
  if (!output.trim()) return paint.text.dim('    (no matches)');

  const grouped = groupSearchByFile(output);
  if (!grouped) return clip(output);

  const out = [];
  let totalLines = 0;
  for (const [file, hits] of grouped) {
    if (totalLines > MAX_DETAIL_LINES) {
      out.push(paint.text.dim(`    … ${grouped.size - out.length / 2} more file(s)`));
      break;
    }
    out.push(`    ${paint.brand.data(file)}`);
    for (const hit of hits.slice(0, 8)) {
      out.push(`      ${paint.text.dim(hit.line + ':')} ${paint.text.primary(hit.text)}`);
      totalLines++;
    }
    if (hits.length > 8) {
      out.push(paint.text.dim(`      … ${hits.length - 8} more match(es)`));
    }
    totalLines += 1;
  }
  return out.join('\n');
}

function groupSearchByFile(output) {
  const groups = new Map();
  let any = false;
  for (const line of output.split('\n')) {
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    any = true;
    const [, file, ln, text] = m;
    if (!groups.has(file)) groups.set(file, []);
    groups.get(file).push({ line: ln, text: text.trim().slice(0, MAX_LINE_WIDTH) });
  }
  return any ? groups : null;
}

function detailListFiles(card) {
  const output = String(card.result?.output ?? '');
  if (!output.trim()) return paint.text.dim('    (empty)');
  const lines = output.split('\n').filter(Boolean).slice(0, MAX_DETAIL_LINES);
  return lines.map(l => `    ${paint.text.primary(l)}`).join('\n');
}

// ── Write / edit ────────────────────────────────────────────────────────

function detailEditFile(card) {
  const diff = card.result?.diff || card.result?.patch || card.result?.output;
  if (diff) return renderDiff(String(diff));

  const before = card.args?.search;
  const after = card.args?.replace;
  if (before != null && after != null) {
    return [
      `    ${paint.state.danger('- ' + String(before).split('\n')[0].slice(0, 160))}`,
      `    ${paint.state.success('+ ' + String(after).split('\n')[0].slice(0, 160))}`,
    ].join('\n');
  }
  return paint.text.dim('    (edit applied, no diff returned)');
}

function detailWriteFile(card) {
  const content = card.args?.content;
  if (!content) return paint.text.dim('    (no content)');
  return numbered(String(content), 1);
}

function detailWriteProject(card) {
  const files = card.args?.files || [];
  if (!files.length) return paint.text.dim('    (no files)');
  return files.slice(0, 30).map(f => {
    const p = f.path || f.file_path || '';
    const lines = typeof f.content === 'string' ? f.content.split('\n').length : '?';
    return `    ${paint.brand.primary(p)} ${paint.text.dim(`(${lines} lines)`)}`;
  }).join('\n');
}

function detailDeleteFile(card) {
  const p = card.args?.file_path || card.args?.path || '';
  return `    ${paint.state.danger('✗')} ${paint.text.primary(p)}`;
}

// ── Shell / validators ──────────────────────────────────────────────────

function detailShell(card) {
  const stdout = String(card.result?.stdout ?? card.result?.output ?? '');
  const stderr = String(card.result?.stderr ?? '');
  const out = [];
  if (stdout) {
    out.push(paint.text.dim('    stdout'));
    out.push(clip(stdout));
  }
  if (stderr) {
    if (out.length) out.push('');
    out.push(paint.state.warn('    stderr'));
    out.push(clip(stderr, paint.state.danger));
  }
  return out.length ? out.join('\n') : paint.text.dim('    (no output)');
}

function detailValidator(card) {
  return detailShell(card);
}

// ── Sub-agent output ────────────────────────────────────────────────────

function detailPlan(card) {
  const text = String(card.result?.output ?? card.result?.plan ?? '');
  if (!text.trim()) return paint.text.dim('    (no plan)');
  // Number list items, highlight headers.
  return text.split('\n').slice(0, MAX_DETAIL_LINES).map(line => {
    if (/^\s*\d+\./.test(line)) return `    ${paint.brand.accent(line.trim())}`;
    if (/^#+\s/.test(line))     return `    ${paint.bold(paint.brand.primary(line.trim()))}`;
    return `    ${paint.text.primary(line)}`;
  }).join('\n');
}

function detailGenericOutput(card) {
  const out = String(card.result?.output ?? card.result?.output_preview ?? '');
  return clip(out);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function numbered(text, start) {
  const lines = String(text).split('\n');
  const total = lines.length;
  const width = String(start + total - 1).length;
  return lines.slice(0, MAX_DETAIL_LINES).map((line, i) => {
    const n = String(start + i).padStart(width);
    return `    ${paint.text.dim(n)} ${paint.text.primary(line.slice(0, MAX_LINE_WIDTH))}`;
  }).join('\n') + (total > MAX_DETAIL_LINES
    ? `\n    ${paint.text.dim(`… ${total - MAX_DETAIL_LINES} more line(s)`)}`
    : '');
}

function clip(text, painter = paint.text.primary) {
  if (!text) return paint.text.dim('    (empty)');
  const lines = String(text).split('\n');
  const head = lines.slice(0, MAX_DETAIL_LINES).map(l => `    ${painter(l.slice(0, MAX_LINE_WIDTH))}`);
  if (lines.length > MAX_DETAIL_LINES) {
    head.push(`    ${paint.text.dim(`… ${lines.length - MAX_DETAIL_LINES} more line(s)`)}`);
  }
  return head.join('\n');
}

function renderDiff(text) {
  return text.split('\n').slice(0, MAX_DETAIL_LINES).map(line => {
    if (line.startsWith('+++') || line.startsWith('---')) return `    ${paint.bold(paint.text.muted(line))}`;
    if (line.startsWith('@@'))                            return `    ${paint.brand.data(line)}`;
    if (line.startsWith('+'))                             return `    ${paint.state.success(line)}`;
    if (line.startsWith('-'))                             return `    ${paint.state.danger(line)}`;
    return `    ${paint.text.dim(line)}`;
  }).join('\n');
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
