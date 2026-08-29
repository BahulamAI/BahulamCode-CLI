import { paint } from './palette.mjs';

function tonePaint(tone) {
  // 'user' tone was brand.accent (pink) — swapped to state.success (green)
  // so the "your input" prompt reads as an active/go signal instead of the
  // magenta 'attention/warn' tint the accent palette carries elsewhere.
  return tone === 'user' ? paint.state.success : paint.brand.primary;
}

export function transcriptHeader(label, { tone = 'assistant' } = {}) {
  const p = tonePaint(tone);
  return `${paint.bold(p(label))} ${p('›')}`;
}

export function transcriptLine(line = '', { tone = 'assistant' } = {}) {
  return `  ${line}`;
}

export function transcriptLines(text, opts = {}) {
  return String(text ?? '')
    .split('\n')
    .map(line => transcriptLine(line, opts));
}
