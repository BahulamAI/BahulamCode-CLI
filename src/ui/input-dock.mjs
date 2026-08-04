/**
 * Fixed input dock — Bahulam Code identity + meta + tips.
 *
 * Reserves rows at the bottom of the terminal so agent/tool output scrolls
 * above the prompt. The input area GROWS DYNAMICALLY as the user types or
 * pastes multi-line content: starts at 1 row, expands up to `MAX_INPUT_ROWS`
 * (default 6) to fit the wrapped buffer, shrinks back when the buffer is
 * cleared. On resize, the scroll region moves so content above reflows
 * smoothly.
 *
 * When the wrapped buffer still exceeds the max, only the LAST max rows
 * render with a leading '…' marker (explicit truncation).
 *
 * Multi-line paste — including bracketed paste bursts — renders as one
 * visible block in the dock and submits as a single message. The dock
 * itself doesn't parse newlines; wrapToLines treats them as hard breaks.
 *
 * Layout (fixed 8 rows + N input rows):
 *   ── ▎Bahulam Code ══════════════ 12.3k tok · 2m 41s ═══   ← top rule (colored)
 *                                                              ← spacer
 *        + add instruction › foo bar                          ← input row 1
 *        baz quux                                             ← input row 2 (added as needed)
 *        ...                                                  ← up to MAX_INPUT_ROWS
 *                                                              ← spacer
 *   ══════════════════════════════════════════════════════   ← bottom rule (colored)
 *      deepseek-chat-v3 · Tarang-Orca ⎇ main · turn 4         ← meta row
 *      [Enter] send · [/] commands …                          ← tips row
 *   (one blank row at very bottom for cursor safety)
 *
 * Config:
 *   BAHULAM_INPUT_ROWS_MAX / KEPLER_INPUT_ROWS_MAX   1..12  hard cap on input row growth (default 6)
 *   BAHULAM_FIXED_INPUT=0 / KEPLER_FIXED_INPUT=0             disable dock entirely (fallback readline)
 */

import { paint, width as visibleWidth } from './palette.mjs';
import { term, onResize } from './term.mjs';
import { wrapToLines, tailWithEllipsis, cursorPositionInLines } from './text-layout.mjs';

const ESC = '\x1b[';
const OUT = process.stderr;

const BRAND_LABEL = 'Bahulam Code';
const LABEL_ACCENT = '▎'; // left-edge accent bar

// Horizontal margin: text starts INPUT_INDENT cols from the left edge and
// leaves INPUT_RIGHT_PAD cols of clear space on the right so wrapped lines
// don't kiss the terminal edge.
const INPUT_INDENT = 5;
const INPUT_RIGHT_PAD = 2;
const META_INDENT = 4;

const DEFAULT_MAX_INPUT_ROWS = 6;
const MIN_INPUT_ROWS = 1;
const MAX_INPUT_ROWS_CAP = 12;

// Fixed rows around the input area:
//   1 top rule + 1 spacer above + input(N) + 1 spacer below + 1 bottom rule
//   + 1 meta row + 1 tips row + 1 safety row
// = 7 + N
const FIXED_ROWS = 7;

let mounted = false;
let inputRowsMax = DEFAULT_MAX_INPUT_ROWS;
let inputRows = MIN_INPUT_ROWS;
let reservedRows = FIXED_ROWS + MIN_INPUT_ROWS;
let unsubResize = null;
// prefix + value are tracked here so any code path that redraws the dock
// (renderFrame, applyLayout, redrawDockFrame, resize) can end by parking
// the cursor at the correct input position. Without this, readline echoes
// land on rows the dock briefly moved through mid-render and characters
// appear above/below the input row.
let lastFrame = { context: '', meta: '', tips: '', prefix: '', value: '', cursor: null };
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

// Row map (top → bottom of the reserved region).
function topRuleRow()       { return contentBottomRow() + 1; }
function spacerAboveRow()   { return topRuleRow() + 1; }
function inputRowStart()    { return spacerAboveRow() + 1; }
function inputRowEnd()      { return inputRowStart() + inputRows - 1; }
function spacerBelowRow()   { return inputRowEnd() + 1; }
function bottomRuleRow()    { return spacerBelowRow() + 1; }
function metaRow()          { return bottomRuleRow() + 1; }
function tipsRow()          { return metaRow() + 1; }

function inputTextBudget() {
  return Math.max(8, cols() - INPUT_INDENT - INPUT_RIGHT_PAD - 1);
}

function resolveMaxInputRows(requested) {
  const raw = requested != null
    ? requested
    : (process.env.BAHULAM_INPUT_ROWS_MAX || process.env.KEPLER_INPUT_ROWS_MAX);
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_INPUT_ROWS;
  return Math.max(MIN_INPUT_ROWS, Math.min(MAX_INPUT_ROWS_CAP, n));
}

// How many input rows does this (prefix + value) buffer need? Wrapped line
// count clamped to [1, inputRowsMax]. Beyond the cap, tail-with-ellipsis
// takes over inside drawInputLines so at most inputRowsMax rows render.
function computeInputRowsForBuffer(prefix, value) {
  const budget = inputTextBudget();
  const wrapped = wrapToLines(`${prefix || ''}${value || ''}`, budget);
  const wanted = Math.max(MIN_INPUT_ROWS, wrapped.length);
  return Math.min(inputRowsMax, wanted);
}

// Resize the input area to a new row count. Moves the scroll region so
// content above shifts accordingly; the dock frame is redrawn at the
// new position. No-op if the count didn't change.
//
// CRITICAL: when the dock SHRINKS (inputRows decreases), the frame moves
// down and previously-dock rows become part of the scroll region. Those
// rows still hold their old dock content (rule chars, prior input text,
// meta line) which then leaks into the transcript as streamed content
// scrolls past them. We clear the old dock region BEFORE moving the frame
// so the freed rows are blank when they enter the scroll region.
function setInputRowsTo(nextRows) {
  const clamped = Math.max(MIN_INPUT_ROWS, Math.min(inputRowsMax, Math.floor(nextRows)));
  if (clamped === inputRows) return false;
  const shrinking = clamped < inputRows;
  if (mounted && shrinking) {
    // Clear the entire old reserved region — top rule through safety row —
    // so nothing that lived here leaks into the scroll region after we
    // move the frame down.
    for (let row = topRuleRow(); row <= rows(); row++) {
      moveTo(row, 1);
      clearLine();
    }
  }
  inputRows = clamped;
  reservedRows = FIXED_ROWS + inputRows;
  if (mounted) {
    const bottom = contentBottomRow();
    setScrollRegion(1, bottom);
    renderFrame(lastFrame);
  }
  return true;
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

function ruleChars(count) {
  return '═'.repeat(Math.max(0, count));
}

// Top rule: `── ▎Bahulam Code ═════════════ [context] ═══`
// - Leading two rule chars for a clean edge
// - Colored accent bar + brand label on the left
// - Optional right-aligned context strip (session tokens/elapsed) with rule
//   fill between label and context
function topRuleLine(context = '') {
  const w = Math.max(0, cols() - 1);
  const brand = paint.brand.primary;
  const bold = paint.bold;

  const leadRule = brand(ruleChars(2));
  const accent = brand(LABEL_ACCENT);
  const label = bold(brand(BRAND_LABEL));
  const leftBlock = `${leadRule} ${accent}${label}`;
  const leftWidth = visibleWidth(leftBlock);

  const ctx = fitText(context, Math.max(0, Math.floor(w / 2)));
  const ctxWidth = ctx ? visibleWidth(ctx) : 0;

  // Rule fill in the middle. Reserve 1 space around ctx when present.
  const gap = 1;
  const rightPadRule = 2;
  const middleWidth = Math.max(1, w - leftWidth - gap - ctxWidth - (ctx ? gap + rightPadRule : 0));
  const middleRule = brand(ruleChars(middleWidth));

  if (!ctx) {
    return `${leftBlock} ${middleRule}`;
  }
  const tailRule = brand(ruleChars(rightPadRule));
  return `${leftBlock} ${middleRule} ${paint.text.dim(ctx)} ${tailRule}`;
}

function bottomRuleLine() {
  return paint.brand.primary(ruleChars(Math.max(0, cols() - 1)));
}

// Always park the cursor at the tracked (prefix, value) input position.
// Called at the END of every dock render path so readline echoes land in
// the input row, not on whichever row a mid-render moveTo left them on.
// When there is no tracked input (nothing to focus yet), park at the
// scroll-region bottom so writes at least stay above the dock frame.
function parkCursorAtInput() {
  if (!mounted) return;
  const prefix = lastFrame.prefix || '';
  const value = lastFrame.value || '';
  if (!prefix && !value) {
    moveTo(inputRowStart(), INPUT_INDENT + 1);
    return;
  }
  focusDockInput(prefix, value, lastFrame.cursor);
}

function applyLayout() {
  if (!mounted) return;
  const bottom = contentBottomRow();
  setScrollRegion(1, bottom);
  renderFrame(lastFrame);
  // On (re)mount and resize, park at input if we have one; otherwise sit at
  // the bottom of the content region so any pending content writes flush
  // above the dock rather than into a stale mid-frame position.
  if (lastFrame.prefix || lastFrame.value) {
    parkCursorAtInput();
  } else {
    moveTo(bottom, 1);
  }
}

function renderFrame(frame = {}) {
  if (!mounted) return;
  lastFrame = { ...lastFrame, ...frame };

  moveTo(topRuleRow(), 1);
  clearLine();
  write(padLine(topRuleLine(lastFrame.context)));

  // Spacer above input.
  moveTo(spacerAboveRow(), 1);
  clearLine();

  // (input rows are written by drawInputLines / clearInputRows)

  // Spacer below input.
  moveTo(spacerBelowRow(), 1);
  clearLine();

  moveTo(bottomRuleRow(), 1);
  clearLine();
  write(padLine(bottomRuleLine()));

  // Meta row: cwd ⎇ branch · turn N · tokens
  moveTo(metaRow(), 1);
  clearLine();
  const metaIndent = ' '.repeat(META_INDENT);
  const metaBudget = Math.max(0, cols() - META_INDENT - 1);
  const metaText = lastFrame.meta ? paint.text.muted(fitText(lastFrame.meta, metaBudget)) : '';
  write(padLine(`${metaIndent}${metaText}`));

  // Tips row.
  moveTo(tipsRow(), 1);
  clearLine();
  const tipsIndent = ' '.repeat(META_INDENT);
  const tipsBudget = Math.max(0, cols() - META_INDENT - 1);
  write(padLine(`${tipsIndent}${paint.text.dim(fitText(lastFrame.tips, tipsBudget))}`));

  // Safety row.
  moveTo(rows(), 1);
  clearLine();

  // Deliberately NOT using saveCursor/restoreCursor. VT100 has a single
  // cursor-save slot per terminal; nested calls in drawInputLines /
  // pinned-status writers clobber the outer save and restore to the wrong
  // place. Instead, callers that need the cursor parked at the input row
  // invoke parkCursorAtInput() after renderFrame returns.
}

function clearInputRows() {
  for (let row = inputRowStart(); row <= inputRowEnd(); row++) {
    moveTo(row, 1);
    clearLine();
  }
}

export function clearDockArea({ restore = true } = {}) {
  if (!mounted) return false;
  if (restore) saveCursor();
  for (let row = topRuleRow(); row <= rows(); row++) {
    moveTo(row, 1);
    clearLine();
  }
  if (restore) restoreCursor();
  return true;
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
    wrapped,
    prefix: prefix || '',
  };
}

function drawInputLines(lines) {
  const indent = ' '.repeat(INPUT_INDENT);
  for (let i = 0; i < inputRows; i++) {
    const row = inputRowStart() + i;
    moveTo(row, 1);
    clearLine();
    if (i < lines.length) {
      write(`${indent}${lines[i]}`);
    }
  }
  // No save/restore — caller parks cursor via focusDockInput.
}

export function isInputDockMounted() {
  return mounted;
}

export function mountInputDock({ inputRowsMax: requestedMax } = {}) {
  const t = term();
  if (!t.isTTY || t.plain) return false;
  if (process.env.BAHULAM_FIXED_INPUT === '0' || process.env.KEPLER_FIXED_INPUT === '0') return false;
  if (mounted) return true;

  inputRowsMax = resolveMaxInputRows(requestedMax);
  inputRows = MIN_INPUT_ROWS;
  reservedRows = FIXED_ROWS + inputRows;
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
    const exitRow = topRuleRow();
    clearDockArea({ restore: false });
    clearScrollRegion();
    moveTo(Math.min(rows(), exitRow), 1);
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

// Redraw just the frame (rules, spacers, meta, tips, safety row) without
// touching the input rows. Callers that write into the dock's non-input
// rows (e.g. slash-hint overlays) use this to restore the frame after
// clearing their overlay.
export function redrawDockFrame() {
  if (!mounted) return false;
  renderFrame(lastFrame);
  parkCursorAtInput();
  return true;
}

export function prepareInputPrompt({ context = '', tips = '', meta = '' } = {}) {
  if (!mounted) return false;
  setInputRowsTo(MIN_INPUT_ROWS);
  clearInputRows();
  renderFrame({ context, tips, meta, prefix: '', value: '' });
  moveTo(inputRowStart(), INPUT_INDENT + 1);
  return true;
}

export function clearInputPrompt() {
  if (!mounted) return false;
  clearInputRows();
  lastFrame.value = '';
  renderFrame(lastFrame);
  parkCursorAtInput();
  return true;
}

export function renderDockInput(prefix, value, { context = '', tips = '', meta = '', cursor = null } = {}) {
  if (!mounted) return false;
  setInputRowsTo(computeInputRowsForBuffer(prefix, value));
  renderFrame({ context, tips, meta, prefix, value, cursor });
  const layout = layoutInput(prefix, value);
  drawInputLines(layout.lines);
  focusDockInput(prefix, value, cursor);
  return true;
}

/**
 * Move the terminal cursor to the position that corresponds to
 * `prefix + value[0..cursorInValue]` within the (possibly wrapped and
 * truncated) input area. When `cursorInValue` is null/undefined, the cursor
 * lands at the logical end of `value` (append-mode default).
 *
 * `cursorInValue` is a char index into the RAW value string (matching
 * readline's `rl.cursor`), not into the wrapped/rendered output.
 */
export function focusDockInput(prefix, value = '', cursorInValue = null) {
  if (!mounted) return false;
  const layout = layoutInput(prefix, value);
  const valueStr = String(value || '');
  const rawCursor = cursorInValue == null
    ? valueStr.length
    : Math.max(0, Math.min(valueStr.length, Math.floor(cursorInValue)));
  const cursorSlice = valueStr.slice(0, rawCursor);
  const offset = visibleWidth(`${prefix || ''}${cursorSlice}`);
  const pos = cursorPositionInLines(layout.wrapped, offset);
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
    FIXED_ROWS,
    BRAND_LABEL,
  };
}
