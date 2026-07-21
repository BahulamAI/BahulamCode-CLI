/**
 * ANSI Terminal Renderer — cursor control, box drawing, status bars.
 *
 * Color helpers (the `c` object) now route through the semantic palette
 * (`src/ui/palette.mjs`) so the entire CLI honors the Kepler brand and
 * tier fallbacks (truecolor, ansi256, ansi16, none) without touching
 * each call site. Hot-swap-friendly: external semantics like `c.red`,
 * `c.bold`, `c.cyan` are preserved as the legacy contract; new code
 * should prefer importing `paint` directly.
 */

import { paint } from '../ui/palette.mjs';

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
// Legacy color names re-mapped onto semantic palette tokens. The CLI's
// branding is centralized in palette.mjs; this object is preserved only
// so existing imports keep compiling. Internal Kepler color choices are
// documented next to each mapping for the next code review.

const identity = (s) => String(s ?? '');

export const c = {
  reset:       identity,                       // palette already wraps with RESET

  // Styles — work at every tier
  bold:        paint.bold,
  dim:         paint.dim,
  italic:      paint.italic,
  underline:   paint.underline,

  // State semantics
  red:         paint.state.danger,             // failure / hard error
  green:       paint.state.success,            // pass / aligned
  yellow:      paint.state.warn,               // soft warn / retry

  // Brand semantics
  blue:        paint.brand.primary,            // headers, primary brand
  magenta:     paint.brand.accent,             // attention required
  brand:       paint.brand.primary,            // primary brand surface
  cyan:        paint.brand.data,               // code / file paths
  cyanRegular: paint.brand.data,
  cyanBold:    (s) => paint.bold(paint.brand.data(s)),

  // Text semantics
  white:       paint.text.primary,             // primary text
  gray:        paint.text.dim,                 // hints, metadata, dim text

  // Backgrounds — kept as raw ANSI; rarely used and have no palette analog
  bgRed:       (s) => `${ESC}41m${String(s ?? '')}${ESC}0m`,
  bgGreen:     (s) => `${ESC}42m${String(s ?? '')}${ESC}0m`,
  bgCyan:      (s) => `${ESC}46m${String(s ?? '')}${ESC}0m`,
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
  return String(str ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function visibleWidth(str) {
  let width = 0;
  for (const char of stripAnsi(str)) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code === 0) continue;
    if (code < 32 || (code >= 0x7f && code < 0xa0)) continue;
    if (code >= 0x300 && code <= 0x36f) continue;
    if (code >= 0xfe00 && code <= 0xfe0f) continue;
    if (isWideCodePoint(code)) width += 2;
    else width += 1;
  }
  return width;
}

function isWideCodePoint(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  );
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

  const lines = normalizeMarkdownFlow(text).split('\n');
  const out = [];
  let inCodeBlock = false;
  let codeLang = '';
  const columns = markdownColumns();

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
      out.push(...renderWrappedMarkdownLine(c.gray('  │') + ' ', '    ', content, columns, c.italic));
      continue;
    }

    // Task lists
    const task = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.*)/);
    if (task) {
      const done = task[2].toLowerCase() === 'x';
      const renderState = done ? c.green : c.gray;
      const marker = done ? '✓' : '○';
      out.push(...renderWrappedMarkdownLine(
        `${task[1]}  `,
        `${task[1]}    `,
        `${marker} ${task[3]}`,
        columns,
        renderState,
      ));
      continue;
    }

    // Lists
    if (/^\s*[-*]\s/.test(line)) {
      const indent = line.match(/^(\s*)/)[1];
      const content = line.replace(/^\s*[-*]\s/, '');
      out.push(...renderWrappedMarkdownLine(
        `${indent}  ${c.brand('•')} `,
        `${indent}    `,
        content,
        columns,
        inlineMarkdown,
      ));
      continue;
    }

    // Numbered lists
    if (/^\s*\d+\.\s/.test(line)) {
      const match = line.match(/^(\s*)(\d+)\.\s(.*)/);
      if (match) {
        const marker = `${match[2]}.`;
        out.push(...renderWrappedMarkdownLine(
          `${match[1]}  ${c.brand(marker)} `,
          `${match[1]}${' '.repeat(marker.length + 3)}`,
          match[3],
          columns,
          inlineMarkdown,
        ));
        continue;
      }
    }

    // Regular paragraph line. Wrap before writing so the terminal does not
    // split long words at the viewport edge.
    const indent = line.match(/^(\s*)/)[1] || '';
    const content = line.slice(indent.length);
    out.push(...renderWrappedMarkdownLine(indent, indent, content, columns, inlineMarkdown));
  }

  return out.join('\n');
}

function normalizeMarkdownFlow(text) {
  const source = String(text || '').split('\n');
  const normalized = [];
  let paragraph = [];
  let inCodeBlock = false;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    normalized.push(paragraph.map(line => line.trim()).join(' '));
    paragraph = [];
  };

  const isStructural = (line) => {
    const trimmed = line.trim();
    return (
      !trimmed ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('>') ||
      trimmed.startsWith('|') ||
      /^---+$/.test(trimmed) ||
      /^\s*[-*]\s+/.test(line) ||
      /^\s*[-*]\s+\[[ xX]\]\s+/.test(line) ||
      /^\s*\d+\.\s+/.test(line)
    );
  };

  const appendToPreviousList = (line) => {
    if (!normalized.length) return false;
    const previous = normalized[normalized.length - 1];
    if (!/^\s*(?:[-*]|\d+\.)\s+/.test(previous)) return false;
    if (isStructural(line)) return false;
    normalized[normalized.length - 1] = `${previous} ${line.trim()}`;
    return true;
  };

  for (const line of source) {
    if (line.trimStart().startsWith('```')) {
      flushParagraph();
      normalized.push(line);
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      normalized.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      normalized.push('');
      continue;
    }

    if (appendToPreviousList(line)) {
      continue;
    }

    if (isStructural(line)) {
      flushParagraph();
      normalized.push(line);
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return normalized.join('\n');
}

function markdownColumns() {
  // Every content call site writes rendered lines with a leading "  " (2 col
  // indent). If we wrap at the full terminal width, those two extra columns
  // push each line past the viewport and the terminal hard-wraps at the
  // character boundary — splitting words like "wro/ng" or "multip/le". Reserve
  // that indent (plus one column of safety for wide-char surprises) so the
  // renderer's soft-wrap does the whole job.
  const raw = process.stdout.columns || process.stderr.columns || 100;
  return Math.max(40, raw - 3);
}

function renderWrappedMarkdownLine(firstPrefix, continuationPrefix, content, columns, renderContent) {
  const firstWidth = Math.max(12, columns - stripAnsi(firstPrefix).length);
  const nextWidth = Math.max(12, columns - stripAnsi(continuationPrefix).length);
  const wrapped = wrapWords(String(content || ''), firstWidth, nextWidth);
  return wrapped.map((part, index) => {
    const prefix = index === 0 ? firstPrefix : continuationPrefix;
    return `${prefix}${renderContent(part)}`;
  });
}

function wrapWords(text, firstWidth, nextWidth) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [''];

  const lines = [];
  let width = firstWidth;
  let current = '';

  for (const word of words) {
    if (!current && word.length > width) {
      lines.push(...splitLongWord(word, width));
      width = nextWidth;
      current = '';
      continue;
    }
    if (!current) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
      continue;
    }
    lines.push(current);
    width = nextWidth;
    if (word.length > width) {
      lines.push(...splitLongWord(word, width));
      current = '';
      continue;
    }
    current = word;
  }

  if (current) lines.push(current);
  return lines;
}

function splitLongWord(word, width) {
  const chunks = [];
  const safeWidth = Math.max(8, width);
  for (let i = 0; i < word.length; i += safeWidth) {
    chunks.push(word.slice(i, i + safeWidth));
  }
  return chunks;
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
  const widths = markdownTableWidths(headers, rows, columnCount);
  const border = c.gray(`  ${widths.map(width => '─'.repeat(width + 2)).join('┼')}`);
  const formatRow = (row, header = false) => renderMarkdownTableRow(row, widths, header);
  return [formatRow(headers, true), border, ...rows.map(row => formatRow(row))];
}

function markdownTableWidths(headers, rows, columnCount) {
  const columns = markdownColumns();
  const contentBudget = Math.max(columnCount * 8, columns - (3 * columnCount) - 1);
  const desired = Array.from({ length: columnCount }, (_, index) => {
    const values = [headers[index] || '', ...rows.map(row => row[index] || '')];
    return Math.max(...values.map(value => visibleWidth(markdownTableCellText(value))), 3);
  });

  if (columnCount === 1) return [Math.min(desired[0], contentBudget)];

  if (columnCount === 2) {
    const firstMax = Math.max(12, Math.min(32, contentBudget - 24));
    const first = Math.max(8, Math.min(desired[0], firstMax));
    const second = Math.max(16, contentBudget - first);
    return [first, second];
  }

  const minWidths = desired.map((width, index) => {
    const headerWidth = visibleWidth(markdownTableCellText(headers[index] || ''));
    return Math.min(width, Math.max(8, Math.min(headerWidth || 8, 16)));
  });
  const widths = desired.map(width => Math.min(width, 30));

  while (widths.reduce((sum, width) => sum + width, 0) > contentBudget) {
    let shrinkIndex = -1;
    let widest = -1;
    for (let index = 0; index < widths.length; index++) {
      if (widths[index] > minWidths[index] && widths[index] > widest) {
        widest = widths[index];
        shrinkIndex = index;
      }
    }
    if (shrinkIndex < 0) break;
    widths[shrinkIndex]--;
  }

  return widths;
}

function renderMarkdownTableRow(row, widths, header = false) {
  const wrapped = widths.map((width, index) => {
    const value = markdownTableCellText(row[index] || '');
    const lines = wrapWords(value, width, width);
    return lines.length ? lines : [''];
  });
  const height = Math.max(...wrapped.map(lines => lines.length), 1);
  const rendered = [];

  for (let lineIndex = 0; lineIndex < height; lineIndex++) {
    const cells = widths.map((width, index) => {
      const value = wrapped[index][lineIndex] || '';
      const padded = value + ' '.repeat(Math.max(0, width - visibleWidth(value)));
      return header ? c.bold(padded) : padded;
    });
    rendered.push(`  ${cells.map(cell => ` ${cell} `).join(c.gray('│'))}`);
  }

  return rendered.join('\n');
}

function markdownTableCellText(value) {
  return stripAnsi(String(value || ''))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
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

import { calculateCost, formatCostValue, costToCredits, formatCredits } from '../core/pricing.mjs';

/**
 * Format cost from token counts.
 * Accepts either (inputTokens, outputTokens) for legacy calls,
 * or a single usage object with optional per-model breakdown.
 */
export function formatCost(inputOrUsage, outputTokens) {
  if (typeof inputOrUsage === 'object' && inputOrUsage !== null) {
    const { total } = calculateCost(inputOrUsage);
    return formatCredits(costToCredits(total));
  }
  const { total } = calculateCost({
    input_tokens: inputOrUsage || 0,
    output_tokens: outputTokens || 0,
  });
  return formatCredits(costToCredits(total));
}
