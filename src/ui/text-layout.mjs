/**
 * Pure text layout helpers.
 *
 * Extracted so the input dock's line-wrapping and clipping logic can be
 * unit-tested without a live terminal. Everything here is a pure function
 * of its inputs.
 */

import { strip as stripAnsi, width as visibleWidth } from './palette.mjs';

/**
 * Wrap `text` into lines of at most `maxWidth` visible columns.
 *
 * - Preserves existing '\n' as hard breaks.
 * - Wraps long lines at whitespace when possible.
 * - Breaks mid-word only when a single word exceeds maxWidth.
 * - Empty input returns [''].
 * - ANSI escapes are preserved; wrap decisions use visible width.
 *
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string[]}
 */
export function wrapToLines(text, maxWidth) {
  const width = Math.max(1, Math.floor(maxWidth));
  const source = String(text ?? '');
  if (!source) return [''];

  const out = [];
  for (const rawLine of source.split('\n')) {
    if (rawLine === '') { out.push(''); continue; }
    if (visibleWidth(rawLine) <= width) { out.push(rawLine); continue; }

    // Long line — wrap at whitespace where possible.
    let current = '';
    const tokens = tokenizeForWrap(rawLine);
    for (const token of tokens) {
      const isSpace = /^\s+$/.test(stripAnsi(token));
      const candidate = current + token;
      if (visibleWidth(candidate) <= width) { current = candidate; continue; }
      if (current) { out.push(current.replace(/\s+$/, '')); current = ''; }
      if (isSpace) continue; // don't start a new line with pure whitespace
      // Token alone still too wide — chunk it.
      if (visibleWidth(token) > width) {
        for (const chunk of chunkByVisibleWidth(token, width)) out.push(chunk);
      } else {
        current = token;
      }
    }
    if (current) out.push(current.replace(/\s+$/, ''));
  }
  return out.length ? out : [''];
}

/**
 * Take the last `maxRows` of `lines`. If more lines were dropped, prefix
 * the first surviving line with a dim '…' marker so the truncation is
 * explicit (per PRD §5.1).
 *
 * Returns { visible, truncated: boolean, dropped: number }.
 */
export function tailWithEllipsis(lines, maxRows, ellipsis = '… ') {
  const rows = Math.max(1, Math.floor(maxRows));
  const arr = Array.isArray(lines) ? lines : [];
  if (arr.length <= rows) return { visible: arr.slice(), truncated: false, dropped: 0 };
  const dropped = arr.length - rows;
  const visible = arr.slice(dropped);
  visible[0] = `${ellipsis}${visible[0] || ''}`;
  return { visible, truncated: true, dropped };
}

/**
 * Given the wrapped visible lines and a cursor position (as a linear
 * character offset into the *joined* wrapped output), return the
 * { row, col } inside the visible block (0-indexed).
 *
 * Used to place the terminal cursor after rendering the input buffer.
 */
export function cursorPositionInLines(visibleLines, offset) {
  const arr = Array.isArray(visibleLines) ? visibleLines : [];
  let remaining = Math.max(0, Math.floor(offset));
  for (let row = 0; row < arr.length; row++) {
    const line = arr[row] || '';
    const w = visibleWidth(line);
    if (remaining <= w) return { row, col: remaining };
    remaining -= w;
    // Newline between wrapped lines doesn't count as a visible column,
    // but consumes zero of the remaining offset either.
  }
  const lastRow = Math.max(0, arr.length - 1);
  return { row: lastRow, col: visibleWidth(arr[lastRow] || '') };
}

// ── internals ────────────────────────────────────────────────────────────

// Tokenize into runs of non-whitespace and whitespace so wrapWords can
// decide break points without merging spaces into words. ANSI escapes stay
// attached to the visible token they precede.
function tokenizeForWrap(line) {
  const tokens = [];
  const re = /(\s+|\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) tokens.push(m[0]);
  return tokens;
}

// Split a single overly-long token into chunks of at most `maxWidth`
// visible cells, preserving ANSI escape sequences (they don't count).
function chunkByVisibleWidth(token, maxWidth) {
  const chunks = [];
  let buf = '';
  let bufWidth = 0;
  const chars = Array.from(String(token));
  for (const ch of chars) {
    // Naive: treat each codepoint as 1 cell. Good enough for path-like
    // tokens; wide-char inputs would need a fuller width table.
    if (bufWidth + 1 > maxWidth) {
      chunks.push(buf);
      buf = '';
      bufWidth = 0;
    }
    buf += ch;
    bufWidth += 1;
  }
  if (buf) chunks.push(buf);
  return chunks;
}
