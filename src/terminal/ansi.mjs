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
  underline: (s) => `${ESC}4m${s}${ESC}0m`,
  red:     (s) => `${ESC}31m${s}${ESC}0m`,
  green:   (s) => `${ESC}32m${s}${ESC}0m`,
  yellow:  (s) => `${ESC}33m${s}${ESC}0m`,
  blue:    (s) => `${ESC}34m${s}${ESC}0m`,
  magenta: (s) => `${ESC}35m${s}${ESC}0m`,
  brand:   (s) => `${ESC}36m${s}${ESC}0m`,
  cyan:    (s) => `${ESC}94m${s}${ESC}0m`,
  cyanRegular: (s) => `${ESC}36m${s}${ESC}0m`,
  cyanBold: (s) => `${ESC}1;36m${s}${ESC}0m`,
  white:   (s) => `${ESC}97m${s}${ESC}0m`,
  gray:    (s) => `${ESC}90m${s}${ESC}0m`,
  bgRed:   (s) => `${ESC}41m${s}${ESC}0m`,
  bgGreen: (s) => `${ESC}42m${s}${ESC}0m`,
  bgCyan:  (s) => `${ESC}46m${s}${ESC}0m`,
};

// ── Box Drawing ──

const BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };

export function drawBox(content, { borderColor = 'brand', width } = {}) {
  const w = width || (process.stdout.columns || 80) - 2;
  const colorFn = c[borderColor] || c.brand;
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
  return `${c.brand(frame)} ${c.brand(text)}`;
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

// ── Markdown Rendering ──

/**
 * Render markdown to ANSI-styled terminal text.
 * Supports: headers, bold, italic, code, code blocks, tables, blockquotes,
 * task lists, lists, and links.
 */
export function renderMarkdown(text) {
  if (!text) return '';

  const lines = text.split('\n');
  const out = [];
  let inCodeBlock = false;
  let codeLang = '';

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    // Code block start/end
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        out.push(c.gray('  └' + '─'.repeat(40)));
        inCodeBlock = false;
        codeLang = '';
      } else {
        codeLang = line.trim().slice(3).trim();
        out.push(c.gray('  ┌' + '─'.repeat(4) + (codeLang ? ` ${codeLang} ` : '') + '─'.repeat(Math.max(0, 35 - codeLang.length))));
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      out.push(c.gray('  │ ') + renderCodeLine(line, codeLang));
      continue;
    }

    // GitHub-flavored Markdown table
    if (
      line.includes('|') &&
      lineIndex + 1 < lines.length &&
      isTableSeparator(lines[lineIndex + 1])
    ) {
      const headers = parseTableRow(line);
      const rows = [];
      lineIndex += 2;
      while (lineIndex < lines.length && lines[lineIndex].includes('|') && lines[lineIndex].trim()) {
        rows.push(parseTableRow(lines[lineIndex]));
        lineIndex++;
      }
      lineIndex--;
      out.push(...renderMarkdownTable(headers, rows));
      continue;
    }

    // Headers
    if (line.startsWith('### ')) {
      out.push(c.bold(c.brand(line.slice(4))));
      continue;
    }
    if (line.startsWith('## ')) {
      out.push(c.bold(c.brand(line.slice(3))));
      continue;
    }
    if (line.startsWith('# ')) {
      out.push(c.bold(c.brand(line.slice(2))));
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      out.push(c.gray('─'.repeat(40)));
      continue;
    }

    // Blockquotes
    if (/^\s*>\s?/.test(line)) {
      const content = line.replace(/^\s*>\s?/, '');
      out.push(`${c.gray('  │')} ${c.italic(content)}`);
      continue;
    }

    // Task lists
    const task = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.*)/);
    if (task) {
      const done = task[2].toLowerCase() === 'x';
      const renderState = done ? c.green : c.gray;
      const marker = done ? '✓' : '○';
      out.push(`${task[1]}  ${renderState(`${marker} ${task[3]}`)}`);
      continue;
    }

    // Lists
    if (/^\s*[-*]\s/.test(line)) {
      const indent = line.match(/^(\s*)/)[1];
      const content = line.replace(/^\s*[-*]\s/, '');
      out.push(`${indent}  ${c.brand('•')} ${inlineMarkdown(content)}`);
      continue;
    }

    // Numbered lists
    if (/^\s*\d+\.\s/.test(line)) {
      const match = line.match(/^(\s*)(\d+)\.\s(.*)/);
      if (match) {
        out.push(`${match[1]}  ${c.brand(match[2] + '.')} ${inlineMarkdown(match[3])}`);
        continue;
      }
    }

    // Regular line with inline formatting
    out.push(inlineMarkdown(line));
  }

  return out.join('\n');
}

function renderCodeLine(line, language) {
  const lang = String(language || '').toLowerCase();
  if (lang === 'diff') {
    if (line.startsWith('+')) return c.green(line);
    if (line.startsWith('-')) return c.red(line);
    if (line.startsWith('@@')) return c.brand(line);
  }
  if (lang === 'json' || lang === 'yaml' || lang === 'yml' || lang === 'toml') {
    return line.replace(/^(\s*)(["']?[\w.-]+["']?)(\s*[:=])(.*)$/, (_, space, key, separator, value) =>
      `${space}${c.cyanBold(key)}${c.gray(separator)}${c.cyanRegular(value)}`
    );
  }
  return c.cyan(line);
}

function parseTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function isTableSeparator(line) {
  const cells = parseTableRow(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function renderMarkdownTable(headers, rows) {
  const columnCount = Math.max(headers.length, ...rows.map(row => row.length));
  const widths = Array.from({ length: columnCount }, (_, index) => {
    const values = [headers[index] || '', ...rows.map(row => row[index] || '')];
    return Math.min(40, Math.max(...values.map(value => stripAnsi(value).length), 3));
  });
  const border = c.gray(`  ${widths.map(width => '─'.repeat(width + 2)).join('┼')}`);
  const formatRow = (row, header = false) => {
    const cells = widths.map((width, index) => {
      const value = truncate(row[index] || '', width);
      const padded = value + ' '.repeat(Math.max(0, width - stripAnsi(value).length));
      return header ? c.bold(padded) : inlineMarkdown(padded);
    });
    return `  ${cells.map(cell => ` ${cell} `).join(c.gray('│'))}`;
  };
  return [formatRow(headers, true), border, ...rows.map(row => formatRow(row))];
}

/**
 * Apply inline markdown: **bold**, *italic*, `code`, [links](url)
 */
function inlineMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, (_, s) => c.bold(s))
    .replace(/\*(.+?)\*/g, (_, s) => c.italic(s))
    .replace(/`(.+?)`/g, (_, s) => c.cyan(s))
    .replace(
      /\[(.+?)\]\((.+?)\)/g,
      (_, label, url) => `${c.underline(c.white(label))} ${c.gray('(' + url + ')')}`,
    );
}

// ── Diff Display ──

/**
 * Render a unified diff with +/- color highlighting.
 */
export function renderDiff(diffText) {
  if (!diffText) return '';
  const lines = diffText.split('\n');
  const out = [];
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      out.push(c.bold(line));
    } else if (line.startsWith('@@')) {
      out.push(c.brand(line));
    } else if (line.startsWith('+')) {
      out.push(c.green(line));
    } else if (line.startsWith('-')) {
      out.push(c.red(line));
    } else {
      out.push(c.gray(line));
    }
  }
  return out.join('\n');
}

// ── Info Panel ──

/**
 * Display a labeled info panel (no box borders, just indented content).
 * @param {string} label - Panel title
 * @param {Array<[string, string]>} rows - [label, value] pairs
 * @param {string} [color='brand'] - Title color
 */
export function infoPanel(label, rows, color = 'brand') {
  const colorFn = c[color] || c.brand;
  write(`  ${colorFn(c.bold(label))}\n`);
  write(`  ${c.gray('─'.repeat(Math.min(40, (process.stdout.columns || 80) - 4)))}\n`);
  for (const [key, val] of rows) {
    write(`  ${c.gray(key.padEnd(14))} ${val}\n`);
  }
  write('\n');
}

// ── Table Display ──

/**
 * Render a simple table.
 * @param {string[]} headers
 * @param {string[][]} rows
 */
export function table(headers, rows) {
  const widths = headers.map((h, i) => {
    const maxRow = rows.reduce((max, row) => Math.max(max, stripAnsi(row[i] || '').length), 0);
    return Math.max(stripAnsi(h).length, maxRow) + 2;
  });

  // Header
  write('  ' + headers.map((h, i) => c.bold(c.brand(h.padEnd(widths[i])))).join('') + '\n');
  write('  ' + widths.map(w => c.gray('─'.repeat(w))).join('') + '\n');

  // Rows
  for (const row of rows) {
    write('  ' + row.map((cell, i) => {
      const plain = stripAnsi(cell || '');
      const pad = Math.max(0, widths[i] - plain.length);
      return (cell || '') + ' '.repeat(pad);
    }).join('') + '\n');
  }
}

// ── Elapsed Timer ──

export function formatElapsed(startMs) {
  const s = Math.floor((Date.now() - startMs) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

// ── Format Cost ──

import { calculateCost, formatCostValue } from '../core/pricing.mjs';

/**
 * Format cost from token counts.
 * Accepts either (inputTokens, outputTokens) for legacy calls,
 * or a single usage object with optional per-model breakdown.
 */
export function formatCost(inputOrUsage, outputTokens) {
  // New API: pass a usage object directly
  if (typeof inputOrUsage === 'object' && inputOrUsage !== null) {
    const { total } = calculateCost(inputOrUsage);
    return formatCostValue(total);
  }
  // Legacy API: flat input/output token counts, default pricing
  const { total } = calculateCost({
    input_tokens: inputOrUsage || 0,
    output_tokens: outputTokens || 0,
  });
  return formatCostValue(total);
}
