/**
 * Kepler palette — semantic color tokens for the CLI.
 *
 * Every feature module imports from here, never from raw ANSI. Tokens resolve
 * at call time so changing terminal capabilities (resize, `refresh()`) is
 * picked up without restarting the process.
 *
 *   import { paint } from './palette.mjs';
 *   process.stdout.write(paint.brand.primary('KEPLER'));
 *
 * Composition (multiple styles on one string):
 *
 *   paint.bold(paint.brand.primary('KEPLER'))
 *
 * Tier behavior:
 *   truecolor → 24-bit RGB
 *   ansi256   → nearest 256-color index
 *   ansi16    → nearest basic color
 *   none      → identity (input returned unchanged)
 *
 * Brand identity (Mission Control PRD-055):
 *   primary  Deep Space Purple  #7c3aed
 *   accent   Stellar Magenta    #ec4899
 *   data     Neon Cyan          #22d3ee
 *   success  Aligned green      #22c55e
 *   warn     Soft amber         #eab308
 *   danger   Failure red        #ef4444
 *   dim      Sub-agent / hint   #6b7280
 *   text     Primary text       #c9d1d9
 */

import { term } from './term.mjs';

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

// ── Brand tokens ─────────────────────────────────────────────────────────
// Each token is { rgb: [r,g,b], ansi256: n, ansi16: 'fgName' }.
// `ansi16` maps to a key in BASIC_FG below.

export const TOKENS = Object.freeze({
  // Brand
  'brand.primary': { rgb: [124, 58, 237],  ansi256: 99,  ansi16: 'magenta' }, // #7c3aed
  'brand.accent':  { rgb: [236, 72, 153],  ansi256: 198, ansi16: 'magenta' }, // #ec4899
  'brand.data':    { rgb: [34, 211, 238],  ansi256: 87,  ansi16: 'cyan'    }, // #22d3ee

  // State
  'state.success': { rgb: [34, 197, 94],   ansi256: 41,  ansi16: 'green'   }, // #22c55e
  'state.warn':    { rgb: [234, 179, 8],   ansi256: 220, ansi16: 'yellow'  }, // #eab308
  'state.danger':  { rgb: [239, 68, 68],   ansi256: 196, ansi16: 'red'     }, // #ef4444

  // Text
  'text.primary':  { rgb: [201, 209, 217], ansi256: 250, ansi16: 'white'   }, // #c9d1d9
  'text.dim':      { rgb: [107, 114, 128], ansi256: 245, ansi16: 'gray'    }, // #6b7280
  'text.muted':    { rgb: [156, 163, 175], ansi256: 247, ansi16: 'gray'    }, // #9ca3af
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

function openForToken(token, capability) {
  const def = TOKENS[token];
  if (!def) return '';

  if (capability === 'truecolor') {
    const [r, g, b] = def.rgb;
    return `${ESC}38;2;${r};${g};${b}m`;
  }
  if (capability === 'ansi256') {
    return `${ESC}38;5;${def.ansi256}m`;
  }
  if (capability === 'ansi16') {
    return `${ESC}${BASIC_FG[def.ansi16] || BASIC_FG.white}m`;
  }
  return '';
}

function wrap(open) {
  if (!open) return (input) => String(input ?? '');
  // Re-open after every embedded reset so nested styles compose.
  // Cheap and predictable; most tool output is short enough that the cost
  // is negligible compared to writing to the TTY.
  return (input) => {
    const text = String(input ?? '');
    if (!text) return '';
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
  for (const token of Object.keys(TOKENS)) {
    const [ns, name] = token.split('.');
    if (!paint[ns]) paint[ns] = {};
    paint[ns][name] = (input) => {
      const t = term();
      if (!t.color) return String(input ?? '');
      return wrap(openForToken(token, t.colorLevel))(input);
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
    return { open: openForToken(key, t.colorLevel), close: RESET };
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
