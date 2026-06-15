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
      { key: 'y', label: 'approve',  value: 'approve',  hint: 'run this once' },
      { key: 'e', label: 'edit',     value: 'edit',     hint: 'tweak the args before running' },
      { key: 'r', label: 're-plan',  value: 'replan',   hint: 'send back to the agent' },
      { key: 'n', label: 'reject',   value: 'reject',   hint: 'do not run' },
      { key: '?', label: 'why',      value: 'why',      hint: 'show reasoning' },
    ];
  }
  return [
    { key: 'y', label: 'approve',         value: 'approve',     hint: 'run this once' },
    { key: 't', label: 'always allow',    value: 'allow-type',  hint: 'auto-approve future calls to this tool' },
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

  const summary = toolDisplaySummary(tool, args, {});
  const toolLine = `${icon(tool)} ${paint.text.primary(toolDisplayLabel(tool))} ${paint.text.muted(summary ? `"${truncate(summary, cols - 20)}"` : '')}`;

  const lines = [
    bar(cols, accent),
    fill(' AWAITING APPROVAL', cols, accent, paint.bold(accent('AWAITING APPROVAL'))),
    fill('', cols, accent),
    fill(' ' + ' '.repeat(PAD_X - 1) + toolLine, cols, accent),
    fill('', cols, accent),
    fill(' ' + ' '.repeat(PAD_X - 1) + paint.text.dim('Tier: ') + accent(tierLabel(tier)), cols, accent),
  ];
  if (why) {
    lines.push(fill(' ' + ' '.repeat(PAD_X - 1) + paint.text.dim('Why:  ') + paint.text.primary(truncate(why, cols - PAD_X - 12)), cols, accent));
  }
  lines.push(fill('', cols, accent));

  for (let i = 0; i < opts.length; i++) {
    const o = opts[i];
    const isSel = i === selected;
    const cursor = isSel ? accent('▸ ') : paint.text.dim('  ');
    const keyTag = paint.text.dim('[') + (isSel ? accent(o.key) : paint.brand.data(o.key)) + paint.text.dim('] ');
    const label = isSel ? paint.bold(accent(o.label)) : paint.text.primary(o.label);
    const hint = o.hint ? '   ' + paint.text.muted(o.hint) : '';
    lines.push(fill(' ' + ' '.repeat(PAD_X - 1) + cursor + keyTag + label + hint, cols, accent));
  }

  lines.push(fill('', cols, accent));
  lines.push(fill(' ' + ' '.repeat(PAD_X - 1) +
    paint.text.dim('↑↓ ') + paint.brand.data('move') +
    paint.text.dim('  ·  Enter ') + paint.brand.data('pick') +
    paint.text.dim('  ·  or press a letter'), cols, accent));
  lines.push(bar(cols, accent));

  return '\n' + lines.join('\n');
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
  const lines = [];
  const head = `${paint.brand.data('?')} ${paint.text.primary(label)} ${paint.text.muted(summary ? `"${truncate(summary, 80)}"` : '')}`;
  lines.push('  ' + head);
  lines.push('  ' + paint.text.dim('Tier ') + paint.brand.data(tierLabel(tier)) +
             (why ? '   ' + paint.text.dim('Why ') + paint.text.muted(truncate(why, 60)) : ''));
  lines.push('  ' + paint.text.dim('[') + paint.brand.data('Enter') + paint.text.dim('=yes  ') +
             paint.brand.data('n') + paint.text.dim('=no  ') +
             paint.brand.data('?') + paint.text.dim('=why]'));
  return '\n' + lines.join('\n');
}

export { TIERS };
