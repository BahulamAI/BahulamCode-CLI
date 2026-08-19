/**
 * Render queue — THE single writer for the rich-TTY screen.
 *
 * Every glitch class the old pipeline suffered (flicker, dock overlap,
 * wrap artifacts, resize mangling, approval gaps) traced to the same root:
 * multiple modules moved the cursor independently — spinner interval,
 * content flush timer, dock repaints, approval prompts — with the single
 * VT100 save/restore slot as their only (broken) coordination.
 *
 * Discipline (Ink's core insight, without adopting Ink):
 *   1. Exactly ONE module writes to the terminal in rich mode. This one.
 *   2. Every operation is a complete transaction: position → write →
 *      re-park. No saveCursor/restoreCursor anywhere.
 *   3. Cursor position is tracked exactly — possible only because raw
 *      writes are banned. process.stdout/stderr are patched to REDIRECT
 *      through queue.content() (not merely observe), so a stray
 *      console.log from any dependency is serialized instead of
 *      corrupting the screen.
 *   4. The transient status line (spinner) is coalesced last-wins and is
 *      always cleared before content lands, then redrawn after — content
 *      and spinner can no longer interleave.
 *
 * Plain / non-TTY mode: the queue degrades to a pass-through (content →
 * stdout, status dropped, no cursor ops) so piped transcripts stay clean.
 *
 * Cell-width accounting: `cellWidth()` measures terminal CELLS (East
 * Asian Wide/Fullwidth = 2, combining marks/ZWJ = 0, tabs → next stop),
 * unlike palette.width() which counts codepoints. Wrap math that feeds
 * cursor tracking MUST use cells, or CJK/emoji output drifts the dock.
 */

import { term, onResize } from './term.mjs';

const ESC = '\x1b[';

// ── ANSI / OSC stripping ─────────────────────────────────────────────────
// CSI (incl. private + intermediate bytes), OSC (BEL or ST terminated),
// charset selection, and simple ESC-letter sequences.
const ANSI_RE = new RegExp([
  '\\x1b\\[[0-?]*[ -/]*[@-~]',          // CSI
  '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', // OSC ... BEL|ST
  '\\x1b[()][A-Za-z0-9]',               // charset
  '\\x1b[@-Z\\\\-_]',                   // 2-byte ESC sequences
].join('|'), 'g');

export function stripSequences(text) {
  return String(text ?? '').replace(ANSI_RE, '');
}

// ── Cell width ───────────────────────────────────────────────────────────

function isZeroWidth(cp) {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacriticals
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    cp === 0x200d ||                  // ZWJ
    cp === 0xfeff
  );
}

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||  // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||  // CJK radicals, punctuation
    (cp >= 0x3041 && cp <= 0x33ff) ||  // Hiragana..CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||  // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||  // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||  // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji blocks
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Terminal cell width of `text` after stripping escape sequences. */
export function cellWidth(text) {
  const plain = stripSequences(text);
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    if (cp === 0x09) { w = (Math.floor(w / 8) + 1) * 8; continue; }
    if (cp < 0x20 || cp === 0x7f) continue;
    if (isZeroWidth(cp)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

// ── Queue state ──────────────────────────────────────────────────────────

let active = false;           // rich mode engaged (dock mounted)
let out = process.stderr;     // the one true stream in rich mode
let rawStderrWrite = null;    // originals captured at activate()
let rawStdoutWrite = null;

let row = 1;                  // tracked content cursor (1-based)
let col = 1;
let regionBottom = null;      // scroll-region bottom (content area)
let statusLine = '';          // current transient status ('' = none)
let statusVisible = false;
let parked = null;            // {row, col} where input echo expects the cursor
let inTransaction = 0;        // reentrancy guard for queue-internal writes
let contentEscapeCarry = '';  // incomplete ESC sequence crossing write chunks

function rawWrite(s) {
  // Always bypass the redirect patch for queue-internal writes.
  (rawStderrWrite || process.stderr.write.bind(process.stderr))(s);
}

function seq(s) { rawWrite(ESC + s); }
function moveTo(r, c) { seq(`${r};${c}H`); }
function clearLine() { seq('2K'); }

function cols() {
  return Math.max(20, term().columns || out.columns || 80);
}

function bottom() {
  return regionBottom ?? Math.max(10, term().rows || 24);
}

// ── Exact tracking ───────────────────────────────────────────────────────
// Advance the tracked (row, col) as the terminal will after printing
// `text`. Only printable content passes through here — queue ops position
// with moveTo(), never with embedded CSI in content.

function advance(text) {
  const width = cols();
  const plain = stripSequences(text);
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    if (cp === 0x0a) { row = Math.min(bottom(), row + 1); col = 1; continue; }
    if (cp === 0x0d) { col = 1; continue; }
    if (cp === 0x09) { col = (Math.floor((col - 1) / 8) + 1) * 8 + 1; }
    else if (cp < 0x20 || cp === 0x7f || isZeroWidth(cp)) { continue; }
    else { col += isWide(cp) ? 2 : 1; }
    if (col > width) { row = Math.min(bottom(), row + 1); col = 1; }
  }
}

// ── Status line (spinner) discipline ─────────────────────────────────────

function eraseStatus() {
  if (!statusVisible) return;
  moveTo(Math.min(bottom(), row), 1);
  clearLine();
  statusVisible = false;
}

function paintStatus() {
  if (!statusLine) return;
  moveTo(Math.min(bottom(), row), 1);
  clearLine();
  rawWrite(statusLine);
  statusVisible = true;
}

function repark() {
  if (parked) moveTo(parked.row, parked.col);
  else moveTo(Math.min(bottom(), row), col);
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Engage rich mode. The queue captures both std streams and becomes the
 * sole writer. `initial` seeds the tracked cursor (dock mount computes it).
 */
export function activate({ initialRow = 1, initialCol = 1, bottom: b = null } = {}) {
  if (active) return true;
  const t = term();
  if (!t.isTTY || t.plain) return false;
  active = true;
  row = Math.max(1, initialRow);
  col = Math.max(1, initialCol);
  regionBottom = b;
  rawStdoutWrite = process.stdout.write.bind(process.stdout);
  rawStderrWrite = process.stderr.write.bind(process.stderr);
  // REDIRECT, don't observe: stray writers become serialized content.
  process.stdout.write = redirectedWrite;
  process.stderr.write = redirectedWrite;
  return true;
}

export function deactivate() {
  if (!active) return;
  if (rawStdoutWrite) { process.stdout.write = rawStdoutWrite; rawStdoutWrite = null; }
  if (rawStderrWrite) { process.stderr.write = rawStderrWrite; rawStderrWrite = null; }
  active = false;
  regionBottom = null;
  statusLine = '';
  statusVisible = false;
  parked = null;
  contentEscapeCarry = '';
}

export function isActive() { return active; }

function redirectedWrite(chunk, encoding, cb) {
  if (inTransaction > 0) {
    // Queue-internal writes that (incorrectly) went through the patched
    // stream — pass straight through.
    rawWrite(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? ''));
  } else {
    content(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? ''));
  }
  if (typeof encoding === 'function') encoding();
  else if (typeof cb === 'function') cb();
  return true;
}

// Content is TEXT, not cursor commands (Ink's discipline). SGR color
// sequences pass through; cursor movement / erase / scroll sequences are
// stripped — a content writer that embeds CUU/ED/DECSTBM would move the
// real cursor without tracking following (the old approval-redraw gap
// bug). Positioning belongs to the queue alone.
function sanitizeContent(s) {
  const input = contentEscapeCarry + String(s ?? '');
  contentEscapeCarry = '';
  let out = '';

  for (let i = 0; i < input.length;) {
    const ch = input[i];
    if (ch !== '\x1b') {
      out += ch;
      i++;
      continue;
    }

    if (i + 1 >= input.length) {
      contentEscapeCarry = input.slice(i);
      break;
    }

    const next = input[i + 1];

    // CSI: ESC [ params/intermediates final. Preserve only SGR (`m`).
    if (next === '[') {
      let j = i + 2;
      while (j < input.length) {
        const code = input.charCodeAt(j);
        if (code >= 0x40 && code <= 0x7e) break;
        j++;
      }
      if (j >= input.length) {
        contentEscapeCarry = input.slice(i);
        break;
      }
      const seqText = input.slice(i, j + 1);
      if (input[j] === 'm') out += seqText;
      i = j + 1;
      continue;
    }

    // OSC: ESC ] ... BEL or ST. Strip, buffering incomplete sequences.
    if (next === ']') {
      let j = i + 2;
      let completeAt = -1;
      while (j < input.length) {
        if (input[j] === '\x07') { completeAt = j; break; }
        if (input[j] === '\x1b' && input[j + 1] === '\\') { completeAt = j + 1; break; }
        j++;
      }
      if (completeAt < 0) {
        contentEscapeCarry = input.slice(i);
        break;
      }
      i = completeAt + 1;
      continue;
    }

    // Charset selection: ESC ( X / ESC ) X. Strip, buffering if split.
    if (next === '(' || next === ')') {
      if (i + 2 >= input.length) {
        contentEscapeCarry = input.slice(i);
        break;
      }
      i += 3;
      continue;
    }

    // Other two-byte ESC commands. Strip the ESC command byte too.
    i += 2;
  }

  return out;
}

/**
 * Append transcript content at the tracked position. Multi-line safe.
 * Clears the status line first and repaints it after, so spinner and
 * content can never interleave.
 */
export function content(text) {
  const s = String(text ?? '');
  if (!s) return;
  if (!active) { (rawStdoutWrite || process.stdout.write.bind(process.stdout))(s); return; }
  const clean = sanitizeContent(s);
  if (!clean) return;
  inTransaction++;
  try {
    eraseStatus();
    moveTo(Math.min(bottom(), row), col);
    rawWrite(clean);
    advance(clean);
    paintStatus();
    repark();
  } finally {
    inTransaction--;
  }
}

/**
 * Set / update the transient status (spinner) line. Last-wins; a repaint
 * happens only when the rendered string actually changed.
 */
export function status(line) {
  const s = String(line ?? '');
  if (!active) return;
  if (s === statusLine && statusVisible) return;
  inTransaction++;
  try {
    statusLine = s;
    if (!s) { eraseStatus(); } else { paintStatus(); }
    repark();
  } finally {
    inTransaction--;
  }
}

export function clearStatus() { status(''); }

/**
 * Absolute-positioned write for dock frame rows. Does NOT touch content
 * tracking. `clear` wipes the line first.
 */
export function at(r, c, text, { clear = true } = {}) {
  if (!active) return;
  inTransaction++;
  try {
    moveTo(r, c);
    if (clear) clearLine();
    if (text) rawWrite(String(text));
  } finally {
    inTransaction--;
  }
}

/** Set the scroll region (content area 1..b). */
export function setRegion(top, b) {
  if (!active) return;
  inTransaction++;
  try {
    seq(`${top};${b}r`);
    regionBottom = b;
    row = Math.min(b, row);
  } finally {
    inTransaction--;
  }
}

export function clearRegion() {
  if (!active) return;
  inTransaction++;
  try { seq('r'); regionBottom = null; } finally { inTransaction--; }
}

/**
 * Batch several at()/setRegion() calls (a dock repaint) and finish with
 * the cursor parked for input echo. Single place where parking happens.
 */
export function frame(fn, { park = null } = {}) {
  if (!active) { if (typeof fn === 'function') fn(); return; }
  inTransaction++;
  try {
    if (typeof fn === 'function') fn();
    if (park) parked = { row: park.row, col: park.col };
    repark();
  } finally {
    inTransaction--;
  }
}

/**
 * Serialized raw write for trusted frame painters (the input dock). The
 * caller owns positioning via embedded escape sequences; content tracking
 * is not touched. Bypasses the redirect patch.
 */
export function raw(s) {
  if (!active) { (rawStderrWrite || process.stderr.write.bind(process.stderr))(String(s ?? '')); return; }
  inTransaction++;
  try { rawWrite(String(s ?? '')); } finally { inTransaction--; }
}

/** Park the input-echo cursor. Every op re-parks here afterwards. */
export function park(r, c) {
  if (!active) return;
  parked = r == null ? null : { row: r, col: c ?? 1 };
  inTransaction++;
  try { repark(); } finally { inTransaction--; }
}

/** Tracked content cursor (exact — no simulation drift). */
export function contentCursor() {
  return { row, col };
}

/** Hard re-anchor after resize: tracking through a reflow is fiction. */
export function reanchor({ row: r, col: c = 1, bottom: b = null } = {}) {
  if (!active) return;
  if (b != null) regionBottom = b;
  row = Math.max(1, Math.min(bottom(), r ?? bottom()));
  col = Math.max(1, c);
  statusVisible = false; // old status row is gone after reflow
}

/** Reset tracked cursor without touching the screen (dock mount). */
export function seed({ row: r = 1, col: c = 1, bottom: b = null } = {}) {
  row = Math.max(1, r);
  col = Math.max(1, c);
  if (b != null) regionBottom = b;
}

// Test-only accessors.
export function _internals() {
  return {
    state: () => ({ active, row, col, regionBottom, statusLine, statusVisible, parked }),
    advance,
    cellWidth,
    stripSequences,
    sanitizeContent,
  };
}
