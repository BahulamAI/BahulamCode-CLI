/**
 * Shared terminal chrome: a quiet rule, a small label, and readable content.
 * No background fills or cursor control; safe in transcripts and fixed docks.
 */
import { paint, strip, width } from './palette.mjs';
import { term } from './term.mjs';
import { wrapToLines } from './text-layout.mjs';

export const glyph = (unicode, ascii) => term().unicode ? unicode : ascii;

// Transitional raw-code access for event/approval writers that interpolate
// styles. Resolve on every access so NO_COLOR and theme changes are honored.
export const sgr = {
  get reset() { return paint.token('text.primary').close; },
  get bold() { return term().color ? '\x1b[1m' : ''; },
  get muted() { return paint.token('text.muted').open; },
  get primary() { return paint.token('brand.primary').open; },
  get success() { return paint.token('state.success').open; },
  get danger() { return paint.token('state.danger').open; },
  get warn() { return paint.token('state.warn').open; },
};

export function clipLabel(value, columns) {
  const text = strip(value).replace(/\s+/g, ' ').trim();
  const budget = Math.max(0, columns);
  if (width(text) <= budget) return text;
  if (budget < 2) return '';
  return [...text].slice(0, budget - 1).join('') + glyph('…', '~');
}

export function sectionHeading(label, { detail = '', columns = term().columns, tone = 'brand' } = {}) {
  const budget = Math.max(1, columns - 3);
  const color = tone === 'danger' ? paint.state.danger : tone === 'warn' ? paint.state.warn : paint.brand.primary;
  const title = paint.bold(color(label));
  const suffix = detail ? paint.text.muted(glyph(' · ', ' / ') + detail) : '';
  return wrapToLines(title + suffix, budget).map(line => '  ' + line).join('\n');
}

export function dockHeading(label, context, columns, { approval = false } = {}) {
  const budget = Math.max(1, columns);
  const title = clipLabel(label, Math.max(1, budget - 4));
  const left = paint.text.dim(glyph('─ ', '- ')) + paint.bold((approval ? paint.state.warn : paint.brand.primary)(title));
  const available = Math.max(0, budget - width(left) - 4);
  const right = clipLabel(context, available);
  const middle = glyph('─', '-').repeat(Math.max(0, budget - width(left) - (right ? width(right) + 2 : 1)));
  return left + ' ' + paint.text.dim(middle) + (right ? ' ' + paint.text.muted(right) : '');
}

export function inputHints({ running = false, columns = term().columns } = {}) {
  const hints = running
    ? ['Enter send', 'Esc cancel', 'Ctrl+P pause', 'F2 details']
    : ['Enter send', '/ commands', 'Tab complete', '@clipboard image', 'F2 details'];
  const separator = glyph(' · ', ' / ');
  let result = '';
  for (const hint of hints) {
    const next = result ? result + separator + hint : hint;
    if (width(next) > Math.max(1, columns - 5)) break;
    result = next;
  }
  return result;
}
