/**
 * ANSI Terminal Renderer — zero dependencies, zero flickering.
 *
 * Provides cursor control, colors, box drawing, progress bars,
 * in-place updates, and a persistent status bar.
 */

const ESC = '\x1b[';
const write = (s) => process.stderr.write(s);

// ── Cursor Control ──

export const cursor = {
  hide:      () => write(`${ESC}?25l`),
  show:      () => write(`${ESC}?25h`),
  save:      () => write(`${ESC}s`),
  restore:   () => write(`${ESC}u`),
  to:        (row, col) => write(`${ESC}${row};${col}H`),
  up:        (n = 1) => write(`${ESC}${n}A`),
  down:      (n = 1) => write(`${ESC}${n}B`),
  right:     (n = 1) => write(`${ESC}${n}C`),
  left:      (n = 1) => write(`${ESC}${n}D`),
  col:       (n = 1) => write(`${ESC}${n}G`),
  clearLine: () => write(`${ESC}2K`),
  clearDown: () => write(`${ESC}J`),
  clearScreen: () => write(`${ESC}2J${ESC}H`),
};

// ── Colors ──

export const c = {
  reset:   (s) => `${ESC}0m${s}${ESC}0m`,
  bold:    (s) => `${ESC}1m${s}${ESC}0m`,
  dim:     (s) => `${ESC}2m${s}${ESC}0m`,
  italic:  (s) => `${ESC}3m${s}${ESC}0m`,
  red:     (s) => `${ESC}31m${s}${ESC}0m`,
  green:   (s) => `${ESC}32m${s}${ESC}0m`,
  yellow:  (s) => `${ESC}33m${s}${ESC}0m`,
  blue:    (s) => `${ESC}34m${s}${ESC}0m`,
  magenta: (s) => `${ESC}35m${s}${ESC}0m`,
  cyan:    (s) => `${ESC}36m${s}${ESC}0m`,
  gray:    (s) => `${ESC}90m${s}${ESC}0m`,
  bgRed:   (s) => `${ESC}41m${s}${ESC}0m`,
  bgGreen: (s) => `${ESC}42m${s}${ESC}0m`,
  bgCyan:  (s) => `${ESC}46m${s}${ESC}0m`,
};

// ── Box Drawing ──

const BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };

export function drawBox(content, { borderColor = 'cyan', width } = {}) {
  const w = width || (process.stdout.columns || 80) - 2;
  const colorFn = c[borderColor] || c.cyan;
  const lines = content.split('\n');

  write(colorFn(`${BOX.tl}${BOX.h.repeat(w)}${BOX.tr}`) + '\n');
  for (const line of lines) {
    const plain = stripAnsi(line);
    const pad = Math.max(0, w - plain.length);
    write(`${colorFn(BOX.v)} ${line}${' '.repeat(pad)}${colorFn(BOX.v)}\n`);
  }
  write(colorFn(`${BOX.bl}${BOX.h.repeat(w)}${BOX.br}`) + '\n');
}

// ── Progress Bar ──

export function progressBar(percent, width = 20, label = '') {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * width);
  const empty = width - filled;
  const color = p < 50 ? c.green : p < 80 ? c.yellow : c.red;
  const bar = color('█'.repeat(filled)) + c.gray('░'.repeat(empty));
  const pct = `${Math.round(p)}%`.padStart(4);
  return label ? `${c.gray(label.padEnd(8))}${bar} ${pct}` : `${bar} ${pct}`;
}

// ── Spinner ──

const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
let _spinnerIdx = 0;

export function spinner(text) {
  const frame = SPINNER_FRAMES[_spinnerIdx % SPINNER_FRAMES.length];
  _spinnerIdx++;
  return `${c.cyan(frame)} ${c.cyan(text)}`;
}

// ── In-Place Update ──

let _lastLineCount = 0;

/**
 * Write text, erasing the previous in-place output.
 * Call with '' to clear.
 */
export function inPlace(text) {
  // Erase previous lines
  if (_lastLineCount > 0) {
    for (let i = 0; i < _lastLineCount; i++) {
      cursor.up();
      cursor.clearLine();
      cursor.col(1);
    }
  }
  if (text) {
    write(text + '\n');
    _lastLineCount = text.split('\n').length;
  } else {
    _lastLineCount = 0;
  }
}

// ── Status Bar (persistent bottom) ──

export function statusBar(parts) {
  const sep = c.gray(' ┃ ');
  const line = parts.join(sep);
  // Save position, go to bottom, write, restore
  const rows = process.stdout.rows || 30;
  cursor.save();
  cursor.to(rows, 1);
  cursor.clearLine();
  write(` ${line}`);
  cursor.restore();
}

// ── Helpers ──

export function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function truncate(str, max) {
  if (!str) return '';
  const plain = stripAnsi(str);
  if (plain.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

export function hr(char = '─', color = 'gray') {
  const w = process.stdout.columns || 80;
  write(c[color](char.repeat(w)) + '\n');
}
