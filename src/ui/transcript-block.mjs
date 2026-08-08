import { paint } from './palette.mjs';

function tonePaint(tone) {
  return tone === 'user' ? paint.brand.accent : paint.brand.primary;
}

export function transcriptHeader(label, { tone = 'assistant' } = {}) {
  const p = tonePaint(tone);
  return `  ${p('╭─')} ${paint.bold(p(label))}`;
}

export function transcriptLine(line = '', { tone = 'assistant' } = {}) {
  const p = tonePaint(tone);
  return `  ${p('│')} ${line}`;
}

export function transcriptLines(text, opts = {}) {
  return String(text ?? '')
    .split('\n')
    .map(line => transcriptLine(line, opts));
}
