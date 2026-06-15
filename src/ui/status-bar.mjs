/**
 * Persistent two-line status bar — Mission Control (PRD-055 §5).
 *
 * Anchors itself to the bottom two rows of the terminal using a DECSTBM
 * scroll region:
 *
 *   ┌────────────────────────────────────────────────┐
 *   │  scroll region (rows 1..rows-2)                │
 *   │  scroll region (rows 1..rows-2)                │
 *   │  scroll region (rows 1..rows-2)                │
 *   ├────────────────────────────────────────────────┤
 *   │  status line 1 — ORBIT | TASK | TURN | COST    │
 *   │  status line 2 — keyboard dock                  │
 *   └────────────────────────────────────────────────┘
 *
 * The scroll region is set once at mount; afterwards normal stdout/stderr
 * writes scroll within the upper region without ever touching the bar.
 *
 * Behavior:
 *   - No-op when stdout is not a TTY, or when KEPLER_PLAIN=1.
 *     The `mount/unmount/setOrbit` API is still safe to call.
 *   - Re-renders on state change (event-driven), not on a timer (except
 *     while in a state with a live spinner — see `_tickIfNeeded`).
 *   - SIGWINCH handler re-pads and re-sets the scroll region.
 *   - `unmount()` MUST be called before exit so the scroll region is
 *     restored and the cursor is shown.
 *
 * Implementation notes:
 *   - All output goes to stderr to keep stdout pipe-clean for `--print`/
 *     headless modes; if stdout is the only thing piped, the headless
 *     branch already short-circuits this module before any escape codes
 *     are emitted.
 *   - The PRD's "tput sc/rc" hint is shorthand. We use the actual VT100
 *     scroll region (`CSI top;bot r`) plus save/restore cursor.
 */

import { paint, width as visibleWidth } from './palette.mjs';
import { icons } from './icons.mjs';
import { spinnerFrame, SPINNER_INTERVAL_MS } from './spinner.mjs';
import { term, onResize } from './term.mjs';
import { ORBITS } from '../state/orbit.mjs';
import { dockForOrbit, renderDock } from './dock.mjs';

const ESC = '\x1b[';
const OUT = process.stderr;

// ── Orbit metadata: visual style + label ─────────────────────────────────

const ORBIT_META = {
  [ORBITS.IDLE]:      { label: 'IDLE',      paint: (s) => paint.text.dim(s),    spinning: false },
  [ORBITS.DISCOVERY]: { label: 'DISCOVERY', paint: (s) => paint.text.dim(s),    spinning: true  },
  [ORBITS.PLANNING]:  { label: 'PLANNING',  paint: (s) => paint.state.warn(s),  spinning: true  },
  [ORBITS.EXECUTION]: { label: 'EXECUTION', paint: (s) => paint.brand.primary(s), spinning: true },
  [ORBITS.ALIGNMENT]: { label: 'ALIGNMENT', paint: (s) => paint.brand.data(s),  spinning: true  },
  [ORBITS.AWAITING]:  { label: 'AWAITING',  paint: (s) => paint.brand.accent(s), spinning: false, border: true },
  [ORBITS.PAUSED]:    { label: 'PAUSED',    paint: (s) => paint.state.warn(s),  spinning: false },
};

// ── State held by the singleton ──────────────────────────────────────────

let mounted = false;
let unsubResize = null;
let tickInterval = null;
let lastSnapshot = null;
let resetting = false;

// ── Low-level cursor / region helpers ────────────────────────────────────

function write(s) { try { OUT.write(s); } catch {} }

function setScrollRegion(top, bottom) { write(`${ESC}${top};${bottom}r`); }
function clearScrollRegion()           { write(`${ESC}r`); }
function saveCursor()                  { write(`${ESC}s`); }
function restoreCursor()               { write(`${ESC}u`); }
function moveTo(row, col)              { write(`${ESC}${row};${col}H`); }
function clearLine()                   { write(`${ESC}2K`); }
function hideCursor()                  { write(`${ESC}?25l`); }
function showCursor()                  { write(`${ESC}?25h`); }

// ── Layout: assemble the two lines ───────────────────────────────────────

function formatCost(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function buildLineOne(snap, cols) {
  const meta = ORBIT_META[snap.orbit] || ORBIT_META[ORBITS.IDLE];
  const sep  = paint.text.dim(' │ ');

  const glyph = meta.spinning ? spinnerFrame(meta.paint) : meta.paint(icons.orbit);
  const orbitLabel = `${glyph} ${meta.paint('ORBIT: ' + meta.label)}`;

  const segments = [orbitLabel];

  if (snap.task) {
    segments.push(paint.text.dim('TASK: ') + paint.text.primary(snap.task));
  }
  if (snap.subAgents > 0) {
    segments.push(paint.text.dim('SUB-AGENTS: ') + paint.brand.data(`${icons.subAgent} ${snap.subAgents}`));
  }
  if (snap.turn > 0) {
    const turnText = snap.maxTurn > 0 ? `TURN ${snap.turn}/${snap.maxTurn}` : `TURN ${snap.turn}`;
    segments.push(paint.text.dim(turnText));
  }
  segments.push(paint.text.dim('COST ') + paint.brand.data(formatCost(snap.cost)));

  return assembleLine(segments, sep, cols);
}

function buildLineTwo(snap, cols) {
  if (snap.orbit === ORBITS.AWAITING && snap.awaitingTool) {
    const prefix = paint.brand.accent(`${icons.warn} APPROVAL  `) + paint.text.primary(snap.awaitingTool);
    const tail = renderDock(dockForOrbit(snap.orbit), Math.max(0, cols - visibleWidth(prefix) - 2));
    return ` ${prefix}  ${tail}`;
  }
  const hints = dockForOrbit(snap.orbit);
  return ' ' + renderDock(hints, cols - 1);
}

/**
 * Concatenate segments with separators, dropping trailing segments when
 * they exceed `cols` of visible width. Always keeps the first segment.
 */
function assembleLine(segments, sep, cols) {
  if (segments.length === 0) return '';
  let out = ' ' + segments[0];
  let used = 1 + visibleWidth(segments[0]);
  for (let i = 1; i < segments.length; i++) {
    const piece = sep + segments[i];
    const cost = visibleWidth(piece);
    if (used + cost > cols) break;
    out += piece;
    used += cost;
  }
  return out;
}

// ── Render ───────────────────────────────────────────────────────────────

function paintLine(text, cols) {
  const pad = Math.max(0, cols - visibleWidth(text));
  return text + ' '.repeat(pad);
}

function render(snap) {
  if (!mounted || !snap) return;
  const t = term();
  if (!t.isTTY || t.plain) return;

  const cols = Math.max(20, t.columns);
  const rows = Math.max(4,  t.rows);

  const line1 = paintLine(buildLineOne(snap, cols), cols);
  const line2 = paintLine(buildLineTwo(snap, cols), cols);

  saveCursor();
  moveTo(rows - 1, 1);
  clearLine();
  write(line1);
  moveTo(rows, 1);
  clearLine();
  write(line2);
  restoreCursor();
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Mount the status bar. Sets up the scroll region, hides the cursor, and
 * registers SIGWINCH. Returns `false` when the environment is not TTY
 * (caller can short-circuit).
 *
 * Safe to call multiple times — re-entrant calls are no-ops.
 */
export function mount() {
  if (mounted) return true;
  const t = term();
  if (!t.isTTY || t.plain) return false;

  // Reserve the bottom 2 rows.
  const rows = Math.max(4, t.rows);
  setScrollRegion(1, rows - 2);
  moveTo(rows - 1, 1); clearLine();
  moveTo(rows, 1);     clearLine();
  // Restore cursor into the scroll region so subsequent writes go there.
  moveTo(rows - 2, 1);

  unsubResize = onResize(() => {
    if (!mounted) return;
    const r = Math.max(4, term().rows);
    setScrollRegion(1, r - 2);
    if (lastSnapshot) render(lastSnapshot);
  });

  // Cleanup hooks — exits, signals, uncaught crash all restore the terminal.
  process.once('exit',    safeUnmount);
  process.once('SIGINT',  () => { safeUnmount(); process.exit(130); });
  process.once('SIGTERM', () => { safeUnmount(); process.exit(143); });

  mounted = true;
  return true;
}

/**
 * Tear down: restore scroll region, show cursor. Must be called before
 * process exit. Safe to call when not mounted.
 */
export function unmount() {
  if (!mounted || resetting) return;
  resetting = true;
  try {
    clearScrollRegion();
    showCursor();
    if (unsubResize) { unsubResize(); unsubResize = null; }
    if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  } finally {
    mounted = false;
    resetting = false;
  }
}

function safeUnmount() { try { unmount(); } catch {} }

/**
 * Push a new orbit snapshot. Triggers a render and starts/stops the
 * spinner tick as needed.
 */
export function setOrbit(snap) {
  lastSnapshot = snap;
  if (!mounted) return;
  const meta = ORBIT_META[snap.orbit] || ORBIT_META[ORBITS.IDLE];
  if (meta.spinning) startTick();
  else stopTick();
  render(snap);
}

/** Force an immediate redraw using the last known snapshot. */
export function redraw() {
  if (lastSnapshot) render(lastSnapshot);
}

function startTick() {
  if (tickInterval || !mounted) return;
  tickInterval = setInterval(() => {
    if (!mounted || !lastSnapshot) return;
    render(lastSnapshot);
  }, SPINNER_INTERVAL_MS);
  if (typeof tickInterval.unref === 'function') tickInterval.unref();
}

function stopTick() {
  if (!tickInterval) return;
  clearInterval(tickInterval);
  tickInterval = null;
}

/**
 * Connect an `orbit` state machine instance to this status bar. Returns an
 * unsubscribe function. The bar is mounted automatically; tear it down with
 * `unmount()` or by calling the returned function (which also unmounts).
 */
export function attachOrbit(orbit) {
  if (!orbit || typeof orbit.on !== 'function') return () => {};
  if (!mount()) return () => {}; // non-TTY: silently ignore
  const unsub = orbit.on('change', setOrbit);
  // Initial paint
  setOrbit(orbit.state());
  return () => {
    try { unsub(); } catch {}
    unmount();
  };
}
