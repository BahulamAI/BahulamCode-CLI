/**
 * Terminal command cards: invocation, context, outcome and output are distinct.
 * Full details always use the original command, not a parsed script-body preview.
 */
import path from 'node:path';
import { paint } from './palette.mjs';
import { term } from './term.mjs';
import { glyph, recordHead, recordNote } from './chrome.mjs';
import { wrapCode, wrapRuns } from './code-layout.mjs';
import { stripSequences } from './render-queue.mjs';
import { shellCommandDisplay, shellCommandProfile } from '../terminal/tool-display.mjs';
import { renderUnifiedDiff } from './diff.mjs';

export function toolSource(data = {}) {
  if (!data) return '';
  const name = value => typeof value === 'string' ? value : value?.name || '';
  return [
    name(data._plugin || data.plugin) ? 'plugin ' + name(data._plugin || data.plugin) : '',
    name(data._mcp_server || data.mcp_server) ? 'MCP ' + name(data._mcp_server || data.mcp_server) : '',
    name(data.workflow_name || data.workflow) ? 'workflow ' + name(data.workflow_name || data.workflow) : '',
    name(data.sub_agent_label || data.sub_agent) ? 'agent ' + name(data.sub_agent_label || data.sub_agent) : '',
  ].filter(Boolean).join(glyph(' · ', ' / '));
}

export function commandStatus(result, durationMs) {
  if (!result) return { text: 'running', tone: 'active' };
  const raw = result.exit_code ?? result.exitCode;
  const exit = raw !== '' && raw != null && /^-?\d+$/.test(String(raw)) ? Number(raw) : null;
  let text = result._blocked ? 'blocked' : result._timed_out ? 'timed out'
    : result._observation_timeout ? 'observed output tail'
    : result.success === false || (exit != null && exit !== 0) ? 'failed'
    : result.success === true || exit === 0 ? 'completed' : 'result received';
  const tone = result._observation_timeout ? 'warn'
    : result._blocked || result._timed_out || result.success === false || (exit != null && exit !== 0) ? 'danger'
    : result.success === true || exit === 0 ? 'success' : 'muted';
  // Observation timeout isn't the process's exit status.
  if (exit != null && !result._observation_timeout) text += glyph(' · ', ' / ') + 'exit ' + exit;
  const ms = durationMs ?? result.duration_ms ?? (result.duration_s != null ? Number(result.duration_s) * 1000 : null);
  if (Number.isFinite(ms)) text += glyph(' · ', ' / ') + (ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's');
  return { text, tone };
}


export function commandRuns(command) {
  // A display lexer, not a shell parser. Tokenization must preserve every byte.
  const tokens = String(command).match(/(?:\d*)?(?:>>?|<<?|>&|<&)|&&|\|\||[|;]|\s+|(?:\\.|"(?:\\.|[^"\\])*"|'[^']*'|[^\s"'|;&<>])+|./gsu) || [];
  let expectsCommand = true, redirection = false;
  return tokens.map(text => {
    let painter = paint.text.primary;
    if (/^\s+$/.test(text)) { if (text.includes('\n')) expectsCommand = true; }
    else if (/^(?:&&|\|\||[|;])$/.test(text)) { painter = paint.text.muted; expectsCommand = true; }
    else if (/^\d*(?:>>?|<<?|>&|<&)$/.test(text)) { painter = paint.text.muted; redirection = true; }
    else if (redirection) { painter = paint.text.primary; redirection = false; }
    else if (expectsCommand && !/^[A-Za-z_][\w]*=/.test(text)) { painter = text => paint.bold(paint.brand.primary(text)); expectsCommand = false; }
    else if (/^-/.test(text)) painter = paint.brand.data;
    else if (/^["']/.test(text)) painter = paint.syntax.string;
    else if (/^\d+(?:\.\d+)?$/.test(text)) painter = paint.syntax.literal;
    return { text, paint: painter };
  });
}

function compactDirectory(directory, cwd = process.cwd()) {
  const value = String(directory || '');
  if (!value) return '';
  try {
    const resolved = path.resolve(value);
    const current = path.resolve(cwd || process.cwd());
    if (resolved === current) return '.';
    const relative = path.relative(current, resolved);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return relative;
    }
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home && (resolved === home || resolved.startsWith(`${home}${path.sep}`))) {
      return `~${resolved.slice(home.length)}`;
    }
    return `…/${path.basename(path.dirname(resolved))}/${path.basename(resolved)}`;
  } catch {
    return value;
  }
}

export function renderCommandHead(args = {}, { columns = term().columns, indent = '  ', cwd, source = '', marker = '' } = {}) {
  const command = String(args.command ?? args.cmd ?? '');
  const explicitCwd = args.cwd || args.working_directory;
  const launchCwd = explicitCwd || cwd;
  const profile = shellCommandProfile(command, { cwd: launchCwd });
  const display = shellCommandDisplay(command, { cwd: launchCwd });
  // "Running" matches the present-progressive verb used for every other tool
  // row (Reading / Editing / Searching files). The `$ command` line below
  // already says this is a shell, so it is not repeated in the detail.
  const out = [recordHead('Running', source, { columns, indent, marker })];
  const bodyIndent = indent + '  ';
  if (profile.compact) {
    out.push(wrapCode(profile.kind + glyph(' · ', ' / ') + profile.commandLineCount + ' lines', paint.text.primary, { columns, indent: bodyIndent }));
    if (profile.preview) out.push(wrapCode('preview  ' + profile.preview, paint.text.muted, { columns, indent: bodyIndent }));
    out.push(wrapCode('full command  F2 or /last', paint.text.muted, { columns, indent: bodyIndent }));
  } else {
    out.push(...wrapRuns(commandRuns(explicitCwd ? command : display.command), { columns, indent: bodyIndent, first: paint.text.muted('$ '), rest: paint.text.muted(glyph('↳ ', '> ')) }));
  }
  // Keep an explicit leading cd visible when a separate launch directory is supplied.
  const directory = compactDirectory(explicitCwd || display.cwdLabel || cwd);
  if (directory) out.push(wrapCode('cwd  ' + directory, paint.text.muted, { columns, indent: bodyIndent }));
  return out.join('\n');
}

function outputSection(label, text, args, { columns, indent, full = false, error = false, showLabel = true } = {}) {
  if (!text) return '';
  // Align output under the record gutter so prose, rows and truncation hints
  // share one left edge instead of each section inventing its own indent.
  const gutter = indent + '  ';
  const plain = stripSequences(String(text)).replace(/\r\n/g, '\n');
  const command = shellCommandDisplay(args.command || args.cmd || '').command;
  const gitDiff = /^\s*git\s+(?:diff|show)\b/.test(command) && /^(?:diff --git |@@ |[+-])/m.test(plain);
  const out = showLabel ? [wrapCode(label, paint.text.muted, { columns, indent: gutter })] : [];
  const body = gutter + '  ';
  if (gitDiff && !error) {
    out.push(renderUnifiedDiff(plain, { columns, indent: body, maxLines: full ? Infinity : 8 }));
  } else {
    const lines = plain.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const configured = Number.parseInt(process.env.BAHULAM_SHELL_PREVIEW_ROWS, 10);
    const previewCount = Number.isFinite(configured) && configured > 0 ? configured : /^\s*git\s+(?:status|diff|show)\b/.test(command) ? 8 : 2;
    const visible = full ? lines : lines.slice(0, previewCount);
    for (const line of visible) {
      const errorLine = error || /^\s*(?:error|fatal|exception)\b/i.test(line);
      out.push(wrapCode(line, errorLine ? paint.state.danger : paint.text.muted, { columns, indent: body }));
    }
    if (visible.length < lines.length) out.push(wrapCode(glyph('… ', '... ') + (lines.length - visible.length) + ' more rows · F2 details or /last', paint.text.muted, { columns, indent: body }));
  }
  return out.join('\n');
}

export function renderCommandResult(result = {}, { args = {}, columns = term().columns, indent = '  ', durationMs, full = false, summary } = {}) {
  const state = commandStatus(result, durationMs);
  const out = [recordNote(state.text, { columns, indent, tone: state.tone })];
  result ||= {};
  const stdout = result.stdout ?? result.output_preview ?? result.output ?? '';
  const fullOutput = full ? result.stdout ?? result.output ?? stdout : stdout;
  const stderr = result.stderr || '';
  const structuredSummary = summary && /^(?:json\b|.+\bin sync\b|.+\bout of sync\b)/.test(summary.text || '');
  if (structuredSummary) out.push(wrapCode(summary.text, paint.text.muted, { columns, indent }));
  if (result.error && !String(fullOutput).includes(result.error) && !String(stderr).includes(result.error)) out.push(wrapCode(result.error, paint.state.danger, { columns, indent }));
  if (fullOutput && (!structuredSummary || full)) {
    const showLabel = Boolean(stderr) || full;
    out.push(outputSection(showLabel ? 'stdout' : 'result', fullOutput, args, { columns, indent, full, showLabel }));
  }
  else if (fullOutput && structuredSummary) out.push(wrapCode('full output  F2 or /last', paint.text.muted, { columns, indent: indent + '  ' }));
  if (stderr) out.push(outputSection('stderr', stderr, args, { columns, indent, full, error: true }));
  if (!fullOutput && !stderr && result.message) out.push(wrapCode(result.message, paint.text.primary, { columns, indent }));
  return out.filter(Boolean).join('\n');
}

export function renderCommandDetails(card, { columns = term().columns, indent = '  ' } = {}) {
  const command = String(card.args?.command ?? card.args?.cmd ?? '');
  const out = [recordHead('Details', card.source || 'command', { columns, indent })];
  const cwd = card.args?.cwd || card.args?.working_directory || card.cwd;
  if (cwd) out.push(wrapCode('cwd  ' + cwd, paint.text.muted, { columns, indent }));
  if (command) {
    out.push(wrapCode(command.includes('\n') ? 'full command / script' : 'full command', paint.text.muted, { columns, indent }));
    // Preserve all physical lines including the final newline, heredoc delimiter
    // and everything after it. Never rewrite the command before displaying it.
    const lines = command.split('\n'), digits = String(lines.length).length;
    lines.forEach((line, i) => out.push(wrapCode(line, paint.text.primary, {
      columns, indent, first: paint.text.muted(String(i + 1).padStart(digits) + '  '),
      rest: paint.text.muted(' '.repeat(digits) + glyph('↳ ', '> ')), wordWrap: false,
    })));
  }
  out.push(renderCommandResult(card.result, { args: card.args, columns, indent, durationMs: card.durationMs, full: true }));
  return out.join('\n');
}

/** An explicit user action, not an automatic browser launch or session handoff. */
export function workspaceAction(file, { cwd, columns = term().columns, indent = '  ' } = {}) {
  if (!file || /[\x00-\x1f\x7f]/.test(file)) return '';
  const target = cwd ? path.resolve(cwd, file) : path.isAbsolute(file) ? file : './' + file.replace(/^\.\//, '');
  const quoted = "'" + target.replace(/'/g, "'\"'\"'") + "'";
  return wrapCode('Open file locally (new workspace):', paint.text.muted, { columns, indent }) + '\n'
    + wrapCode('bahulam workspace open ' + quoted, paint.brand.primary, { columns, indent, wordWrap: false });
}
