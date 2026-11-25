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

// ── Record grammar ───────────────────────────────────────────────────────
// Every non-prose transcript line uses one shape:
//
//   Reading src/ui/palette.mjs          ← head: two spaces, colored verb
//   ⎿ 47 lines                          ← note: aligned gutter, outcome
//
// Before this, agent text, tool calls and shell cards each picked their own
// indent, marker and separator glyph, so a long transcript read as three
// different apps stacked on top of each other.

function recordColor(tone) {
  if (tone === 'danger') return paint.state.danger;
  if (tone === 'warn') return paint.state.warn;
  if (tone === 'success') return paint.state.success;
  if (tone === 'muted') return paint.text.muted;
  return paint.brand.primary;
}

/** Head of a record: `{indent}{verb} {detail}`, wrapping under the verb. */
export function recordHead(role, detail = '', { columns = term().columns, tone = 'brand', indent = '  ', marker = '' } = {}) {
  const lead = marker + paint.bold(recordColor(tone)(role));
  const suffix = detail ? ' ' + paint.text.primary(detail) : '';
  const budget = Math.max(1, columns - indent.length - marker.length);
  return wrapToLines(lead + suffix, budget)
    .map((line, i) => (i === 0 ? indent : ' '.repeat(indent.length + marker.length)) + line)
    .join('\n');
}

/** Continuation of a record: outcome/detail aligned under the role name. */
export function recordNote(text, { columns = term().columns, indent = '  ', tone = 'muted' } = {}) {
  if (!text) return '';
  const gutter = indent + glyph('⎿ ', '> ');
  const budget = Math.max(1, columns - gutter.length);
  return wrapToLines(recordColor(tone)(text), budget)
    .map((line, i) => (i === 0 ? gutter : ' '.repeat(gutter.length)) + line)
    .join('\n');
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
    ? ['Enter send', '$ skills', 'Esc cancel', 'Ctrl+P pause', 'F2 details']
    : ['Enter send', '/ commands', '$ skills', 'Tab complete', '@clipboard image', 'F2 details'];
  const separator = glyph(' · ', ' / ');
  let result = '';
  for (const hint of hints) {
    const next = result ? result + separator + hint : hint;
    if (width(next) > Math.max(1, columns - 5)) break;
    result = next;
  }
  return result;
}
