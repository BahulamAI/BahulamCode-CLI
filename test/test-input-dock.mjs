import assert from 'node:assert';

// Force a deterministic terminal capability before importing anything that
// resolves color state. Matches the convention used by test-terminal-rendering.
import { _setForTesting as _setTermForTesting } from '../src/ui/term.mjs';
_setTermForTesting({ isTTY: true, color: true, colorLevel: 'ansi16', plain: false });

import {
  wrapToLines,
  tailWithEllipsis,
  cursorPositionInLines,
} from '../src/ui/text-layout.mjs';
import * as dock from '../src/ui/input-dock.mjs';
import { strip as stripAnsi, width as visibleWidth } from '../src/ui/palette.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

console.log('\n\x1b[1mtest-input-dock.mjs\x1b[0m\n');

// ── wrapToLines ─────────────────────────────────────────────────────────

test('wrapToLines: empty input returns single empty line', () => {
  assert.deepStrictEqual(wrapToLines('', 40), ['']);
  assert.deepStrictEqual(wrapToLines(null, 40), ['']);
  assert.deepStrictEqual(wrapToLines(undefined, 40), ['']);
});

test('wrapToLines: short line passes through unchanged', () => {
  assert.deepStrictEqual(wrapToLines('hello', 40), ['hello']);
});

test('wrapToLines: preserves explicit newlines as hard breaks', () => {
  const out = wrapToLines('a\nb\nc', 40);
  assert.deepStrictEqual(out, ['a', 'b', 'c']);
});

test('wrapToLines: wraps at whitespace when possible', () => {
  const out = wrapToLines('the quick brown fox jumps over the lazy dog', 20);
  for (const line of out) assert.ok(visibleWidth(line) <= 20, `line too wide: ${line}`);
  assert.strictEqual(out.join(' ').replace(/\s+/g, ' ').trim(),
    'the quick brown fox jumps over the lazy dog');
});

test('wrapToLines: chunks a single overly-long word mid-word', () => {
  const path = '/very/long/absolute/path/that/exceeds/one/line.mjs';
  const out = wrapToLines(path, 20);
  assert.ok(out.length > 1, `expected chunks, got ${out.length}`);
  for (const line of out) assert.ok(visibleWidth(line) <= 20, `chunk too wide: ${line}`);
  assert.strictEqual(out.join(''), path);
});

test('wrapToLines: does not start a wrapped line with pure whitespace', () => {
  const out = wrapToLines('foo bar baz qux quux', 8);
  for (const line of out) {
    if (!line) continue;
    assert.notStrictEqual(line[0], ' ',
      `wrapped line unexpectedly starts with space: ${JSON.stringify(line)}`);
  }
});

test('wrapToLines: narrow 40 / 60 / 80 columns produce widths within budget', () => {
  const text = 'The compact tool card shows a stable one-line summary and expands on demand.';
  for (const width of [40, 60, 80]) {
    const out = wrapToLines(text, width);
    for (const line of out) {
      assert.ok(visibleWidth(line) <= width,
        `width ${width}: line width ${visibleWidth(line)} > budget for ${JSON.stringify(line)}`);
    }
  }
});

test('wrapToLines: ANSI-styled input wraps by visible width, not raw length', () => {
  const styled = '\x1b[1mhello\x1b[0m \x1b[36mworld\x1b[0m';
  const out = wrapToLines(styled, 40);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(stripAnsi(out[0]), 'hello world');
});

// ── tailWithEllipsis ────────────────────────────────────────────────────

test('tailWithEllipsis: input shorter than maxRows returns as-is', () => {
  const r = tailWithEllipsis(['a', 'b'], 3);
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.dropped, 0);
  assert.deepStrictEqual(r.visible, ['a', 'b']);
});

test('tailWithEllipsis: input longer than maxRows keeps tail with marker', () => {
  const r = tailWithEllipsis(['a', 'b', 'c', 'd', 'e'], 2);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.dropped, 3);
  assert.strictEqual(r.visible.length, 2);
  assert.ok(r.visible[0].startsWith('… '),
    `expected ellipsis on first visible line, got ${JSON.stringify(r.visible[0])}`);
  assert.strictEqual(r.visible[1], 'e');
});

test('tailWithEllipsis: maxRows=1 keeps last line with marker', () => {
  const r = tailWithEllipsis(['a', 'b', 'c'], 1);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.visible.length, 1);
  assert.ok(r.visible[0].startsWith('… '));
});

// ── cursorPositionInLines ───────────────────────────────────────────────

test('cursorPositionInLines: offset 0 maps to row 0 col 0', () => {
  assert.deepStrictEqual(cursorPositionInLines(['hello'], 0), { row: 0, col: 0 });
});

test('cursorPositionInLines: offset within first line', () => {
  assert.deepStrictEqual(cursorPositionInLines(['hello world'], 3),
    { row: 0, col: 3 });
});

test('cursorPositionInLines: offset that spans wrap points', () => {
  // Two lines of width 5: 'hello' | 'world'
  const r = cursorPositionInLines(['hello', 'world'], 7);
  assert.strictEqual(r.row, 1);
  assert.strictEqual(r.col, 2);
});

test('cursorPositionInLines: offset past end clamps to last line end', () => {
  const r = cursorPositionInLines(['ab', 'cd'], 999);
  assert.strictEqual(r.row, 1);
  assert.strictEqual(r.col, 2);
});

test('cursorPositionInLines: empty input returns {0,0}', () => {
  assert.deepStrictEqual(cursorPositionInLines([], 0), { row: 0, col: 0 });
  assert.deepStrictEqual(cursorPositionInLines([''], 0), { row: 0, col: 0 });
});

// ── integration-ish: pasted multi-line input into a 2-row dock ──────────

test('20-line paste into 2-row dock: shows last 2 lines with ellipsis', () => {
  const paste = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
  const wrapped = wrapToLines(paste, 40);
  assert.strictEqual(wrapped.length, 20);
  const tail = tailWithEllipsis(wrapped, 2);
  assert.strictEqual(tail.truncated, true);
  assert.strictEqual(tail.visible.length, 2);
  assert.ok(tail.visible[0].startsWith('… line 19'),
    `expected '… line 19', got ${JSON.stringify(tail.visible[0])}`);
  assert.strictEqual(tail.visible[1], 'line 20');
});

test('long path in a 40-col terminal: chunks safely within budget', () => {
  const path = '/Users/sree/Sites/Tarang Orca/codekepler-backend/app/api/very/long/path/here.py';
  const wrapped = wrapToLines(path, 40);
  for (const line of wrapped) {
    assert.ok(visibleWidth(line) <= 40, `chunk width ${visibleWidth(line)} > 40: ${line}`);
  }
});

// ── dock module surface: dynamic growth entry points exist ──────────────

test('input-dock exports the dynamic-growth API surface', () => {
  // Consumers of the dock (repl.mjs execution input) call renderDockInput
  // with a prefix + value; the dock internally grows/shrinks the input
  // area to fit the wrapped content up to KEPLER_INPUT_ROWS_MAX.
  for (const fn of ['renderDockInput', 'focusDockInput', 'prepareInputPrompt',
                    'clearInputPrompt', 'mountInputDock', 'unmountInputDock',
                    'clearDockArea', 'moveToContent', 'isInputDockMounted']) {
    assert.strictEqual(typeof dock[fn], 'function', `missing export: ${fn}`);
  }
});

test('mountInputDock signature accepts { inputRowsMax }', () => {
  // Non-TTY environment (npm test) → mount is a no-op returning false.
  // We only care that the call shape doesn't throw and that the export
  // exists with the right arg name (guards against silent rename).
  const source = dock.mountInputDock.toString();
  assert.ok(source.includes('inputRowsMax'),
    'mountInputDock should accept inputRowsMax option');
});

test('unmountInputDock clears dock rows before resetting terminal state', () => {
  const source = dock.unmountInputDock.toString();
  assert.ok(source.includes('clearDockArea({ restore: false })'),
    'unmountInputDock should clear the reserved dock rows');
  assert.ok(source.includes('clearScrollRegion()'),
    'unmountInputDock should reset the scroll region');
});

// ── frame identity + layout constants ───────────────────────────────────

test('dock brands the frame with "Bahulam Code"', () => {
  const { BRAND_LABEL } = dock._internals();
  assert.strictEqual(BRAND_LABEL, 'Bahulam Code');
});

test('dock reserves 7 fixed rows around the input area', () => {
  // top rule + spacer + input(N) + spacer + bottom rule + meta + tips + safety
  // = 7 fixed + N input rows
  const { FIXED_ROWS } = dock._internals();
  assert.strictEqual(FIXED_ROWS, 7);
});

test('renderDockInput accepts a meta option alongside context and tips', () => {
  const source = dock.renderDockInput.toString();
  assert.ok(source.includes('meta'),
    'renderDockInput should destructure meta from its options');
});

test('prepareInputPrompt accepts a meta option alongside context and tips', () => {
  const source = dock.prepareInputPrompt.toString();
  assert.ok(source.includes('meta'),
    'prepareInputPrompt should destructure meta from its options');
});

console.log(`\n\x1b[32m${passed} passed\x1b[0m\n`);
