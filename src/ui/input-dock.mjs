/**
 * Fixed input dock.
 *
 * Reserves a few rows at the bottom of the terminal so agent/tool output
 * scrolls above the prompt. The readline prompt itself owns the input row.
 */

import { paint, width as visibleWidth } from './palette.mjs';
import { term, onResize } from './term.mjs';

const ESC = '\x1b[';
const OUT = process.stderr;
const DEFAULT_ROWS = 4;

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
  return Math.max(8, term().rows || 24);
}

function cols() {
  return Math.max(40, term().columns || 80);
}

function contentBottomRow() {
  return Math.max(1, rows() - reservedRows);
}

function boundaryRow() {
  return contentBottomRow() + 1;
}

function inputRow() {
  return contentBottomRow() + 2;
}

function tipsRow() {
  return contentBottomRow() + 3;
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

function boundaryLine(context = '') {
  const w = cols();
  const ctx = fitText(context, Math.max(0, Math.floor(w / 2)));
  if (!ctx) return paint.text.dim('─'.repeat(w));
  const ctxWidth = visibleWidth(ctx);
  const left = Math.max(8, w - ctxWidth - 4);
  return paint.text.dim('─'.repeat(left)) + ' ' + paint.text.dim(ctx) + ' ' + paint.text.dim('─'.repeat(Math.max(0, w - left - ctxWidth - 2)));
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
  moveTo(boundaryRow(), 1);
  clearLine();
  write(padLine(boundaryLine(lastFrame.context)));
  moveTo(tipsRow(), 1);
  clearLine();
  write(padLine(`  ${paint.text.dim(fitText(lastFrame.tips, cols() - 4))}`));
  moveTo(rows(), 1);
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

  reservedRows = Math.max(3, Math.min(6, Number.parseInt(String(requestedRows), 10) || DEFAULT_ROWS));
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

export function prepareInputPrompt({ context = '', tips = '' } = {}) {
  if (!mounted) return false;
  renderFrame({ context, tips });
  moveTo(inputRow(), 1);
  clearLine();
  return true;
}

export function clearInputPrompt() {
  if (!mounted) return false;
  saveCursor();
  moveTo(inputRow(), 1);
  clearLine();
  restoreCursor();
  return true;
}

export function renderDockInput(prefix, value, { context = '', tips = '' } = {}) {
  if (!mounted) return false;
  renderFrame({ context, tips });
  moveTo(inputRow(), 1);
  clearLine();
  write(`${prefix}${value || ''}`);
  return true;
}
