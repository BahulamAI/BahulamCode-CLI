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
import { shellCommandProfile, toolDisplayLabel, toolDisplaySummary } from '../terminal/tool-display.mjs';
import { isSensitiveConfigPath } from '../core/safety.mjs';

const MAX_DETAIL_LINES = 60;
const MAX_SHELL_DETAIL_LINES = 220;
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

  const diff = unifiedForFileDiff(card.result?.file_diff)
    || card.result?.diff
    || card.result?.patch
    || card.result?.output;
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
  const redacted = redactedFileDiff(card.result?.file_diff)
    || (isSensitiveConfigPath(card.args?.file_path || card.args?.path)
      ? sensitiveFallbackDiff(card)
      : null);
  if (redacted) return renderRedactedDiff(redacted);

  const diff = unifiedForFileDiff(card.result?.file_diff) || card.result?.diff;
  if (diff) return renderDiff(String(diff));
  const content = card.args?.content;
  if (!content) return paint.text.dim('    (no content)');
  return numbered(String(content), 1);
}

function detailWriteProject(card) {
  const diffs = card.result?.file_diffs || [];
  if (diffs.length) {
    return diffs.map(diff => {
      const redacted = redactedFileDiff(diff);
      if (redacted) return renderRedactedDiff(redacted);
      const unified = unifiedForFileDiff(diff);
      return unified ? renderDiff(unified) : '';
    }).filter(Boolean).join('\n');
  }
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
  const file = diff.relative_path || diff.path || 'sensitive config';
  const add = diff.lines_added ?? 0;
  const rem = diff.lines_removed ?? 0;
  return `    ${paint.brand.primary(file)} ${paint.text.dim(`+${add} −${rem}`)}\n    ${paint.text.dim('diff redacted for sensitive config')}`;
}

function detailDeleteFile(card) {
  const p = card.args?.file_path || card.args?.path || '';
  return `    ${paint.state.danger('✗')} ${paint.text.primary(p)}`;
}

// ── Shell / validators ──────────────────────────────────────────────────

function detailShell(card) {
  const command = String(card.args?.command || card.args?.cmd || '').trim();
  const stdout = String(card.result?.stdout ?? card.result?.output ?? '');
  const stderr = String(card.result?.stderr ?? '');
  const out = [];
  if (command) {
    const profile = shellCommandProfile(command);
    if (profile.cwdLabel) {
      out.push(paint.text.dim('    cwd'));
      out.push(`    ${paint.brand.data(profile.cwdLabel)}`);
      out.push('');
    }

    out.push(paint.text.dim('    command'));
    if (profile.script?.body) {
      out.push(`    ${paint.text.primary(profile.script.invocation || profile.command.split('\n')[0] || profile.command)}`);
      out.push('');
      out.push(paint.text.dim('    script'));
      out.push(numbered(profile.script.body, 1, { maxLines: MAX_SHELL_DETAIL_LINES }));
    } else {
      out.push(clip(profile.command, paint.text.primary, { maxLines: MAX_SHELL_DETAIL_LINES }));
    }
  }
  if (stdout) {
    if (out.length) out.push('');
    out.push(paint.text.dim('    stdout'));
    out.push(clip(stdout, paint.text.primary, { maxLines: MAX_DETAIL_LINES }));
  }
  if (stderr) {
    if (out.length) out.push('');
    out.push(paint.state.warn('    stderr'));
    out.push(clip(stderr, paint.state.danger, { maxLines: MAX_DETAIL_LINES }));
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
  return text.split('\n').slice(0, MAX_DETAIL_LINES).map(line => {
    if (line.startsWith('+++') || line.startsWith('---')) return `    ${paint.bold(paint.text.muted(line))}`;
    if (line.startsWith('@@'))                            return `    ${paint.brand.data(line)}`;
    if (line.startsWith('+'))                             return `    ${paint.state.success(line)}`;
    if (line.startsWith('-'))                             return `    ${paint.state.danger(line)}`;
    return `    ${paint.text.dim(line)}`;
  }).join('\n');
}

function unifiedForFileDiff(diff) {
  if (!diff) return '';
  if (diff.unified) return String(diff.unified);
  const hunks = Array.isArray(diff.hunks) ? diff.hunks : [];
  if (!hunks.length) return '';
  const file = diff.relative_path || diff.path || 'file';
  const out = [`--- a/${file}`, `+++ b/${file}`];
  for (const hunk of hunks) {
    const lines = hunkLines(hunk);
    if (!lines.length) continue;
    const oldCount = hunk.old_count ?? hunk.old_lines ?? countLinesForSide(lines, 'old');
    const newCount = hunk.new_count ?? hunk.new_lines ?? countLinesForSide(lines, 'new');
    out.push(`@@ -${hunk.old_start ?? 1},${oldCount} +${hunk.new_start ?? 1},${newCount} @@`);
    for (const line of lines) out.push(toUnifiedLine(line));
  }
  return out.length > 2 ? out.join('\n') : '';
}

function hunkLines(hunk = {}) {
  if (Array.isArray(hunk.lines)) return hunk.lines;
  if (typeof hunk.body !== 'string') return [];
  return hunk.body.replace(/\r\n?/g, '\n').split('\n').filter(line => line && !line.startsWith('@@'));
}

function toUnifiedLine(line) {
  if (typeof line === 'string') {
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) return line;
    return ` ${line}`;
  }
  const type = String(line?.type || '').toLowerCase();
  const text = String(line?.text ?? line?.content ?? '');
  if (type === 'add' || type === 'added') return `+${text}`;
  if (type === 'remove' || type === 'removed' || type === 'delete') return `-${text}`;
  return ` ${text}`;
}

function countLinesForSide(lines, side) {
  return lines.filter(line => {
    const type = typeof line === 'string'
      ? (line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context')
      : String(line?.type || 'context').toLowerCase();
    if (side === 'old') return type !== 'add' && type !== 'added';
    return type !== 'remove' && type !== 'removed' && type !== 'delete';
  }).length;
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
