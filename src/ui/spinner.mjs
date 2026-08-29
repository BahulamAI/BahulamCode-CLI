/**
 * Single shared spinner — Mission Control (PRD-055 §4.4).
 *
 * One spinner instance per process. The repl and status bar consume frames
 * from the same source so the eye never sees two animations out of phase.
 *
 * Usage:
 *
 *   const stop = startSpinner('Reading auth.py');
 *   await doWork();
 *   stop();                          // clears the line and stops the timer
 *
 * Or, for a managed line that already exists (e.g. the status bar):
 *
 *   const tick = spinnerFrame();     // current frame, advances on next call
 *
 * Behavior:
 *   - 120ms per frame.
 *   - Suppressed entirely when stdout is not a TTY or when BAHULAM_PLAIN=1.
 *     The `start`/`stop` API is still safe to call (no-op).
 *   - Color follows the current orbit (orchestrated by the caller via the
 *     palette token). Default: brand.primary.
 *   - ASCII fallback (when no Unicode): 'plain dot rotation'.
 */

import { paint } from './palette.mjs';
import { term } from './term.mjs';

// 8-step rotation. The PRD spec calls for ◯ → ◔ → ◑ → ◕ → ● → ◕ → ◑ → ◔
// which yields a perceptual "breathing" cycle rather than a left-right spin.
const FRAMES_UTF = ['◯', '◔', '◑', '◕', '●', '◕', '◑', '◔'];
const FRAMES_ASCII = ['.', 'o', 'O', '@', 'O', 'o', '.', ' '];

const INTERVAL_MS = 120;

let _frame = 0;

/**
 * Current spinner glyph. Advances the cursor each call.
 * Honors capability detection automatically.
 */
export function spinnerFrame(painter = paint.brand.primary) {
  const frames = term().unicode ? FRAMES_UTF : FRAMES_ASCII;
  const ch = frames[_frame % frames.length];
  _frame = (_frame + 1) % frames.length;
  return painter ? painter(ch) : ch;
}

/**
 * Reset to frame 0 — useful at the start of a new turn so consecutive
 * tool calls do not inherit each other's phase.
 */
export function resetSpinner() {
  _frame = 0;
}

/**
 * Start an inline spinner attached to `text`. Returns a stop function.
 *
 * The line is re-rendered in place using carriage return + erase, so the
 * caller does not need to manage cursor state. If the terminal cannot
 * render in place (non-TTY, dumb terminal, plain mode), the spinner becomes
 * a single static line `"… text"` written once.
 */
export function startSpinner(text, { stream = process.stderr, painter, color = 'brand.primary' } = {}) {
  const t = term();
  if (!t.isTTY || t.plain || !t.color) {
    try { stream.write(`… ${text}\n`); } catch {}
    return () => {};
  }

  const paintFn = painter || tokenPainter(color);
  let stopped = false;

  const render = () => {
    if (stopped) return;
    const glyph = spinnerFrame(paintFn);
    try {
      stream.write(`\r\x1b[2K${glyph} ${paint.text.dim(text)}`);
    } catch {
      // Stream closed mid-spin — stop quietly.
      stop();
    }
  };

  render();
  const handle = setInterval(render, INTERVAL_MS);

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
    try {
      stream.write('\r\x1b[2K');
    } catch {}
  }

  return stop;
}

/**
 * Look up a painter function from a dotted token name (e.g. 'brand.accent').
 * Falls back to the identity painter when the token does not exist.
 */
function tokenPainter(tokenPath) {
  const [ns, name] = String(tokenPath || '').split('.');
  const group = paint[ns];
  if (group && typeof group[name] === 'function') return group[name];
  return (s) => String(s ?? '');
}

/**
 * Interval used by the shared spinner. Exposed for the status bar to
 * synchronize its own re-paints with the spinner phase.
 */
export const SPINNER_INTERVAL_MS = INTERVAL_MS;
