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
import { icon } from './icons.mjs';
import { shellCommandProfile, toolDisplayLabel, toolDisplaySummary } from '../terminal/tool-display.mjs';
import { isSensitiveConfigPath } from '../core/safety.mjs';
import { renderFileDiffs, renderUnifiedDiff } from './diff.mjs';
import { renderCommandDetails, workspaceAction } from './command-card.mjs';
import { wrapCode } from './code-layout.mjs';
import { stripSequences } from './render-queue.mjs';
import { sectionHeading } from './chrome.mjs';

const MAX_DETAIL_LINES = 60;
const MAX_LINE_WIDTH = 220;

// ── Dispatch ─────────────────────────────────────────────────────────────

export function detailFor(card) {
  if (!card) return paint.text.dim('  (no card to expand)');
  const { tool } = card;

  if (['shell', 'run_tests', 'validate_build', 'lint_check', 'validate_file', 'validate_structure'].includes(tool)) return renderCommandDetails(card);
  const header = renderHeader(card);
  const body = renderBody(card);
  const file = card.args?.file_path || card.args?.path;
  const action = ['write_file', 'edit_file'].includes(tool) && card.result?.success !== false ? workspaceAction(file, { cwd: card.cwd }) : '';
  return [header, body, action].filter(Boolean).join('\n');
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
    case 'Agent':
    case 'agent':
    case 'task':            return detailAgent(card);
    case 'sub_agent_tools': return detailSubAgentTools(card);
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
  const lines = [sectionHeading(toolDisplayLabel(tool), { detail: card.source || '' })];
  const args1 = oneLineArgs(tool, args);
  if (args1) lines.push(wrapCode('args  ' + stripSequences(args1), paint.text.muted, { indent: '  ' }));
  if (durationMs != null) lines.push(wrapCode('time  ' + formatDuration(durationMs), paint.text.muted, { indent: '  ' }));
  if (result?.success === false) lines.push(wrapCode('error ' + (result.error || 'failed'), paint.state.danger, { indent: '  ' }));
  return lines.join('\n');
}

function oneLineArgs(tool, args) {
  if (!args) return '';
  try {
    const compact = JSON.stringify(safeDetailArgs(tool, args));
    if (compact.length <= 140) return paint.text.muted(compact);
    return paint.text.muted(compact.slice(0, 137) + '…');
  } catch {
    return paint.text.muted(String(args));
  }
}

function safeDetailArgs(tool, args) {
  if (tool === 'shell') {
    const profile = shellCommandProfile(args?.command || args?.cmd || '');
    return {
      command: profile.summary,
      ...(profile.cwdLabel ? { cwd: profile.cwdLabel } : {}),
    };
  }
  if (tool === 'write_file') {
    const { content, ...rest } = args || {};
    return {
      ...rest,
      content: typeof content === 'string' ? `[${content.split('\n').length} lines omitted]` : content,
    };
  }
  if (tool === 'write_project') {
    return {
      ...args,
      files: (args.files || []).map(file => ({
        path: file.path || file.file_path,
        content: typeof file.content === 'string' ? `[${file.content.split('\n').length} lines omitted]` : file.content,
      })),
    };
  }
  if (tool === 'Agent' || tool === 'agent' || tool === 'task') {
    const prompt = args?.prompt || args?.task || args?.query || args?.description || args?.instruction || '';
    return {
      ...(args?.subagent_type ? { subagent_type: args.subagent_type } : {}),
      ...(args?.agent ? { agent: args.agent } : {}),
      ...(args?.name ? { name: args.name } : {}),
      ...(Array.isArray(args?.allowed_tools) ? { allowed_tools: args.allowed_tools } : {}),
      ...(prompt ? { prompt: `[${String(prompt).split('\n').length} lines] ${String(prompt).split('\n').find(Boolean)?.slice(0, 80) || ''}` } : {}),
    };
  }
  if (tool === 'edit_file') {
    const next = { ...args };
    if (isSensitiveConfigPath(next.file_path || next.path)) {
      for (const key of ['search', 'replace', 'old_string', 'new_string']) {
        if (typeof next[key] === 'string') next[key] = '[redacted]';
      }
      return next;
    }
    for (const key of ['search', 'replace', 'old_string', 'new_string']) {
      if (typeof next[key] === 'string' && next[key].length > 80) {
        next[key] = `[${next[key].split('\n').length} lines omitted]`;
      }
    }
    return next;
  }
  return args;
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
  const redacted = redactedFileDiff(card.result?.file_diff)
    || (isSensitiveConfigPath(card.args?.file_path || card.args?.path)
      ? sensitiveFallbackDiff(card)
      : null);
  if (redacted) return renderRedactedDiff(redacted);

  if (card.result?.file_diff) return renderFileDiffs(card.result, { indent: '  ' });
  const diff = card.result?.diff
    || card.result?.patch
    || card.result?.output;
  if (diff) return renderDiff(String(diff));

  const before = card.args?.search ?? card.args?.old_string;
  const after = card.args?.replace ?? card.args?.new_string;
  if (before != null && after != null) {
    return [
      wrapCode('Requested replacement (file line numbers unavailable)', paint.text.muted, { indent: '  ' }),
      ...String(before).split('\n').map(line => wrapCode(line, paint.state.danger, { indent: '  ', first: '- ', rest: '  ', wordWrap: false })),
      ...String(after).split('\n').map(line => wrapCode(line, paint.state.success, { indent: '  ', first: '+ ', rest: '  ', wordWrap: false })),
    ].join('\n');
  }
  return paint.text.dim('    (edit applied, no diff returned)');
}

function detailWriteFile(card) {
  const redacted = redactedFileDiff(card.result?.file_diff)
    || (isSensitiveConfigPath(card.args?.file_path || card.args?.path)
      ? sensitiveFallbackDiff(card)
      : null);
  if (redacted) return renderRedactedDiff(redacted);

  if (card.result?.file_diff) return renderFileDiffs(card.result, { indent: '  ' });
  const diff = card.result?.diff;
  if (diff) return renderDiff(String(diff));
  const content = card.args?.content;
  if (!content) return paint.text.dim('    (no content)');
  const lines = String(content).split('\n'), digits = String(lines.length).length;
  return [wrapCode('Submitted content (no diff returned)', paint.text.muted, { indent: '  ' }),
    ...lines.map((line, i) => wrapCode(line, paint.text.primary, {
      indent: '  ', first: paint.text.muted(String(i + 1).padStart(digits) + '  '), rest: ' '.repeat(digits + 2), wordWrap: false,
    })),
  ].join('\n');
}

function detailWriteProject(card) {
  const diffs = card.result?.file_diffs || [];
  if (diffs.length) return renderFileDiffs(card.result, { indent: '  ' });
  const files = card.args?.files || [];
  if (!files.length) return paint.text.dim('    (no files)');
  return files.slice(0, 30).map(f => {
    const p = f.path || f.file_path || '';
    const lines = typeof f.content === 'string' ? f.content.split('\n').length : '?';
    return `    ${paint.brand.primary(p)} ${paint.text.dim(`(${lines} lines)`)}`;
  }).join('\n');
}

function redactedFileDiff(diff) {
  return diff?.redacted ? diff : null;
}

function sensitiveFallbackDiff(card) {
  return {
    relative_path: card.args?.file_path || card.args?.path || 'sensitive config',
    lines_added: card.result?.lines_added,
    lines_removed: card.result?.lines_removed,
    redacted: true,
  };
}

function renderRedactedDiff(diff = {}) {
  return renderFileDiffs({ ...diff, redacted: true }, { indent: '  ' });
}

function detailDeleteFile(card) {
  const p = card.args?.file_path || card.args?.path || '';
  return `    ${paint.state.danger('✗')} ${paint.text.primary(p)}`;
}

// ── Shell / validators ──────────────────────────────────────────────────

function detailShell(card) {
  return renderCommandDetails(card);
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

function detailAgent(card) {
  const args = card.args || {};
  const prompt = args.prompt || args.task || args.query || args.description || args.instruction || '';
  const out = [];
  const meta = [
    args.subagent_type ? `type ${args.subagent_type}` : '',
    args.agent || args.name || '',
    Array.isArray(args.allowed_tools) && args.allowed_tools.length
      ? `${args.allowed_tools.length} allowed tools`
      : '',
  ].filter(Boolean).join(' · ');
  if (meta) out.push(`    ${paint.text.dim(meta)}`);
  if (prompt) {
    out.push(paint.text.dim('    prompt'));
    out.push(clip(prompt, paint.text.primary, { maxLines: MAX_DETAIL_LINES }));
  }
  const result = String(card.result?.output ?? card.result?.output_preview ?? '');
  if (result) {
    if (out.length) out.push('');
    out.push(paint.text.dim('    result'));
    out.push(clip(result));
  }
  return out.length ? out.join('\n') : detailGenericOutput(card);
}

function detailSubAgentTools(card) {
  const entries = Array.isArray(card.result?.tools) ? card.result.tools : [];
  if (!entries.length) return paint.text.dim('    (no folded tool calls)');

  const out = [];
  entries.forEach((entry, index) => {
    const tool = entry.tool || 'tool';
    const args = entry.args || {};
    const summary = entry.summary || toolDisplaySummary(tool, args);
    const outcome = entry.outcome ? ` ${paint.text.dim('—')} ${paint.text.muted(entry.outcome)}` : '';
    const duration = entry.durationMs != null ? ` ${paint.text.dim('· ' + formatDuration(entry.durationMs))}` : '';
    out.push(`    ${paint.text.dim(`${index + 1}.`)} ${icon(tool)} ${toolDisplayLabel(tool)}${summary ? ` ${paint.text.muted(summary)}` : ''}${outcome}${duration}`);

    const child = {
      tool,
      args,
      result: entry.result || null,
      durationMs: entry.durationMs ?? null,
    };
    const detail = renderBody(child);
    if (detail) out.push(indentBlock(detail, '      '));
  });
  return out.join('\n');
}

function detailGenericOutput(card) {
  const out = String(card.result?.output ?? card.result?.output_preview ?? '');
  return clip(out);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function numbered(text, start, { maxLines = MAX_DETAIL_LINES } = {}) {
  const lines = String(text).split('\n');
  const total = lines.length;
  const width = String(start + total - 1).length;
  return lines.slice(0, maxLines).map((line, i) => {
    const n = String(start + i).padStart(width);
    return `    ${paint.text.dim(n)} ${paint.text.primary(line.slice(0, MAX_LINE_WIDTH))}`;
  }).join('\n') + (total > maxLines
    ? `\n    ${paint.text.dim(`… ${total - maxLines} more line(s)`)}`
    : '');
}

function clip(text, painter = paint.text.primary, { maxLines = MAX_DETAIL_LINES } = {}) {
  if (!text) return paint.text.dim('    (empty)');
  const lines = String(text).split('\n');
  const head = lines.slice(0, maxLines).map(l => `    ${painter(l.slice(0, MAX_LINE_WIDTH))}`);
  if (lines.length > maxLines) {
    head.push(`    ${paint.text.dim(`… ${lines.length - maxLines} more line(s)`)}`);
  }
  return head.join('\n');
}

function indentBlock(text, prefix) {
  return String(text || '')
    .split('\n')
    .map(line => `${prefix}${line.trimStart()}`)
    .join('\n');
}

function renderDiff(text) {
  return renderUnifiedDiff(text, { indent: '  ' });
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
