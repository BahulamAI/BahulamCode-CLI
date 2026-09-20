import { paint } from './palette.mjs';
import { glyph } from './chrome.mjs';

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
