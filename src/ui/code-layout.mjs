/**
 * Cell-aware, style-safe layout for code and command cards.
 * Styling is applied after wrapping; SGR bytes never enter width accounting.
 */
import { cellWidth } from './render-queue.mjs';
import { term } from './term.mjs';

export function safeCodeText(value) {
  return String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,
    ch => '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0'));
}

export function wrapRuns(runs, { columns = term().columns, indent = '', first = '', rest = first, wordWrap = true } = {}) {
  const limit = Math.max(8, Number(columns) || 80) - 1;
  const lines = [];
  let prefix = indent + first;
  let used = cellWidth(prefix);
  let parts = [];
  const flush = () => {
    lines.push(prefix + parts.map(part => part.paint ? part.paint(part.text) : part.text).join(''));
    prefix = indent + rest;
    used = cellWidth(prefix);
    parts = [];
  };
  const append = (text, painter) => {
    if (parts.length && parts.at(-1).paint === painter) parts.at(-1).text += text;
    else parts.push({ text, paint: painter });
  };
  for (const run of runs) {
    const tokens = safeCodeText(run.text).match(/[^\S\n]+|\n|[^\s]+/gu) || [];
    for (const token of tokens) {
      if (token === '\n') { flush(); continue; }
      const tokenWidth = cellWidth(token);
      if (wordWrap && !/^\s+$/.test(token) && tokenWidth <= limit - cellWidth(prefix) && used + tokenWidth > limit && parts.length) flush();
      for (const ch of token) {
        // Expand tabs from the actual terminal column, not from zero.
        const value = ch === '\t' ? ' '.repeat(8 - used % 8) : ch;
        for (const unit of value) {
          const size = cellWidth(unit);
          if (used + size > limit && parts.length) flush();
          append(unit, run.paint);
          used += size;
        }
      }
    }
  }
  if (parts.length || !lines.length) flush();
  return lines;
}

export function wrapCode(text, painter, options = {}) {
  return wrapRuns([{ text, paint: painter }], options).join('\n');
}
