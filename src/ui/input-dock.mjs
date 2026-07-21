/**
 * Fixed input dock.
 *
 * Reserves a few rows at the bottom of the terminal so agent/tool output
 * scrolls above the prompt. The readline prompt itself owns the input row.
 *
 * Layout (double-rule sandwich):
 *   ══════════════════ context ══════════   ← top rule (brand)
 *      You › build a login page             ← input row (indented)
 *   ══════════════════════════════════════   ← bottom rule (dim)
 *      [Enter] send · [/] commands …        ← tips row
 *   (one blank row at very bottom for cursor safety)
 */

import { paint, width as visibleWidth } from './palette.mjs';
import { term, onResize } from './term.mjs';

const ESC = '\x1b[';
const OUT = process.stderr;
const DEFAULT_ROWS = 5;
const INPUT_INDENT = 3;

let mounted = false;
let reservedRows = DEFAULT_ROWS;
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

function topRuleRow()    { return contentBottomRow() + 1; }
function inputRow()      { return contentBottomRow() + 2; }
function bottomRuleRow() { return contentBottomRow() + 3; }
function tipsRow()       { return contentBottomRow() + 4; }

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

function clearInputRow() {
  saveCursor();
  moveTo(inputRow(), 1);
  clearLine();
  restoreCursor();
}

export function isInputDockMounted() {
  return mounted;
}

export function mountInputDock({ rows: requestedRows = DEFAULT_ROWS } = {}) {
  const t = term();
  if (!t.isTTY || t.plain || process.env.KEPLER_FIXED_INPUT === '0') return false;
  if (mounted) return true;

  reservedRows = Math.max(4, Math.min(7, Number.parseInt(String(requestedRows), 10) || DEFAULT_ROWS));
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
  clearInputRow();
  renderFrame({ context, tips });
  moveTo(inputRow(), INPUT_INDENT + 1);
  return true;
}

export function clearInputPrompt() {
  if (!mounted) return false;
  clearInputRow();
  renderFrame(lastFrame);
  return true;
}

export function renderDockInput(prefix, value, { context = '', tips = '' } = {}) {
  if (!mounted) return false;
  clearInputRow();
  renderFrame({ context, tips });
  moveTo(inputRow(), INPUT_INDENT + 1);
  write(`${prefix}${value || ''}`);
  return true;
}

export function focusDockInput(prefix, value = '') {
  if (!mounted) return false;
  const w = cols();
  const pos = INPUT_INDENT + visibleWidth(`${prefix || ''}${value || ''}`);
  // Input never wraps within the dock — clamp to the input row.
  const col = Math.min(w, pos + 1);
  moveTo(inputRow(), col);
  return true;
}

export function inputRowColumn() {
  return INPUT_INDENT + 1;
}
