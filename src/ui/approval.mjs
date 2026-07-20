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
import { shellCommandDisplay, toolDisplayLabel, toolDisplaySummary } from '../terminal/tool-display.mjs';
import { label as tierLabel, requiresExplicitApproval, TIERS } from '../core/risk-tier.mjs';

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
  const approve = { key: 'y', label: 'approve once',  value: 'approve',  hint: 'run this call' };
  const cancel = { key: 'n', label: 'cancel', value: 'reject', hint: 'do not run' };
  if (requiresExplicitApproval(tier)) {
    return [approve, cancel];
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
  tool, args = {}, tier, why: _why = '', width,
  options, selected = 0,
} = {}) {
  const cols = Math.max(60, Math.min(width || process.stderr.columns || 96, 120));
  const explicit = requiresExplicitApproval(tier);
  const accent = explicit ? paint.brand.accent : paint.brand.data;
  const opts = options || defaultOptions(tier);
  const title = `${riskIcon(tier)}  ${approvalTitle(tier)} · ${tierLabel(tier)} · ${tool || 'tool'}`;

  const lines = [
    horizontalRule(title, cols, accent),
    ...subjectRows(tool, args, cols, accent),
    ...decisionRows(opts, selected, accent),
    `  ${paint.text.dim('↑↓ move · Enter pick · letter shortcut · Esc cancel')}`,
    horizontalRule('', cols, accent),
  ];

  return '\n' + lines.join('\n');
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

function riskIcon(tier) {
  switch (tier) {
    case TIERS.SENSITIVE_READ:
      return '🔐';
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
    case TIERS.SENSITIVE_READ: return 'SENSITIVE';
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
    case TIERS.SHELL_DANGEROUS:
    case TIERS.DESTRUCTIVE:
      return tierTitle(tier);
    default:
      return 'APPROVAL';
  }
}

function horizontalRule(title, cols, accent) {
  if (!title) return `  ${accent('─'.repeat(Math.max(24, cols - 2)))}`;
  const label = ` ${paint.bold(accent(title))} `;
  const remaining = Math.max(8, cols - 2 - visibleWidth(label) - 2);
  return `  ${accent('─')} ${label}${accent('─'.repeat(remaining))}`;
}

function subjectRows(tool, args, cols, accent) {
  const rows = [];
  const available = Math.max(24, cols - 4);
  const summary = toolDisplaySummary(tool, args, {});
  const label = `${icon(tool)} ${paint.text.primary(toolDisplayLabel(tool))}`;
  const details = subjectDetails(tool, args, summary, Math.max(24, available - visibleWidth(label) - 1));

  if (details.length === 1 && visibleWidth(`${label} ${details[0]}`) <= available) {
    rows.push(`  ${label} ${paint.text.primary(details[0])}`);
    return rows;
  }

  rows.push(`  ${label}`);
  for (const line of subjectDetails(tool, args, summary, Math.max(24, available - 2))) {
    rows.push(`    ${paint.text.primary(line)}`);
  }
  return rows;
}

function decisionRows(opts, selected, accent) {
  const rows = [`  ${paint.text.dim('Decision')}`];
  for (let i = 0; i < opts.length; i++) {
    rows.push(`  ${optionToken(opts[i], i === selected, accent)}`);
  }
  return rows;
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
    const display = shellCommandDisplay(args.command || args.cmd || summary || '');
    const lines = wrapText(display.command, available);
    if (display.cwdLabel) lines.push(`in ${display.cwdLabel}`);
    return lines.length ? lines : ['(empty command)'];
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
