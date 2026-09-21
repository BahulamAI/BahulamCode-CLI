import assert from 'node:assert/strict';
import { term, _setForTesting } from '../src/ui/term.mjs';
import * as queue from '../src/ui/render-queue.mjs';
import * as dock from '../src/ui/input-dock.mjs';
import { ApprovalManager } from '../src/core/approval.mjs';
import { TIERS } from '../src/core/risk-tier.mjs';

const originalTerm = { ...term() };
const stdout = process.stdout.write;
const stderr = process.stderr.write;
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const resume = process.stdin.resume;
const setRawMode = process.stdin.setRawMode;
const resizeListeners = process.stdout.listenerCount('resize');
let output = '';
try {
  _setForTesting({ isTTY: true, color: true, colorLevel: 'ansi16', unicode: true,
    plain: false, ttyMode: 'rich', fixedInput: true, columns: 80, rows: 24 });
  process.stdout.write = process.stderr.write = chunk => { output += String(chunk); return true; };
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  process.stdin.resume = () => {};
  process.stdin.setRawMode = () => {};
  assert.equal(dock.mountInputDock(), true);
  dock.renderDockInput('you > ', 'before approval');
  assert.equal(dock._internals().reservedRows(), 6);
    // Metadata refreshes preserve both a live-instruction draft and a cursor
  // in the middle of an idle draft; they never paint the input rows.
  for (const [prefix, value, cursor] of [['+ add context > ', 'check the API too', null], ['you > ', 'edit this text', 4]]) {
    dock.renderDockInput(prefix, value, { cursor, tips: 'original tips' });
    const parked = { ...queue._internals().state().parked };
    const regionBottom = queue._internals().state().regionBottom;
    const size = dock._internals().reservedRows();
    for (let tick = 0; tick < 3; tick++) {
      output = '';
      assert.equal(dock.refreshDockMetadata({ context: tick + 's elapsed', meta: 'project / branch' }), true);
      assert.ok(!output.includes(prefix));
      assert.ok(!output.includes(value));
      assert.ok(!output.includes('original tips'));
      process.stdout.write('streamed chunk\n');
      assert.deepEqual(queue._internals().state().parked, parked);
      assert.equal(queue._internals().state().regionBottom, regionBottom);
      assert.equal(dock._internals().reservedRows(), size);
    }
    output = '';
    dock.redrawDockInput();
    assert.ok(output.includes(value), 'draft survives clock ticks');
  }
  dock.renderDockOverlay({ context: 'APPROVAL / shell', lines: ['$ npm test', '[y] approve once', '[n] cancel'] });
  const reserved = dock._internals().reservedRows();
  output = '';
  // The one-second REPL refresh, execution-input redraw, and input cleanup
  // must all leave the visible approval intact until its owner dismisses it.
  assert.equal(dock.renderDockInput('you > ', '', { context: '1m elapsed' }), false);
  assert.equal(dock.refreshDockMetadata({ context: 'timer' }), false);
  assert.equal(dock.clearInputPrompt(), false);
  assert.equal(dock.prepareInputPrompt(), false);
  assert.equal(dock.focusDockInput('you > ', ''), false);
  assert.equal(output, '');
  assert.equal(dock._internals().reservedRows(), reserved);
  process.stdout.write('Streaming output while approval is pending\n');
  dock.drawPinnedStatus('waiting');
  dock.redrawDockInput();
  assert.equal(dock.isDockOverlayActive(), true);
  assert.match(output, /\[y\] approve once/);
  assert.equal(dock._internals().reservedRows(), reserved);
  dock.dismissDockOverlay();
  assert.equal(dock.isDockOverlayActive(), false);
  assert.equal(dock._internals().reservedRows(), 6);
  assert.equal(dock.renderDockInput('you > ', 'after approval'), true);

  for (const outcome of ['y', 'n', 'escape', 'throw']) {
    _setForTesting({ columns: 80, rows: 24 });
    const log = [];
    // In-memory dependencies: these tests never write trust rules or approval logs.
    const manager = new ApprovalManager({ policy: { hitl: {} }, trustStore: {}, approvalLog: { append: entry => log.push(entry) } });
    let starts = 0, ends = 0, pauses = 0, resumes = 0, reads = 0;
    manager.setExecutionHooks({
      onPause: () => pauses++, onResume: () => resumes++,
      onApprovalPromptStart: () => starts++,
      onApprovalPromptEnd: () => { ends++; if (outcome === 'throw') throw Error('host paint failed'); },
    });
    manager._readKey = async () => {
      assert.equal(manager._approvalPromptActive, true);
      assert.equal(dock.isDockOverlayActive(), true);
      assert.equal(dock.renderDockInput('you > ', 'timer refresh'), false);
      if (reads++ === 0) {
        process.stdout.write('background result\n');
        _setForTesting({ columns: 40, rows: 18 });
        process.stdout.emit('resize');
        return 'pagedown';
      }
      if (reads === 2) return 'pageup';
      if (outcome === 'throw') throw Error('input interrupted');
      return outcome;
    };
    const pending = manager._prompt('shell', { command: Array.from({ length: 30 }, (_, i) => 'echo item_' + i).join('\n') }, { tier: TIERS.SHELL_MEDIUM });
    if (outcome === 'throw') await assert.rejects(pending, /input interrupted/);
    else assert.equal((await pending).approved, outcome === 'y');
    assert.equal(manager._approvalPromptActive, false);
    assert.equal(dock.isDockOverlayActive(), false);
    assert.equal(starts, 1);
    assert.equal(ends, 1);
    assert.equal(pauses, 1);
    assert.equal(resumes, 1);
    assert.equal(log.length, outcome === 'throw' ? 0 : 1);
    assert.equal(process.stdout.listenerCount('resize'), resizeListeners + 1);
    assert.equal(dock.renderDockInput('you > ', 'ready'), true);
  }
  // A tiny window switches from the dock to transcript presentation, but
  // must still release the host's approval marker and raw input ownership.
  _setForTesting({ columns: 20, rows: 10 });
  const fallback = new ApprovalManager({ policy: { hitl: {} }, trustStore: {}, approvalLog: { append() {} } });
  let fallbackEnded = 0;
  fallback.setExecutionHooks({ onApprovalPromptEnd: () => fallbackEnded++ });
  fallback._readKey = async () => {
    assert.equal(dock.isDockOverlayActive(), false);
    return 'escape';
  };
  assert.equal((await fallback._prompt('shell', { command: 'npm publish' }, { tier: TIERS.SHELL_MEDIUM })).approved, false);
  assert.equal(fallbackEnded, 1);
  assert.equal(fallback._approvalPromptActive, false);
} finally {
  dock.unmountInputDock();
  process.stdout.write = stdout;
  process.stderr.write = stderr;
  if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
  else delete process.stdin.isTTY;
  process.stdin.resume = resume;
  if (setRawMode) process.stdin.setRawMode = setRawMode;
  else delete process.stdin.setRawMode;
  _setForTesting(originalTerm);
}
assert.equal(process.stdout.listenerCount('resize'), resizeListeners);
console.log('Dock lifecycle: timer/streaming/resize/paging/approve/cancel/interruption regression checks passed.');
