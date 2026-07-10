/**
 * Approval prompt UI — Mission Control (PRD-055 §8.2).
 *
 *   ┃ AWAITING APPROVAL                                                ┃
 *   ┃                                                                  ┃
 *   ┃   ⚙️  shell "rm -rf node_modules"                                ┃
 *   ┃                                                                  ┃
 *   ┃   Tier:    SHELL-DANGEROUS                                       ┃
 *   ┃   Why:     Recursive delete in project directory                 ┃
 *   ┃                                                                  ┃
 *   ┃   [Enter] approve   [e] edit   [r] re-plan   [n] reject   [?] why
 *
 * The border colour is `brand.accent` (magenta) for explicit-approval
 * tiers; safe-default prompts use `brand.data` so they read as advisory.
 *
 * Pure — caller writes the returned string to stderr.
 */

import { paint, width as visibleWidth } from './palette.mjs';
import { icon } from './icons.mjs';
import { toolDisplayLabel, toolDisplaySummary } from '../terminal/tool-display.mjs';
import { label as tierLabel, requiresExplicitApproval, TIERS } from '../core/risk-tier.mjs';

const VBAR = '┃';
const PAD_X = 3;

/**
 * Default option set per tier. Caller can override via `opts.options`.
 *
 * Each option is `{ key, label, value, hint? }`:
 *   key   — single-letter shortcut (case-insensitive)
 *   label — text shown in the menu
 *   value — return value from the menu loop
 *   hint  — secondary description shown to the right of the label
 */
export function defaultOptions(tier) {
  if (requiresExplicitApproval(tier)) {
    return [
      { key: 'y', label: 'approve once',  value: 'approve',  hint: 'run this call' },
      { key: 'e', label: 'edit args',     value: 'edit',     hint: 'send back with changes' },
      { key: 'r', label: 're-plan with note...',  value: 'replan',   hint: 'steer the agent' },
      { key: 'n', label: 'reject with reason...', value: 'reject',   hint: 'do not run' },
      { key: '?', label: 'why',      value: 'why',      hint: 'show reasoning' },
    ];
  }
  return [
    { key: 'y', label: 'approve',         value: 'approve',     hint: 'run this once' },
    { key: 't', label: 'always allow',    value: 'allow-type',  hint: 'auto-approve future calls to this tool' },
    { key: 'r', label: 're-plan with note...', value: 'replan', hint: 'steer the agent' },
    { key: 'n', label: 'reject',          value: 'reject',      hint: 'do not run' },
    { key: '?', label: 'why',             value: 'why',         hint: 'show reasoning' },
  ];
}

/**
 * Render the bordered prompt with vertical, arrow-navigable options.
 *
 *   ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
 *   ┃ AWAITING APPROVAL          ┃
 *   ┃                            ┃
 *   ┃   ⚙️  shell "rm -rf …"     ┃
 *   ┃                            ┃
 *   ┃   Tier: SHELL-DANGEROUS    ┃
 *   ┃   Why:  Recursive delete…  ┃
 *   ┃                            ┃
 *   ┃   ▸ [y] approve            ┃   ← selected (accent)
 *   ┃     [e] edit               ┃
 *   ┃     [r] re-plan            ┃
 *   ┃     [n] reject             ┃
 *   ┃     [?] why                ┃
 *   ┃                            ┃
 *   ┃   ↑↓ move · Enter pick     ┃
 *   ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
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
  options, selected = 0,
} = {}) {
  const cols = Math.max(60, Math.min(width || process.stderr.columns || 96, 120));
  const explicit = requiresExplicitApproval(tier);
  const accent = explicit ? paint.brand.accent : paint.brand.data;
  const opts = options || defaultOptions(tier);
  const available = cols - 2 - PAD_X * 2;
  const title = `${riskIcon(tier)}  ${tierTitle(tier)} · ${tierLabel(tier)} · ${tool || 'tool'}`;

  const lines = [
    bar(cols, accent),
    fill(' ' + ' '.repeat(PAD_X - 1) + paint.bold(accent(title)), cols, accent),
    fill('', cols, accent),
    ...subjectRows(tool, args, cols, accent),
    fill('', cols, accent),
  ];
  if (why) {
    const whyLines = wrapText(why, Math.max(20, available - 6));
    lines.push(fill(' ' + ' '.repeat(PAD_X - 1) + paint.text.dim('Why  ') + paint.text.primary(whyLines[0]), cols, accent));
    for (const line of whyLines.slice(1, 4)) {
      lines.push(fill(' ' + ' '.repeat(PAD_X - 1) + paint.text.dim('     ') + paint.text.primary(line), cols, accent));
    }
    if (whyLines.length > 4) {
      lines.push(fill(' ' + ' '.repeat(PAD_X - 1) + paint.text.dim('     ...'), cols, accent));
    }
  } else {
    lines.push(fill(' ' + ' '.repeat(PAD_X - 1) + paint.text.dim('Why  ') + paint.text.muted('No additional reason provided'), cols, accent));
  }
  lines.push(fill('', cols, accent));
  lines.push(fill(' ' + ' '.repeat(PAD_X - 1) + paint.text.dim('Scope of this decision:'), cols, accent));

  for (let i = 0; i < opts.length; i++) {
    const o = opts[i];
    const isSel = i === selected;
    const cursor = isSel ? accent('▸ ') : paint.text.dim('  ');
    const keyTag = paint.text.dim('[') + (isSel ? accent(o.key) : paint.brand.data(o.key)) + paint.text.dim('] ');
    const label = isSel ? paint.bold(accent(o.label)) : paint.text.primary(o.label);
    const hint = o.hint ? '  ' + paint.text.muted(o.hint) : '';
    lines.push(fill(' ' + ' '.repeat(PAD_X - 1) + cursor + keyTag + label + hint, cols, accent));
  }

  lines.push(fill('', cols, accent));
  lines.push(fill(' ' + ' '.repeat(PAD_X - 1) +
    paint.text.dim('↑↓ ') + paint.brand.data('move') +
    paint.text.dim('  ·  Enter ') + paint.brand.data('pick') +
    paint.text.dim('  ·  letter shortcut  ·  Esc reject'), cols, accent));
  lines.push(bar(cols, accent));

  return '\n' + lines.join('\n');
}

export function renderTrustedApproval({ tool, args = {}, scope = 'session', ruleId = '', delaySeconds = 0 } = {}) {
  const summary = toolDisplaySummary(tool, args, {});
  const subject = `${tool || 'tool'}${summary ? ` "${truncate(summary, 80)}"` : ''}`;
  const rule = ruleId ? ` · rule ${ruleId}` : '';
  const delay = delaySeconds > 0 ? ` · auto-approved after ${delaySeconds}s` : '';
  return `  ${paint.state.success('✓')} ${paint.text.primary(subject)} ${paint.text.dim(`· pre-approved (${String(scope || 'session').toLowerCase()}${rule})${delay}`)}\n`;
}

function bar(width, painter) {
  // Top / bottom rule: a magenta vertical-stack line spanning the full width.
  return painter('▔'.repeat(width));
}

function fill(text, width, painter, override) {
  const visible = override ?? text;
  const pad = Math.max(0, width - 2 - visibleWidth(visible));
  return painter(VBAR) + visible + ' '.repeat(pad) + painter(VBAR);
}

function truncate(text, n) {
  const s = String(text || '');
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

// ── Inline (safe-default) prompt for shell-medium / network ────────────

/**
 * Render the compact one-line prompt used for safe-default tiers.
 * The bordered block is reserved for explicit-approval tiers.
 *
 *   ? Run `npm install lodash`?  Tier: SHELL-MEDIUM   [Enter=yes  n=no  ?=why]
 */
export function renderInlinePrompt({ tool, args = {}, tier, why = '' } = {}) {
  const summary = toolDisplaySummary(tool, args, {});
  const label = toolDisplayLabel(tool);
  const rail = paint.text.dim('│');
  const lines = [];
  const head = `${riskIcon(tier)}  ${paint.text.primary(label)} ${paint.text.muted(summary ? `"${truncate(summary, 80)}"` : '')}`;
  lines.push('  ' + head);
  lines.push(`  ${rail}  ${paint.text.dim('Tier')} ${paint.brand.data(tierTitle(tier))} ${paint.text.dim('·')} ${paint.brand.data(tierLabel(tier))}` +
             (why ? ' · ' + paint.text.muted(truncate(why, 80)) : ''));
  lines.push(`  ${rail}  ` + paint.text.dim('[') + paint.brand.data('Enter') + paint.text.dim('=approve  ') +
             paint.brand.data('n') + paint.text.dim('=no  ') +
             paint.brand.data('r') + paint.text.dim('=note  ') +
             paint.brand.data('?') + paint.text.dim('=why]'));
  return '\n' + lines.join('\n');
}

export { TIERS };

function riskIcon(tier) {
  switch (tier) {
    case TIERS.SHELL_DANGEROUS:
    case TIERS.DESTRUCTIVE:
      return '🔴';
    case TIERS.SHELL_MEDIUM:
      return '⚠';
    case TIERS.NETWORK:
      return '🌐';
    case TIERS.LOCAL_EDIT:
      return '✎';
    default:
      return '◈';
  }
}

function tierTitle(tier) {
  switch (tier) {
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

function subjectRows(tool, args, cols, accent) {
  const available = cols - 2 - PAD_X * 2;
  const prefix = ' ' + ' '.repeat(PAD_X - 1);
  const rows = [];
  const summary = toolDisplaySummary(tool, args, {});
  const label = `${icon(tool)} ${paint.text.primary(toolDisplayLabel(tool))}`;
  rows.push(fill(prefix + label, cols, accent));

  for (const line of subjectDetails(tool, args, summary, available)) {
    rows.push(fill(prefix + paint.text.primary(line), cols, accent));
  }
  return rows;
}

function subjectDetails(tool, args = {}, summary = '', available = 72) {
  if (tool === 'shell') {
    const command = args.command || args.cmd || summary || '';
    const lines = wrapText(command, available);
    return lines.length ? lines.slice(0, 4) : ['(empty command)'];
  }
  if (tool === 'write_file') {
    const file = args.file_path || args.path || summary || '';
    const lineCount = typeof args.content === 'string' ? args.content.split('\n').length : null;
    return [`${file}${lineCount ? ` · ${lineCount} lines` : ''}`];
  }
  if (tool === 'edit_file') {
    const file = args.file_path || args.path || '';
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

function hostFromUrl(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return '';
  }
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
