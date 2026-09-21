import { paint } from './palette.mjs';
import { glyph } from './chrome.mjs';
import { term } from './term.mjs';

export function blockSeparatorMode() {
  return String(process.env.BAHULAM_BLOCK_SEPARATOR || 'subtle').toLowerCase();
}

/** Separate speakers/activity groups, never individual streaming chunks. */
export function transcriptBoundary(previous, next, {
  compactSame = false, columns = term().columns, mode = blockSeparatorMode(),
} = {}) {
  if (!previous || (compactSame && previous === next)) return '';
  if (mode === 'off' || mode === 'none') return '';
  const width = Math.min(44, Math.max(1, (Number(columns) || 80) - 3));
  if (mode === 'dotted' || mode === 'dots') {
    return '  ' + paint.text.dim(glyph('·', '.').repeat(width)) + '\n';
  }
  if (mode === 'space') return '\n';
  const group = block => ['user', 'content'].includes(block) ? block : 'activity';
  if (group(previous) === group(next)) return '\n';
  return '\n  ' + paint.text.dim(glyph('─', '-').repeat(width)) + '\n';
}

function tonePaint(tone) {
  // Green is reserved for successful outcomes, not ordinary user input.
  return tone === 'user' ? paint.text.primary : paint.brand.primary;
}

export function transcriptHeader(label, { tone = 'assistant' } = {}) {
  const p = tonePaint(tone);
  return `${paint.bold(p(label))} ${p(glyph('›', '>'))}`;
}

export function transcriptLine(line = '', { tone = 'assistant' } = {}) {
  return `  ${line}`;
}

export function transcriptLines(text, opts = {}) {
  return String(text ?? '')
    .split('\n')
    .map(line => transcriptLine(line, opts));
}
