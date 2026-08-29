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
 *      deepseek-chat-v3 · Bahulam ⎇ main · turn 4         ← meta row
 *      [Enter] send · [/] commands …                          ← tips row
 *   (one blank row at very bottom for cursor safety)
 *
 * Config:
 *   BAHULAM_INPUT_ROWS_MAX   1..12  hard cap on input row growth (default 6)
 *   BAHULAM_TTY_MODE=stable         scrollback-safe transcript, no fixed dock
 *   BAHULAM_PLAIN=1                 deterministic no-ANSI output for automation
 *   BAHULAM_FIXED_INPUT=0           disable dock entirely (fallback readline)
 */

import { paint, width as visibleWidth } from './palette.mjs';
import { term, onResize } from './term.mjs';
import { wrapToLines, tailWithEllipsis, cursorPositionInLines } from './text-layout.mjs';
import * as queue from './render-queue.mjs';

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
const DEFAULT_OVERLAY_MAX_ROWS = 8;
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
let lastFrame = { context: '', meta: '', tips: '', prefix: '', value: '', cursor: null, overlayLines: null };
let resetting = false;
let lastGeometry = null;
let contentCursorRow = 1;
let contentCursorCol = 1;
let contentTrackingActive = false;
let suppressWriteTracking = 0;
let originalStdoutWrite = null;
let originalStderrWrite = null;

function write(s) {
  // All dock frame bytes flow through the render queue's serialized raw
  // channel when it is active — bypassing the content redirect so frame
  // paints never land in the transcript. Legacy fallback writes straight
  // to stderr with the old suppress-tracking guard.
  if (queue.isActive()) {
    queue.raw(s);
    return;
  }
  try {
    suppressWriteTracking++;
    OUT.write(s);
  } catch {
  } finally {
    suppressWriteTracking = Math.max(0, suppressWriteTracking - 1);
  }
}
function setScrollRegion(top, bottom) {
  // Keep the queue's notion of the content region in sync — its content
  // cursor clamps to this bottom.
  if (queue.isActive()) { queue.setRegion(top, bottom); return; }
  write(`${ESC}${top};${bottom}r`);
}
function clearScrollRegion() {
  if (queue.isActive()) { queue.clearRegion(); return; }
  write(`${ESC}r`);
}
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

function drawableColumns() {
  // Avoid writing into the final terminal column. Many terminals enter
  // autowrap state there; during rapid resizes that can push fixed dock
  // frame lines into scrollback.
  return Math.max(1, cols() - 1);
}

function contentBottomRow() {
  return Math.max(1, rows() - reservedRows);
}

function clampContentCursor() {
  const bottom = contentBottomRow();
  contentCursorRow = Math.max(1, Math.min(bottom, contentCursorRow || 1));
  contentCursorCol = Math.max(1, Math.min(cols(), contentCursorCol || 1));
}

function resetContentCursor(row = 1, col = 1) {
  contentCursorRow = Math.max(1, Math.min(contentBottomRow(), Math.floor(row || 1)));
  contentCursorCol = Math.max(1, Math.min(cols(), Math.floor(col || 1)));
}

function trackContentWrite(chunk) {
  if (!mounted || !contentTrackingActive || suppressWriteTracking > 0) return;
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
  if (!text) return;
  const clean = text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '');
  const bottom = contentBottomRow();
  const width = Math.max(1, drawableColumns());
  for (const ch of clean) {
    if (ch === '\r') {
      contentCursorCol = 1;
      continue;
    }
    if (ch === '\n') {
      contentCursorRow = Math.min(bottom, contentCursorRow + 1);
      contentCursorCol = 1;
      continue;
    }
    contentCursorCol++;
    if (contentCursorCol > width) {
      contentCursorRow = Math.min(bottom, contentCursorRow + 1);
      contentCursorCol = 1;
    }
  }
}

function patchOutputTracking() {
  if (originalStdoutWrite || originalStderrWrite) return;
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = function trackedStdoutWrite(chunk, ...args) {
    trackContentWrite(chunk);
    return originalStdoutWrite(chunk, ...args);
  };
  process.stderr.write = function trackedStderrWrite(chunk, ...args) {
    trackContentWrite(chunk);
    return originalStderrWrite(chunk, ...args);
  };
}

function unpatchOutputTracking() {
  if (originalStdoutWrite) {
    process.stdout.write = originalStdoutWrite;
    originalStdoutWrite = null;
  }
  if (originalStderrWrite) {
    process.stderr.write = originalStderrWrite;
    originalStderrWrite = null;
  }
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
    : process.env.BAHULAM_INPUT_ROWS_MAX;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_INPUT_ROWS;
  return Math.max(MIN_INPUT_ROWS, Math.min(MAX_INPUT_ROWS_CAP, n));
}

function resolveOverlayRowCap(requested = DEFAULT_OVERLAY_MAX_ROWS) {
  const n = Number.parseInt(String(requested), 10);
  if (!Number.isFinite(n)) return DEFAULT_OVERLAY_MAX_ROWS;
  // Overlays (approval scripts) may need more rows than the typing cap —
  // the user cannot approve what they cannot see. Allow up to half the
  // terminal so the transcript stays visible; typing input keeps the
  // tight MAX_INPUT_ROWS_CAP via normalizeInputRows above.
  const dynamicCap = Math.max(MAX_INPUT_ROWS_CAP, Math.floor((rows() || 24) / 2));
  return Math.max(MIN_INPUT_ROWS, Math.min(dynamicCap, n));
}

function overlayRowsForWrapped(wrappedLength, requestedMaxRows = DEFAULT_OVERLAY_MAX_ROWS) {
  const rowCap = resolveOverlayRowCap(requestedMaxRows);
  const wanted = Math.max(MIN_INPUT_ROWS, Math.floor(Number(wrappedLength) || 0));
  return Math.min(rowCap, wanted);
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
function setInputRowsTo(nextRows, { maxRows = inputRowsMax } = {}) {
  const clamped = Math.max(MIN_INPUT_ROWS, Math.min(maxRows, Math.floor(nextRows)));
  if (clamped === inputRows) return false;
  const shrinking = clamped < inputRows;
  const growing = clamped > inputRows;
  if (mounted && shrinking) {
    // Clear the entire old reserved region — top rule through safety row —
    // so nothing that lived here leaks into the scroll region after we
    // move the frame down.
    for (let row = topRuleRow(); row <= rows(); row++) {
      moveTo(row, 1);
      clearLine();
    }
  } else if (mounted && growing) {
    // GROWING is the case that used to eat transcript. Rows near the
    // bottom of the current scroll region are about to become dock rows;
    // whatever transcript sat on them would be overwritten by the wider
    // dock frame and NEVER enter terminal scrollback, so users lost
    // history the moment approval prompts (or any overlay) mounted.
    //
    // Fix: push the doomed rows into scrollback BEFORE shrinking the
    // region. Move cursor to the last row of the CURRENT (larger) scroll
    // region and emit `growth` line-feeds. Each LF at the last row of a
    // DECSTBM region scrolls the whole region up one line — top row goes
    // to scrollback, everything else shifts up, bottom clears. After N
    // such LFs the content that USED to be on rows we're about to reserve
    // is safely in scrollback and the reserved rows are blank — ready
    // for the dock frame with zero visible loss to the user.
    const growth = clamped - inputRows;
    const oldContentBottom = contentBottomRow(); // computed against OLD reservedRows
    moveTo(oldContentBottom, 1);
    for (let i = 0; i < growth; i++) write('\n');
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
  const pad = Math.max(0, drawableColumns() - visibleWidth(value));
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
  const w = Math.max(0, drawableColumns());
  const brand = paint.brand.primary;
  const bold = paint.bold;

  const leadRule = brand(ruleChars(2));
  const accent = brand(LABEL_ACCENT);
  const label = bold(brand(BRAND_LABEL));
  const leftBlock = `${leadRule} ${accent}${label}`;
  const leftWidth = visibleWidth(leftBlock);
  const rightPadRule = 2;

  const maxCtxWidth = Math.max(0, Math.min(
    Math.floor(w / 2),
    w - leftWidth - 1 /* left gap */ - 1 /* minimum middle */ - 1 /* ctx gap */ - rightPadRule - 1 /* tail gap */,
  ));
  const ctx = fitText(context, maxCtxWidth);
  const ctxWidth = ctx ? visibleWidth(ctx) : 0;

  // Rule fill in the middle. Reserve 1 space around ctx when present.
  const middleWidth = ctx
    ? Math.max(1, w - leftWidth - ctxWidth - rightPadRule - 3)
    : Math.max(1, w - leftWidth - 1);
  const middleRule = brand(ruleChars(middleWidth));

  if (!ctx) {
    return `${leftBlock} ${middleRule}`;
  }
  const tailRule = brand(ruleChars(rightPadRule));
  return `${leftBlock} ${middleRule} ${paint.text.dim(ctx)} ${tailRule}`;
}

function bottomRuleLine() {
  return paint.brand.primary(ruleChars(Math.max(0, drawableColumns())));
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
    if (queue.isActive()) {
      queue.park(inputRowStart(), INPUT_INDENT + 1);
      return;
    }
    moveTo(inputRowStart(), INPUT_INDENT + 1);
    return;
  }
  focusDockInput(prefix, value, lastFrame.cursor);
}

function applyLayout({ clearPrevious = false } = {}) {
  if (!mounted) return;
  if (clearPrevious && lastGeometry) {
    clearDockArea({ restore: true, geometry: lastGeometry });
  }
  const bottom = contentBottomRow();
  setScrollRegion(1, bottom);
  renderFrame(lastFrame);
  clampContentCursor();
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
  if (Array.isArray(lastFrame.overlayLines)) {
    drawInputLines(lastFrame.overlayLines);
  }

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
  lastGeometry = {
    top: topRuleRow(),
    bottom: rows(),
  };
}

function clearDockRows(startRow, endRow) {
  const maxRow = rows();
  const start = Math.max(1, Math.min(maxRow, Math.floor(startRow || 1)));
  const end = Math.max(start, Math.min(maxRow, Math.floor(endRow || maxRow)));
  for (let row = start; row <= end; row++) {
    moveTo(row, 1);
    clearLine();
  }
}

function clearInputRows() {
  for (let row = inputRowStart(); row <= inputRowEnd(); row++) {
    moveTo(row, 1);
    clearLine();
  }
}

export function clearDockArea({ restore = true, geometry = null } = {}) {
  if (!mounted) return false;
  if (restore) saveCursor();
  clearDockRows(geometry?.top || topRuleRow(), geometry?.bottom || rows());
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

function layoutOverlayLines(lines) {
  const budget = inputTextBudget();
  const wrapped = [];
  for (const line of lines) {
    wrapped.push(...wrapToLines(line, budget));
  }
  return wrapped.length ? wrapped : [''];
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

export function mountInputDock({
  inputRowsMax: requestedMax,
  initialContentRow = 1,
  initialContentCol = 1,
} = {}) {
  const t = term();
  if (!t.isTTY || t.plain) return false;
  if (t.ttyMode !== 'rich' || t.fixedInput === false) return false;
  if (process.env.BAHULAM_FIXED_INPUT === '0') return false;
  if (mounted) return true;

  inputRowsMax = resolveMaxInputRows(requestedMax);
  inputRows = MIN_INPUT_ROWS;
  reservedRows = FIXED_ROWS + inputRows;
  resetContentCursor(initialContentRow, initialContentCol);
  contentTrackingActive = false;
  mounted = true;
  // Render queue becomes the sole writer + exact cursor tracker. The
  // legacy simulate-by-parsing patch only engages if activation is
  // refused (shouldn't happen — mount gating matches activate gating).
  const queued = queue.activate({
    initialRow: contentCursorRow,
    initialCol: contentCursorCol,
    bottom: contentBottomRow(),
  });
  if (!queued) patchOutputTracking();
  applyLayout();

  unsubResize = onResize(() => {
    if (queue.isActive()) {
      // Terminal reflow makes any tracked position fiction — hard
      // re-anchor to the new content-region bottom before repainting.
      queue.reanchor({ row: contentBottomRow(), col: 1, bottom: contentBottomRow() });
      resetContentCursor(contentBottomRow(), 1);
    }
    applyLayout({ clearPrevious: true });
  });
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
    contentTrackingActive = false;
    queue.deactivate();
    unpatchOutputTracking();
    resetting = false;
    lastGeometry = null;
  }
}

function safeUnmount() { try { unmountInputDock(); } catch {} }

export function moveToContent() {
  if (!mounted) return false;
  if (queue.isActive()) {
    // Content self-positions through queue.content(); nothing to do.
    return true;
  }
  clampContentCursor();
  contentTrackingActive = true;
  moveTo(contentCursorRow, contentCursorCol);
  return true;
}

// The next transcript row. Spinner/status overlays live next to the latest
// content instead of near the scroll-region bottom; otherwise sparse agent
// events leave large blank holes between visible lines.
export function pinnedStatusRow() {
  if (!mounted) return null;
  clampContentCursor();
  return Math.max(1, Math.min(contentBottomRow(), contentCursorRow));
}

export function drawPinnedStatus(line) {
  if (!mounted) return false;
  if (queue.isActive()) {
    // Coalesced, serialized, no VT100 save-slot involvement.
    queue.status(String(line || ''));
    return true;
  }
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
  if (queue.isActive()) {
    queue.clearStatus();
    return true;
  }
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
  contentTrackingActive = false;
  renderFrame(lastFrame);
  parkCursorAtInput();
  return true;
}

export function prepareInputPrompt({ context = '', tips = '', meta = '' } = {}) {
  if (!mounted) return false;
  contentTrackingActive = false;
  setInputRowsTo(MIN_INPUT_ROWS);
  clearInputRows();
  renderFrame({ context, tips, meta, prefix: '', value: '', overlayLines: null });
  moveTo(inputRowStart(), INPUT_INDENT + 1);
  return true;
}

export function clearInputPrompt() {
  if (!mounted) return false;
  contentTrackingActive = false;
  lastFrame.value = '';
  lastFrame.overlayLines = null;
  setInputRowsTo(MIN_INPUT_ROWS);
  clearInputRows();
  renderFrame(lastFrame);
  parkCursorAtInput();
  return true;
}

export function renderDockInput(prefix, value, { context = '', tips = '', meta = '', cursor = null } = {}) {
  if (!mounted) return false;
  contentTrackingActive = false;
  setInputRowsTo(computeInputRowsForBuffer(prefix, value));
  renderFrame({ context, tips, meta, prefix, value, cursor, overlayLines: null });
  const layout = layoutInput(prefix, value);
  drawInputLines(layout.lines);
  focusDockInput(prefix, value, cursor);
  return true;
}

export function renderDockOverlay({
  context = '',
  lines = [],
  meta = '',
  tips = '',
  maxRows = DEFAULT_OVERLAY_MAX_ROWS,
} = {}) {
  if (!mounted) return false;
  contentTrackingActive = false;
  const sourceLines = Array.isArray(lines) ? lines : String(lines || '').split('\n');
  const wrapped = layoutOverlayLines(sourceLines);
  const rowCap = resolveOverlayRowCap(maxRows);
  setInputRowsTo(overlayRowsForWrapped(wrapped.length, rowCap), { maxRows: rowCap });
  const tail = tailWithEllipsis(wrapped, inputRows);
  renderFrame({
    context,
    meta,
    tips,
    prefix: '',
    value: '',
    cursor: null,
    overlayLines: tail.visible,
  });
  moveTo(rows(), 1);
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
  contentTrackingActive = false;
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
  if (queue.isActive()) {
    // Record the park position — every queue op re-parks here so readline
    // echoes always land in the input row, even mid-stream.
    queue.park(row, col);
    return true;
  }
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
    topRuleLine,
    bottomRuleLine,
    padLine,
    drawableColumns,
    resetContentCursor,
    contentCursor: () => ({ row: contentCursorRow, col: contentCursorCol, active: contentTrackingActive }),
    overlayRowsForWrapped,
    FIXED_ROWS,
    MAX_INPUT_ROWS_CAP,
    DEFAULT_OVERLAY_MAX_ROWS,
    BRAND_LABEL,
  };
}
