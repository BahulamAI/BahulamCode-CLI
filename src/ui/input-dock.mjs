/**
 * Fixed input dock.
 *
 * Reserves rows at the bottom of the terminal so agent/tool output scrolls
 * above the prompt. The dock has a fixed max height (top rule + N input
 * rows + bottom rule + tips + safety row); when the input buffer wraps
 * beyond N visible rows, only the last N render with a leading '…' marker.
 * Growing the dock dynamically would resize the scroll region on every
 * paste — that's disruptive to the content above, so the reservation is
 * fixed at max.
 *
 * Layout (double-rule sandwich, with input rows = 2 by default):
 *   ══════════════════ context ══════════   ← top rule
 *      + add instruction › foo bar          ← input row 1
 *      baz quux                             ← input row 2 (empty if 1-line)
 *   ══════════════════════════════════════   ← bottom rule
 *      [Enter] send · [/] commands …        ← tips row
 *   (one blank row at very bottom for cursor safety)
 *
 * Config:
 *   KEPLER_INPUT_ROWS    1..5   input row count (default 2)
 *   KEPLER_FIXED_INPUT=0        disable dock entirely (fallback readline)
 */

import { paint, width as visibleWidth } from './palette.mjs';
import { term, onResize } from './term.mjs';
import { wrapToLines, tailWithEllipsis, cursorPositionInLines } from './text-layout.mjs';

const ESC = '\x1b[';
const OUT = process.stderr;
const INPUT_INDENT = 3;
const DEFAULT_INPUT_ROWS = 2;
const MIN_INPUT_ROWS = 1;
const MAX_INPUT_ROWS = 5;

let mounted = false;
let inputRows = DEFAULT_INPUT_ROWS;
let reservedRows = 4 + DEFAULT_INPUT_ROWS; // top + input(N) + bottom + tips + safety
let unsubResize = null;
let lastFrame = { context: '', tips: '' };
let resetting = false;

function write(s) { try { OUT.write(s); } catch {} }
function setScrollRegion(top, bottom) { write(`${ESC}${top};${bottom}r`); }
function clearScrollRegion() { write(`${ESC}r`); }
function saveCursor() { write(`${ESC}s`); }
function restoreCursor() { write(`${ESC}u`); }
function moveTo(row, col) { write(`${ESC}${row};${col}H`); }
function clearLine() { write(`${ESC}2K`); }

function rows() {
  return Math.max(10, term().rows || 24);
}

function cols() {
  return Math.max(40, term().columns || 80);
}

function contentBottomRow() {
  return Math.max(1, rows() - reservedRows);
}

function topRuleRow()       { return contentBottomRow() + 1; }
function inputRowStart()    { return contentBottomRow() + 2; }
function inputRowEnd()      { return inputRowStart() + inputRows - 1; }
function bottomRuleRow()    { return inputRowEnd() + 1; }
function tipsRow()          { return bottomRuleRow() + 1; }

function inputTextBudget() {
  return Math.max(8, cols() - INPUT_INDENT - 1);
}

function resolveInputRows(requested) {
  const raw = requested != null
    ? requested
    : process.env.KEPLER_INPUT_ROWS;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return DEFAULT_INPUT_ROWS;
  return Math.max(MIN_INPUT_ROWS, Math.min(MAX_INPUT_ROWS, n));
}

function padLine(text) {
  const value = String(text || '');
  const pad = Math.max(0, cols() - visibleWidth(value));
  return value + ' '.repeat(pad);
}

function fitText(text, maxWidth) {
  const plain = String(text || '').replace(/\s+/g, ' ').trim();
  if (visibleWidth(plain) <= maxWidth) return plain;
  if (maxWidth <= 1) return '';
  return plain.slice(0, Math.max(0, maxWidth - 1)) + '…';
}

// Both rules use the same character, color, and treatment so the sandwich
// reads as a single enclosing frame. Leave 1 col of margin to dodge the
// right-edge autowrap most terminals inflict on full-width writes.
function ruleChars(count) {
  return '═'.repeat(Math.max(0, count));
}

function topRuleLine(context = '') {
  const w = Math.max(0, cols() - 1);
  const ctx = fitText(context, Math.max(0, Math.floor(w / 2)));
  if (!ctx) return paint.text.dim(ruleChars(w));
  const ctxWidth = visibleWidth(ctx);
  const left  = Math.max(8, w - ctxWidth - 4);
  const right = Math.max(0, w - left - ctxWidth - 2);
  return paint.text.dim(ruleChars(left)) + ' ' + paint.text.dim(ctx) + ' ' + paint.text.dim(ruleChars(right));
}

function bottomRuleLine() {
  return paint.text.dim(ruleChars(Math.max(0, cols() - 1)));
}

function applyLayout() {
  if (!mounted) return;
  const bottom = contentBottomRow();
  setScrollRegion(1, bottom);
  renderFrame(lastFrame);
  moveTo(bottom, 1);
}

function renderFrame(frame = {}) {
  if (!mounted) return;
  lastFrame = { ...lastFrame, ...frame };
  saveCursor();

  moveTo(topRuleRow(), 1);
  clearLine();
  write(padLine(topRuleLine(lastFrame.context)));

  moveTo(bottomRuleRow(), 1);
  clearLine();
  write(padLine(bottomRuleLine()));

  moveTo(tipsRow(), 1);
  clearLine();
  const indent = ' '.repeat(INPUT_INDENT);
  write(padLine(`${indent}${paint.text.dim(fitText(lastFrame.tips, cols() - INPUT_INDENT - 1))}`));

  moveTo(rows(), 1);
  clearLine();
  restoreCursor();
}

function clearInputRows() {
  saveCursor();
  for (let row = inputRowStart(); row <= inputRowEnd(); row++) {
    moveTo(row, 1);
    clearLine();
  }
  restoreCursor();
}

/**
 * Wrap `prefix + value` into visible lines, keeping only the last N rows
 * with an ellipsis marker on overflow. Returned lines are already indented
 * for the input area.
 */
function layoutInput(prefix, value) {
  const budget = inputTextBudget();
  const combined = `${prefix || ''}${value || ''}`;
  const wrapped = wrapToLines(combined, budget);
  const tail = tailWithEllipsis(wrapped, inputRows);
  return {
    lines: tail.visible,
    truncated: tail.truncated,
    dropped: tail.dropped,
    wrapped, // full wrap for cursor math
    prefix: prefix || '',
  };
}

function drawInputLines(lines) {
  saveCursor();
  const indent = ' '.repeat(INPUT_INDENT);
  for (let i = 0; i < inputRows; i++) {
    const row = inputRowStart() + i;
    moveTo(row, 1);
    clearLine();
    if (i < lines.length) {
      write(`${indent}${lines[i]}`);
    }
  }
  restoreCursor();
}

export function isInputDockMounted() {
  return mounted;
}

export function mountInputDock({ inputRows: requestedInputRows } = {}) {
  const t = term();
  if (!t.isTTY || t.plain || process.env.KEPLER_FIXED_INPUT === '0') return false;
  if (mounted) return true;

  inputRows = resolveInputRows(requestedInputRows);
  reservedRows = 4 + inputRows; // top + input(N) + bottom + tips + safety
  mounted = true;
  applyLayout();

  unsubResize = onResize(() => applyLayout());
  process.once('exit', safeUnmount);
  process.once('SIGTERM', () => { safeUnmount(); process.exit(143); });
  return true;
}

export function unmountInputDock() {
  if (!mounted || resetting) return;
  resetting = true;
  try {
    clearScrollRegion();
    if (unsubResize) { unsubResize(); unsubResize = null; }
  } finally {
    mounted = false;
    resetting = false;
  }
}

function safeUnmount() { try { unmountInputDock(); } catch {} }

export function moveToContent() {
  if (!mounted) return false;
  moveTo(contentBottomRow(), 1);
  return true;
}

// One row above the bottom of the scroll region. Writes here won't trigger
// the scroll-on-LF that happens when writing '\n' at the region's bottom row —
// exactly what the persistent explore/spinner line needs to overwrite in place
// without piling copies of itself into scrollback.
export function pinnedStatusRow() {
  if (!mounted) return null;
  return Math.max(1, contentBottomRow() - 1);
}

// Write a single-line status at pinnedStatusRow, overwriting whatever's there.
// Uses absolute cursor positioning + clear-line so it's immune to whatever
// _lastLineCount inPlace() thinks it has.
export function drawPinnedStatus(line) {
  if (!mounted) return false;
  const row = pinnedStatusRow();
  if (row == null) return false;
  saveCursor();
  moveTo(row, 1);
  clearLine();
  write(String(line || ''));
  restoreCursor();
  return true;
}

export function clearPinnedStatus() {
  if (!mounted) return false;
  const row = pinnedStatusRow();
  if (row == null) return false;
  saveCursor();
  moveTo(row, 1);
  clearLine();
  restoreCursor();
  return true;
}

export function prepareInputPrompt({ context = '', tips = '' } = {}) {
  if (!mounted) return false;
  clearInputRows();
  renderFrame({ context, tips });
  moveTo(inputRowStart(), INPUT_INDENT + 1);
  return true;
}

export function clearInputPrompt() {
  if (!mounted) return false;
  clearInputRows();
  renderFrame(lastFrame);
  return true;
}

export function renderDockInput(prefix, value, { context = '', tips = '' } = {}) {
  if (!mounted) return false;
  renderFrame({ context, tips });
  const layout = layoutInput(prefix, value);
  drawInputLines(layout.lines);
  // Position cursor at the logical end of the buffer.
  focusDockInput(prefix, value);
  return true;
}

/**
 * Move the terminal cursor to the position that corresponds to the logical
 * end of `prefix + value` within the (possibly wrapped and truncated) input
 * area. If the buffer overflowed, the cursor lands on the last visible row.
 */
export function focusDockInput(prefix, value = '') {
  if (!mounted) return false;
  const layout = layoutInput(prefix, value);
  const offset = visibleWidth(`${prefix || ''}${value || ''}`);
  const pos = cursorPositionInLines(layout.wrapped, offset);
  // Clamp the row into the visible input area — offscreen rows map to the
  // last visible row (mirroring the tail-with-ellipsis behavior).
  const visibleRowIdx = Math.max(
    0,
    Math.min(inputRows - 1, pos.row - Math.max(0, layout.wrapped.length - inputRows)),
  );
  const row = inputRowStart() + visibleRowIdx;
  const col = Math.min(cols(), INPUT_INDENT + 1 + Math.max(0, pos.col));
  moveTo(row, col);
  return true;
}

export function inputRowColumn() {
  return INPUT_INDENT + 1;
}

// Test-only accessors.
export function _internals() {
  return {
    inputRows: () => inputRows,
    reservedRows: () => reservedRows,
    layoutInput,
    inputTextBudget,
  };
}
