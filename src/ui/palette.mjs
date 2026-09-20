/**
 * Bahulam semantic palette: ink, indigo, and calm status colors.
 * Resolved at call time for light/dark themes and terminal capabilities.
 * Truecolor, ANSI 256/16, NO_COLOR, and nested style composition are supported.
 * Use paint.brand.primary('bahulam.') instead of raw ANSI in feature modules.
 */

import { term } from './term.mjs';

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

// ── Brand tokens ─────────────────────────────────────────────────────────
// Each token is { rgb: [r,g,b], ansi256: n, ansi16: 'fgName' }.
// `ansi16` maps to a key in BASIC_FG below.

// Values mirror packages/config/src/bahulam-design.ts in the web platform.
// Light/dark variants keep the website identity legible in terminal themes.
export const TOKENS = Object.freeze({
  'brand.primary': { rgb: [190, 198, 255], ansi256: 147, ansi16: 'blue' },
  'brand.accent':  { rgb: [209, 184, 235], ansi256: 183, ansi16: 'magenta' },
  'brand.data':    { rgb: [145, 207, 216], ansi256: 116, ansi16: 'cyan' },
  'syntax.keyword': { rgb: [209, 184, 235], ansi256: 183, ansi16: 'magenta' },
  'syntax.string':  { rgb: [145, 207, 216], ansi256: 116, ansi16: 'cyan' },
  'syntax.literal': { rgb: [231, 196, 148], ansi256: 222, ansi16: 'yellow' },
  'state.success': { rgb: [154, 214, 184], ansi256: 151, ansi16: 'green' },
  'state.warn':    { rgb: [242, 203, 137], ansi256: 222, ansi16: 'yellow' },
  'state.danger':  { rgb: [255, 176, 182], ansi256: 217, ansi16: 'red' },
  'text.primary':  { rgb: [240, 241, 248], ansi256: 255, ansi16: 'white' },
  'text.dim':      { rgb: [183, 190, 206], ansi256: 250, ansi16: 'gray' },
  'text.muted':    { rgb: [183, 190, 206], ansi256: 250, ansi16: 'gray' },
});

export const LIGHT_TOKENS = Object.freeze({
  'brand.primary': { rgb: [48, 59, 160], ansi256: 61, ansi16: 'blue' },
  'brand.accent':  { rgb: [112, 83, 155], ansi256: 97, ansi16: 'magenta' },
  'brand.data':    { rgb: [38, 105, 120], ansi256: 23, ansi16: 'cyan' },
  'syntax.keyword': { rgb: [113, 76, 145], ansi256: 97, ansi16: 'magenta' },
  'syntax.string':  { rgb: [38, 105, 120], ansi256: 23, ansi16: 'cyan' },
  'syntax.literal': { rgb: [135, 88, 32], ansi256: 94, ansi16: 'yellow' },
  'state.success': { rgb: [40, 104, 79], ansi256: 23, ansi16: 'green' },
  'state.warn':    { rgb: [138, 91, 21], ansi256: 94, ansi16: 'yellow' },
  'state.danger':  { rgb: [173, 54, 63], ansi256: 131, ansi16: 'red' },
  'text.primary':  { rgb: [32, 35, 49], ansi256: 235, ansi16: 'black' },
  'text.dim':      { rgb: [96, 100, 114], ansi256: 242, ansi16: 'gray' },
  'text.muted':    { rgb: [96, 100, 114], ansi256: 242, ansi16: 'gray' },
});

// Diff surfaces are separate from foreground tokens. ANSI 16 palettes are
// user-defined and cannot reliably supply subtle, contrast-safe backgrounds.
export const DIFF_BACKGROUNDS = Object.freeze({
  dark: Object.freeze({
    // The 256-color cube has no muted near-black green/red. Neutral
    // surfaces plus the existing colored foreground are the calmer fallback.
    'diff.addLine':    { rgb: [34, 61, 49], ansi256: 236 },
    'diff.removeLine': { rgb: [68, 39, 48], ansi256: 237 },
    'diff.addWord':    { rgb: [43, 88, 62], ansi256: 238 },
    'diff.removeWord': { rgb: [104, 47, 59], ansi256: 239 },
  }),
  light: Object.freeze({
    'diff.addLine':    { rgb: [219, 238, 222], ansi256: 194 },
    'diff.removeLine': { rgb: [247, 221, 224], ansi256: 224 },
    'diff.addWord':    { rgb: [177, 218, 185], ansi256: 151 },
    'diff.removeWord': { rgb: [236, 179, 187], ansi256: 217 },
  }),
});

// ── ANSI 16-color foreground codes ───────────────────────────────────────

const BASIC_FG = {
  black:   30,
  red:     31,
  green:   32,
  yellow:  33,
  blue:    34,
  magenta: 35,
  cyan:    36,
  white:   37,
  gray:    90,
};

// ── Style codes (work at every tier) ─────────────────────────────────────

const STYLE_CODES = {
  bold:      [1, 22],
  dim:       [2, 22],
  italic:    [3, 23],
  underline: [4, 24],
  inverse:   [7, 27],
  strike:    [9, 29],
};

// ── Open / close sequence builders ───────────────────────────────────────

function openForToken(token, capability, appearance) {
  const surface = DIFF_BACKGROUNDS[appearance === 'light' ? 'light' : 'dark'][token];
  const def = surface || (appearance === 'light' ? LIGHT_TOKENS : TOKENS)[token];
  if (!def) return '';
  const channel = surface ? 48 : 38;

  if (capability === 'truecolor') {
    const [r, g, b] = def.rgb;
    return `${ESC}${channel};2;${r};${g};${b}m`;
  }
  if (capability === 'ansi256') {
    return `${ESC}${channel};5;${def.ansi256}m`;
  }
  if (capability === 'ansi16' && !surface) {
    return `${ESC}${BASIC_FG[def.ansi16] || BASIC_FG.white}m`;
  }
  return '';
}

function wrap(open, background = false) {
  if (!open) return (input) => String(input ?? '');
  // Re-open after every embedded reset so nested styles compose.
  // Cheap and predictable; most tool output is short enough that the cost
  // is negligible compared to writing to the TTY.
  return (input) => {
    const text = String(input ?? '');
    if (!text) return '';
    if (background) {
      // Restore an outer row after a word background closes, and after
      // foreground resets. Only close the background: never leak it into
      // the next line or discard the caller's foreground/style state.
      return `${open}${text.replace(/\x1b\[(?:0|49)m/g, reset => reset + open)}${ESC}49m`;
    }
    if (!text.includes(RESET)) return `${open}${text}${RESET}`;
    return `${open}${text.split(RESET).join(`${RESET}${open}`)}${RESET}`;
  };
}

function styleWrap(openCode, closeCode) {
  return (input) => {
    const text = String(input ?? '');
    if (!text) return '';
    // No color tier check here — styles like bold/dim work even in ansi16.
    if (!term().color) return text;
    const open = `${ESC}${openCode}m`;
    const close = `${ESC}${closeCode}m`;
    if (!text.includes(close)) return `${open}${text}${close}`;
    return `${open}${text.split(close).join(`${close}${open}`)}${close}`;
  };
}

// ── Build a structured `paint` object once per token ─────────────────────

function buildPaint() {
  const paint = {};

  // Brand / state / text colorizers, nested by namespace.
  for (const token of [...Object.keys(TOKENS), ...Object.keys(DIFF_BACKGROUNDS.dark)]) {
    const [ns, name] = token.split('.');
    if (!paint[ns]) paint[ns] = {};
    paint[ns][name] = (input) => {
      const t = term();
      if (!t.color) return String(input ?? '');
      return wrap(openForToken(token, t.colorLevel, t.appearance), ns === 'diff')(input);
    };
  }

  // Style colorizers (callable directly).
  for (const [style, [open, close]] of Object.entries(STYLE_CODES)) {
    paint[style] = styleWrap(open, close);
  }

  // Compose helper — apply multiple styles left-to-right.
  paint.compose = (...fns) => (input) =>
    fns.reduce((acc, fn) => (typeof fn === 'function' ? fn(acc) : acc), input);

  // Raw token accessor for callers that need to inject codes around their
  // own text (e.g. status bar repaint loops that re-style a buffer).
  paint.token = (key) => {
    const t = term();
    if (!t.color) return { open: '', close: '' };
    const open = openForToken(key, t.colorLevel, t.appearance);
    return { open, close: open ? (key.startsWith('diff.') ? `${ESC}49m` : RESET) : '' };
  };

  return paint;
}

export const paint = buildPaint();

// ── Plain-text helper (always strips colors) ─────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function strip(input) {
  return String(input ?? '').replace(ANSI_RE, '');
}

/**
 * Visible length of a string (ignoring ANSI codes).
 * Surrogate pairs (emoji) count as 1 visual cell for layout purposes — this
 * is consistent with most terminals' rendering of single-codepoint emoji.
 */
export function width(input) {
  const plain = strip(input);
  // Strip variation selectors so "🛰️" measures as one cell.
  return [...plain.replace(/︎|️/g, '')].length;
}

// ── Backwards compatibility re-exports ───────────────────────────────────
// `ansi.mjs` and other legacy modules import these names. New code should
// prefer `paint.brand.primary(...)` etc.

export const RESET_CODE = RESET;
