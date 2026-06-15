/**
 * Terminal capability detection.
 *
 * Resolves once at import. Re-evaluation requires `refresh()` (used by tests
 * and the rare command that toggles a relevant env var mid-process).
 *
 * Capability tiers (highest first):
 *   truecolor - 24-bit RGB (e.g. iTerm2, modern xterm, Windows Terminal)
 *   ansi256  - 256-color palette
 *   ansi16   - basic 16 colors
 *   none     - no color (NO_COLOR=1, dumb terminal, non-TTY without override)
 */

const TRUECOLOR_TERMS = new Set([
  'truecolor',
  '24bit',
  '24-bit',
]);

const ANSI256_TERMS = [
  /-256(color)?$/i,
  /^xterm/i,
  /^screen/i,
  /^tmux/i,
  /^rxvt-unicode/i,
  /^alacritty/i,
];

const DUMB_TERMS = new Set(['', 'dumb', 'unknown']);

function readEnv() {
  const env = process.env || {};
  return {
    NO_COLOR: env.NO_COLOR,
    FORCE_COLOR: env.FORCE_COLOR,
    KEPLER_PLAIN: env.KEPLER_PLAIN,
    COLORTERM: (env.COLORTERM || '').toLowerCase(),
    TERM: (env.TERM || '').toLowerCase(),
    TERM_PROGRAM: env.TERM_PROGRAM || '',
    CI: env.CI,
  };
}

function detectColorLevel(env, isTTY) {
  // Hard opt-out (https://no-color.org). Honored even on TTYs.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  if (env.KEPLER_PLAIN === '1') return 'none';

  // Hard opt-in. FORCE_COLOR=1|2|3 maps to ansi16|ansi256|truecolor.
  // FORCE_COLOR with no value or =true falls through to detection.
  if (env.FORCE_COLOR !== undefined) {
    const v = String(env.FORCE_COLOR).trim();
    if (v === '0' || v === 'false') return 'none';
    if (v === '1') return 'ansi16';
    if (v === '2') return 'ansi256';
    if (v === '3') return 'truecolor';
    // Any other truthy value: continue detection but allow non-TTY.
    isTTY = true;
  }

  // No TTY and not forced: no color.
  if (!isTTY) return 'none';

  if (DUMB_TERMS.has(env.TERM)) return 'none';

  if (TRUECOLOR_TERMS.has(env.COLORTERM)) return 'truecolor';

  // Some terminal emulators advertise truecolor through TERM_PROGRAM.
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm') {
    return 'truecolor';
  }
  if (env.TERM_PROGRAM === 'vscode' || env.TERM_PROGRAM === 'Apple_Terminal') {
    return 'ansi256';
  }

  if (ANSI256_TERMS.some(re => re.test(env.TERM))) return 'ansi256';

  return 'ansi16';
}

function detectUnicode(env) {
  if (env.KEPLER_PLAIN === '1') return false;
  // Most modern terminals on macOS/Linux handle UTF-8.
  // Windows ConEmu / older terminals are the main holdouts; conservative
  // fallback when LANG and LC_* are missing or explicitly POSIX.
  const lang = (process.env.LANG || process.env.LC_ALL || process.env.LC_CTYPE || '').toLowerCase();
  if (!lang) return process.platform !== 'win32';
  if (lang.includes('utf')) return true;
  return false;
}

function compute() {
  const env = readEnv();
  const isTTY = !!(process.stdout && process.stdout.isTTY);
  const level = detectColorLevel(env, isTTY);
  return {
    isTTY,
    colorLevel: level,                       // 'none' | 'ansi16' | 'ansi256' | 'truecolor'
    color: level !== 'none',
    truecolor: level === 'truecolor',
    ansi256: level === 'ansi256' || level === 'truecolor',
    unicode: detectUnicode(env),
    plain: env.KEPLER_PLAIN === '1',
    columns: (process.stdout && process.stdout.columns) || 80,
    rows: (process.stdout && process.stdout.rows) || 24,
    ci: !!env.CI,
  };
}

let _capabilities = compute();

/**
 * Current terminal capabilities. Stable until `refresh()` is called.
 */
export function term() {
  return _capabilities;
}

/**
 * Re-run capability detection. Tests, `/config` reloads, or runtime env changes.
 */
export function refresh() {
  _capabilities = compute();
  return _capabilities;
}

/**
 * Listen for terminal resizes. Returns an unsubscribe function.
 * Callers receive the latest capabilities object (with updated columns/rows).
 */
export function onResize(handler) {
  if (typeof handler !== 'function') return () => {};
  const stream = process.stdout;
  if (!stream || typeof stream.on !== 'function') return () => {};

  const onChange = () => {
    _capabilities = {
      ..._capabilities,
      columns: stream.columns || _capabilities.columns,
      rows: stream.rows || _capabilities.rows,
    };
    handler(_capabilities);
  };
  stream.on('resize', onChange);
  return () => stream.off('resize', onChange);
}

/**
 * Force a capability level. Test-only escape hatch.
 * Pass `null` to clear and re-detect.
 */
export function _setForTesting(overrides) {
  if (overrides === null) {
    _capabilities = compute();
    return _capabilities;
  }
  _capabilities = { ..._capabilities, ...overrides };
  return _capabilities;
}
