/**
 * Approval prompt UI — Mission Control (PRD-055 §8.2).
 *
 *   ── ⚠ APPROVAL · SHELL-MEDIUM · shell ───────────────────────────────
 *   ⚙️ Running git add package.json && git status --short
 *   Decision
 *   ▸ [y] approve once     run this call
 *     [t] always allow     auto-approve future calls to this tool
 *     [n] cancel           do not run
 *   ↑↓ move · Enter pick · letter shortcut · Esc cancel
 *
 * Indigo highlights the active decision; amber marks explicit risks.
 * Fixed docks page long details while keeping decision choices visible.
 *
 * Pure — caller writes the returned string to stderr.
 */

import { paint, width as visibleWidth } from './palette.mjs';
import { glyph, sectionHeading } from './chrome.mjs';
import { term } from './term.mjs';
import { wrapToLines } from './text-layout.mjs';
import { dockContentWidth, dockOverlayCapacity } from './input-dock.mjs';
import { icon } from './icons.mjs';
import { shellCommandDisplay, shellCommandProfile, toolDisplayLabel, toolDisplaySummary } from '../terminal/tool-display.mjs';
import { label as tierLabel, requiresExplicitApproval, TIERS } from '../core/risk-tier.mjs';
import { isSensitiveConfigPath } from '../core/safety.mjs';

/**
 * Default option set per tier. Caller can override via `opts.options`.
 *
 * Each option is `{ key, label, value, hint? }`:
 *   key   — single-letter shortcut (case-insensitive)
 *   label — text shown in the menu
 *   value — return value from the menu loop
 *   hint  — secondary description shown to the right of the label
 */
export function defaultOptions(tier, { tool = '', args = {} } = {}) {
  const approve = { key: 'y', label: 'approve once',  value: 'approve',  hint: 'run this call' };
  const cancel = { key: 'n', label: 'cancel', value: 'reject', hint: 'do not run' };
  if (requiresExplicitApproval(tier)) {
    return [approve, cancel];
  }
  if (tool === 'shell') {
    return [
      approve,
      { key: 't', label: 'allow similar', value: 'allow-session', hint: `auto-approve ${shellTrustHint(args)} this session` },
      cancel,
    ];
  }
  return [
    approve,
    { key: 't', label: 'always allow',    value: 'allow-type',  hint: 'auto-approve future calls to this tool' },
    cancel,
  ];
}

/**
 * Render the compact horizontal prompt with arrow-navigable options.
 *
 *   ── ⚠ APPROVAL · SHELL-MEDIUM · shell ───────────────────────────────
 *   ⚙️ Running rm -rf node_modules && npm install
 *   Decision
 *   ▸ [y] approve once
 *     [t] always allow
 *     [n] cancel
 *   ↑↓ move · Enter pick · letter shortcut · Esc cancel
 *   ────────────────────────────────────────────────────────────────────
 *
 * @param {object} opts
 * @param {string} opts.tool
 * @param {object} opts.args
 * @param {string} opts.tier
 * @param {string} [opts.why]
 * @param {number} [opts.width]
 * @param {Array}  [opts.options]    — override default option set
 * @param {number} [opts.selected]   — index of the highlighted option
 */
export function renderApprovalPrompt({
  tool, args = {}, tier, why = '', width,
  options, selected = 0, showDetails = false,
} = {}) {
  const cols = Math.max(20, Math.min(width || term().columns || 80, 120));
  const explicit = requiresExplicitApproval(tier);
  const accent = explicit ? paint.state.warn : paint.brand.primary;
  const opts = options || defaultOptions(tier, { tool, args });
  const title = `⚠ ${approvalTitle(tier)} · ${tierLabel(tier)} · ${tool || 'tool'}`;

  const lines = [
    sectionHeading('Review action', { detail: title, columns: cols, tone: explicit ? 'warn' : 'brand' }),
    ...subjectRows(tool, args, cols, accent),
    ...detailRows(tool, args, cols, accent, showDetails),
    ...riskRows(tool, args, tier, accent),
    ...reasonRows(tool, args, why, cols, accent),
    blockLine(accent),
    ...decisionRows(opts, selected, accent),
    blockLine(accent, paint.text.dim(approvalFooter(tool, showDetails))),
  ];

  return '\n' + lines.flatMap(line => wrapToLines(line, Math.max(1, cols - 1))).join('\n');
}

/**
 * Paged details with pinned decisions. Paging changes presentation only.
 * Selection changes never change the height or hide the action's risk.
 */
export function renderApprovalDockPrompt({
  tool, args = {}, tier, why = '', width,
  options, selected = 0, showDetails = false, page = 0, terminalRows = term().rows,
} = {}) {
  const cols = Math.max(20, width || term().columns || 80);
  const budget = dockContentWidth(cols);
  const opts = options || defaultOptions(tier, { tool, args });
  const command = String(args.command || args.cmd || '');
  const fullCommandRequired = tool === 'shell' && shellCommandProfile(command).compact;
  const detailView = showDetails || fullCommandRequired;
  const accent = requiresExplicitApproval(tier) ? paint.state.warn : paint.brand.primary;
  const wrap = line => wrapToLines(line, budget, { preserveTrailingWhitespace: true });
  const risks = riskTerms(tool, args, tier);
  const pinned = risks.length ? wrap(paint.state.warn('risk   ' + risks.join(', '))) : [];
  const subject = tool === 'shell' && detailView
    ? command : subjectDetails(tool, args, toolDisplaySummary(tool, args, {}), budget).join('\n');
  const content = [];
  if (tool === 'shell') {
    content.push(paint.text.muted(detailView ? 'Command / full details' : 'Command'));
    // Detail view includes the original command, heredoc terminators, and
    // trailing commands. Never substitute a shortened script body here.
    const rawLines = subject.split(/\r?\n/);
    rawLines.forEach((line, index) => content.push(paint.text.primary(
      detailView && rawLines.length > 1 ? String(index + 1).padStart(String(rawLines.length).length) + '  ' + line
        : line.startsWith('$ ') ? line : '$ ' + line
    )));
    const cwd = args.cwd || args.working_directory;
    if (cwd) content.push(paint.text.muted('cwd    ') + paint.text.primary(cwd));
  } else {
    content.push(paint.text.muted(toolDisplayLabel(tool)));
    content.push(...subject.split('\n').map(paint.text.primary));
  }
  const reason = compactReason(tool, args, why);
  if (reason) content.push(paint.text.muted('reason ') + paint.text.primary(reason));
  const body = content.flatMap(wrap);
  const choices = opts.flatMap((option, index) => {
    const scope = { 'allow-session': 'session', 'allow-type': 'session', 'allow-project': 'project' }[option.value];
    const scoped = scope ? { ...option, label: option.label + ' (' + scope + ')' } : option;
    return wrap(optionToken({ ...scoped, hint: '' }, index === selected, accent));
  });
  const decision = [paint.text.muted('Decision'), ...choices];
  const capacity = dockOverlayCapacity(terminalRows);
  const bodySize = Math.max(1, capacity - pinned.length - decision.length - 2);
  const pageCount = Math.max(1, Math.ceil(body.length / bodySize));
  const currentPage = Math.max(0, Math.min(pageCount - 1, Math.floor(Number(page) || 0)));
  const pageRows = body.slice(currentPage * bodySize, (currentPage + 1) * bodySize);
  while (pageRows.length < Math.min(bodySize, body.length)) pageRows.push('');
  const position = pageCount > 1
    ? 'Details ' + (currentPage + 1) + '/' + pageCount + glyph(' · ', ' / ') + 'PgUp/PgDn'
    : 'Review before running';
  const lines = [...pinned, ...pageRows, ...wrap(paint.text.muted(position)), '', ...decision];
  return {
    prefix: '? approve > ',
    value: subject,
    context: approvalTitle(tier) + glyph(' · ', ' / ') + tierLabel(tier) + glyph(' · ', ' / ') + (tool || 'tool'),
    meta: [opts[selected]?.hint, tool === 'shell' ? (fullCommandRequired ? 'Full command' : 'd ' + (showDetails ? 'hide details' : 'details')) : ''].filter(Boolean).join(glyph(' · ', ' / ')),
    tips: glyph('↑↓ choose · Enter pick · Esc cancel', 'Arrows / Enter pick / Esc cancel'),
    lines,
    maxRows: capacity,
    page: currentPage,
    pageCount,
    fits: lines.length <= capacity,
  };
}

function shellTrustHint(args = {}) {
  const display = shellCommandDisplay(args.command || args.cmd || '');
  const parts = String(display.command || '').trim().split(/\s+/).filter(Boolean);
  const shape = parts.slice(0, 2).join(' ');
  return shape ? `${shape}*` : 'similar shell commands';
}

export function renderTrustedApproval({ tool, args = {}, scope = 'session', ruleId = '', delaySeconds = 0 } = {}) {
  const summary = approvalSubjectSummary(tool, args);
  const subject = `${tool || 'tool'}${summary ? ` "${truncate(summary, 80)}"` : ''}`;
  const rule = ruleId ? ` · rule ${ruleId}` : '';
  const delay = delaySeconds > 0 ? ` · auto-approved after ${delaySeconds}s` : '';
  return `  ${paint.state.success('✓')} ${paint.text.primary(subject)} ${paint.text.dim(`· pre-approved (${String(scope || 'session').toLowerCase()}${rule})${delay}`)}\n`;
}

function truncate(text, n) {
  const s = String(text || '');
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

// ── Compatibility wrapper ──────────────────────────────────────────────

/**
 * Render the unified approval prompt. Kept as a named export for older call
 * sites/tests that imported the previous inline renderer.
 */
export function renderInlinePrompt({ tool, args = {}, tier, why = '' } = {}) {
  return renderApprovalPrompt({ tool, args, tier, why });
}

export { TIERS };

function tierTitle(tier) {
  switch (tier) {
    case TIERS.SENSITIVE_READ: return 'SENSITIVE';
    case TIERS.PROTECTED_EDIT: return 'PROTECTED';
    case TIERS.SHELL_DANGEROUS: return 'DANGEROUS';
    case TIERS.DESTRUCTIVE: return 'DESTRUCTIVE';
    case TIERS.SHELL_MEDIUM: return 'MEDIUM';
    case TIERS.NETWORK: return 'NETWORK';
    case TIERS.LOCAL_EDIT: return 'EDIT';
    case TIERS.SHELL_SAFE: return 'SAFE';
    case TIERS.READ: return 'READ';
    default: return tierLabel(tier);
  }
}

function approvalTitle(tier) {
  switch (tier) {
    case TIERS.SENSITIVE_READ:
    case TIERS.PROTECTED_EDIT:
    case TIERS.SHELL_DANGEROUS:
    case TIERS.DESTRUCTIVE:
      return tierTitle(tier);
    default:
      return 'APPROVAL';
  }
}

function blockLine(accent, text = '') {
  return text ? `  ${text}` : '  ';
}

function subjectRows(tool, args, cols, accent) {
  const rows = [];
  const available = Math.max(24, cols - 5);
  const summary = toolDisplaySummary(tool, args, {});
  const label = subjectLabel(tool);
  const details = subjectDetails(tool, args, summary, Math.max(24, available - visibleWidth(label) - 1));

  if (details.length === 1 && visibleWidth(`${label} ${details[0]}`) <= available) {
    rows.push(blockLine(accent, `${label} ${paint.text.primary(details[0])}`));
    return rows;
  }

  rows.push(blockLine(accent, label));
  for (const line of subjectDetails(tool, args, summary, Math.max(24, available - 2))) {
    rows.push(blockLine(accent, `${paint.text.dim('  ')}${paint.text.primary(line)}`));
  }
  return rows;
}

function subjectLabel(tool) {
  const label = toolDisplayLabel(tool);
  if (tool === 'shell') {
    return `${paint.text.dim('• shell ·')} ${paint.text.primary(label)}`;
  }
  return `${icon(tool)} ${paint.text.primary(label)}`;
}

function decisionRows(opts, selected, accent) {
  const rows = [blockLine(accent, paint.text.dim('Decision'))];
  for (let i = 0; i < opts.length; i++) {
    rows.push(blockLine(accent, optionToken(opts[i], i === selected, accent)));
  }
  return rows;
}

function reasonRows(tool, args, why, cols, accent) {
  const reason = compactReason(tool, args, why);
  if (!reason) return [];
  const label = paint.text.dim('reason ');
  const firstWidth = Math.max(20, cols - 5 - visibleWidth(label));
  const restWidth = Math.max(20, cols - 5 - 7);
  const wrapped = wrapText(reason, firstWidth);
  const rows = [];
  wrapped.forEach((line, index) => {
    if (index === 0) {
      rows.push(blockLine(accent, `${label}${paint.text.primary(line)}`));
    } else {
      for (const rest of wrapText(line, restWidth)) {
        rows.push(blockLine(accent, `${paint.text.dim('       ')}${paint.text.primary(rest)}`));
      }
    }
  });
  return rows;
}

function compactReason(tool, args = {}, why = '') {
  const reason = String(why || '').replace(/\s+/g, ' ').trim();
  if (!reason || tool !== 'shell') return reason;

  const redundantShellPrefix = reason.match(/^Shell command requires approval:\s*(.+)$/i);
  if (!redundantShellPrefix) return reason;

  const command = String(args.command || args.cmd || '').replace(/\s+/g, ' ').trim();
  const repeated = redundantShellPrefix[1].replace(/\s+/g, ' ').trim();
  if (!command || repeated === command || command.startsWith(repeated) || repeated.startsWith(command)) {
    return 'Shell command requires approval.';
  }
  return reason;
}

function riskRows(tool, args = {}, tier, accent) {
  const terms = riskTerms(tool, args, tier);
  if (!terms.length) return [];
  return [blockLine(accent, `${paint.text.dim('risk   ')}${paint.state.warn(terms.join(', '))}`)];
}

function riskTerms(tool, args = {}, tier) {
  const terms = [];
  if (tool === 'shell') {
    const command = String(args.command || args.cmd || '');
    const patterns = [
      [/rm\s+-[^\n]*r[^\n]*f|rm\s+-[^\n]*f[^\n]*r/i, 'rm -rf'],
      [/\bsudo\b/i, 'sudo'],
      [/\bgit\s+push\b[^\n]*(?:--force|-f)\b/i, 'force push'],
      [/\bnpm\s+publish\b/i, 'publish'],
      [/\b(?:kill|pkill)\b/i, 'process kill'],
      [/\bchmod\s+777\b/i, 'chmod 777'],
      [/\bcurl\b|\bwget\b/i, 'network download'],
    ];
    for (const [re, label] of patterns) {
      if (re.test(command)) terms.push(label);
    }
  }
  if (tier === TIERS.SENSITIVE_READ) terms.push('sensitive read');
  if (tier === TIERS.PROTECTED_EDIT) terms.push('protected edit');
  if (tier === TIERS.DESTRUCTIVE) terms.push('destructive');
  return [...new Set(terms)].slice(0, 3);
}

function optionToken(option, selected, accent) {
  const cursor = selected ? accent(glyph('▸ ', '> ')) : paint.text.dim('  ');
  const keyTag = paint.text.dim('[') + (selected ? accent(option.key) : paint.text.muted(option.key)) + paint.text.dim('] ');
  const label = selected ? paint.bold(accent(option.label)) : paint.text.primary(option.label);
  const hint = option.hint ? `  ${paint.text.muted(option.hint)}` : '';
  return `${cursor}${keyTag}${label}${hint}`;
}

function subjectDetails(tool, args = {}, summary = '', available = 72) {
  if (tool === 'shell') {
    const command = args.command || args.cmd || summary || '';
    const profile = shellCommandProfile(command);
    if (profile.compact) {
      const lines = [`$ ${profile.summary}`];
      if (profile.cwdLabel) lines.push(`in ${profile.cwdLabel}`);
      return lines;
    }
    const display = shellCommandDisplay(command);
    const lines = wrapText(display.command, Math.max(20, available - 2))
      .map((line, index) => `${index === 0 ? '$' : '>'} ${line}`);
    if (display.cwdLabel) lines.push(`in ${display.cwdLabel}`);
    return lines.length ? lines : ['(empty command)'];
  }
  if (tool === 'write_file') {
    const file = args.file_path || args.path || summary || '';
    if (isSensitiveConfigPath(file)) return [`${file} · content redacted`];
    const lineCount = typeof args.content === 'string' ? args.content.split('\n').length : null;
    return [`${file}${lineCount ? ` · ${lineCount} lines` : ''}`];
  }
  if (tool === 'edit_file') {
    const file = args.file_path || args.path || '';
    if (isSensitiveConfigPath(file)) {
      const details = [`${file || summary}`];
      if (args.search || args.old_string) details.push('match: [redacted]');
      if (args.replace || args.new_string) details.push('replace: [redacted]');
      return details;
    }
    const search = String(args.search || args.old_string || '').trim();
    const replacement = String(args.replace || args.new_string || '').trim();
    const details = [`${file || summary}`];
    if (search) details.push(`match: ${truncate(search, available - 7)}`);
    if (replacement) details.push(`replace: ${truncate(replacement, available - 9)}`);
    return details.slice(0, 4);
  }
  if (tool === 'delete_file') {
    return [args.file_path || args.path || summary || ''];
  }
  if (tool === 'WebFetch' || tool === 'fetch_url') {
    const url = args.url || summary || '';
    return [`Target ${hostFromUrl(url) || url}`];
  }
  return wrapText(summary || JSON.stringify(args || {}), available).slice(0, 4);
}

function detailRows(tool, args = {}, cols, accent, showDetails) {
  if (!showDetails || tool !== 'shell') return [];
  const rows = [blockLine(accent, paint.text.dim('details / full command'))];
  // Include wrappers, heredoc terminators and trailing commands in fallback
  // terminals too. A script-body preview is not the full action.
  rows.push(...numberedRows(String(args.command || args.cmd || ''), cols, accent));
  const cwd = args.cwd || args.working_directory;
  if (cwd) rows.push(...wrappedLabeledRows('cwd    ', cwd, cols, accent));
  return rows;
}

function approvalFooter(tool, showDetails) {
  const details = tool === 'shell'
    ? ` · d ${showDetails ? 'hide details' : 'details'}`
    : '';
  return `↑↓ move · Enter pick · letter shortcut${details} · Esc cancel`;
}

function approvalSubjectSummary(tool, args = {}) {
  const summary = toolDisplaySummary(tool, args, {});
  if (tool !== 'shell') return summary;
  const display = shellCommandDisplay(args.command || args.cmd || summary || '');
  return display.cwdLabel ? `${display.command} in ${display.cwdLabel}` : display.command;
}

function hostFromUrl(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return '';
  }
}

function wrappedLabeledRows(label, text, cols, accent, maxLines = 120) {
  const rows = [];
  const labelText = paint.text.dim(label);
  const firstWidth = Math.max(28, cols - 5 - visibleWidth(labelText) - 1);
  const restWidth = Math.max(28, cols - 5 - visibleWidth(labelText) - 1);
  const sourceLines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let emitted = 0;
  for (const source of sourceLines) {
    const wrapped = wrapText(source || ' ', emitted === 0 ? firstWidth : restWidth);
    for (const line of wrapped) {
      if (emitted >= maxLines) {
        rows.push(blockLine(accent, `${paint.text.dim('       ')}${paint.text.dim('... detail truncated')}`));
        return rows;
      }
      rows.push(blockLine(accent, `${emitted === 0 ? labelText : paint.text.dim('       ')} ${paint.text.primary(line)}`));
      emitted++;
    }
  }
  return rows;
}

function numberedRows(text, cols, accent) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const numberWidth = String(lines.length).length;
  const textWidth = Math.max(1, cols - numberWidth - 5);
  return lines.flatMap((line, index) => wrapText(line, textWidth).map((part, continuation) =>
    blockLine(accent, paint.text.dim(continuation ? ' '.repeat(numberWidth + 1) : String(index + 1).padStart(numberWidth) + ' ') + paint.text.primary(part))
  ));
}

function wrapText(text, width) {
  return wrapToLines(String(text || ''), Math.max(1, width), { preserveTrailingWhitespace: true });
}
