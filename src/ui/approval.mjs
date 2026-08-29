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
 * The rule colour is `brand.accent` (magenta) for explicit-approval
 * tiers; safe-default prompts use `brand.data` so they read as advisory.
 *
 * Pure — caller writes the returned string to stderr.
 */

import { paint, width as visibleWidth } from './palette.mjs';
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
  const cols = Math.max(60, Math.min(width || process.stderr.columns || 96, 120));
  const explicit = requiresExplicitApproval(tier);
  const accent = explicit ? paint.brand.accent : paint.brand.data;
  const opts = options || defaultOptions(tier, { tool, args });
  const title = `⚠ ${approvalTitle(tier)} · ${tierLabel(tier)} · ${tool || 'tool'}`;

  const lines = [
    blockHeader(title, accent),
    ...subjectRows(tool, args, cols, accent),
    ...detailRows(tool, args, cols, accent, showDetails),
    ...riskRows(tool, args, tier, accent),
    ...reasonRows(tool, args, why, cols, accent),
    blockLine(accent),
    ...decisionRows(opts, selected, accent),
    blockLine(accent, paint.text.dim(approvalFooter(tool, showDetails))),
  ];

  return '\n' + lines.join('\n');
}

export function renderApprovalDockPrompt({
  tool, args = {}, tier, why = '', width,
  options, selected = 0, showDetails = false,
} = {}) {
  const cols = Math.max(60, Math.min(width || process.stderr.columns || 96, 120));
  const opts = options || defaultOptions(tier, { tool, args });
  // Multi-line shell/python scripts auto-expand: the user cannot approve
  // what they cannot see. "shell script · 5 lines · 309 B" as the only
  // subject made blind approval the default. After execution the script
  // collapses back to the one-line tool card (details stay on /last).
  const isScriptCommand = tool === 'shell'
    && /\n/.test(String(args.command || args.cmd || ''));
  const detailView = showDetails || isScriptCommand;
  const subject = approvalDockSubject(tool, args, cols, detailView);
  const risks = riskTerms(tool, args, tier);
  const reason = compactReason(tool, args, why);
  const lines = [
    ...approvalDockSubjectRows(subject),
    ...(risks.length ? [`${paint.text.dim('risk   ')}${paint.state.warn(risks.join(', '))}`] : []),
    ...(reason ? [`${paint.text.dim('reason ')}${paint.text.primary(truncate(reason, 120))}`] : []),
    paint.text.dim('Decision'),
    ...opts.map((option, index) => optionToken(option, index === selected, explicitAccent(tier))),
  ];

  // Show the WHOLE script when it fits — a partial script (…lines cut at
  // the top) makes blind approval the default. Cap at half the terminal
  // so the dock never eats the whole screen. Non-detail approvals keep
  // the tight 8-row cap.
  const termRows = Math.max(12, Number(process.stderr.rows) || 24);
  const detailCap = Math.max(12, Math.floor(termRows / 2));
  const maxRows = detailView ? Math.min(detailCap, Math.max(12, lines.length + 1)) : 8;

  return {
    prefix: '? approve › ',
    value: truncateForDock(subject, detailView ? 1200 : 220),
    context: `${approvalTitle(tier)} · ${tierLabel(tier)} · ${tool || 'tool'}`,
    meta: '',
    tips: approvalFooter(tool, detailView),
    lines,
    maxRows,
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

function blockHeader(title, accent) {
  return `  ${paint.bold(accent(title))}`;
}

function blockLine(accent, text = '') {
  return text ? `  ${text}` : '  ';
}

function explicitAccent(tier) {
  return requiresExplicitApproval(tier) ? paint.brand.accent : paint.brand.data;
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
  const cursor = selected ? accent('▸ ') : paint.text.dim('  ');
  const keyTag = paint.text.dim('[') + (selected ? accent(option.key) : paint.brand.data(option.key)) + paint.text.dim('] ');
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
  const profile = shellCommandProfile(args.command || args.cmd || '');
  const rows = [];
  const labelWidth = 9;
  const textWidth = Math.max(28, cols - 5 - labelWidth);

  if (profile.cwdLabel) {
    rows.push(blockLine(accent, `${paint.text.dim('cwd    ')} ${paint.brand.data(profile.cwdLabel)}`));
  }

  rows.push(blockLine(accent, paint.text.dim('details')));
  if (profile.script?.body) {
    const invocation = profile.script.invocation || profile.command.split('\n')[0] || profile.command;
    for (const line of wrapText(invocation, textWidth)) {
      rows.push(blockLine(accent, `${paint.text.dim('cmd    ')} ${paint.text.primary(line)}`));
    }
    rows.push(blockLine(accent, paint.text.dim('script ')));
    rows.push(...numberedRows(profile.script.body, cols, accent, 120));
  } else {
    rows.push(...wrappedLabeledRows('cmd    ', profile.command, cols, accent, 120));
  }

  return rows;
}

function approvalFooter(tool, showDetails) {
  const details = tool === 'shell'
    ? ` · d ${showDetails ? 'hide details' : 'details'}`
    : '';
  return `↑↓ move · Enter pick · letter shortcut${details} · Esc cancel`;
}

function approvalDockDetails(tool, args = {}, cols = 96) {
  if (tool !== 'shell') return subjectDetails(tool, args, toolDisplaySummary(tool, args, {}), cols).join(' · ');
  const profile = shellCommandProfile(args.command || args.cmd || '');
  if (profile.script?.body) {
    const invocation = profile.script.invocation || profile.command.split('\n')[0] || profile.command;
    return [
      `$ ${invocation}`,
      ...profile.script.body.split(/\r?\n/).slice(0, 12).map((line, index) => `${index + 1} ${line}`),
      ...(profile.script.body.split(/\r?\n/).length > 12 ? ['...'] : []),
    ].join('\n');
  }
  return profile.command;
}

function approvalDockSubject(tool, args = {}, cols = 96, showDetails = false) {
  if (showDetails && tool === 'shell') return approvalDockDetails(tool, args, cols);
  return subjectDetails(
    tool,
    args,
    toolDisplaySummary(tool, args, {}),
    Math.max(24, cols - 20),
  ).join(' · ');
}

function approvalDockSubjectRows(subject) {
  const lines = String(subject || '').split('\n');
  const first = lines.shift() || '';
  // 12 continuation rows matches approvalDockDetails' script cap — a
  // 12-line script renders fully in the approval prompt.
  return [
    `${paint.text.dim('? approve ›')} ${paint.text.primary(truncate(first, 160))}`,
    ...lines.slice(0, 12).map(line => `${paint.text.dim('           ')}${paint.text.primary(truncate(line, 160))}`),
  ];
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

function numberedRows(text, cols, accent, maxLines = 120) {
  const rows = [];
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const width = String(Math.min(lines.length, maxLines)).length;
  const textWidth = Math.max(28, cols - 5 - width - 2);
  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    const n = String(i + 1).padStart(width);
    rows.push(blockLine(accent, `${paint.text.dim(`${n} `)}${paint.text.primary(truncate(lines[i], textWidth))}`));
  }
  if (lines.length > maxLines) {
    rows.push(blockLine(accent, `${paint.text.dim(`... ${lines.length - maxLines} more line(s)`)}`));
  }
  return rows;
}

function truncateForDock(text, maxChars) {
  const value = String(text || '').trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function wrapText(text, width) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) {
      line = word;
      continue;
    }
    if ((line + ' ' + word).length <= width) {
      line += ' ' + word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
